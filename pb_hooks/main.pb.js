/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/supernaut/ready", (event) => {
  return event.json(200, { ok: true });
});

routerAdd("GET", "/api/game/percentile", (event) => {
  const query = event.request.url.query();
  const dayNumberParam = query.get("day_number");
  const scoreParam = query.get("score");

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

  const dayNumber = parseInt(dayNumberParam, 10);
  const score = parseInt(scoreParam, 10);

  try {
    const records = event.app.findRecordsByFilter(
      "scores",
      "day_number = {:day_number}",
      "",
      0,
      0,
      { day_number: dayNumber }
    );

    const count = records.length;
    let beaten = 0;
    let tied = 0;
    for (let i = 0; i < records.length; i++) {
      const recordScore = records[i].getInt("score");
      if (recordScore < score) {
        beaten++;
      } else if (recordScore === score) {
        tied++;
      }
    }

    const percentile = count > 0 ? Math.round(((beaten + 0.5 * tied) / count) * 100) : 100;
    return event.json(200, { day_number: dayNumber, score: score, plays: count, percentile: percentile });
  } catch (err) {
    return event.json(200, { day_number: dayNumber, score: score, plays: 0, percentile: 100 });
  }
});
