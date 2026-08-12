/// <reference path="../pb_data/types.d.ts" />
// Add a durable creation timestamp to scenarios so the playwright can load generation
// history in actual creation order. Safe to re-run after a partial failure.
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

  let scenarios;
  try {
    scenarios = app.findCollectionByNameOrId("scenarios");
  } catch {
    // The original game migration owns collection creation.
    return;
  }

  let changed = false;
  changed = addFieldIfMissing(scenarios, new AutodateField({ name: "created", onCreate: true })) || changed;

  if (changed) {
    app.save(scenarios);
  }
}, (app) => {
  // Keep historical timestamps on rollback.
});
