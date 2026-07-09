/// <reference path="../pb_data/types.d.ts" />
// TEMPORARY diagnostic route — remove after backfill investigation.
routerAdd("GET", "/api/game/debug-backfill-x7k92q", (e) => {
  function parseJSON(record, field) {
    try {
      var raw = record.getString(field);
      if (raw) return JSON.parse(raw);
    } catch (err) {}
    try {
      var v = record.get(field);
      if (typeof v === "string") return JSON.parse(v);
      if (typeof v === "object" && v !== null) return v;
    } catch (err2) {}
    return null;
  }
  var out = { scores: [], sessions: [] };
  try {
    var scores = e.app.findRecordsByFilter("scores", "outcome = 'deal'", "created", 0, 0);
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      out.scores.push({
        id: s.id,
        handle: s.getString("handle"),
        device_id: s.getString("device_id"),
        score: s.getInt("score"),
        turns: s.getInt("turns"),
        deal_price: s.get("deal_price"),
        day_number: s.getInt("day_number"),
        created: s.getString("created"),
      });
    }
  } catch (err) {
    out.scores_error = String(err);
  }
  try {
    var sessions = e.app.findRecordsByFilter("sessions", "status = 'deal'", "created", 0, 0);
    for (var j = 0; j < sessions.length; j++) {
      var sess = sessions[j];
      var state = parseJSON(sess, "state") || {};
      var transcript = parseJSON(sess, "transcript") || [];
      var lastAccept = null;
      for (var k = transcript.length - 1; k >= 0; k--) {
        var t = transcript[k] || {};
        if (t.role === "actor" && t.action === "accept") {
          lastAccept = { offer: t.offer };
          break;
        }
      }
      out.sessions.push({
        id: sess.id,
        created: sess.getString("created"),
        device_id: state.device_id || null,
        handle: state.handle || null,
        turns: state.turns,
        current_ask: state.current_ask,
        last_accept: lastAccept,
        transcript_len: transcript.length,
      });
    }
  } catch (err2) {
    out.sessions_error = String(err2);
  }
  return e.json(200, out);
});
