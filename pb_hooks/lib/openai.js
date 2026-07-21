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

function decodeBase64(value) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var clean = String(value || "").replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (!clean || clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean)) {
    throw new Error("invalid base64 image payload");
  }

  var bytes = [];
  for (var i = 0; i < clean.length; i += 4) {
    var c1 = alphabet.indexOf(clean.charAt(i));
    var c2 = alphabet.indexOf(clean.charAt(i + 1));
    var third = clean.charAt(i + 2);
    var fourth = clean.charAt(i + 3);
    var c3 = third === "=" || third === "" ? 0 : alphabet.indexOf(third);
    var c4 = fourth === "=" || fourth === "" ? 0 : alphabet.indexOf(fourth);
    if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) {
      throw new Error("invalid base64 image payload");
    }

    bytes.push((c1 << 2) | (c2 >> 4));
    if (third !== "=" && third !== "") {
      bytes.push(((c2 & 15) << 4) | (c3 >> 2));
    }
    if (fourth !== "=" && fourth !== "") {
      bytes.push(((c3 & 3) << 6) | c4);
    }
  }
  return bytes;
}

function imageRequestPayload(prompt, opts) {
  opts = opts || {};
  return {
    model: opts.model || env("OPENAI_IMAGE_MODEL") || "gpt-image-1-mini",
    prompt: String(prompt || ""),
    n: 1,
    size: opts.size || "1024x1024",
    quality: opts.quality || "low",
    output_format: opts.outputFormat || "jpeg",
    output_compression: typeof opts.outputCompression === "number" ? opts.outputCompression : 70,
    background: "opaque",
  };
}

function imageExtension(outputFormat) {
  if (outputFormat === "jpeg") {
    return "jpg";
  }
  if (outputFormat === "webp") {
    return "webp";
  }
  return "png";
}

function imageMimeType(outputFormat) {
  if (outputFormat === "jpeg") {
    return "image/jpeg";
  }
  if (outputFormat === "webp") {
    return "image/webp";
  }
  return "image/png";
}

// USD per 1M tokens: [input, output, cache_read]. Unknown models log tokens with cost 0.
var PRICING_PER_MTOK = {
  "gpt-4.1": [2.0, 8.0, 0.5],
  "gpt-4.1-mini": [0.4, 1.6, 0.1],
  "gpt-4.1-nano": [0.1, 0.4, 0.025],
  "gpt-4o": [2.5, 10.0, 1.25],
  "gpt-4o-mini": [0.15, 0.6, 0.075],
};

function resolveRates(model) {
  if (!model) {
    return null;
  }
  if (PRICING_PER_MTOK[model]) {
    return PRICING_PER_MTOK[model];
  }
  // OpenAI responses return versioned names like "gpt-4.1-mini-2025-04-14";
  // match the longest known prefix so those still price correctly.
  var bestKey = null;
  for (var key in PRICING_PER_MTOK) {
    if (model.indexOf(key + "-") === 0 && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? PRICING_PER_MTOK[bestKey] : null;
}

function computeCostUSD(model, promptTokens, completionTokens, cachedTokens) {
  var rates = resolveRates(model);
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

function generateImage(prompt, opts) {
  opts = opts || {};
  prompt = String(prompt || "").replace(/^\s+|\s+$/g, "");
  if (!prompt) {
    throw new Error("OpenAI image prompt is empty");
  }

  var apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OpenAI API key missing: set OPENAI_API_KEY");
  }

  var payload = imageRequestPayload(prompt, opts);
  var startedAt = Date.now();
  var res;
  try {
    res = $http.send({
      url: "https://api.openai.com/v1/images/generations",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeout: opts.timeout || 120,
    });
  } catch (err) {
    traceUsage({ model: payload.model, context: opts.context || "actor_portrait", durationMs: Date.now() - startedAt, error: err.message });
    throw new Error("OpenAI image request failed: " + err.message);
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
    } catch (errStatus) {}
    traceUsage({ model: payload.model, context: opts.context || "actor_portrait", durationMs: durationMs, error: "status " + statusCode + ": " + detail });
    throw new Error("OpenAI image request failed with status " + statusCode + ": " + detail);
  }

  var data = parsedBody || parseJSON(rawBody, "OpenAI image response");
  var usage = data && data.usage ? data.usage : {};
  traceUsage({
    model: payload.model,
    context: opts.context || "actor_portrait",
    promptTokens: usage.input_tokens || 0,
    completionTokens: usage.output_tokens || 0,
    durationMs: durationMs,
  });
  if (!data.data || !data.data.length || !data.data[0].b64_json) {
    throw new Error("OpenAI image response missing data[0].b64_json");
  }

  var outputFormat = data.output_format || payload.output_format;
  return {
    bytes: decodeBase64(data.data[0].b64_json),
    filename: opts.filename || ("actor-portrait." + imageExtension(outputFormat)),
    mimeType: imageMimeType(outputFormat),
  };
}

module.exports = {
  chatJSON: chatJSON,
  generateImage: generateImage,
  _test: {
    decodeBase64: decodeBase64,
    imageRequestPayload: imageRequestPayload,
  },
};
