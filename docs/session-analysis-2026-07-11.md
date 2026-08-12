# Talked Down — Session Data Analysis (2026-07-11)

Backend: https://sn-pb-repo-1292607600-93600e.fly.dev · generated from the live session, score, and incident collections.

## Overview

- Sessions: **327** (deals 53, no-deals 22, abandoned/active 252)
- Scored plays: **53**
- Incidents flagged: **49**

## Score distribution

- Overall: n=53, min=0, median=40, mean=38.5, max=95
- 2026-07-08: n=10, median=27.5, best=60
- 2026-07-09: n=21, median=38, best=46
- 2026-07-10: n=16, median=52, best=69
- day #0: n=5, median=85, best=95
- day #2: n=1, median=94, best=94

Result labels:
- Fair Dealer: 20
- Paid Too Much: 13
- No Deal: 12
- Master Negotiator: 4
- Smooth Talker: 4

## Drop-off

- 23% of started sessions reach an ending (deal or no-deal); 252 are still active/abandoned.
- Sessions created since timestamp tracking shipped: 104 (27 deals, 1 no-deal, 76 active/abandoned), a 27% completion rate.
- Of those 76 active timestamped sessions, 75 have no player message and one has one message. Pre-message drop-off remains the clearest friction point.

## Message counts

- Player turns stay well below the 15-message cap. Completed recent sessions generally close in 1–7 turns; cap pressure is not indicated.
- The timestamped cohort is too young and too sparse to attribute a causal effect to the opener chips.

## Transcript patterns (tactics)

- The completed timestamped cohort contains successful concrete offers, practical trade-offs, and explicit acceptance. No new tactic sample is large enough to replace the prior observation that flattery and logic outperform hostility.

## Incidents

- concession_clamped: 15
- invalid_accept_unconfirmed: 7
- claim_verify_failed: 6
- decision_snapped: 20
- actor_unavailable: 1
- The integrity guardrails continue to catch constrained concessions and unconfirmed accepts.

## Decision

No product change shipped today. The new timestamp cohort gives only one day of observation, and the most obvious friction signal is already the opener flow being measured. Changing difficulty or the UI now would confound that measurement. Keep the current experience stable for another daily sample, then compare first-message and completion rates across timestamped cohorts.
