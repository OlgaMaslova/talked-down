/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/game/session/start", (e) => {
  var actorLib = require(__hooks + "/lib/actor.js");
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
  var startBody = e.requestInfo().body || {};
  var deviceId = String(startBody.device_id || "").slice(0, 64);
  if (deviceId) {
    var sc = actorLib.findTodaysScoreForDevice(e.app, deviceId);
    if (sc) {
      return e.json(200, {
        llm: true,
        already_played: true,
        result: {
          score: sc.getInt("score"),
          result_label: sc.getString("result_label"),
          outcome: sc.getString("outcome"),
          turns: sc.getInt("turns"),
          percentile: sc.getInt("percentile"),
          day_number: sc.getInt("day_number") || actorLib.currentDayNumber(),
          streak: actorLib.computeStreakForDevice(e.app, deviceId),
        },
      });
    }
  }
  var created = actorLib.newSessionRecord(e.app, scenario, spec, {
    device_id: startBody.device_id,
    handle: startBody.handle,
  });
  return e.json(200, {
    llm: true,
    session_token: created.token,
    scenario: actorLib.publicScenarioPayload(scenario, spec, created.state),
  });
});

routerAdd("POST", "/api/game/session/turn", (e) => {
  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};
  var token = String(body.session_token || "");
  var playerMessage = String(body.message || "");

  if (!token) {
    return e.json(404, { error: "session_not_found" });
  }
  if (!playerMessage) {
    return e.json(400, { error: "message_required" });
  }
  if (playerMessage.length > actorLib.MAX_MESSAGE_CHARS) {
    // House rule: messages are capped. Enforced server-side so the cap
    // cannot be bypassed by skipping the UI.
    return e.json(400, {
      error: "message_too_long",
      max_message_chars: actorLib.MAX_MESSAGE_CHARS,
    });
  }

  var session;
  try {
    session = e.app.findFirstRecordByData("sessions", "token", token);
  } catch (err) {
    return e.json(404, { error: "session_not_found" });
  }

  if (session.getString("status") !== "active") {
    return e.json(409, { error: "session_not_active" });
  }

  var scenario = e.app.findRecordById("scenarios", session.getString("scenario"));
  var secretRecord = actorLib.findSecretForScenario(e.app, scenario.id);
  var spec = actorLib.getJSONField(secretRecord, "secret_spec", {});
  var state = actorLib.getJSONField(session, "state", {});
  var transcript = actorLib.getJSONField(session, "transcript", []);
  if (!Array.isArray(transcript)) {
    transcript = [];
  }

  var maxTurns = actorLib.intOrDefault(spec.max_turns, 10);
  var currentTurns = actorLib.intOrDefault(state.turns, 0);

  var actor;
  try {
    actor = actorLib.cleanActorResult(actorLib.chatJSON(
      actorLib.buildActorMessages(scenario, spec, state, transcript, playerMessage),
      { temperature: 0.7, context: "actor_turn" }
    ));
  } catch (err) {
    console.log("actor_unavailable: " + err.message);
    actorLib.logIncident(e.app, token, "actor_unavailable", { error: err.message, turn: currentTurns });
    return e.json(200, {
      message: actorLib.scriptedFallbackLine(token, currentTurns),
      done: false,
      state: actorLib.responseState(state),
    });
  }

  var nextTurns = currentTurns + 1;
  var nextPatience = actorLib.intOrDefault(state.patience, actorLib.intOrDefault(spec.patience, 10)) + actor.patience_delta;
  var action = actor.action;
  var accepted = false;

  var isNonPrice = spec.frame === "non_price";

  // pending_offer: the offer currently on the table, recorded server-side.
  // A number for price frames, the string "terms" for non-price frames.
  // (Reads legacy pending_confirmation for sessions started before this change.)
  var pendingOffer = typeof state.pending_offer !== "undefined" ? state.pending_offer : state.pending_confirmation;
  if (typeof pendingOffer !== "string") {
    pendingOffer = actorLib.numberOrNull(pendingOffer);
  }

  // A new number from the player is a counter: whatever was on the table is
  // superseded before we evaluate the actor's move.
  var playerNumbers = actorLib.numbersInText(playerMessage);
  if (playerNumbers.length && actorLib.numberOrNull(pendingOffer) !== null && playerNumbers.indexOf(actorLib.numberOrNull(pendingOffer)) === -1) {
    pendingOffer = null;
  }

  if (action === "propose") {
    // First-class proposal: the actor puts a deal on the table. Nothing
    // closes this turn; the server records exactly what is pending.
    pendingOffer = isNonPrice ? "terms" : actorLib.numberOrNull(actor.offer);
  } else if (action === "accept" && isNonPrice) {
    // Non-price scenario: close only when terms were on the table (recorded
    // proposal, or the actor's previous message ended with a question).
    var lastActorMessage = "";
    for (var ti = transcript.length - 1; ti >= 0; ti--) {
      if (transcript[ti] && transcript[ti].role === "actor") {
        lastActorMessage = String(transcript[ti].message || "");
        break;
      }
    }
    var actorJustAsked = /\?\s*$/.test(lastActorMessage);
    if (pendingOffer === "terms" || actorJustAsked) {
      accepted = true;
    } else {
      // Nothing was on the table: demote the close to a proposal.
      action = "propose";
      pendingOffer = "terms";
    }
  } else if (action === "accept") {
    var floorOk = actorLib.dealRespectsFloor(spec, actor.offer);
    var playerAgreed =
      actorLib.playerStatedPrice(transcript, playerMessage, actor.offer) ||
      (actorLib.numberOrNull(pendingOffer) !== null &&
        actorLib.numberOrNull(pendingOffer) === actorLib.numberOrNull(actor.offer));

    if (floorOk && playerAgreed) {
      accepted = true;
    } else if (floorOk && !playerAgreed) {
      actorLib.logIncident(e.app, token, "invalid_accept_unconfirmed", {
        offer: actor.offer,
        floor_ok: floorOk,
        player_agreed: playerAgreed,
        turn: currentTurns,
      });
      // The actor tried to close at a price the player never stated or
      // confirmed. Demote the close into a proposal: the deal can only
      // complete after the player answers the "deal at X?" question.
      action = "propose";
      pendingOffer = actorLib.numberOrNull(actor.offer);
    } else {
      actorLib.logIncident(e.app, token, "invalid_accept_floor", {
        offer: actor.offer,
        floor_ok: floorOk,
        player_agreed: playerAgreed,
        turn: currentTurns,
      });
      action = "continue";
      pendingOffer = null;
    }
  }

  var done = false;
  var outcome = null;
  var status = "active";
  var dealPrice = null;

  if (accepted) {
    done = true;
    outcome = "deal";
    status = "deal";
    dealPrice = isNonPrice ? null : actor.offer;
  } else if (action === "walk_away" || nextPatience <= 0 || nextTurns >= maxTurns) {
    done = true;
    outcome = "no_deal";
    status = "no_deal";
  }

  var nextAsk = actor.offer !== null ? actor.offer : actorLib.numberOrNull(state.current_ask);
  var priorDeviceId = state.device_id;
  var priorHandle = state.handle;
  state = {
    patience: nextPatience,
    turns: nextTurns,
    current_ask: nextAsk,
    mood: actor.mood,
    device_id: priorDeviceId,
    handle: priorHandle,
  };
  if (!accepted && pendingOffer !== null) {
    state.pending_offer = pendingOffer;
  }

  transcript.push({ role: "player", message: playerMessage });
  transcript.push({ role: "actor", message: actor.reply, action: action, offer: actor.offer, mood: actor.mood });

  session.set("transcript", JSON.stringify(transcript));
  session.set("state", JSON.stringify(state));
  session.set("status", status);
  e.app.save(session);

  var scoreResult = null;
  if (done) {
    actorLib.runNotaryBestEffort(session, transcript);
    if (state.device_id === "calibration") {
      // Calibration self-play: score deterministically but never write a
      // score record, so calibration runs cannot pollute daily rankings.
      scoreResult = actorLib.computeServerScore(spec, outcome, dealPrice, nextTurns, nextPatience);
      scoreResult.percentile = null;
    } else {
      scoreResult = actorLib.saveServerScoreBestEffort(e.app, scenario, spec, outcome, dealPrice, nextTurns, nextPatience, token, state);
    }
  }

  var response = {
    message: actor.reply,
    done: done,
    state: actorLib.responseState(state),
  };
  if (done) {
    response.outcome = outcome;
    if (outcome === "deal" && dealPrice !== null) {
      response.dealPrice = dealPrice;
    }
    if (scoreResult) {
      response.score = scoreResult.score;
      response.label = scoreResult.label;
      response.percentile = scoreResult.percentile;
    }
  }

  return e.json(200, response);
});

// Superuser-only: open a negotiation session for ANY scenario (by id or
// scenario_date), so the self-play calibration harness can exercise
// non-today scenarios. Regular turn flow is reused unchanged.
routerAdd("POST", "/api/admin/calibration/start", (e) => {
  var actorLib = require(__hooks + "/lib/actor.js");
  var body = e.requestInfo().body || {};

  var scenario = null;
  try {
    if (body.scenario_id) {
      scenario = e.app.findRecordById("scenarios", String(body.scenario_id));
    } else if (body.scenario_date) {
      scenario = e.app.findFirstRecordByFilter(
        "scenarios",
        "status = {:status} && scenario_date = {:date}",
        { status: "published", date: String(body.scenario_date) }
      );
    }
  } catch (err) {
    scenario = null;
  }
  if (!scenario) {
    return e.json(404, { error: "scenario_not_found" });
  }

  var secretRecord;
  try {
    secretRecord = actorLib.findSecretForScenario(e.app, scenario.id);
  } catch (err) {
    return e.json(404, { error: "secret_not_found" });
  }

  var spec = actorLib.getJSONField(secretRecord, "secret_spec", {});
  var created = actorLib.newSessionRecord(e.app, scenario, spec, {
    device_id: "calibration",
    handle: "calibration",
  });
  return e.json(200, {
    llm: true,
    scenario_id: scenario.id,
    session_token: created.token,
    scenario: actorLib.publicScenarioPayload(scenario, spec, created.state),
  });
}, $apis.requireSuperuserAuth());
