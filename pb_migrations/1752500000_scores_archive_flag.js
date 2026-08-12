/// <reference path="../pb_data/types.d.ts" />
// Adds a bool `archive` flag to scores: archive (past-day) plays are stored
// for the player's history but are excluded from daily percentile, leaderboard,
// streaks, and recaps. Safe to re-run: guards the field addition.
migrate((app) => {
  let scores;
  try {
    scores = app.findCollectionByNameOrId("scores");
  } catch {
    return;
  }

  const hasField = (collection, name) => {
    if (collection.fields && collection.fields.getByName) {
      return !!collection.fields.getByName(name);
    }
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return true;
      }
    }
    return false;
  };

  if (!hasField(scores, "archive")) {
    if (scores.fields && scores.fields.add) {
      scores.fields.add(new BoolField({ name: "archive" }));
    } else {
      scores.fields = scores.fields || [];
      scores.fields.push(new BoolField({ name: "archive" }));
    }
    app.save(scores);
  }
}, (app) => {
  try {
    const scores = app.findCollectionByNameOrId("scores");
    try {
      if (scores.fields && scores.fields.getByName && scores.fields.removeById) {
        const field = scores.fields.getByName("archive");
        if (field) {
          scores.fields.removeById(field.id);
        }
      } else {
        scores.fields = (scores.fields || []).filter((field) => field.name !== "archive");
      }
    } catch {}
    app.save(scores);
  } catch {}
});
