/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/supernaut/ready", function(event) {
  return event.json(200, { ok: true });
});

// actor.pb.js owns session/start. Intercept its already-played response so the
// client gets the same server-calculated cooldown used by replay/start. Archive
// starts are intentionally left to actor.pb.js unchanged.
routerUse(function(e) {
  if (String(e.request.method || "").toUpperCase() !== "POST" || String(e.request.url.path || "") !== "/api/game/session/start") {
    return e.next();
  }

  var body = e.requestInfo().body || {};
  if (typeof body.day_number !== "undefined" && body.day_number !== null && String(body.day_number) !== "") {
    return e.next();
  }

  var deviceId = String(body.device_id || "").slice(0, 64);
  if (!deviceId) {
    return e.next();
  }

  var actorLib = require(__hooks + "/lib/actor.js");
  // Keep actor.pb.js's no-scenario/no-secret behavior intact before returning
  // an already-played payload from this middleware.
  var scenario = actorLib.findTodaysScenario(e.app);
  if (!scenario) {
    return e.next();
  }
  try {
    actorLib.findSecretForScenario(e.app, scenario.id);
  } catch (err) {
    return e.next();
  }

  var score = actorLib.findTodaysScoreForDevice(e.app, deviceId);
  if (!score) {
    return e.next();
  }

  return e.json(200, {
    llm: true,
    already_played: true,
    replay_available_at_ms: actorLib.replayAvailableAtMs(e.app, score, deviceId, Date.now()),
    result: {
      score: score.getInt("score"),
      result_label: score.getString("result_label"),
      outcome: score.getString("outcome"),
      turns: score.getInt("turns"),
      percentile: score.getInt("percentile"),
      day_number: score.getInt("day_number") || actorLib.currentDayNumber(),
      streak: actorLib.computeStreakForDevice(e.app, deviceId),
    },
  });
});

// actor.pb.js owns the existing turn route. Current replay sessions are
// cooldown-gated and unranked, not timed. The guard only recognizes historical
// expired records; it never adds a deadline or pause behavior to new replays.
routerUse(function(e) {
  if (String(e.request.method || "").toUpperCase() !== "POST" || String(e.request.url.path || "") !== "/api/game/session/turn") {
    return e.next();
  }

  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};
  var sessionToken = String(body.session_token || "");
  if (!sessionToken) {
    return e.next();
  }

  try {
    var guard = actorLib.guardReplayTurn(e.app, sessionToken);
    if (guard && guard.expired) {
      return e.json(410, { error: "replay_expired" });
    }
  } catch (err) {
    console.log("replay_turn_guard_failed: " + err.message);
    return e.json(500, { error: "replay_guard_unavailable" });
  }

  return e.next();
});

// actor.pb.js reconstructs normal turn state explicitly. Preserve the replay
// marker when that handler writes a replay turn, keeping it unranked without
// carrying any timer or pause fields.
onRecordUpdate(function(e) {
  var actorLib = require(__hooks + "/lib/actor.js");
  try {
    actorLib.preserveReplayStateOnSessionUpdate(e.app, e.record);
  } catch (err) {
    console.log("replay_state_preserve_failed: " + err.message);
  }
  return e.next();
}, "sessions");

routerAdd("POST", "/api/game/replay/start", function(e) {
  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};
  var deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!deviceId || deviceId.length > 64) {
    return e.json(400, { error: "device_id_required" });
  }

  var dailyScore = actorLib.findTodaysScoreForDevice(e.app, deviceId);
  if (!dailyScore) {
    return e.json(403, { error: "replay_not_eligible" });
  }

  var replayAvailableAtMs = actorLib.replayAvailableAtMs(e.app, dailyScore, deviceId, Date.now());
  if (Date.now() < replayAvailableAtMs) {
    return e.json(429, {
      error: "replay_cooldown",
      replay_available_at_ms: replayAvailableAtMs,
    });
  }

  var scenario = actorLib.findTodaysScenario(e.app);
  if (!scenario) {
    return e.json(200, { llm: false });
  }

  var secretRecord;
  try {
    secretRecord = actorLib.findSecretForScenario(e.app, scenario.id);
  } catch (err) {
    return e.json(200, { llm: false });
  }

  var spec = actorLib.getJSONField(secretRecord, "secret_spec", {});
  var created;
  try {
    created = actorLib.newReplaySessionRecord(e.app, scenario, spec, {
      device_id: deviceId,
      handle: body.handle,
    });
  } catch (err) {
    console.log("replay_start_failed: " + err.message);
    return e.json(500, { error: "replay_start_unavailable" });
  }

  return e.json(200, {
    llm: true,
    session_token: created.token,
    scenario: actorLib.publicScenarioPayload(scenario, spec, created.state),
    replay: { unranked: true },
  });
});

routerAdd("GET", "/api/game/percentile", function(event) {
  var query = event.request.url.query();
  var dayNumberParam = query.get("day_number");
  var scoreParam = query.get("score");

  if (dayNumberParam === "" || dayNumberParam === null || typeof dayNumberParam === "undefined") {
    return event.json(400, { error: "day_number_required" });
  }
  if (scoreParam === "" || scoreParam === null || typeof scoreParam === "undefined") {
    return event.json(400, { error: "score_required" });
  }
  if (!/^-?\d+$/.test(dayNumberParam)) {
    return event.json(400, { error: "day_number_must_be_int" });
  }
  if (!/^-?\d+$/.test(scoreParam)) {
    return event.json(400, { error: "score_must_be_int" });
  }

  var dayNumber = parseInt(dayNumberParam, 10);
  var score = parseInt(scoreParam, 10);

  try {
    var records = event.app.findRecordsByFilter(
      "scores",
      "day_number = {:day_number} && archive = false",
      "",
      0,
      0,
      { day_number: dayNumber }
    );

    var count = records.length;
    var beaten = 0;
    var tied = 0;
    for (var i = 0; i < records.length; i++) {
      var recordScore = records[i].getInt("score");
      if (recordScore < score) {
        beaten++;
      } else if (recordScore === score) {
        tied++;
      }
    }

    var percentile = count > 0 ? Math.round(((beaten + 0.5 * tied) / count) * 100) : 100;
    return event.json(200, { day_number: dayNumber, score: score, plays: count, percentile: percentile });
  } catch (err) {
    return event.json(200, { day_number: dayNumber, score: score, plays: 0, percentile: 100 });
  }
});
