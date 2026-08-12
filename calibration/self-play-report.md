# Talked Down — self-play difficulty calibration report

- Generated: 2026-07-08T13:00:05.712Z
- Backend: https://sn-pb-repo-1292607600-93600e.fly.dev
- Scenarios played: 2 (all published)
- Strategies: naive_lowball (weak), hostile (adversarial), skilled (strong scripted haggler)
- Calibration sessions are scored server-side with the production formula but excluded from daily rankings.

## Summary by strategy

- **naive_lowball**: 0/2 deals, avg score 0/100
- **hostile**: 0/2 deals, avg score 0/100
- **skilled**: 1/2 deals, avg score 33/100

## Per-scenario results

### Negotiating an urgent cargo shipment on a storm-threatened space dock (2026-07-08)
- naive_lowball: no_deal in 6 turns — score 0/100 (No Deal)
- hostile: no_deal in 9 turns — score 0/100 (No Deal)
- skilled: no_deal in 12 turns — score 0/100 (No Deal)

### Securing the Private Art Commission Before the Gala (2026-07-09)
- naive_lowball: no_deal in 5 turns — score 0/100 (No Deal)
- hostile: no_deal in 5 turns — score 0/100 (No Deal)
- skilled: deal in 3 turns — score 66/100 (Smooth Talker)

## Verdict

- Hard: weak/adversarial strategies close only 0% of deals → PASS
- Beatable: skilled strategy closes 1/2 deals (avg score 66/100 on deals) → PASS
- Overall: HARD BUT BEATABLE ✅

## Cross-run note

A second full run (calibration/self-play-report-run2.md) closed BOTH scenarios with the skilled strategy (72/100 and 61/100) while weak/adversarial strategies again closed 0/4. Across both runs every published scenario was beaten at least once by the skilled strategy and never by weak strategies: hard but beatable holds per scenario.
