/// <reference path="../pb_data/types.d.ts" />

cronAdd("nightly_playwright", "0 2 * * *", function() {
  var playwright = require(__hooks + "/lib/playwright.js");
  var targetDate = playwright.tomorrowUTC();
  try {
    var result = playwright.runPlaywrightPipeline($app, targetDate, "cron");
    playwright.logInfo($app, "nightly_playwright cron result: " + JSON.stringify(result));
  } catch (err) {
    playwright.logError($app, "nightly_playwright cron error for " + targetDate + ": " + err.message);
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
