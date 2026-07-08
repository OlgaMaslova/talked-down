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
  var pendingConfirmation = null;

  var isNonPrice = spec.frame === "non_price";

  if (action === "accept" && isNonPrice) {
    // Non-price scenario: no numeric offer to validate. Close when the player
    // has already seen and answered a question: either a pending server-side
    // proposal, or the actor's immediately previous message asked the player
    // something (e.g. "Do you agree to these terms?") and this turn is the
    // player's answer. Otherwise the accept becomes an explicit proposal.
    var lastActorMessage = "";
    for (var ti = transcript.length - 1; ti >= 0; ti--) {
      if (transcript[ti] && transcript[ti].role === "actor") {
        lastActorMessage = String(transcript[ti].message || "");
        break;
      }
    }
    var actorJustAsked = /\?\s*$/.test(lastActorMessage);
    if (state.pending_confirmation === "terms" || actorJustAsked) {
      accepted = true;
    } else {
      action = "continue";
      pendingConfirmation = "terms";
    }
  } else if (action === "accept") {
    var floorOk = actorLib.dealRespectsFloor(spec, actor.offer);
    var playerAgreed =
      actorLib.playerStatedPrice(transcript, playerMessage, actor.offer) ||
      (actorLib.numberOrNull(state.pending_confirmation) !== null &&
        actorLib.numberOrNull(state.pending_confirmation) === actorLib.numberOrNull(actor.offer));

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
      // confirmed. Convert the close into an explicit proposal: the deal
      // can only complete on the player's next turn, after they have seen
      // and answered the "deal at X?" question.
      action = "continue";
      pendingConfirmation = actorLib.numberOrNull(actor.offer);
    } else {
      actorLib.logIncident(e.app, token, "invalid_accept_floor", {
        offer: actor.offer,
        floor_ok: floorOk,
        player_agreed: playerAgreed,
        turn: currentTurns,
      });
      action = "continue";
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
  if (pendingConfirmation !== null) {
    state.pending_confirmation = pendingConfirmation;
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
    scoreResult = actorLib.saveServerScoreBestEffort(e.app, scenario, spec, outcome, dealPrice, nextTurns, nextPatience, token, state);
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
