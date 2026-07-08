/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId("llm_usage");
  } catch {
    collection = new Collection({
      name: "llm_usage",
      type: "base",
    });
  }

  collection.fields = [
    new TextField({ name: "model", required: true, max: 120 }),
    new TextField({ name: "context", max: 120 }),
    new NumberField({ name: "prompt_tokens", min: 0 }),
    new NumberField({ name: "completion_tokens", min: 0 }),
    new NumberField({ name: "total_tokens", min: 0 }),
    new NumberField({ name: "cost_usd", min: 0 }),
    new NumberField({ name: "duration_ms", min: 0 }),
    new SelectField({ name: "status", values: ["ok", "error"], maxSelect: 1 }),
    new TextField({ name: "error", max: 500 }),
    new AutodateField({ name: "created", onCreate: true }),
  ];

  // Only superusers can read; app users never see cost data.
  collection.listRule = null;
  collection.viewRule = null;
  collection.createRule = null;
  collection.updateRule = null;
  collection.deleteRule = null;

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("llm_usage");
  return app.delete(collection);
});
