#!/usr/bin/env node
// Live tester for the concession clamp: plays TODAY's scenario against the
// deployed backend through the public endpoints, using device_id
// "calibration" so runs are scored deterministically but never written to
// the daily rankings.
//
// Strategies:
//   grinder — sends ONLY bare numbers. The actor's ask must move at most
//             ~8% of the opening→floor span per turn (small grind steps).
//   talker  — makes substantive arguments; may earn real lever-based steps.
//
// Usage: POCKETBASE_URL=https://... node scripts/tester.mjs

const BASE = process.env.POCKETBASE_URL || "https://sn-pb-repo-1292607600-93600e.fly.dev";

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function grinder(scenario) {
  const ask = scenario.current_ask;
  let offer = ask ? Math.round(ask * 0.8) : 100;
  return {
    name: "grinder (bare numbers only)",
    next() {
      offer = Math.round(offer + ask * 0.02);
      return String(offer);
    },
  };
}

function talker(scenario) {
  const ask = scenario.current_ask;
  let offer = ask ? Math.round(ask * 0.7) : null;
  let i = 0;
  return {
    name: "talker (substantive arguments)",
    next(state, lastReply) {
      i++;
      const cur = (state && state.currentAsk) || ask;
      const m = String(lastReply || "").match(/(\d[\d.,]*)/g);
      if (/deal at|do we have a deal/i.test(lastReply || "") && m) {
        const proposed = Number(m[m.length - 1].replace(/[.,]/g, ""));
        if (proposed && proposed <= ask * 0.92) return `Yes — ${proposed} works. Deal at ${proposed}.`;
      }
      const lines = [
        `This unit's seen hard seasons — I'll take it as-is, no warranty claims, and handle the pickup and hauling myself. ${offer}?`,
        `I can pay cash today and be out of your way in an hour. Meet me at ${Math.round(offer * 1.05)}?`,
        `I'll send other dock crews your way too — you know my word is good. ${Math.round(offer * 1.1)}?`,
        `Final stretch: ${Math.round(cur * 0.97)} and we shake on it now.`,
        `Alright, ${cur}. Deal at ${cur}.`,
      ];
      return lines[Math.min(i - 1, lines.length - 1)].slice(0, 280);
    },
  };
}

async function play(factory) {
  const start = await api("/api/game/session/start", { device_id: "calibration", handle: "calibration" });
  if (start.status !== 200 || !start.body.session_token) {
    console.log("start failed:", start.status, JSON.stringify(start.body));
    return;
  }
  const scenario = start.body.scenario;
  const strat = factory(scenario);
  console.log(`\n=== ${strat.name} — "${scenario.title}" (opening ask ${scenario.current_ask}) ===`);
  let state = { currentAsk: scenario.current_ask, patience: scenario.patience, turns: 0 };
  let lastReply = scenario.opening_message;
  for (let t = 0; t < (scenario.max_turns || 10) + 1; t++) {
    const msg = strat.next(state, lastReply);
    const prevAsk = state.currentAsk;
    const turn = await api("/api/game/session/turn", { session_token: start.body.session_token, message: msg });
    if (turn.status !== 200) { console.log("turn failed:", turn.status, JSON.stringify(turn.body)); return; }
    state = turn.body.state || state;
    lastReply = turn.body.message;
    const moved = prevAsk != null && state.currentAsk != null ? prevAsk - state.currentAsk : null;
    console.log(`player: ${msg}`);
    console.log(`actor : ${lastReply}`);
    console.log(`   [ask ${prevAsk} -> ${state.currentAsk} (moved ${moved}), patience ${state.patience}, turn ${state.turns}]`);
    if (turn.body.done) {
      console.log(`   DONE: ${turn.body.outcome}${turn.body.dealPrice != null ? " at " + turn.body.dealPrice : ""}, score ${turn.body.score ?? "-"} (${turn.body.label ?? "-"})`);
      return;
    }
  }
}

await play(grinder);
await play(talker);
