/// <reference path="../pb_data/types.d.ts" />
// Adds LLM scenario metadata plus locked server-only scenario/session collections.
// Safe to re-run: guards every collection, field, and index create with existence checks.
migrate((app) => {
  const hasField = (collection, name) => {
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return true;
      }
    }
    return false;
  };

  const addFieldIfMissing = (collection, field) => {
    if (!hasField(collection, field.name)) {
      collection.fields.push(field);
    }
  };

  const hasIndex = (collection, name) => {
    for (const index of collection.indexes || []) {
      if (String(index).indexOf(name) !== -1) {
        return true;
      }
    }
    return false;
  };

  const addIndexIfMissing = (collection, name, sql) => {
    if (!hasIndex(collection, name)) {
      collection.indexes.push(sql);
    }
  };

  const scenarios = app.findCollectionByNameOrId("scenarios");

  // --- scenarios LLM metadata ---
  addFieldIfMissing(scenarios, new TextField({ name: "scenario_date", max: 10 }));
  addFieldIfMissing(scenarios, new SelectField({
    name: "status",
    maxSelect: 1,
    values: ["draft", "published", "retired"],
  }));
  addFieldIfMissing(scenarios, new TextField({ name: "generator", max: 32 }));
  app.save(scenarios);

  // --- scenario_secrets ---
  let scenarioSecrets;
  try {
    scenarioSecrets = app.findCollectionByNameOrId("scenario_secrets");
  } catch {
    scenarioSecrets = new Collection({
      name: "scenario_secrets",
      type: "base",
    });
    scenarioSecrets.fields = [];
    scenarioSecrets.indexes = [];
  }

  addFieldIfMissing(scenarioSecrets, new RelationField({
    name: "scenario",
    collectionId: scenarios.id,
    required: true,
    maxSelect: 1,
  }));
  addFieldIfMissing(scenarioSecrets, new JSONField({ name: "secret_spec", maxSize: 50000 }));
  addFieldIfMissing(scenarioSecrets, new JSONField({ name: "security_report", maxSize: 50000 }));

  // Superuser/hooks only. No public API access.
  scenarioSecrets.listRule = null;
  scenarioSecrets.viewRule = null;
  scenarioSecrets.createRule = null;
  scenarioSecrets.updateRule = null;
  scenarioSecrets.deleteRule = null;

  app.save(scenarioSecrets);

  // --- sessions ---
  let sessions;
  try {
    sessions = app.findCollectionByNameOrId("sessions");
  } catch {
    sessions = new Collection({
      name: "sessions",
      type: "base",
    });
    sessions.fields = [];
    sessions.indexes = [];
  }

  addFieldIfMissing(sessions, new RelationField({
    name: "scenario",
    collectionId: scenarios.id,
    required: true,
    maxSelect: 1,
  }));
  addFieldIfMissing(sessions, new TextField({ name: "token", required: true }));
  addFieldIfMissing(sessions, new JSONField({ name: "transcript", maxSize: 200000 }));
  addFieldIfMissing(sessions, new JSONField({ name: "state", maxSize: 20000 }));
  addFieldIfMissing(sessions, new SelectField({
    name: "status",
    required: true,
    maxSelect: 1,
    values: ["active", "deal", "no_deal"],
  }));
  addFieldIfMissing(sessions, new JSONField({ name: "agreement", maxSize: 50000 }));

  // Accessed only through custom hook routes. No public API access.
  sessions.listRule = null;
  sessions.viewRule = null;
  sessions.createRule = null;
  sessions.updateRule = null;
  sessions.deleteRule = null;

  sessions.indexes = sessions.indexes || [];
  addIndexIfMissing(sessions, "idx_sessions_token", "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token)");

  app.save(sessions);
}, (app) => {
  const removeFields = (collection, names) => {
    collection.fields = (collection.fields || []).filter((field) => names.indexOf(field.name) === -1);
  };

  try {
    app.delete(app.findCollectionByNameOrId("sessions"));
  } catch {}
  try {
    app.delete(app.findCollectionByNameOrId("scenario_secrets"));
  } catch {}
  try {
    const scenarios = app.findCollectionByNameOrId("scenarios");
    removeFields(scenarios, ["scenario_date", "status", "generator"]);
    app.save(scenarios);
  } catch {}
});
