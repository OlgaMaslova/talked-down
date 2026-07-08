import type { EngineConfig } from './engine';

export interface ScoringConfig {
  max_score: number;
  price_weight: number;
  turns_weight: number;
  patience_weight: number;
}

export interface ScoreResult {
  score: number;
  label: string;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Computes the final score for a finished negotiation.
 * - dealPrice undefined => no deal was reached: score is always 0.
 * - Otherwise price/turns/patience each contribute a weighted slice
 *   (weights come from the scenario's scoring_config).
 */
export function computeScore(
  scoring: ScoringConfig,
  engine: EngineConfig,
  dealPrice: number | undefined,
  turns: number,
  patienceRemaining: number,
): ScoreResult {
  if (dealPrice === undefined) {
    return { score: 0, label: 'No Deal' };
  }

  const isBuy = engine.direction === 'buy';
  const opening = engine.opening_price;
  const floor = engine.floor_price;

  let priceFraction: number;
  if (isBuy) {
    priceFraction = opening === floor ? 1 : (opening - dealPrice) / (opening - floor);
  } else {
    priceFraction = floor === opening ? 1 : (dealPrice - opening) / (floor - opening);
  }
  priceFraction = clamp01(priceFraction);
  const priceScore = priceFraction * scoring.price_weight;

  const clampedTurns = Math.min(Math.max(turns, 1), 10);
  const turnsFraction = clamp01(1 - (clampedTurns - 1) / 9);
  const turnsScore = turnsFraction * scoring.turns_weight;

  const initialPatience = engine.patience;
  const patienceFraction = initialPatience > 0 ? clamp01(patienceRemaining / initialPatience) : 0;
  const patienceScore = patienceFraction * scoring.patience_weight;

  const rawTotal = priceScore + turnsScore + patienceScore;
  const score = Math.max(0, Math.min(scoring.max_score, Math.round(rawTotal)));

  let label: string;
  if (score >= 85) label = 'Master Negotiator';
  else if (score >= 65) label = 'Smooth Talker';
  else if (score >= 40) label = 'Fair Dealer';
  else if (score > 0) label = 'Paid Too Much';
  else label = 'No Deal';

  return { score, label };
}
