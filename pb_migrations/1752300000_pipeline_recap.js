/// <reference path="../pb_data/types.d.ts" />
// Adds nightly pipeline observability collections:
// - recaps: public-readable daily recap of the prior day's plays (no hidden data)
// - pipeline_runs: locked log of every nightly generate/test/publish/recap run
// Safe to re-run: guards every collection and field create with existence checks.
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

  // --- recaps (public read; written only by server hooks) ---
  let recaps;
  try {
    recaps = app.findCollectionByNameOrId("recaps");
  } catch {
    recaps = new Collection({ name: "recaps", type: "base" });
    recaps.fields = [];
    recaps.indexes = [];
  }
  addFieldIfMissing(recaps, new TextField({ name: "recap_date", max: 10 }));
  addFieldIfMissing(recaps, new NumberField({ name: "day_number", onlyInt: true }));
  addFieldIfMissing(recaps, new NumberField({ name: "plays", onlyInt: true }));
  addFieldIfMissing(recaps, new NumberField({ name: "deals", onlyInt: true }));
  addFieldIfMissing(recaps, new NumberField({ name: "no_deals", onlyInt: true }));
  addFieldIfMissing(recaps, new NumberField({ name: "avg_score" }));
  addFieldIfMissing(recaps, new NumberField({ name: "best_score", onlyInt: true }));
  addFieldIfMissing(recaps, new TextField({ name: "best_handle", max: 40 }));
  addFieldIfMissing(recaps, new TextField({ name: "scenario_title", max: 160 }));
  recaps.listRule = "";
  recaps.viewRule = "";
  recaps.createRule = null;
  recaps.updateRule = null;
  recaps.deleteRule = null;
  recaps.indexes = recaps.indexes || [];
  if (!recaps.indexes.some((i) => String(i).indexOf("idx_recaps_date") !== -1)) {
    recaps.indexes.push("CREATE UNIQUE INDEX IF NOT EXISTS idx_recaps_date ON recaps (recap_date)");
  }
  app.save(recaps);

  // --- pipeline_runs (superuser/hooks only) ---
  let runs;
  try {
    runs = app.findCollectionByNameOrId("pipeline_runs");
  } catch {
    runs = new Collection({ name: "pipeline_runs", type: "base" });
    runs.fields = [];
    runs.indexes = [];
  }
  addFieldIfMissing(runs, new TextField({ name: "run_date", max: 10 }));
  addFieldIfMissing(runs, new TextField({ name: "target_date", max: 10 }));
  addFieldIfMissing(runs, new TextField({ name: "source", max: 16 }));
  addFieldIfMissing(runs, new SelectField({
    name: "status",
    maxSelect: 1,
    values: ["published", "skipped", "failed", "error"],
  }));
  addFieldIfMissing(runs, new JSONField({ name: "result", maxSize: 50000 }));
  addFieldIfMissing(runs, new JSONField({ name: "recap", maxSize: 50000 }));
  runs.listRule = null;
  runs.viewRule = null;
  runs.createRule = null;
  runs.updateRule = null;
  runs.deleteRule = null;
  app.save(runs);
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("pipeline_runs"));
  } catch {}
  try {
    app.delete(app.findCollectionByNameOrId("recaps"));
  } catch {}
});
