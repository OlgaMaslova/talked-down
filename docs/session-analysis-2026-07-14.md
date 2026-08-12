# Talked Down — Session Data Analysis (2026-07-14)

Backend: https://sn-pb-repo-1292607600-93600e.fly.dev · live session, score, and incident data

## Overview

- Sessions: **366** (deals 61, no-deals 22, abandoned/active 283)
- Scored plays: **61**
- Incidents flagged: **51**

## Score distribution

- Overall: n=61, min=0, median=40, mean=39.1, max=95
- 2026-07-08: n=10, median=27.5, best=60
- 2026-07-09: n=21, median=38, best=46
- 2026-07-10: n=16, median=52, best=69
- 2026-07-11: n=6, median=43, best=60
- 2026-07-12: n=1, median=62, best=62
- 2026-07-13: n=1, median=18, best=18
- day #0: n=5, median=85, best=95
- day #2: n=1, median=94, best=94

Result labels:
- Fair Dealer: 26
- Paid Too Much: 15
- No Deal: 12
- Smooth Talker: 4
- Master Negotiator: 4

## Drop-off

- 23% of started sessions reach an ending (deal or no-deal); 283 are still active/abandoned.
- Abandoners quit after a median of 0 player messages.
- Since the July 12 report, nine additional active sessions have been created without a corresponding improvement in the early-turn completion signal.

## Message counts

- Player messages per session: median=0, maximum=12 (cap 15).
- Message length remains below a cap-pressure threshold; no player is approaching the 15-message limit in the new sample.

## Transcript patterns (tactics)

- flattery: used in 17 sessions, 10 deals (59% deal rate)
- hostility: used in 5 sessions, 1 deal (20% deal rate)
- logic: used in 22 sessions, 12 deals (55% deal rate)
- walkaway: used in 9 sessions, 3 deals (33% deal rate)

## Incidents

- claim_verify_failed: 6
- invalid_accept_unconfirmed: 7
- concession_clamped: 15
- decision_snapped: 22
- actor_unavailable: 1

## Decision

No product change shipped today. The score distribution remains calibrated (40/100 median), integrity events did not increase, and the only new tactic evidence is a single successful logical/budget-focused negotiation. The persistent pre-message drop-off remains the dominant constraint, but the additional sample still does not isolate a new, safe UI or difficulty adjustment beyond the opener flow already under observation.
