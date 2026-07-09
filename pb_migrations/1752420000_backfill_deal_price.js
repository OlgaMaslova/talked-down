/// <reference path="../pb_data/types.d.ts" />
// Backfills scores.deal_price for legacy deal scores by matching same-day closed sessions.
// Safe to re-run: only scores with an empty/zero deal_price are considered.
migrate((app) => {
  function fieldByName(collection, name) {
    try {
      if (collection.fields && collection.fields.getByName) {
        return collection.fields.getByName(name);
      }
    } catch (err) {}
    for (var i = 0; i < (collection.fields || []).length; i++) {
      if (collection.fields[i].name === name) {
        return collection.fields[i];
      }
    }
    return null;
  }

  function hasField(collection, name) {
    return !!fieldByName(collection, name);
  }

  function parseJSONField(record, fieldName, fallback) {
    try {
      var raw = record.getString(fieldName);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (errRaw) {}

    try {
      var value = record.get(fieldName);
      if (value === null || typeof value === "undefined" || value === "") {
        return fallback;
      }
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch (errString) {
          return fallback;
        }
      }
      if (typeof value === "object") {
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

  function positiveField(record, fieldName) {
    try {
      var raw = record.get(fieldName);
      var parsed = numberOrNull(raw);
      if (parsed !== null) {
        return parsed > 0;
      }
    } catch (errRaw) {}

    try {
      var value = record.getFloat(fieldName);
      return typeof value === "number" && isFinite(value) && value > 0;
    } catch (errFloat) {}

    return false;
  }

  function createdString(record) {
    try {
      var raw = record.getString("created");
      if (raw) {
        return raw;
      }
    } catch (errString) {}

    try {
      var value = record.get("created");
      if (value) {
        return String(value);
      }
    } catch (errValue) {}

    return "";
  }

  function parseCreated(value) {
    if (!value) {
      return null;
    }

    var text = String(value);
    var normalized = text.replace(" ", "T");
    if (normalized.indexOf("T") !== -1 && !(/[zZ]$|[+-][0-9]{2}:?[0-9]{2}$/.test(normalized))) {
      normalized += "Z";
    }

    var date = new Date(normalized);
    if (isNaN(date.getTime())) {
      date = new Date(text);
    }
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  function pbDateString(date) {
    return date.toISOString().replace("T", " ");
  }

  function utcDayRange(created) {
    var date = parseCreated(created);
    if (!date) {
      return null;
    }

    var start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    var end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      start: pbDateString(start),
      end: pbDateString(end),
    };
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

  function allPricesEqual(candidates) {
    if (!candidates.length) {
      return false;
    }

    var price = candidates[0].price;
    for (var i = 1; i < candidates.length; i++) {
      if (candidates[i].price !== price) {
        return false;
      }
    }
    return true;
  }

  function chooseCandidate(scoreTurns, candidates) {
    if (!candidates.length) {
      return null;
    }

    if (scoreTurns !== null) {
      var matches = [];
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].turns !== null && candidates[i].turns === scoreTurns) {
          matches.push(candidates[i]);
        }
      }
      if (matches.length === 1) {
        return matches[0];
      }
    }

    if (candidates.length > 1 && allPricesEqual(candidates)) {
      return candidates[0];
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    return null;
  }

  try {
    var scoresCollection = app.findCollectionByNameOrId("scores");
    var sessionsCollection = app.findCollectionByNameOrId("sessions");
    if (!scoresCollection || !sessionsCollection) {
      return;
    }
    if (!hasField(scoresCollection, "outcome") || !hasField(scoresCollection, "deal_price") || !hasField(scoresCollection, "device_id")) {
      return;
    }
    if (!hasField(sessionsCollection, "status") || !hasField(sessionsCollection, "state") || !hasField(sessionsCollection, "transcript")) {
      return;
    }

    var scores = app.findRecordsByFilter("scores", "outcome = 'deal'", "created", 0, 0);
    var consumedSessions = {};
    var considered = 0;
    var updated = 0;
    var skipped = 0;

    for (var i = 0; i < scores.length; i++) {
      var score = scores[i];
      if (positiveField(score, "deal_price")) {
        continue;
      }

      considered++;

      try {
        var deviceId = score.getString("device_id");
        if (!deviceId) {
          skipped++;
          console.log("backfill_deal_price: skipping score " + score.id + " without device_id");
          continue;
        }

        var range = utcDayRange(createdString(score));
        if (!range) {
          skipped++;
          console.log("backfill_deal_price: skipping score " + score.id + " without parseable created date");
          continue;
        }

        var sessions = app.findRecordsByFilter(
          "sessions",
          "status = 'deal' && created >= {:start} && created < {:end}",
          "created",
          0,
          0,
          { start: range.start, end: range.end }
        );

        var candidates = [];
        for (var j = 0; j < sessions.length; j++) {
          var session = sessions[j];
          if (consumedSessions[session.id]) {
            continue;
          }

          var state = parseJSONField(session, "state", {});
          if (!state || String(state.device_id || "") !== String(deviceId)) {
            continue;
          }

          var price = extractDealPrice(session, state);
          if (price === null) {
            continue;
          }

          candidates.push({
            id: session.id,
            record: session,
            price: price,
            turns: numberOrNull(state.turns),
          });
        }

        var scoreTurns = numberOrNull(score.get("turns"));
        var chosen = chooseCandidate(scoreTurns, candidates);
        if (!chosen) {
          skipped++;
          console.log("backfill_deal_price: skipping score " + score.id + " with " + candidates.length + " priced candidate sessions");
          continue;
        }

        score.set("deal_price", chosen.price);
        app.save(score);
        consumedSessions[chosen.id] = true;
        updated++;
      } catch (errScore) {
        skipped++;
        console.log("backfill_deal_price: skipping score " + score.id + " after error: " + errScore);
      }
    }

    console.log("backfill_deal_price: updated " + updated + " of " + considered + " legacy deal scores; skipped " + skipped);
  } catch (err) {
    console.log("backfill_deal_price: skipped migration after error: " + err);
  }
}, (app) => {
  // Down migration intentionally left as no-op: recomputed deal prices are not reverted.
});
