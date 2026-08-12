/// <reference path="../pb_data/types.d.ts" />
// Adds one optional public actor portrait to scenarios.
// No data backfill: future nightly generations attach their portrait before publish.
migrate((app) => {
  let scenarios;
  try {
    scenarios = app.findCollectionByNameOrId("scenarios");
  } catch {
    // A partial/atypical install without the base collection must still boot.
    return;
  }

  let existing = null;
  try {
    existing = scenarios.fields.getByName("actor_portrait");
  } catch {}
  if (existing) {
    return;
  }

  scenarios.fields.add(new FileField({
    name: "actor_portrait",
    required: false,
    protected: false,
    maxSelect: 1,
    maxSize: 5 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp"],
  }));
  return app.save(scenarios);
}, (app) => {
  let scenarios;
  try {
    scenarios = app.findCollectionByNameOrId("scenarios");
  } catch {
    return;
  }

  let field = null;
  try {
    field = scenarios.fields.getByName("actor_portrait");
  } catch {}
  if (!field) {
    return;
  }

  scenarios.fields.removeById(field.id);
  return app.save(scenarios);
});
