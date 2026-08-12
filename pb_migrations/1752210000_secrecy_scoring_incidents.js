/// <reference path="../pb_data/types.d.ts" />
// Locks hidden scenario config, makes scores server-written, and adds incident logging.
// Safe to re-run: guards every collection and field mutation with existence checks.
migrate((app) => {
  const fieldByName = (collection, name) => {
    try {
      if (collection.fields && collection.fields.getByName) {
        return collection.fields.getByName(name);
      }
    } catch {}
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return field;
      }
    }
    return null;
  };

  const hasField = (collection, name) => {
    return !!fieldByName(collection, name);
  };

  const addFieldIfMissing = (collection, field) => {
    if (!hasField(collection, field.name)) {
      if (collection.fields && collection.fields.add) {
        collection.fields.add(field);
      } else {
        collection.fields.push(field);
      }
    }
  };

  // --- scenarios secrecy ---
  try {
    const scenarios = app.findCollectionByNameOrId("scenarios");
    const engineConfig = fieldByName(scenarios, "engine_config");
    if (engineConfig) {
      engineConfig.hidden = true;
    }
    const scoringConfig = fieldByName(scenarios, "scoring_config");
    if (scoringConfig) {
      scoringConfig.hidden = true;
    }
    app.save(scenarios);
  } catch {}

  // --- scores server-written fields ---
  try {
    const scores = app.findCollectionByNameOrId("scores");
    addFieldIfMissing(scores, new TextField({ name: "day", max: 10 }));
    addFieldIfMissing(scores, new NumberField({ name: "percentile" }));
    addFieldIfMissing(scores, new TextField({ name: "outcome", max: 16 }));
    scores.listRule = "";
    scores.viewRule = "";
    scores.createRule = null;
    app.save(scores);
  } catch {}

  // --- incidents ---
  let incidents;
  try {
    incidents = app.findCollectionByNameOrId("incidents");
  } catch {
    incidents = new Collection({
      name: "incidents",
      type: "base",
    });
    incidents.fields = [];
    incidents.indexes = [];
  }

  addFieldIfMissing(incidents, new TextField({ name: "session", max: 64 }));
  addFieldIfMissing(incidents, new TextField({ name: "type", required: true, max: 64 }));
  addFieldIfMissing(incidents, new JSONField({ name: "details", maxSize: 20000 }));

  incidents.listRule = null;
  incidents.viewRule = null;
  incidents.createRule = null;
  incidents.updateRule = null;
  incidents.deleteRule = null;

  app.save(incidents);
}, (app) => {
  const fieldByName = (collection, name) => {
    try {
      if (collection.fields && collection.fields.getByName) {
        return collection.fields.getByName(name);
      }
    } catch {}
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return field;
      }
    }
    return null;
  };

  try {
    const scenarios = app.findCollectionByNameOrId("scenarios");
    const engineConfig = fieldByName(scenarios, "engine_config");
    if (engineConfig) {
      engineConfig.hidden = false;
    }
    const scoringConfig = fieldByName(scenarios, "scoring_config");
    if (scoringConfig) {
      scoringConfig.hidden = false;
    }
    app.save(scenarios);
  } catch {}

  try {
    const scores = app.findCollectionByNameOrId("scores");
    scores.createRule = "";
    app.save(scores);
  } catch {}

  try {
    app.delete(app.findCollectionByNameOrId("incidents"));
  } catch {}
});
