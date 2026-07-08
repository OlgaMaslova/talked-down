/// <reference path="../../pb_data/types.d.ts" />

function env(name) {
  try {
    if (typeof $os !== "undefined" && $os.getenv) {
      return $os.getenv(name);
    }
  } catch (err) {}
  return "";
}

function parseJSON(value, context) {
  if (value === null || typeof value === "undefined" || value === "") {
    throw new Error(context + ": empty JSON payload");
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(context + ": invalid JSON: " + err.message);
    }
  }
  return value;
}

function responseBodyToString(res) {
  if (!res || typeof res.body === "undefined" || res.body === null) {
    return "";
  }
  if (typeof res.body === "string") {
    return res.body;
  }
  return toString(res.body);
}

// USD per 1M tokens: [input, output, cache_read]. Unknown models log tokens with cost 0.
var PRICING_PER_MTOK = {
  "gpt-4.1": [2.0, 8.0, 0.5],
  "gpt-4.1-mini": [0.4, 1.6, 0.1],
  "gpt-4.1-nano": [0.1, 0.4, 0.025],
  "gpt-4o": [2.5, 10.0, 1.25],
  "gpt-4o-mini": [0.15, 0.6, 0.075],
};

function computeCostUSD(model, promptTokens, completionTokens, cachedTokens) {
  var rates = PRICING_PER_MTOK[model];
  if (!rates) {
    return 0;
  }
  cachedTokens = cachedTokens || 0;
  if (cachedTokens > promptTokens) {
    cachedTokens = promptTokens;
  }
  var uncached = promptTokens - cachedTokens;
  var cacheRate = typeof rates[2] === "number" ? rates[2] : rates[0];
  return (uncached * rates[0] + cachedTokens * cacheRate + completionTokens * rates[1]) / 1000000;
}

function traceUsage(entry) {
  // Best effort: tracing must never break the LLM call path.
  try {
    var collection = $app.findCollectionByNameOrId("llm_usage");
    var record = new Record(collection);
    record.set("model", entry.model || "");
    record.set("context", entry.context || "");
    record.set("prompt_tokens", entry.promptTokens || 0);
    record.set("completion_tokens", entry.completionTokens || 0);
    record.set("cached_tokens", entry.cachedTokens || 0);
    record.set("total_tokens", (entry.promptTokens || 0) + (entry.completionTokens || 0));
    record.set("cost_usd", computeCostUSD(entry.model, entry.promptTokens || 0, entry.completionTokens || 0, entry.cachedTokens || 0));
    record.set("duration_ms", entry.durationMs || 0);
    record.set("status", entry.error ? "error" : "ok");
    record.set("error", entry.error ? String(entry.error).slice(0, 500) : "");
    $app.save(record);
  } catch (err) {
    try {
      console.log("llm_usage_trace_failed: " + err.message);
    } catch (ignored) {}
  }
}

function chatJSON(messages, opts) {
  opts = opts || {};

  var apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OpenAI API key missing: set OPENAI_API_KEY");
  }

  var model = opts.model || env("OPENAI_MODEL") || "gpt-4.1-mini";
  var payload = {
    model: model,
    messages: messages,
    response_format: { type: "json_object" },
  };

  if (typeof opts.temperature !== "undefined" && opts.temperature !== null) {
    payload.temperature = opts.temperature;
  }

  var startedAt = Date.now();
  var res;
  try {
    res = $http.send({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeout: opts.timeout || 30,
    });
  } catch (err) {
    traceUsage({ model: model, context: opts.context, durationMs: Date.now() - startedAt, error: err.message });
    throw new Error("OpenAI request failed: " + err.message);
  }
  var durationMs = Date.now() - startedAt;

  var statusCode = res && (res.statusCode || res.status);
  var rawBody = responseBodyToString(res);
  var parsedBody = res && res.json ? res.json : null;

  if (statusCode < 200 || statusCode >= 300) {
    var detail = rawBody;
    try {
      var errorBody = parsedBody || JSON.parse(rawBody);
      if (errorBody && errorBody.error && errorBody.error.message) {
        detail = errorBody.error.message;
      }
    } catch (err) {}
    traceUsage({ model: model, context: opts.context, durationMs: durationMs, error: "status " + statusCode + ": " + detail });
    throw new Error("OpenAI request failed with status " + statusCode + ": " + detail);
  }

  var data = parsedBody || parseJSON(rawBody, "OpenAI response");
  var usage = data && data.usage ? data.usage : {};
  traceUsage({
    model: (data && data.model) || model,
    context: opts.context,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    cachedTokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
    durationMs: durationMs,
  });
  if (!data.choices || !data.choices.length || !data.choices[0].message) {
    throw new Error("OpenAI response missing choices[0].message");
  }

  var content = data.choices[0].message.content;
  if (typeof content !== "string" || content === "") {
    throw new Error("OpenAI response message content is empty");
  }

  return parseJSON(content, "OpenAI message content");
}

module.exports = {
  chatJSON: chatJSON,
};
