/// <reference path="../pb_data/types.d.ts" />
// Adds optional identity/day fields to the existing scores collection.
// Safe to re-run: guards every field and index addition.
migrate((app) => {
  let scores;
  try {
    scores = app.findCollectionByNameOrId("scores");
  } catch {
    return;
  }

  const hasField = (collection, name) => {
    if (collection.fields && collection.fields.getByName) {
      return !!collection.fields.getByName(name);
    }
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return true;
      }
    }
    return false;
  };

  const addFieldIfMissing = (collection, field) => {
    if (hasField(collection, field.name)) {
      return false;
    }
    if (collection.fields && collection.fields.add) {
      collection.fields.add(field);
    } else {
      collection.fields = collection.fields || [];
      collection.fields.push(field);
    }
    return true;
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
    if (hasIndex(collection, name)) {
      return false;
    }
    collection.indexes = collection.indexes || [];
    collection.indexes.push(sql);
    return true;
  };

  let changed = false;
  changed = addFieldIfMissing(scores, new TextField({ name: "device_id", max: 64 })) || changed;
  changed = addFieldIfMissing(scores, new TextField({ name: "handle", max: 40 })) || changed;
  changed = addFieldIfMissing(scores, new NumberField({ name: "day_number", min: 0, onlyInt: true })) || changed;
  changed = addIndexIfMissing(scores, "idx_scores_device_id", "CREATE INDEX IF NOT EXISTS idx_scores_device_id ON scores (device_id)") || changed;
  changed = addIndexIfMissing(scores, "idx_scores_day_number", "CREATE INDEX IF NOT EXISTS idx_scores_day_number ON scores (day_number)") || changed;

  if (changed) {
    app.save(scores);
  }
}, (app) => {
  try {
    const scores = app.findCollectionByNameOrId("scores");
    const removeField = (name) => {
      try {
        if (scores.fields && scores.fields.getByName && scores.fields.removeById) {
          const field = scores.fields.getByName(name);
          if (field) {
            scores.fields.removeById(field.id);
          }
          return;
        }
        scores.fields = (scores.fields || []).filter((field) => field.name !== name);
      } catch {}
    };

    removeField("device_id");
    removeField("handle");
    removeField("day_number");

    try {
      scores.indexes = (scores.indexes || []).filter((index) => {
        const value = String(index);
        return value.indexOf("idx_scores_device_id") === -1 && value.indexOf("idx_scores_day_number") === -1;
      });
    } catch {}

    app.save(scores);
  } catch {}
});
