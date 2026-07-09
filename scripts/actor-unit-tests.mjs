#!/usr/bin/env node
// Unit tests for the mechanical concession-enforcement layer in
// pb_hooks/lib/actor.js. Runs in plain node (no PocketBase needed):
//   node scripts/actor-unit-tests.mjs
// The repo package.json is type:module while pb_hooks is CommonJS (goja), so
// stage the hook files as .cjs in a temp dir before requiring them.
import { createRequire } from "node:module";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "actor-test-"));
copyFileSync(join(here, "../pb_hooks/lib/actor.js"), join(stage, "actor.cjs"));
copyFileSync(join(here, "../pb_hooks/lib/openai.js"), join(stage, "openai.js"));
const require = createRequire(import.meta.url);
const actor = require(join(stage, "actor.cjs"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("ok   " + name);
  } else {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + JSON.stringify(detail) : ""));
  }
}

const spec = {
  frame: "sell",
  direction: "sell",
  opening_price: 4800,
  floor_price: 4200,
  levers: { rewards: ["offers to handle pickup and hauling themselves", "mentions buying the spare parts crate too"] },
};

// --- number parsing / formats ------------------------------------------------
check("parses 4,500 as 4500", actor.parsePriceToken("4,500") === 4500);
check("parses 4.500 as 4500", actor.parsePriceToken("4.500") === 4500);
check("parses 4500 as 4500", actor.parsePriceToken("4500") === 4500);
check("parses 4.5 as 4.5", actor.parsePriceToken("4.5") === 4.5);
check("numbersInText finds thousand-grouped", JSON.stringify(actor.numbersInText("down to 4,500 credits")) === "[4500]");

// --- reply rewrite handles formatted numbers ---------------------------------
check("rewrites 4,500 in reply", actor.rewritePriceInText("I can do 4,500 credits. 4,500 final.", 4500, 4750) === "I can do 4750 credits. 4750 final.");
check("rewrites 4.500 in reply", actor.rewritePriceInText("Say 4.500 then.", 4500, 4750) === "Say 4750 then.");
check("does not touch other numbers", actor.rewritePriceInText("You said 4100, I want 4500.", 4500, 4750) === "You said 4100, I want 4750.");

// --- price hidden in reply text is recovered and clamped ---------------------
{
  const state = { current_ask: 4800 };
  const a = { reply: "Fine, I can move down to 4,500 for you.", offer: null, action: "continue" };
  const info = actor.clampConcession(spec, state, a, null, "I'm busy here 4000");
  // span 600, no-lever max step 8% = 48 → clamp 4800→4752
  check("null-offer reply price recovered + clamped", info && info.original === 4500 && info.clamped === 4752, info);
  check("offer baseline advanced", a.offer === 4752, a.offer);
  check("reply rewritten incl. formatted number", a.reply.indexOf("4752") !== -1 && a.reply.indexOf("4,500") === -1, a.reply);
}

// --- structured offer still clamped ------------------------------------------
{
  const state = { current_ask: 4800 };
  const a = { reply: "Ok, 4600 and it's yours.", offer: 4600, action: "propose" };
  const info = actor.clampConcession(spec, state, a, null, "4250");
  check("bare-number turn clamped to grind step", info && info.clamped === 4752 && a.offer === 4752, info);
}

// --- lever hit allows a real step ----------------------------------------------
{
  const state = { current_ask: 4800, levers_used: [] };
  const lever = actor.validateLeverHit(spec, state, "offers to handle pickup and hauling themselves", "I'll handle the hauling and pickup myself with my own rig");
  check("genuine lever validates", lever === spec.levers.rewards[0], lever);
  const a = { reply: "Since you're hauling it yourself, 4620.", offer: 4620, action: "propose" };
  const info = actor.clampConcession(spec, state, a, lever, "I'll handle the hauling and pickup myself with my own rig");
  // lever max step 30% of 600 = 180 → 4620 allowed unchanged
  check("lever-backed step allowed", info === null && a.offer === 4620, { info, offer: a.offer });
}

// --- claimed lever on a bare-number turn is rejected ---------------------------
{
  const state = { current_ask: 4800, levers_used: [] };
  const lever = actor.validateLeverHit(spec, state, "offers to handle pickup and hauling themselves", "I'm busy here 4000");
  check("lever claim on bare number rejected", lever === null, lever);
}

// --- used lever cannot be re-claimed -------------------------------------------
{
  const state = { current_ask: 4600, levers_used: ["offers to handle pickup and hauling themselves"] };
  const lever = actor.validateLeverHit(spec, state, "offers to handle pickup and hauling themselves", "again, I'm hauling it myself, pickup on me");
  check("used lever rejected", lever === null, lever);
}

// --- floor is never crossed -----------------------------------------------------
{
  const state = { current_ask: 4260 };
  const a = { reply: "Ugh. 4100 then.", offer: 4100, action: "propose" };
  const info = actor.clampConcession(spec, state, a, null, "4050");
  check("never past floor", info && a.offer >= 4200, { info, offer: a.offer });
}

// --- player-quoted numbers in reply are not treated as new asks ------------------
{
  const state = { current_ask: 4500 };
  const found = actor.extractAskFromReply(spec, state, "4300 shows effort, but I'm holding at 4500.", "4300?");
  check("player echo not extracted, standing ask not a concession", found === null, found);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall tests passed");
process.exit(failures ? 1 : 0);
