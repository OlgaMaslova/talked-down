#!/usr/bin/env node
// Unit tests for the decide→validate→speak pipeline's server-side validation
// layer in pb_hooks/lib/actor.js. Runs in plain node (no PocketBase needed):
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
  patience: 6,
  levers: { rewards: ["offers to handle pickup and hauling themselves", "mentions buying the spare parts crate too"] },
};

// --- number parsing / formats (still used for player-side price parsing) -----
check("parses 4,500 as 4500", actor.parsePriceToken("4,500") === 4500);
check("parses 4.500 as 4500", actor.parsePriceToken("4.500") === 4500);
check("parses 4500 as 4500", actor.parsePriceToken("4500") === 4500);
check("parses 4.5 as 4.5", actor.parsePriceToken("4.5") === 4.5);
check("numbersInText finds thousand-grouped", JSON.stringify(actor.numbersInText("down to 4,500 credits")) === "[4500]");

// --- cleanDecision normalization ---------------------------------------------
{
  const v = actor.cleanDecision({ decision: "nonsense", action: "bogus", proposed_price: "4500", patience_delta: -9, lever_hit: "  x  " });
  check("cleanDecision defaults + coerces", v.decision === "hold" && v.action === "continue" && v.offer === 4500 && v.patience_delta === -2 && v.lever_hit === "x", v);
}

// --- hold: any movement snaps back to the standing ask -------------------------
{
  const v = { decision: "hold", action: "continue", offer: 4600, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4800 }, v);
  check("hold cannot move price", info && info.original === 4600 && v.offer === 4800, { info, v });
}

// --- grind: small step allowed, big step snapped to the grind band -------------
{
  // legacy fixed cap 8% of 600 = 48 → 4800→4752
  const v = { decision: "grind", action: "propose", offer: 4600, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4800 }, v);
  check("oversized grind snapped to band", info && info.snapped === 4752 && v.offer === 4752, { info, v });
}
{
  const v = { decision: "grind", action: "continue", offer: 4770, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4800 }, v);
  check("in-band grind kept as proposed", info === null && v.offer === 4770, { info, v });
}

// --- null proposed price stands on the current ask -----------------------------
{
  const v = { decision: "grind", action: "continue", offer: null, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4700 }, v);
  check("null price → hold at current ask", info === null && v.offer === 4700, v);
}

// --- price never moves away from the player -------------------------------------
{
  const v = { decision: "grind", action: "continue", offer: 4900, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4700 }, v);
  check("raising the ask snapped back", info && v.offer === 4700, { info, v });
}

// --- lever: real step allowed, only with a valid unused lever --------------------
{
  const v = { decision: "lever", action: "propose", offer: 4620, lever_hit: spec.levers.rewards[0] };
  const info = actor.validateDecision(spec, { current_ask: 4800, levers_used: [] }, v);
  // lever band 30% of 600 = 180 → 4620 allowed unchanged
  check("lever-backed step allowed", info === null && v.offer === 4620 && v.lever_hit === spec.levers.rewards[0], v);
}
{
  // lever claim naming a string not in levers.rewards → downgraded to grind
  const v = { decision: "lever", action: "propose", offer: 4600, lever_hit: "clean direct offer" };
  const info = actor.validateDecision(spec, { current_ask: 4800, levers_used: [] }, v);
  check("fake lever downgraded to grind + snapped", v.decision === "grind" && v.lever_hit === null && info && v.offer === 4752, { info, v });
}
{
  // already-used lever → downgraded to grind
  const v = { decision: "lever", action: "propose", offer: 4620, lever_hit: spec.levers.rewards[0] };
  const info = actor.validateDecision(spec, { current_ask: 4800, levers_used: [spec.levers.rewards[0]] }, v);
  check("used lever downgraded to grind + snapped", v.decision === "grind" && v.lever_hit === null && info && v.offer === 4752, { info, v });
}
{
  // oversized lever step snapped to the lever band
  const v = { decision: "lever", action: "propose", offer: 4300, lever_hit: spec.levers.rewards[1] };
  const info = actor.validateDecision(spec, { current_ask: 4800, levers_used: [] }, v);
  check("oversized lever step snapped to 30% band", info && v.offer === 4620, { info, v });
}

// --- floor is never crossed -------------------------------------------------------
{
  const v = { decision: "lever", action: "propose", offer: 4100, lever_hit: spec.levers.rewards[0] };
  const info = actor.validateDecision(spec, { current_ask: 4260, levers_used: [] }, v);
  check("never past floor", info && v.offer >= 4200, { info, v });
}

// --- validateLeverHit (list + one-payout, no word-matching) -------------------------
check("valid lever accepted", actor.validateLeverHit(spec, { levers_used: [] }, spec.levers.rewards[0]) === spec.levers.rewards[0]);
check("case-insensitive match", actor.validateLeverHit(spec, { levers_used: [] }, spec.levers.rewards[0].toUpperCase()) === spec.levers.rewards[0]);
check("unknown lever rejected", actor.validateLeverHit(spec, { levers_used: [] }, "flattery") === null);
check("used lever rejected", actor.validateLeverHit(spec, { levers_used: [spec.levers.rewards[0]] }, spec.levers.rewards[0]) === null);
check("null lever rejected", actor.validateLeverHit(spec, { levers_used: [] }, null) === null);

// --- non-price frames carry no price -------------------------------------------------
{
  const v = { decision: "grind", action: "propose", offer: 500, lever_hit: null };
  const info = actor.validateDecision({ frame: "non_price" }, {}, v);
  check("non-price frame nulls the offer", info === null && v.offer === null, v);
}

// --- per-session grind cap + patience modulation ----------------------------------
{
  // legacy session (no grind_cap) keeps fixed 8%
  check("legacy state uses fixed 0.08", actor.effectiveGrindCap(spec, { current_ask: 4800 }) === 0.08);
  const full = actor.effectiveGrindCap(spec, { grind_cap: 0.10, patience: 6 });
  check("full patience tightens cap (0.075)", Math.abs(full - 0.075) < 1e-9, full);
  const worn = actor.effectiveGrindCap(spec, { grind_cap: 0.10, patience: 0 });
  check("worn-down actor loosens cap (0.125)", Math.abs(worn - 0.125) < 1e-9, worn);
  check("cap lower bound 0.03", actor.effectiveGrindCap(spec, { grind_cap: 0.01, patience: 6 }) === 0.03);
  check("cap upper bound 0.20", actor.effectiveGrindCap(spec, { grind_cap: 0.9, patience: 0 }) === 0.20);
}
{
  // validation uses the session cap: base 0.10, full patience → 7.5% of 600 = 45 → 4800→4755
  const v = { decision: "grind", action: "propose", offer: 4600, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4800, grind_cap: 0.10, patience: 6 }, v);
  check("validation uses session cap + patience", info && info.snapped === 4755 && v.offer === 4755, info);
}
{
  // same turn, worn-down actor: 12.5% of 600 = 75 → 4800→4725
  const v = { decision: "grind", action: "propose", offer: 4600, lever_hit: null };
  const info = actor.validateDecision(spec, { current_ask: 4800, grind_cap: 0.10, patience: 0 }, v);
  check("low patience allows bigger grind", info && info.snapped === 4725, info);
}

// --- buy direction: concession moves the ask UP -------------------------------------
{
  const buySpec = { frame: "buy", direction: "buy", opening_price: 3000, floor_price: 3600, patience: 6, levers: { rewards: ["r1"] } };
  const v = { decision: "grind", action: "continue", offer: 3400, lever_hit: null };
  const info = actor.validateDecision(buySpec, { current_ask: 3000 }, v);
  // span 600, 8% = 48 → 3000→3048
  check("buy-side oversized grind snapped up", info && v.offer === 3048, { info, v });
}

// --- replay cooldown: wait before start, never time the active replay ---------
{
  const completedAt = Date.UTC(2026, 6, 10, 12, 0, 0);
  const score = {
    getString(name) { return name === "created" ? "2026-07-10 12:00:00.000Z" : ""; },
    get(name) { return name === "created" ? "2026-07-10 12:00:00.000Z" : null; },
  };
  check("replay cooldown is exactly one minute", actor.REPLAY_COOLDOWN_MS === 60000, actor.REPLAY_COOLDOWN_MS);
  check(
    "ranked completion blocks replay start for one minute",
    actor.replayAvailabilityFromDailyScore(score, completedAt) === completedAt + 60000,
    actor.replayAvailabilityFromDailyScore(score, completedAt),
  );
}
{
  const dailyScore = {
    getString(name) { return name === "created" ? "2026-07-10 12:00:00.000Z" : ""; },
    get(name) { return name === "created" ? "2026-07-10 12:00:00.000Z" : null; },
  };
  const replayMetrics = {
    getString(name) { return name === "updated" ? "2026-07-10 12:10:00.000Z" : ""; },
    get(name) { return name === "updated" ? "2026-07-10 12:10:00.000Z" : null; },
  };
  const app = {
    findRecordsByFilter() { return [replayMetrics]; },
  };
  check(
    "replay completion starts a fresh one-minute cooldown",
    actor.replayAvailableAtMs(app, dailyScore, "device-1", Date.UTC(2026, 6, 10, 12, 10, 30)) === Date.UTC(2026, 6, 10, 12, 11, 0),
  );
}
{
  const activeReplaySession = {
    getString(name) {
      if (name === "state") return JSON.stringify({ replay: true });
      if (name === "status") return "active";
      return "";
    },
    get(name) { return name === "state" ? { replay: true } : null; },
  };
  const app = {
    findFirstRecordByData() { return activeReplaySession; },
  };
  const guard = actor.guardReplayTurn(app, "replay-token");
  check("active replay has no in-session timer or deadline", guard.replay === true && !guard.expired && !guard.paused, guard);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall tests passed");
process.exit(failures ? 1 : 0);
