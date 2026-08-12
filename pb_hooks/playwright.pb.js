/// <reference path="../pb_data/types.d.ts" />

// Master switch for the nightly generation pipeline. While false, neither the
// nightly job nor the current-day recovery job generates or publishes anything;
// already published scenarios stay live and the manual admin route still works.
// Set to false (and redeploy) to pause daily generation; disable the schedule in
// .github/workflows/nightly-watchdog.yml at the same time, or it alerts nightly.
var PIPELINE_ENABLED = true;

// One-off production backfill. The cron is limited to July 21 and the helper
// additionally requires the exact 2026 date, published scenario identity, and a
// blank portrait. It runs within five minutes of deployment, unregisters itself
// before making the single attempt, and remains a data-level no-op on restarts
// after the portrait is saved.
cronAdd("backfill_alien_souvenir_actor_portrait", "*/5 * 21 7 *", function() {
  cronRemove("backfill_alien_souvenir_actor_portrait");
  var playwright = require(__hooks + "/lib/playwright.js");
  var result = playwright.backfillAlienSouvenirActorPortrait($app);
  if (result.status === "attached") {
    playwright.logInfo($app, "actor portrait backfill result: " + JSON.stringify(result));
  } else if (result.status === "failed") {
    playwright.logError($app, "actor portrait backfill result: " + JSON.stringify(result));
  }
});

cronAdd("nightly_playwright", "0 2 * * *", function() {
  if (!PIPELINE_ENABLED) {
    console.log("nightly_playwright skipped: pipeline disabled");
    return;
  }

  var playwright = require(__hooks + "/lib/playwright.js");
  var targetDate = playwright.tomorrowUTC();

  // 1) Recap the prior (completed) UTC day — best effort, never blocks generation.
  var recap = null;
  try {
    recap = playwright.computeDailyRecap($app);
    playwright.logInfo($app, "nightly recap: " + JSON.stringify(recap));
  } catch (recapErr) {
    playwright.logError($app, "nightly recap failed: " + recapErr.message);
  }

  // 2) Generate + security-test + publish tomorrow's scenario.
  try {
    var result = playwright.runPlaywrightPipeline($app, targetDate, "cron");
    playwright.logInfo($app, "nightly_playwright cron result: " + JSON.stringify(result));
    playwright.recordPipelineRun($app, targetDate, "cron", result, recap, null);
  } catch (err) {
    playwright.logError($app, "nightly_playwright cron error for " + targetDate + ": " + err.message);
    playwright.recordPipelineRun($app, targetDate, "cron", null, recap, err.message);
  }
});

// Every 15 minutes, offset from the nightly job, restore today's game only when
// no published scenario exists. The pipeline repeats the same guard before it
// generates, so normal days remain a lightweight data-level no-op.
cronAdd("recover_current_day_playwright", "7,22,37,52 * * * *", function() {
  if (!PIPELINE_ENABLED) {
    return;
  }

  var playwright = require(__hooks + "/lib/playwright.js");
  var targetDate = new Date().toISOString().slice(0, 10);
  var published;

  try {
    published = $app.findRecordsByFilter(
      "scenarios",
      "status = {:status} && scenario_date = {:date}",
      "",
      1,
      0,
      { status: "published", date: targetDate }
    );
  } catch (lookupErr) {
    playwright.logError($app, "playwright recovery check error for " + targetDate + ": " + lookupErr.message);
    return;
  }

  if (published && published.length) {
    return;
  }

  try {
    var result = playwright.runPlaywrightPipeline($app, targetDate, "recovery");
    playwright.logInfo($app, "playwright recovery result: " + JSON.stringify(result));
    playwright.recordPipelineRun($app, targetDate, "recovery", result, null, null);
  } catch (err) {
    playwright.logError($app, "playwright recovery error for " + targetDate + ": " + err.message);
    playwright.recordPipelineRun($app, targetDate, "recovery", null, null, err.message);
  }
});

// Public watchdog endpoint: booleans/dates/statuses only, no hidden data.
routerAdd("GET", "/api/pipeline/status", function(e) {
  var playwright = require(__hooks + "/lib/playwright.js");
  try {
    return e.json(200, playwright.pipelineStatus(e.app));
  } catch (err) {
    return e.json(500, { ok: false, error: "status_failed" });
  }
});

routerAdd("POST", "/api/admin/run-playwright", function(e) {
  var playwright = require(__hooks + "/lib/playwright.js");

  var body = playwright.getBody(e);
  var targetDate = body && body.date ? String(body.date) : playwright.tomorrowUTC();
  var force = !!(body && body.force);
  if (!playwright.validDateString(targetDate)) {
    return e.json(400, { error: "invalid_date" });
  }

  try {
    var result = playwright.runPlaywrightPipeline(e.app, targetDate, "manual", force);
    return e.json(200, result);
  } catch (err) {
    playwright.logError(e.app, "manual playwright route failed for " + targetDate + ": " + err.message);
    return e.json(500, { error: "playwright_failed", message: err.message });
  }
}, $apis.requireSuperuserAuth());
