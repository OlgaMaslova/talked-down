/// <reference path="../pb_data/types.d.ts" />
// Second attempt at backfilling scores.deal_price for legacy deal scores.
// The first attempt (1752420000) matched on a `created` field that these
// collections do not have, so it backfilled nothing. This one matches
// closed sessions to scores via the scenario's day_index + device_id.
// Safe to re-run: only deal scores with an empty/zero deal_price are touched.
migrate((app) => {
  function parseJSONField(record, fieldName, fallback) {
    try {
      var raw = record.getString(fieldName);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (errRaw) {}
    try {
      var value = record.get(fieldName);
      if (typeof value === "string" && value) {
        return JSON.parse(value);
      }
      if (typeof value === "object" && value !== null) {
        return value;
      }
    } catch (errValue) {}
    return fallback;
  }

  function numberOrNull(value) {
    if (value === null || typeof value === "undefined" || value === "") {
      return null;
    }
    var n = Number(value);
    if (isNaN(n) || !isFinite(n)) {
      return null;
    }
    return n;
  }

  function extractDealPrice(session, state) {
    var transcript = parseJSONField(session, "transcript", []);
    if (Array.isArray(transcript)) {
      for (var i = transcript.length - 1; i >= 0; i--) {
        var entry = transcript[i] || {};
        if (entry.role === "actor" && entry.action === "accept") {
          var offer = numberOrNull(entry.offer);
          if (offer !== null && offer > 0) {
            return offer;
          }
        }
      }
    }
    var currentAsk = numberOrNull(state && state.current_ask);
    if (currentAsk !== null && currentAsk > 0) {
      return currentAsk;
    }
    return null;
  }

  try {
    // Map scenario id -> day_index so sessions can be bucketed per day.
    var scenarioDay = {};
    try {
      var scenarios = app.findRecordsByFilter("scenarios", "id != ''", "", 0, 0);
      for (var si = 0; si < scenarios.length; si++) {
        scenarioDay[scenarios[si].id] = scenarios[si].getInt("day_index");
      }
    } catch (errScen) {}

    var sessions = app.findRecordsByFilter("sessions", "status = 'deal'", "", 0, 0);
    // Candidates keyed by day_index + "|" + device_id.
    var byKey = {};
    for (var j = 0; j < sessions.length; j++) {
      var session = sessions[j];
      var state = parseJSONField(session, "state", {}) || {};
      var deviceId = String(state.device_id || "");
      if (!deviceId) {
        continue;
      }
      var scenarioId = "";
      try {
        scenarioId = String(session.getString("scenario") || "");
      } catch (errRel) {}
      var dayIndex = scenarioDay.hasOwnProperty(scenarioId) ? scenarioDay[scenarioId] : null;
      var price = extractDealPrice(session, state);
      if (price === null) {
        continue;
      }
      var key = String(dayIndex) + "|" + deviceId;
      if (!byKey[key]) {
        byKey[key] = [];
      }
      byKey[key].push({ id: session.id, price: price, turns: numberOrNull(state.turns), used: false });
    }

    var scores = app.findRecordsByFilter("scores", "outcome = 'deal'", "", 0, 0);
    var considered = 0;
    var updated = 0;
    var skipped = 0;
    for (var i = 0; i < scores.length; i++) {
      var score = scores[i];
      var existingPrice = numberOrNull(score.get("deal_price"));
      if (existingPrice !== null && existingPrice > 0) {
        continue;
      }
      considered++;
      try {
        var sDevice = String(score.getString("device_id") || "");
        var sDay = score.getInt("day_index");
        var candidates = (byKey[String(sDay) + "|" + sDevice] || []).filter(function (c) {
          return !c.used;
        });
        if (!candidates.length) {
          skipped++;
          console.log("backfill_deal_price2: no candidate session for score " + score.id);
          continue;
        }
        var chosen = null;
        var sTurns = numberOrNull(score.get("turns"));
        if (sTurns !== null) {
          var turnMatches = candidates.filter(function (c) {
            return c.turns !== null && c.turns === sTurns;
          });
          if (turnMatches.length === 1) {
            chosen = turnMatches[0];
          }
        }
        if (!chosen && candidates.length === 1) {
          chosen = candidates[0];
        }
        if (!chosen) {
          var allEqual = candidates.every(function (c) {
            return c.price === candidates[0].price;
          });
          if (allEqual) {
            chosen = candidates[0];
          }
        }
        if (!chosen) {
          skipped++;
          console.log("backfill_deal_price2: ambiguous candidates for score " + score.id);
          continue;
        }
        score.set("deal_price", chosen.price);
        app.save(score);
        chosen.used = true;
        updated++;
      } catch (errScore) {
        skipped++;
        console.log("backfill_deal_price2: error on score " + score.id + ": " + errScore);
      }
    }
    console.log("backfill_deal_price2: updated " + updated + " of " + considered + " legacy deal scores; skipped " + skipped);
  } catch (err) {
    console.log("backfill_deal_price2: skipped migration after error: " + err);
  }
}, (app) => {
  // Down migration intentionally no-op.
});
