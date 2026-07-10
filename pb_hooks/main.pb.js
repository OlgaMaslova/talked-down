/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/supernaut/ready", function(event) {
  return event.json(200, { ok: true });
});

// actor.pb.js owns the existing turn route. This global middleware runs before
// its handler and closes a replay at the server-side time limit, before any LLM
// work or transcript mutation can happen.
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
    var guard = actorLib.guardReplayTurn(e.app, sessionToken, Date.now());
    if (guard && guard.expired) {
      return e.json(410, { error: "replay_expired" });
    }
    if (guard && guard.paused) {
      return e.json(409, { error: "replay_paused", remaining_ms: guard.remaining_ms });
    }
  } catch (err) {
    console.log("replay_turn_guard_failed: " + err.message);
    return e.json(500, { error: "replay_timing_unavailable" });
  }

  return e.next();
});

// actor.pb.js reconstructs normal turn state explicitly. Preserve replay timing
// fields when that existing handler writes a replay turn so the timing state is
// never dropped from the otherwise normal session record.
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
      device_id: body.device_id,
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
    replay: {
      duration_ms: actorLib.REPLAY_DURATION_MS,
      remaining_ms: actorLib.replayRemainingMs(created.state, Date.now()),
    },
  });
});

routerAdd("POST", "/api/game/replay/pause", function(e) {
  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};
  var sessionToken = String(body.session_token || "");
  var action = String(body.action || "");

  if (!sessionToken) {
    return e.json(404, { error: "session_not_found" });
  }
  if (action !== "pause" && action !== "resume") {
    return e.json(400, { error: "invalid_action" });
  }

  try {
    var result = actorLib.updateReplayPause(e.app, sessionToken, action, Date.now());
    if (result.code === "not_found") {
      return e.json(404, { error: "session_not_found" });
    }
    if (result.code === "not_replay") {
      return e.json(409, { error: "session_not_replay" });
    }
    if (result.code === "expired") {
      return e.json(410, { error: "replay_expired" });
    }
    if (result.code === "not_active") {
      return e.json(409, { error: "session_not_active" });
    }
    return e.json(200, { paused: !!result.paused, remaining_ms: result.remaining_ms });
  } catch (err) {
    console.log("replay_pause_failed: " + err.message);
    return e.json(500, { error: "replay_pause_unavailable" });
  }
});

routerAdd("POST", "/api/game/replay/expire", function(e) {
  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};
  var sessionToken = String(body.session_token || "");

  if (!sessionToken) {
    return e.json(404, { error: "session_not_found" });
  }

  try {
    var result = actorLib.expireReplaySession(e.app, sessionToken, Date.now());
    if (result.code === "not_found") {
      return e.json(404, { error: "session_not_found" });
    }
    if (result.code === "not_replay") {
      return e.json(409, { error: "session_not_replay" });
    }
    if (result.code === "not_active") {
      return e.json(409, { error: "session_not_active" });
    }
    return e.json(200, {
      expired: true,
      elapsed_ms: result.elapsed_ms,
      remaining_ms: 0,
    });
  } catch (err) {
    console.log("replay_expire_failed: " + err.message);
    return e.json(500, { error: "replay_expire_unavailable" });
  }
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
