// Rule-based negotiation engine for "Talked Down".
//
// The chat UI (src/main.ts) only ever talks to the `NegotiationEngine`
// interface below. `createRuleEngine` is a deterministic, keyword/offer
// parsing implementation of that interface. A future LLM-backed engine
// (e.g. `createLlmEngine(config, chatCompletionFn): NegotiationEngine`)
// can be dropped in as a straight replacement for `createRuleEngine` in
// main.ts without any other code changing, as long as it:
//   - is constructed from the same `EngineConfig` shape (loaded from the
//     scenario's `engine_config` JSON field), and
//   - implements `start()` / `respond(userMessage)` returning the same
//     `CharacterTurn` shape.

export interface EngineKeywords {
  flatter: string[];
  insult: string[];
  logic: string[];
  walkaway: string[];
}

export interface EngineResponses {
  accept: string;
  concede: string;
  reject_low: string;
  walkaway_call: string;
  fail: string;
}

export interface EngineConfig {
  direction: 'buy' | 'sell';
  item: string;
  currency: string;
  opening_price: number;
  floor_price: number;
  fair_price: number;
  patience: number;
  concession_ladder: number[];
  keywords: EngineKeywords;
  responses: EngineResponses;
}

export interface CharacterTurnState {
  patience: number;
  currentAsk: number;
  turns: number;
}

export interface CharacterTurn {
  message: string;
  done: boolean;
  outcome?: 'deal' | 'no_deal';
  dealPrice?: number;
  state: CharacterTurnState;
}

/** Contract any negotiation "brain" (rule-based today, LLM-based later) must implement. */
export interface NegotiationEngine {
  /** Initializes/returns the starting state. Does not consume a user turn. */
  start(): CharacterTurn;
  /**
   * Consumes one user message and advances the negotiation by one turn.
   * Async because LLM-backed implementations need a network round trip;
   * the rule engine resolves immediately. May reject (e.g. a network
   * error) — callers must not treat a rejection as consuming the turn.
   */
  respond(userMessage: string): Promise<CharacterTurn>;
}

const MAX_TURNS = 10;
const NEXT_STEP_TOLERANCE = 0.05;

function parseOffer(text: string): number | null {
  const match = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const cleaned = match[0].replace(/,/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function includesKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

const PROD_LINES = [
  "So, what number are we talking?",
  "Come now — make me an offer.",
  "I haven't got all day. What's your number?",
  "Talk price with me, or talk to someone else.",
];

/** Deterministic, config-driven implementation of NegotiationEngine. */
export function createRuleEngine(config: EngineConfig): NegotiationEngine {
  const ladder = config.concession_ladder.length > 0 ? config.concession_ladder : [config.opening_price];
  const isBuy = config.direction === 'buy';
  const limit = config.floor_price;

  let patience = config.patience;
  let ladderIndex = 0;
  let currentAsk = ladder[ladderIndex];
  let turns = 0;
  let flatterUses = 0;
  let logicUses = 0;
  let walkawayUsed = false;
  let noInputStreak = 0;
  let done = false;
  let prodIndex = 0;

  const meetsAsk = (v: number) => (isBuy ? v >= currentAsk : v <= currentAsk);
  const beyondLimit = (v: number) => (isBuy ? v < limit : v > limit);
  const meetPoint = (v: number) => (isBuy ? Math.max(v, limit) : Math.min(v, limit));
  const nearNextStep = (v: number) => {
    const nextIdx = Math.min(ladderIndex + 1, ladder.length - 1);
    const nextStep = ladder[nextIdx];
    return isBuy ? v >= nextStep * (1 - NEXT_STEP_TOLERANCE) : v <= nextStep * (1 + NEXT_STEP_TOLERANCE);
  };
  const concedeOneStep = () => {
    ladderIndex = Math.min(ladderIndex + 1, ladder.length - 1);
    currentAsk = ladder[ladderIndex];
  };
  const concedeTwoSteps = () => {
    ladderIndex = Math.min(ladderIndex + 2, ladder.length - 1);
    currentAsk = ladder[ladderIndex];
  };
  const genericProd = () => {
    const line = PROD_LINES[prodIndex % PROD_LINES.length];
    prodIndex += 1;
    return line;
  };
  const snapshot = (message: string, outcome?: 'deal' | 'no_deal', dealPrice?: number): CharacterTurn => ({
    message,
    done,
    outcome,
    dealPrice,
    state: { patience, currentAsk, turns },
  });

  function start(): CharacterTurn {
    return snapshot('');
  }

  async function respond(userMessage: string): Promise<CharacterTurn> {
    if (done) {
      return snapshot('');
    }

    turns += 1;

    const offer = parseOffer(userMessage);
    const isFlatter = includesKeyword(userMessage, config.keywords.flatter);
    const isInsult = includesKeyword(userMessage, config.keywords.insult);
    const isLogic = includesKeyword(userMessage, config.keywords.logic);
    const isWalkaway = includesKeyword(userMessage, config.keywords.walkaway);

    let message = '';
    let outcome: 'deal' | 'no_deal' | undefined;
    let dealPrice: number | undefined;

    if (offer !== null) {
      noInputStreak = 0;
      if (meetsAsk(offer)) {
        dealPrice = currentAsk;
        outcome = 'deal';
        message = config.responses.accept;
      } else if (beyondLimit(offer)) {
        patience -= 1;
        message = config.responses.reject_low;
      } else if (nearNextStep(offer)) {
        const meeting = meetPoint(offer);
        concedeOneStep();
        currentAsk = meeting;
        dealPrice = meeting;
        outcome = 'deal';
        message = config.responses.accept;
      } else {
        // Offer is within the acceptable range (not beyond the floor) but not
        // close enough to close: the character counters by conceding one step.
        concedeOneStep();
        message = config.responses.concede;
      }
    } else if (isWalkaway) {
      noInputStreak = 0;
      if (!walkawayUsed) {
        walkawayUsed = true;
        concedeTwoSteps();
        message = config.responses.walkaway_call;
      } else {
        outcome = 'no_deal';
        message = config.responses.fail;
      }
    } else if (isInsult) {
      noInputStreak = 0;
      patience -= 2;
      message = config.responses.reject_low;
    } else if (isFlatter && flatterUses < 2) {
      noInputStreak = 0;
      flatterUses += 1;
      concedeOneStep();
      message = config.responses.concede;
    } else if (isLogic) {
      noInputStreak = 0;
      logicUses += 1;
      concedeOneStep();
      if (logicUses % 2 === 1) {
        patience -= 1;
      }
      message = config.responses.concede;
    } else {
      noInputStreak += 1;
      message = genericProd();
      if (noInputStreak >= 2) {
        patience -= 1;
      }
    }

    if (outcome !== 'deal' && outcome !== 'no_deal') {
      if (patience <= 0) {
        outcome = 'no_deal';
        message = config.responses.fail;
      } else if (turns >= MAX_TURNS) {
        outcome = 'no_deal';
        message = config.responses.fail;
      }
    }

    done = outcome === 'deal' || outcome === 'no_deal';

    return snapshot(message, outcome, dealPrice);
  }

  return { start, respond };
}
