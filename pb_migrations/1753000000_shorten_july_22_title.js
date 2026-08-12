/// <reference path="../pb_data/types.d.ts" />
// Shorten the published July 22 scenario title without affecting other records.
// Safe to re-run: missing and already-renamed scenarios are no-ops.
migrate((app) => {
  let scenario;
  try {
    scenario = app.findFirstRecordByFilter(
      "scenarios",
      "status = {:status} && scenario_date = {:date}",
      { status: "published", date: "2026-07-22" }
    );
  } catch {
    return;
  }

  if (!scenario || scenario.getString("title") === "Rush-made gown") {
    return;
  }

  scenario.set("title", "Rush-made gown");
  return app.save(scenario);
}, (app) => {
  // Keep the shortened title on rollback; the prior generated title is not restored.
});
