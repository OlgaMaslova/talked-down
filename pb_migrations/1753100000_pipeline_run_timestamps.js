/// <reference path="../pb_data/types.d.ts" />
// Adds a durable timestamp to pipeline run records. The status endpoint sorts
// by this field, avoiding the missing `created` field on legacy records.
// Safe to re-run after an interrupted migration.
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

  let runs;
  try {
    runs = app.findCollectionByNameOrId("pipeline_runs");
  } catch {
    // The original migration owns collection creation; never create a partial
    // replacement if it is unavailable.
    return;
  }

  let changed = false;
  if (!fieldByName(runs, "created")) {
    if (runs.fields && runs.fields.add) {
      runs.fields.add(new AutodateField({ name: "created", onCreate: true }));
    } else {
      runs.fields = runs.fields || [];
      runs.fields.push(new AutodateField({ name: "created", onCreate: true }));
    }
    changed = true;
  }

  runs.indexes = runs.indexes || [];
  if (!runs.indexes.some((index) => String(index).indexOf("idx_pipeline_runs_created") !== -1)) {
    runs.indexes.push("CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created ON pipeline_runs (created)");
    changed = true;
  }

  if (changed) {
    app.save(runs);
  }
}, (app) => {
  // Preserve timestamp history on rollback.
});
