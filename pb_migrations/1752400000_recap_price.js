/// <reference path="../pb_data/types.d.ts" />
// Adds final-price fields so the daily recap can show the winner's closed price:
// - scores.deal_price: final price of a closed deal (null for no_deal / non-price)
// - recaps.best_price: deal_price of the day's best-scoring record (if any)
// - recaps.currency: scenario currency for formatting best_price
// Safe to re-run: guards every field create with existence checks.
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
      return true;
    }
    return false;
  };

  try {
    const scores = app.findCollectionByNameOrId("scores");
    if (addFieldIfMissing(scores, new NumberField({ name: "deal_price" }))) {
      app.save(scores);
    }
  } catch {}

  try {
    const recaps = app.findCollectionByNameOrId("recaps");
    let changed = addFieldIfMissing(recaps, new NumberField({ name: "best_price" }));
    changed = addFieldIfMissing(recaps, new TextField({ name: "currency", max: 24 })) || changed;
    if (changed) {
      app.save(recaps);
    }
  } catch {}
}, (app) => {
  // Down migration intentionally left as no-op: removing data-bearing fields
  // from live collections is not safe on redeploys.
});
