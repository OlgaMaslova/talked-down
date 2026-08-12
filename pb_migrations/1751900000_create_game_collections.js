/// <reference path="../pb_data/types.d.ts" />
// Creates the 'scenarios' and 'scores' collections for the daily negotiation game.
// Safe to re-run: guards every create with an existence check.
migrate((app) => {
  // --- scenarios ---
  let scenarios;
  try {
    scenarios = app.findCollectionByNameOrId("scenarios");
  } catch {
    scenarios = new Collection({
      name: "scenarios",
      type: "base",
    });
  }

  scenarios.fields = [
    new NumberField({ name: "day_index", min: 0, onlyInt: true }),
    new TextField({ name: "title", required: true, max: 160 }),
    new TextField({ name: "character_name", required: true, max: 80 }),
    new TextField({ name: "character_persona", max: 500 }),
    new TextField({ name: "opening_message", required: true, max: 1000 }),
    new JSONField({ name: "engine_config", maxSize: 20000 }),
    new JSONField({ name: "scoring_config", maxSize: 5000 }),
  ];

  // Public read (game loads today's scenario without auth). No public writes.
  scenarios.listRule = "";
  scenarios.viewRule = "";
  scenarios.createRule = null;
  scenarios.updateRule = null;
  scenarios.deleteRule = null;

  scenarios.indexes = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_day_index ON scenarios (day_index)",
  ];

  app.save(scenarios);

  // --- scores ---
  let scores;
  try {
    scores = app.findCollectionByNameOrId("scores");
  } catch {
    scores = new Collection({
      name: "scores",
      type: "base",
    });
  }

  scores.fields = [
    new NumberField({ name: "day_index", min: 0, onlyInt: true }),
    new NumberField({ name: "score", min: 0, onlyInt: true }),
    new NumberField({ name: "turns", min: 0, onlyInt: true }),
    new TextField({ name: "result_label", max: 80 }),
  ];

  // Anonymous players can submit and read aggregate scores.
  scores.listRule = "";
  scores.viewRule = "";
  scores.createRule = "";
  scores.updateRule = null;
  scores.deleteRule = null;

  scores.indexes = [
    "CREATE INDEX IF NOT EXISTS idx_scores_day_index ON scores (day_index)",
  ];

  app.save(scores);
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("scores"));
  } catch {}
  try {
    app.delete(app.findCollectionByNameOrId("scenarios"));
  } catch {}
});
