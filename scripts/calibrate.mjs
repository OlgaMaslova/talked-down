#!/usr/bin/env node
// Self-play difficulty calibration harness for Talked Down.
//
// Plays every published scenario against the live backend using scripted
// player strategies of varying skill, via the superuser-only
// /api/admin/calibration/start endpoint (calibration sessions are scored
// deterministically server-side but never written to the daily rankings).
//
// Goal: demonstrate scenarios are HARD BUT BEATABLE —
//   - naive / hostile strategies should fail or score poorly
//   - a skilled strategy should be able to reach a deal with a decent score
//
// Usage:
//   POCKETBASE_URL=https://... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//     node scripts/calibrate.mjs [--out calibration/self-play-report.md]

const BASE = process.env.POCKETBASE_URL || "https://sn-pb-repo-1292607600-d50858.fly.dev";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "calibration/self-play-report.md";

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
  process.exit(1);
}

async function api(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function adminToken() {
  const { status, body } = await api("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (status !== 200) throw new Error("admin auth failed: " + status);
  return body.token;
}

function extractAsk(state, fallback) {
  const v = state && state.currentAsk;
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

// --- scripted player strategies -------------------------------------------

// Naive lowballer: opens absurdly low, barely moves, no rapport.
function naiveLowball(scenario) {
  const ask = scenario.current_ask;
  let offer = ask ? Math.max(1, Math.round(ask * 0.1)) : null;
  let i = 0;
  return {
    name: "naive_lowball",
    next(state) {
      const cur = extractAsk(state, ask);
      i++;
      if (offer === null) return "Just let me have it. I'm not giving anything.";
      if (i > 1) offer = Math.round(offer * 1.1);
      if (cur && offer >= cur) return `Fine, ${cur} then. Deal at ${cur}.`;
      return `I'll give you ${offer}. Take it or leave it.`;
    },
  };
}

// Hostile: insults and pressure. Should burn patience and fail.
function hostile() {
  const lines = [
    "This is overpriced junk and you know it.",
    "You're wasting my time. Drop the price now or I walk.",
    "Everyone says you rip people off. Prove them wrong.",
    "This is your last chance before I trash your reputation.",
    "Are you deaf? Lower. The. Price.",
  ];
  let i = 0;
  return { name: "hostile", next: () => lines[Math.min(i++, lines.length - 1)] };
}

// Skilled haggler: rapport, reasons, gradual concessions from ~55% of ask,
// meets around 70-80%, confirms explicitly.
function skilled(scenario) {
  const ask = scenario.current_ask;
  let offer = ask ? Math.round(ask * 0.55) : null;
  let i = 0;
  return {
    name: "skilled",
    next(state, lastReply) {
      const cur = extractAsk(state, ask);
      i++;
      // Non-price scenarios: persuade earnestly, agree to reasonable terms.
      if (offer === null) {
        const persuade = [
          "I understand what this means to you, and I respect it. Here's my case: I'll honor your conditions and you lose nothing by letting me proceed.",
          "You have my word — I'll meet your terms exactly as you set them. What would make you comfortable saying yes?",
          "That's fair. I agree to your terms. Do we have an understanding?",
          "Yes, agreed — exactly as you said. Deal?",
          "Yes. I agree. Deal.",
        ];
        return persuade[Math.min(i - 1, persuade.length - 1)];
      }
      // If the actor proposed a price question, accept it when reasonable.
      const m = String(lastReply || "").match(/(\d+(?:[.,]\d+)?)/g);
      if (/deal at|do we have a deal|would you agree/i.test(lastReply || "") && m) {
        const proposed = Number(m[m.length - 1].replace(",", "."));
        if (proposed && ask && proposed <= ask * 0.9) {
          return `Yes — ${proposed} works for me. Deal at ${proposed}.`;
        }
      }
      if (i === 1) {
        return `I've admired this for a while — you clearly know its worth. My honest budget is ${offer}. Could we start there?`;
      }
      // Concede ~10% of the gap to the current ask each round.
      const target = cur || ask;
      offer = Math.min(Math.round(offer + (target - offer) * 0.35), target);
      if (offer >= target) return `Alright — ${target}. Deal at ${target}.`;
      return `I hear you. Meet me at ${offer} and I'll shake on it right now — cash, no fuss.`;
    },
  };
}

// --- play loop --------------------------------------------------------------

async function playSession(token, scenarioRec, strategyFactory) {
  const start = await api(
    "/api/admin/calibration/start",
    { method: "POST", body: JSON.stringify({ scenario_id: scenarioRec.id }) },
    token
  );
  if (start.status !== 200) {
    return { error: `start failed (${start.status}: ${JSON.stringify(start.body)})` };
  }
  const scenario = start.body.scenario;
  const strat = strategyFactory(scenario);
  let state = { patience: scenario.patience, currentAsk: scenario.current_ask, turns: 0 };
  let lastReply = scenario.opening_message;
  const maxTurns = scenario.max_turns || 10;
  let result = { strategy: strat.name, turns: 0, outcome: "no_deal", score: 0, label: "No Deal" };

  for (let t = 0; t < maxTurns + 2; t++) {
    const msg = String(strat.next(state, lastReply)).slice(0, 280);
    const turn = await api(
      "/api/game/session/turn",
      { method: "POST", body: JSON.stringify({ session_token: start.body.session_token, message: msg }) }
    );
    if (turn.status !== 200) {
      result.error = `turn failed (${turn.status}: ${JSON.stringify(turn.body)})`;
      break;
    }
    state = turn.body.state || state;
    lastReply = turn.body.message;
    result.turns = state.turns;
    if (turn.body.done) {
      result.outcome = turn.body.outcome;
      result.score = turn.body.score ?? 0;
      result.label = turn.body.label ?? (turn.body.outcome === "deal" ? "?" : "No Deal");
      if (turn.body.dealPrice != null) result.dealPrice = turn.body.dealPrice;
      break;
    }
  }
  return result;
}

async function main() {
  const token = await adminToken();
  const list = await api("/api/collections/scenarios/records?perPage=100&filter=" +
    encodeURIComponent('status="published"') + "&sort=scenario_date", {}, token);
  const scenarios = list.body.items || [];
  console.error(`Playing ${scenarios.length} published scenarios x 3 strategies against ${BASE}`);

  const rows = [];
  for (const sc of scenarios) {
    for (const factory of [naiveLowball, hostile, skilled]) {
      const r = await playSession(token, sc, factory);
      rows.push({ scenario: sc.title, date: sc.scenario_date, ...r });
      console.error(`  ${sc.title} / ${r.strategy || "?"}: ${r.outcome || r.error} score=${r.score ?? "-"} turns=${r.turns ?? "-"}`);
    }
  }

  // --- report ---------------------------------------------------------------
  const byStrategy = {};
  for (const r of rows) {
    if (r.error) continue;
    (byStrategy[r.strategy] ||= []).push(r);
  }
  const lines = [];
  lines.push("# Talked Down — self-play difficulty calibration report");
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Backend: ${BASE}`);
  lines.push(`- Scenarios played: ${scenarios.length} (all published)`);
  lines.push("- Strategies: naive_lowball (weak), hostile (adversarial), skilled (strong scripted haggler)");
  lines.push("- Calibration sessions are scored server-side with the production formula but excluded from daily rankings.");
  lines.push("");
  lines.push("## Summary by strategy");
  lines.push("");
  for (const [name, rs] of Object.entries(byStrategy)) {
    const deals = rs.filter((r) => r.outcome === "deal");
    const avg = rs.length ? Math.round(rs.reduce((a, r) => a + (r.score || 0), 0) / rs.length) : 0;
    lines.push(`- **${name}**: ${deals.length}/${rs.length} deals, avg score ${avg}/100`);
  }
  lines.push("");
  lines.push("## Per-scenario results");
  lines.push("");
  for (const sc of scenarios) {
    lines.push(`### ${sc.title} (${sc.scenario_date})`);
    for (const r of rows.filter((x) => x.scenario === sc.title)) {
      if (r.error) {
        lines.push(`- ${r.strategy || "?"}: ERROR — ${r.error}`);
      } else {
        const price = r.dealPrice != null ? `, deal price ${r.dealPrice}` : "";
        lines.push(`- ${r.strategy}: ${r.outcome} in ${r.turns} turns — score ${r.score}/100 (${r.label})${price}`);
      }
    }
    lines.push("");
  }
  lines.push("## Verdict");
  lines.push("");
  const weak = [...(byStrategy.naive_lowball || []), ...(byStrategy.hostile || [])];
  const strong = byStrategy.skilled || [];
  const weakDealRate = weak.length ? weak.filter((r) => r.outcome === "deal").length / weak.length : 0;
  const strongDeals = strong.filter((r) => r.outcome === "deal");
  const strongAvg = strongDeals.length
    ? Math.round(strongDeals.reduce((a, r) => a + r.score, 0) / strongDeals.length)
    : 0;
  const hard = weakDealRate <= 0.4;
  const beatable = strongDeals.length >= Math.ceil(strong.length * 0.5);
  lines.push(`- Hard: weak/adversarial strategies close only ${(weakDealRate * 100).toFixed(0)}% of deals → ${hard ? "PASS" : "REVIEW"}`);
  lines.push(`- Beatable: skilled strategy closes ${strongDeals.length}/${strong.length} deals (avg score ${strongAvg}/100 on deals) → ${beatable ? "PASS" : "REVIEW"}`);
  lines.push(`- Overall: ${hard && beatable ? "HARD BUT BEATABLE ✅" : "NEEDS TUNING ⚠️"}`);
  lines.push("");

  const fs = await import("node:fs");
  fs.mkdirSync("calibration", { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n"));
  console.error(`Report written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
