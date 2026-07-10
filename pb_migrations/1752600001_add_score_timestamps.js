/// <reference path="../pb_data/types.d.ts" />
// Add durable creation/update timestamps to scores for replay cooldown enforcement.
// This is safe to re-run after an interrupted migration and preserves all
// existing score fields, rules, and indexes.
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

  const addFieldIfMissing = (collection, field) => {
    if (fieldByName(collection, field.name)) {
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

  let scores;
  try {
    scores = app.findCollectionByNameOrId("scores");
  } catch {
    // The original game migration owns score collection creation. Do not
    // create an incomplete collection if it is unexpectedly unavailable.
    return;
  }

  let changed = false;
  changed = addFieldIfMissing(scores, new AutodateField({ name: "created", onCreate: true })) || changed;
  changed = addFieldIfMissing(scores, new AutodateField({ name: "updated", onCreate: true, onUpdate: true })) || changed;

  if (changed) {
    app.save(scores);
  }
}, (app) => {
  // Keep historical score timestamps on rollback.
});
