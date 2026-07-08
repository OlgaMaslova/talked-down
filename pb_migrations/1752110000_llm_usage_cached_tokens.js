/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("llm_usage");
  if (!collection.fields.getByName("cached_tokens")) {
    collection.fields.add(new NumberField({ name: "cached_tokens", min: 0 }));
  }
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("llm_usage");
  const field = collection.fields.getByName("cached_tokens");
  if (field) {
    collection.fields.removeById(field.id);
  }
  return app.save(collection);
});
