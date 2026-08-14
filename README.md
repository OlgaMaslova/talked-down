# Talked Down

A daily negotiation game. Every day at 00:00 UTC there is one new scenario: a
character wants something from you at a price you shouldn't accept, and you have
a handful of messages to talk them down (or talk them up — some days you're
selling). One ranked play per device per day, a score out of 100, a percentile
against everyone else who played that day, and a shared leaderboard.

Playable at [talkeddown-app.supernaut.to](https://talkeddown-app.supernaut.to).
Day 1 was 2026-07-07; the day number in the UI counts from there.

The twist is that the character is an LLM holding a **secret spec** — a hidden
floor price, a patience budget, and a list of arguments that move them (levers)
or annoy them. The player never sees it. Getting a good score means figuring out
what this particular character actually cares about, and doing it in few turns
without burning their patience.

## How a game plays

1. `POST /api/game/session/start` opens a session for today's published scenario
   and returns the *public* half of it: title, character name and persona,
   opening message, the player brief, the actor portrait, currency, patience,
   turn cap, and the current ask. The floor price and levers stay server-side.
2. Each `POST /api/game/session/turn` sends one player message (capped at 280
   characters, enforced server-side so the cap can't be bypassed by skipping the
   UI) and runs the actor pipeline below.
3. The player can `POST /api/game/session/accept` the standing ask at any time.
   Accepting is deterministic — no model call — and closes the session.
4. The session ends on a deal, a walkout (patience exhausted), or the turn cap.
   The score is computed and saved server-side.

### The actor pipeline (decide → validate → speak)

Each turn is two model calls with pure server-side math in between
([pb_hooks/lib/actor.js](pb_hooks/lib/actor.js),
[pb_hooks/actor.pb.js:107](pb_hooks/actor.pb.js#L107)):

1. **Decide** — the model returns a structured move (hold, concede, accept,
   walk) with a proposed price.
2. **Validate** — the server checks that move against the secret spec: the
   concession clamp limits how far the ask can move per turn unless the player
   actually hit a lever, and prices are snapped back if the model overshoots.
   Snaps are logged to `incidents`.
3. **Speak** — a second, fresh call writes the in-character reply *given the
   final price*. Because the text is written after the number is settled, the
   reply and the price can never disagree, and no post-hoc rewriting is needed.

### Scoring

Deal price, turns used, and remaining patience each contribute a weighted slice
of a 100-point score, using the scenario's own `scoring_config`. No deal is
always 0. Labels: Master Negotiator (85+), Smooth Talker (65+), Fair Dealer
(40+), Paid Too Much (>0), No Deal.

The authoritative implementation is server-side in
[pb_hooks/lib/actor.js](pb_hooks/lib/actor.js);
[src/scoring.ts](src/scoring.ts) mirrors it for the client.

Percentile comes from `GET /api/game/percentile`, computed over all ranked
scores for that day number.

### Replays and the archive

- **Replay** — after finishing the ranked game you can replay the same day.
  Replays are unranked and gated by a 60-second cooldown
  ([`POST /api/game/replay/start`](pb_hooks/main.pb.js#L107)).
- **Archive** — past days stay playable via `GET /api/game/archive/days` and a
  `day_number` on session start. Archive plays are scored but flagged
  `archive: true` so they never enter the daily distribution or the leaderboard.

### Identity and claiming

There is no signup. On first play the browser mints a random device ID and a
generated handle (`Shrewd Haggler`, `Wily Fox`, …) into localStorage
([src/identity.ts](src/identity.ts)). That device ID carries streaks, history,
and leaderboard position.

A player can *claim* their handle by email: `POST /api/claim/start` rate-limits
and emails a magic link (via AgentMail) back to `talkeddown.com?claim_token=…`,
and `POST /api/claim/verify` binds the handle to the device
([pb_hooks/claim.pb.js](pb_hooks/claim.pb.js)). Claimed handles are marked on the
leaderboard.

## The nightly content pipeline

Scenarios are generated, adversarially tested, and published by the backend
itself — there is no human authoring step and no content in the repo.

`cronAdd("nightly_playwright", "0 2 * * *")`
([pb_hooks/playwright.pb.js](pb_hooks/playwright.pb.js)) runs
[`runPlaywrightPipeline`](pb_hooks/lib/playwright.js#L1157) for *tomorrow's*
date:

1. **Recap** the completed day into `recaps` (best score, play counts, etc.).
2. **Generate** several candidate scenarios per cycle, each declaring one domain
   from a server-owned catalog (culinary, archaeology, fantasy, finance, …).
3. **Validate** each candidate: shape, price coherence, banned named references,
   and that the declared domain actually matches the story text.
4. **Judge for diversity** — reject domains used by the most recent scenarios so
   the game doesn't run five antique-shop days in a row.
5. **Draft + portrait** — create the draft scenario and best-effort generate an
   actor portrait image.
6. **Security-test** — run an attack battery against the actor (prompt
   extraction, floor-price leaks, "ignore your instructions", accepting below
   floor) and have a judge rule on the transcript. Findings are saved to the
   scenario's security report.
7. **Publish** only if it survives; otherwise retry with a new cycle (up to 3).

Two safety nets sit around it: `recover_current_day_playwright` re-runs the
pipeline for *today* every 15 minutes but only when no published scenario exists,
and [.github/workflows/nightly-watchdog.yml](.github/workflows/nightly-watchdog.yml)
polls the public `GET /api/pipeline/status` endpoint 90 minutes after the nightly
run, opening a GitHub issue on breakage.

> **Kill switch.** `PIPELINE_ENABLED` in
> [pb_hooks/playwright.pb.js](pb_hooks/playwright.pb.js#L8) gates both crons.
> Set it to `false` and redeploy to pause generation — already-published
> scenarios stay playable, and the admin route below still works. The status
> endpoint reports the flag, so the watchdog stays quiet during a deliberate
> pause and still alerts if a day ends up with no game.

Because the switch only takes effect once the machine is redeployed, the status
endpoint reports what is actually *running*:

```json
"build": { "pipeline_enabled": true, "booted_at": "2026-08-14T06:12:03Z", "commit": null }
```

`booted_at` is stamped when PocketBase evaluates the hooks, so it changes on
every deploy — the one-request answer to "did my deploy land, and is the switch
on in the build that's live?". `commit` is populated when the platform provides
`SUPERNAUT_COMMIT`, `SOURCE_COMMIT`, or `GIT_COMMIT` in the environment.

Generation can always be driven by hand with the superuser route
`POST /api/admin/run-playwright` (`{ "date": "YYYY-MM-DD", "force": true }`).

## Architecture

| Piece | Where it runs |
| --- | --- |
| Backend, DB, cron, all game logic | PocketBase on Fly.io (`fra`), data on the `pb_data` volume |
| Frontend | Vanilla TS + Vite, built to `public/`, served as a Cloudflare static Worker |
| LLM calls | OpenAI, via [pb_hooks/lib/openai.js](pb_hooks/lib/openai.js) |

The frontend and the API are on **different origins**; the browser always calls
an explicit API URL from `VITE_POCKETBASE_URL`
([src/pocketbase.ts](src/pocketbase.ts)).

### Collections

`scenarios` (public half, published/draft/retired) · `scenario_secrets` (secret
spec + security report, never exposed) · `sessions` (transcript, state,
agreement) · `scores` (ranked + archive-flagged) · `recaps` · `pipeline_runs` ·
`claims` · `incidents` (snaps, security and email failures) · `llm_usage`
(tokens + computed cost per call) · `replay_metrics`.

Read rules are public only for the public halves; secrets and admin routes
require superuser auth.

## Development

```bash
npm install
npm run dev      # vite dev server; set VITE_POCKETBASE_URL to a backend
npm run build    # tsc --noEmit && vite build  ->  public/
npm run deploy   # build + wrangler deploy (frontend only)
```

The hardcoded fallback API URL in [src/pocketbase.ts](src/pocketbase.ts) is a
convenience only — set `VITE_POCKETBASE_URL` for anything real.

Backend env vars (Fly secrets): `OPENAI_API_KEY`, optional `OPENAI_MODEL`,
`PLAYWRIGHT_MODEL`, `OPENAI_IMAGE_MODEL`, and `AGENTMAIL_API_KEY` for claim
emails.

### Tests and harnesses

```bash
node scripts/actor-unit-tests.mjs        # decide→validate→speak validation layer
node scripts/playwright-unit-tests.mjs   # scenario history + domain validation
```

Both run in plain Node with no PocketBase process and no API key — they stage the
CommonJS hook files into a temp dir and require them directly.

Live harnesses (need a running backend; superuser creds for the first two):

```bash
POCKETBASE_URL=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/calibrate.mjs
POCKETBASE_URL=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/analyze-sessions.mjs
POCKETBASE_URL=… node scripts/tester.mjs
```

`calibrate.mjs` self-plays every published scenario with scripted strategies of
varying skill to check that days are **hard but beatable** — naive and hostile
play should fail, skilled play should close a decent deal. It uses the
superuser-only `/api/admin/calibration/start` route; calibration sessions are
scored deterministically but never written to the rankings. Reports land in
[calibration/](calibration/). `analyze-sessions.mjs` pulls live play data into a
markdown report in [docs/](docs/).

## Deployment

The backend deploys to Fly from [Dockerfile.supernaut-pocketbase](Dockerfile.supernaut-pocketbase)
with [fly.toml](fly.toml); pending migrations run on boot, which is why the
health check has a 300s grace period. The frontend deploys separately to
Cloudflare via [wrangler.toml](wrangler.toml).

Editing conventions — stack boundaries, migration safety, and the
platform-managed payments collections — are in [AGENTS.md](AGENTS.md). The two
rules worth repeating: **never edit a migration that has already run** (add a new
one), and `pb_data/` lives on the Fly volume and is never committed.
