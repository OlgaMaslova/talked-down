/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/claim/start", (e) => {
  function jsonError(status, code) {
    return e.json(status, { error: code });
  }
  function logIncident(app, session, type, details) {
    try {
      var collection = app.findCollectionByNameOrId("incidents");
      var record = new Record(collection);
      record.set("session", String(session || "").slice(0, 64));
      record.set("type", String(type || "unknown").slice(0, 64));
      record.set("details", JSON.stringify(details || {}));
      app.save(record);
    } catch (err) {
      try { console.log("incident_log_failed: " + err.message); } catch (ignored) {}
    }
  }
  function esc(text) {
    return String(text || "").replace(/[&<>\"]/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch];
    });
  }

  var body = e.requestInfo().body || {};
  var deviceId = String(body.device_id || "").trim().slice(0, 64);
  var handle = String(body.handle || "").trim().slice(0, 40);
  var email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  if (!deviceId || !handle) {
    return jsonError(400, "invalid_request");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError(400, "invalid_email");
  }

  var now = new Date();
  var twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString().replace("T", " ");
  try {
    var recent = e.app.findRecordsByFilter(
      "claims",
      "status = 'pending' && created >= {:since} && (device_id = {:device_id} || email = {:email})",
      "-created",
      1,
      0,
      { since: twoMinutesAgo, device_id: deviceId, email: email }
    );
    if (recent.length > 0) {
      return jsonError(429, "rate_limited");
    }
    var dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().replace("T", " ");
    var todays = e.app.findRecordsByFilter(
      "claims",
      "device_id = {:device_id} && created >= {:since}",
      "",
      6,
      0,
      { device_id: deviceId, since: dayStart }
    );
    if (todays.length >= 5) {
      return jsonError(429, "rate_limited");
    }
  } catch (err) {
    console.log("claim_rate_limit_failed: " + err.message);
    return jsonError(500, "claim_unavailable");
  }

  var apiKey = "";
  try { apiKey = String($os.getenv("AGENTMAIL_API_KEY") || ""); } catch (err) {}
  if (!apiKey) {
    return jsonError(503, "email_unavailable");
  }

  var token = $security.randomString(48);
  var tokenHash = $security.sha256(token);
  var expires = new Date(now.getTime() + 30 * 60 * 1000).toISOString().replace("T", " ");
  var collection = e.app.findCollectionByNameOrId("claims");
  var record = new Record(collection);
  record.set("device_id", deviceId);
  record.set("handle", handle);
  record.set("email", email);
  record.set("token_hash", tokenHash);
  record.set("expires", expires);
  record.set("status", "pending");
  try {
    e.app.save(record);
  } catch (err) {
    console.log("claim_create_failed: " + err.message);
    return jsonError(500, "claim_unavailable");
  }

  var link = "https://talkeddown.com/?claim_token=" + encodeURIComponent(token);
  var payload = {
    to: [email],
    subject: "Claim your Talked Down handle",
    text: "Claim the Talked Down handle \"" + handle + "\" by opening this link within 30 minutes:\n\n" + link,
    html: "<p>Claim the Talked Down handle <strong>" + esc(handle) + "</strong> by opening this link within 30 minutes:</p><p><a href=\"" + esc(link) + "\">Claim your handle</a></p>",
  };

  var res;
  try {
    res = $http.send({
      url: "https://api.agentmail.to/v0/inboxes/agent@talked-down.supernaut.to/messages/send",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeout: 15,
    });
  } catch (err) {
    console.log("email_send_failed: " + err.message);
    logIncident(e.app, deviceId, "email_send_failed", { error: err.message, email: email, claim_id: record.id });
    return jsonError(502, "email_send_failed");
  }
  var statusCode = res && (res.statusCode || res.status);
  if (statusCode < 200 || statusCode >= 300) {
    var responseBody = "";
    try { responseBody = String(res.body || "").slice(0, 500); } catch (ignored) {}
    console.log("email_send_failed_status: " + statusCode + " " + responseBody);
    logIncident(e.app, deviceId, "email_send_failed", { status: statusCode, body: responseBody, email: email, claim_id: record.id });
    return jsonError(502, "email_send_failed");
  }

  return e.json(200, { ok: true });
});

routerAdd("POST", "/api/claim/verify", (e) => {
  function logIncident(app, session, type, details) {
    try {
      var collection = app.findCollectionByNameOrId("incidents");
      var record = new Record(collection);
      record.set("session", String(session || "").slice(0, 64));
      record.set("type", String(type || "unknown").slice(0, 64));
      record.set("details", JSON.stringify(details || {}));
      app.save(record);
    } catch (err) {
      try { console.log("incident_log_failed: " + err.message); } catch (ignored) {}
    }
  }

  var body = e.requestInfo().body || {};
  var token = String(body.token || "");
  var deviceId = String(body.device_id || "").trim().slice(0, 64);
  if (!token || !deviceId) {
    return e.json(400, { error: "invalid_or_expired" });
  }
  var tokenHash = $security.sha256(token);
  var now = new Date().toISOString().replace("T", " ");
  var record;
  try {
    record = e.app.findFirstRecordByFilter(
      "claims",
      "token_hash = {:token_hash}",
      { token_hash: tokenHash }
    );
  } catch (err) {
    logIncident(e.app, deviceId, "claim_verify_failed", { reason: "not_found" });
    return e.json(400, { error: "invalid_or_expired" });
  }

  var status = record.getString("status");
  // Idempotent: re-opening an already-consumed link on the same device stays a success.
  if (status === "claimed") {
    if (record.getString("device_id") === deviceId) {
      return e.json(200, { ok: true, handle: record.getString("handle"), email: record.getString("email"), device_id: record.getString("device_id") });
    }
    logIncident(e.app, deviceId, "claim_verify_failed", { reason: "already_claimed", claim_id: record.id });
    return e.json(400, { error: "invalid_or_expired" });
  }
  if (status !== "pending" || record.getString("expires").replace("T", " ") < now) {
    logIncident(e.app, deviceId, "claim_verify_failed", { reason: status !== "pending" ? "bad_status:" + status : "expired", claim_id: record.id });
    return e.json(400, { error: "invalid_or_expired" });
  }

  record.set("status", "claimed");
  record.set("claimed_at", now);
  e.app.save(record);
  return e.json(200, { ok: true, handle: record.getString("handle"), email: record.getString("email"), device_id: record.getString("device_id") });
});

routerAdd("GET", "/api/game/leaderboard", (e) => {
  var query = e.request.url.query();
  var scope = String(query.get("scope") || "all");
  if (scope !== "all" && scope !== "day") {
    return e.json(400, { error: "invalid_scope" });
  }
  var dayNumber = null;
  if (scope === "day") {
    var raw = query.get("day_number");
    if (raw === "" || raw === null || typeof raw === "undefined" || !/^-?\d+$/.test(String(raw))) {
      return e.json(400, { error: "day_number_required" });
    }
    dayNumber = parseInt(raw, 10);
  }

  var models = arrayOf(new DynamicModel({ handle: "", claimed: 0, best_score: 0, plays: 0 }));
  var sql = "SELECT COALESCE(NULLIF(c.handle, ''), " +
    "(SELECT s2.handle FROM scores s2 WHERE s2.device_id = s.device_id AND s2.handle != '' ORDER BY s2.created DESC LIMIT 1), " +
    "'Anonymous') AS handle, " +
    "CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS claimed, " +
    "MAX(s.score) AS best_score, COUNT(s.id) AS plays " +
    "FROM scores s LEFT JOIN claims c ON c.id = (SELECT c2.id FROM claims c2 WHERE c2.device_id = s.device_id AND c2.status = 'claimed' ORDER BY c2.claimed_at DESC LIMIT 1) " +
    "WHERE s.device_id != ''";
  var params = {};
  if (scope === "day") {
    sql += " AND s.day_number = {:day_number}";
    params.day_number = dayNumber;
  }
  sql += " GROUP BY s.device_id ORDER BY best_score DESC, plays ASC, handle ASC LIMIT 20";
  try {
    var q = e.app.db().newQuery(sql);
    if (scope === "day") {
      q.bind(params);
    }
    q.all(models);
  } catch (err) {
    console.log("leaderboard_failed: " + err.message);
    return e.json(500, { error: "leaderboard_unavailable" });
  }
  var entries = [];
  for (var i = 0; i < models.length; i++) {
    entries.push({ handle: String(models[i].handle || ""), claimed: Number(models[i].claimed || 0) === 1, best_score: Number(models[i].best_score || 0), plays: Number(models[i].plays || 0) });
  }
  return e.json(200, { scope: scope, entries: entries });
});

routerAdd("GET", "/api/claim/status", (e) => {
  var query = e.request.url.query();
  var deviceId = String(query.get("device_id") || "").trim().slice(0, 64);
  if (!deviceId) {
    return e.json(400, { error: "invalid_request" });
  }
  try {
    var record = e.app.findFirstRecordByFilter(
      "claims",
      "device_id = {:device_id} && status = 'claimed'",
      { device_id: deviceId }
    );
    return e.json(200, { claimed: true, handle: record.getString("handle"), email: record.getString("email") });
  } catch (err) {
    return e.json(200, { claimed: false });
  }
});
