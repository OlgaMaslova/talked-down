#!/usr/bin/env node
// Focused unit tests for scenario-history loading and server-side domain
// validation. Runs in plain Node; no PocketBase process or API key required.
import { createRequire } from "node:module";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "playwright-test-"));
copyFileSync(join(here, "../pb_hooks/lib/playwright.js"), join(stage, "playwright.cjs"));
copyFileSync(join(here, "../pb_hooks/lib/openai.js"), join(stage, "openai.js"));
const require = createRequire(import.meta.url);
const openaiModule = require(join(stage, "openai.js"));
let mockImageResult = new Error("image generation disabled for this test");
let imageRequests = [];
openaiModule.generateImage = (prompt, options) => {
  imageRequests.push({ prompt, options });
  if (mockImageResult instanceof Error) throw mockImageResult;
  return mockImageResult;
};
const playwrightModule = require(join(stage, "playwright.cjs"));
const playwright = playwrightModule._test;
const openai = openaiModule._test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log("ok   " + name);
  } else {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + JSON.stringify(detail) : ""));
  }
}

function record(values) {
  return {
    id: values.id || "record-id",
    getString(name) {
      const value = values[name];
      if (value === null || typeof value === "undefined") return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    get(name) {
      return values[name];
    },
    set(name, value) {
      values[name] = value;
    },
    _values: values,
  };
}

const recentScenarioRecord = record({
  id: "recent-scenario",
  title: "The Last Spare Reactor Core",
  character_name: "Mara Venn",
  character_persona: "a station mechanic beside a cargo bay",
  opening_message: "I can part with one reactor core, but not for scraps.",
  player_brief: "A station mechanic is selling a reactor core.\nYou are a shuttle operator.\nGoal: buy it. Opening ask: 18,000 credits.",
});
const recentSecretRecord = record({
  secret_spec: {
    frame: "buy",
    item: "spare reactor core",
    objective: "sell the core",
    levers: { rewards: ["clear logistics", "fast pickup"], punishes: ["lowballs", "delay"] },
  },
});

let capturedSort = "";
const fakeApp = {
  findRecordsByFilter(collection, filter, sort) {
    if (collection !== "scenarios") throw new Error("unexpected collection");
    capturedSort = sort;
    return [recentScenarioRecord];
  },
  findFirstRecordByFilter(collection) {
    if (collection !== "scenario_secrets") throw new Error("unexpected collection");
    return recentSecretRecord;
  },
};

const recent = playwright.fetchRecentGeneratedScenarios(fakeApp);
check("history sorts by real timestamps with day-index tie-breaker", capturedSort === "-created,-day_index", capturedSort);
check("history loads instead of silently returning empty", recent.length === 1, recent);
check("legacy dock/mechanic story is classified industrial", recent[0].domain_keys.includes("industrial_transport"), recent[0].domain_keys);

let historyError = "";
try {
  playwright.fetchRecentGeneratedScenarios({
    findRecordsByFilter() { throw new Error("invalid sort field"); },
  });
} catch (error) {
  historyError = error.message;
}
check("history query failures stop generation", historyError.includes("recent scenario history query failed"), historyError);

const portraitPrompt = playwright.buildActorPortraitPrompt({
  ...recentScenarioRecord,
  title: "The Last Spare Reactor Core",
  character_name: "Mara Venn",
  character_persona: "a station mechanic beside a cargo bay",
  opening_message: "I can part with one reactor core, but not for scraps.",
  player_brief: "Negotiate with the station mechanic for the reactor core.",
  floor_price: 987654,
  secret_lever: "never expose this",
});
check("portrait prompt requests an original no-text square portrait", portraitPrompt.includes("square 1:1") && portraitPrompt.includes("original fictional") && portraitPrompt.includes("Do not include any text"), portraitPrompt);
check("portrait prompt ignores private-shaped properties", !portraitPrompt.includes("987654") && !portraitPrompt.includes("never expose this"), portraitPrompt);

const imagePayload = openai.imageRequestPayload("portrait prompt", {});
check("image request uses low-cost square JPEG defaults", imagePayload.model === "gpt-image-1-mini" && imagePayload.size === "1024x1024" && imagePayload.quality === "low" && imagePayload.output_format === "jpeg" && imagePayload.output_compression === 70, imagePayload);
check("base64 image bytes decode without Node Buffer", JSON.stringify(openai.decodeBase64("AQID/w==")) === "[1,2,3,255]", openai.decodeBase64("AQID/w=="));

let portraitFailureResult = "not-called";
try {
  portraitFailureResult = playwright.attachActorPortraitBestEffort({
    logger() { return { info() {}, error() {} }; },
  }, recentScenarioRecord);
} catch (error) {
  portraitFailureResult = error.message;
}
check("portrait generation failure remains best-effort", portraitFailureResult === "", portraitFailureResult);

let backfillQueries = 0;
const matchingBackfillScenario = record({
  id: "alien-souvenir",
  title: "The Alien Souvenir",
  character_name: "Zorblax",
  character_persona: "an exacting alien collector inspecting a human souvenir",
  opening_message: "This trinket is curious, but your price is more curious.",
  player_brief: "Negotiate the sale of a human souvenir to Zorblax.",
  scenario_date: "2026-07-21",
  status: "published",
  actor_portrait: "",
});
let backfillSaves = 0;
const backfillApp = {
  findFirstRecordByFilter(collection, filter, params) {
    backfillQueries++;
    check("backfill queries only the published target date", collection === "scenarios" && filter.includes("status") && filter.includes("scenario_date") && params.status === "published" && params.date === "2026-07-21", { collection, filter, params });
    return matchingBackfillScenario;
  },
  save(savedRecord) {
    backfillSaves++;
    if (savedRecord !== matchingBackfillScenario) throw new Error("unexpected record saved");
  },
  logger() { return { info() {}, error() {} }; },
};

globalThis.$filesystem = {
  fileFromBytes(bytes, filename) {
    check("backfill passes generated bytes to PocketBase filesystem", JSON.stringify(bytes) === "[1,2,3]", bytes);
    return filename;
  },
};
mockImageResult = { bytes: [1, 2, 3], filename: "actor-portrait.jpg", mimeType: "image/jpeg" };
imageRequests = [];

const outsideDateResult = playwright.backfillAlienSouvenirActorPortrait(backfillApp, "2026-07-20");
check("backfill is disabled outside the exact date", outsideDateResult.reason === "outside_backfill_date" && backfillQueries === 0, { outsideDateResult, backfillQueries });

const attachedBackfillResult = playwright.backfillAlienSouvenirActorPortrait(backfillApp, "2026-07-21");
check("backfill attaches the missing portrait for the exact published scenario", attachedBackfillResult.status === "attached" && matchingBackfillScenario.getString("actor_portrait") === "actor-portrait.jpg", attachedBackfillResult);
check("backfill reuses the public portrait prompt and image helper", imageRequests.length === 1 && imageRequests[0].prompt.includes("The Alien Souvenir") && imageRequests[0].prompt.includes("Zorblax"), imageRequests);
check("backfill saves once without changing game content or status", backfillSaves === 1 && matchingBackfillScenario.getString("status") === "published" && matchingBackfillScenario.getString("title") === "The Alien Souvenir", { backfillSaves, values: matchingBackfillScenario._values });

const secondBackfillResult = playwright.backfillAlienSouvenirActorPortrait(backfillApp, "2026-07-21");
check("backfill becomes a no-op after success", secondBackfillResult.reason === "portrait_exists" && imageRequests.length === 1 && backfillSaves === 1, { secondBackfillResult, imageRequests: imageRequests.length, backfillSaves });

const mismatchedScenario = record({
  id: "other-scenario",
  title: "A Different Scenario",
  character_name: "Someone Else",
  actor_portrait: "",
});
const mismatchResult = playwright.backfillAlienSouvenirActorPortrait({
  findFirstRecordByFilter() { return mismatchedScenario; },
}, "2026-07-21");
check("backfill refuses a different scenario on the target date", mismatchResult.reason === "scenario_identity_mismatch" && imageRequests.length === 1, mismatchResult);
delete globalThis.$filesystem;
mockImageResult = new Error("image generation disabled for this test");

const generationMessages = playwright.buildGenerationMessages("2026-07-12", recent, 1, 1);
const generationPayload = JSON.parse(generationMessages[1].content);
check("prompt includes server-owned domain catalog", generationPayload.allowed_domains.some((entry) => entry.key === "sports") && generationPayload.allowed_domains.some((entry) => entry.key === "fantasy"));
check("prompt blocks classified recent domain", generationPayload.recent_domains_do_not_repeat.includes("industrial_transport"), generationPayload.recent_domains_do_not_repeat);

const validSportsScenario = {
  public: {
    title: "The Coach's Training Program Offer",
    character_name: "Imani Cole",
    character_persona: "a veteran athletics coach at a city stadium",
    opening_message: "I can offer 200 crowns for your training program. Tell me why it is worth more.",
    player_brief: "A stadium coach wants to buy your training program.\nYou are an independent trainer.\nGoal: sell the program for as much as possible. Opening ask: 200 crowns.",
  },
  secret: {
    domain: "sports",
    frame: "sell",
    direction: "buy",
    item: "athletic training program",
    objective: "sell the training program for the highest defensible price",
    currency: "crowns",
    opening_price: 200,
    fair_price: 250,
    floor_price: 300,
    patience: 6,
    max_turns: 10,
    levers: {
      rewards: ["shows measurable athlete outcomes", "offers a limited pilot"],
      punishes: ["makes unsupported claims", "insults the current coaching staff"],
    },
    concession_style: "raises the offer only when value is demonstrated",
    actor_notes: "Keep the discussion focused on results and implementation.",
    scoring_config: { max_score: 100, price_weight: 70, patience_weight: 20, turns_weight: 10 },
  },
};

let validResult = null;
try {
  validResult = playwright.normalizeAndValidateGenerated(JSON.parse(JSON.stringify(validSportsScenario)), recent);
} catch (error) {
  validResult = error.message;
}
check("new, truthful domain passes validation", validResult && validResult.secret && validResult.secret.domain === "sports", validResult);

const directYouScenario = JSON.parse(JSON.stringify(validSportsScenario));
directYouScenario.public.opening_message = "You have shown strong results, but I can offer 200 crowns. Tell me why it is worth more.";
let directYouResult = null;
try {
  directYouResult = playwright.normalizeAndValidateGenerated(directYouScenario, recent);
} catch (error) {
  directYouResult = error.message;
}
check("direct dialogue beginning with You is allowed", directYouResult && directYouResult.secret, directYouResult);

const narratedScenario = JSON.parse(JSON.stringify(validSportsScenario));
narratedScenario.public.opening_message = "You stand before the coach at the stadium as the negotiation begins.";
let narrationError = "";
try {
  playwright.normalizeAndValidateGenerated(narratedScenario, recent);
} catch (error) {
  narrationError = error.message;
}
check("actual second-person scene narration is rejected", narrationError.includes("public.opening_message contains narration"), narrationError);

const judgeMessages = playwright.buildDiversityJudgeMessages(recent, [validSportsScenario, validSportsScenario]);
check("diversity judge supports a two-candidate subset", judgeMessages[0].content.includes("0 through 1"), judgeMessages[0].content);

const onlyCandidate = { marker: "only-valid-candidate" };
const selectedOnly = playwright.selectDiverseScenarioCandidate({
  logger() { return { info() {}, error() {} }; },
}, "2026-07-12", 1, recent, [onlyCandidate]);
check("a cycle can continue with one valid candidate", selectedOnly === onlyCandidate, selectedOnly);

const repeatedDomainScenario = JSON.parse(JSON.stringify(validSportsScenario));
repeatedDomainScenario.secret.domain = "industrial_transport";
repeatedDomainScenario.public.title = "Cargo Mechanic Training Contract";
repeatedDomainScenario.public.character_persona = "a cargo mechanic at a harbor repair dock";
repeatedDomainScenario.secret.item = "cargo mechanic training contract";
let repeatedError = "";
try {
  playwright.normalizeAndValidateGenerated(repeatedDomainScenario, recent);
} catch (error) {
  repeatedError = error.message;
}
check("recent domain is rejected server-side", repeatedError.includes("domain repeats one of the five most recent scenarios"), repeatedError);

const falseDomainScenario = JSON.parse(JSON.stringify(validSportsScenario));
falseDomainScenario.secret.domain = "fantasy";
let falseDomainError = "";
try {
  playwright.normalizeAndValidateGenerated(falseDomainScenario, []);
} catch (error) {
  falseDomainError = error.message;
}
check("declared domain must match story text", falseDomainError.includes("secret.domain does not match the scenario text"), falseDomainError);

console.log(failures ? `\n${failures} FAILURES` : "\nall tests passed");
process.exit(failures ? 1 : 0);
