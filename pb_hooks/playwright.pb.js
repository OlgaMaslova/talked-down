/// <reference path="../pb_data/types.d.ts" />

cronAdd("nightly_playwright", "0 2 * * *", function() {
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
