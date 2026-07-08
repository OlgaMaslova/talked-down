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
  var created = actorLib.newSessionRecord(e.app, scenario, spec);
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
      { temperature: 0.7 }
    ));
  } catch (err) {
    console.log("actor_unavailable: " + err.message);
    return e.json(502, { error: "actor_unavailable" });
  }

  var nextTurns = currentTurns + 1;
  var nextPatience = actorLib.intOrDefault(state.patience, actorLib.intOrDefault(spec.patience, 10)) + actor.patience_delta;
  var action = actor.action;
  var accepted = false;

  if (action === "accept") {
    if (actorLib.dealRespectsFloor(spec, actor.offer)) {
      accepted = true;
    } else {
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
    dealPrice = actor.offer;
  } else if (action === "walk_away" || nextPatience <= 0 || nextTurns >= maxTurns) {
    done = true;
    outcome = "no_deal";
    status = "no_deal";
  }

  var nextAsk = actor.offer !== null ? actor.offer : actorLib.numberOrNull(state.current_ask);
  state = {
    patience: nextPatience,
    turns: nextTurns,
    current_ask: nextAsk,
    mood: actor.mood,
  };

  transcript.push({ role: "player", message: playerMessage });
  transcript.push({ role: "actor", message: actor.reply, action: action, offer: actor.offer, mood: actor.mood });

  session.set("transcript", JSON.stringify(transcript));
  session.set("state", JSON.stringify(state));
  session.set("status", status);
  e.app.save(session);

  if (done) {
    actorLib.runNotaryBestEffort(session, transcript);
  }

  var response = {
    message: actor.reply,
    done: done,
    state: actorLib.responseState(state),
  };
  if (done) {
    response.outcome = outcome;
    if (outcome === "deal") {
      response.dealPrice = dealPrice;
    }
  }

  return e.json(200, response);
});
