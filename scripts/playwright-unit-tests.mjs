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
const playwright = require(join(stage, "playwright.cjs"))._test;

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
