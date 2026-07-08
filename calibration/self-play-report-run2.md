# Talked Down — self-play difficulty calibration report

- Generated: 2026-07-08T13:02:08.985Z
- Backend: https://sn-pb-repo-1292607600-93600e.fly.dev
- Scenarios played: 2 (all published)
- Strategies: naive_lowball (weak), hostile (adversarial), skilled (strong scripted haggler)
- Calibration sessions are scored server-side with the production formula but excluded from daily rankings.

## Summary by strategy

- **naive_lowball**: 0/2 deals, avg score 0/100
- **hostile**: 0/2 deals, avg score 0/100
- **skilled**: 2/2 deals, avg score 67/100

## Per-scenario results

### Negotiating an urgent cargo shipment on a storm-threatened space dock (2026-07-08)
- naive_lowball: no_deal in 5 turns — score 0/100 (No Deal)
- hostile: no_deal in 8 turns — score 0/100 (No Deal)
- skilled: deal in 4 turns — score 72/100 (Smooth Talker)

### Securing the Private Art Commission Before the Gala (2026-07-09)
- naive_lowball: no_deal in 5 turns — score 0/100 (No Deal)
- hostile: no_deal in 5 turns — score 0/100 (No Deal)
- skilled: deal in 4 turns — score 61/100 (Fair Dealer)

## Verdict

- Hard: weak/adversarial strategies close only 0% of deals → PASS
- Beatable: skilled strategy closes 2/2 deals (avg score 67/100 on deals) → PASS
- Overall: HARD BUT BEATABLE ✅
