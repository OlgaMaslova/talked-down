/// <reference path="../pb_data/types.d.ts" />

// Backfill cost_usd for llm_usage rows recorded with cost 0 because the
// OpenAI response's versioned model name did not match the pricing table.
migrate((app) => {
  var PRICING_PER_MTOK = {
    "gpt-4.1": [2.0, 8.0, 0.5],
    "gpt-4.1-mini": [0.4, 1.6, 0.1],
    "gpt-4.1-nano": [0.1, 0.4, 0.025],
    "gpt-4o": [2.5, 10.0, 1.25],
    "gpt-4o-mini": [0.15, 0.6, 0.075],
  };

  function resolveRates(model) {
    if (!model) return null;
    if (PRICING_PER_MTOK[model]) return PRICING_PER_MTOK[model];
    var bestKey = null;
    for (var key in PRICING_PER_MTOK) {
      if (model.indexOf(key + "-") === 0 && (!bestKey || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
    return bestKey ? PRICING_PER_MTOK[bestKey] : null;
  }

  var collection;
  try {
    collection = app.findCollectionByNameOrId("llm_usage");
  } catch (err) {
    return; // collection missing; nothing to backfill
  }
  if (!collection) return;

  var records = app.findRecordsByFilter("llm_usage", "cost_usd = 0 && prompt_tokens > 0", "", 0, 0);
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    var rates = resolveRates(record.getString("model"));
    if (!rates) continue;
    var promptTokens = record.getInt("prompt_tokens");
    var completionTokens = record.getInt("completion_tokens");
    var cachedTokens = record.getInt("cached_tokens");
    if (cachedTokens > promptTokens) cachedTokens = promptTokens;
    var uncached = promptTokens - cachedTokens;
    var cacheRate = typeof rates[2] === "number" ? rates[2] : rates[0];
    var cost = (uncached * rates[0] + cachedTokens * cacheRate + completionTokens * rates[1]) / 1000000;
    if (cost > 0) {
      record.set("cost_usd", cost);
      app.save(record);
    }
  }
}, (app) => {
  // no-op: recomputed costs are not reverted
});
