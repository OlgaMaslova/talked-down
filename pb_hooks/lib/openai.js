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
    throw new Error("OpenAI request failed: " + err.message);
  }

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
    throw new Error("OpenAI request failed with status " + statusCode + ": " + detail);
  }

  var data = parsedBody || parseJSON(rawBody, "OpenAI response");
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
