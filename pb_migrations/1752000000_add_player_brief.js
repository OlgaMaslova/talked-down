/// <reference path="../pb_data/types.d.ts" />
// Adds the public player_brief field to scenarios: a short player-facing
// description of role, stakes, and goal. Safe to re-run.
migrate((app) => {
  const scenarios = app.findCollectionByNameOrId("scenarios");
  let exists = false;
  for (const field of scenarios.fields || []) {
    if (field.name === "player_brief") {
      exists = true;
      break;
    }
  }
  if (!exists) {
    scenarios.fields.push(new TextField({ name: "player_brief", max: 400 }));
    app.save(scenarios);
  }
}, (app) => {
  try {
    const scenarios = app.findCollectionByNameOrId("scenarios");
    scenarios.fields = (scenarios.fields || []).filter((f) => f.name !== "player_brief");
    app.save(scenarios);
  } catch {}
});
