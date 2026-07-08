// LLM-backed negotiation engine.
//
// Implements the same `NegotiationEngine` contract as the rule engine
// (src/engine.ts), but instead of computing the character's next line
// locally it delegates to the backend's LLM negotiation session, keyed by
// `sessionToken`. All negotiation state (patience, current ask, turn count,
// outcome) is authoritative on the server; this module simply forwards the
// player's message and relays back whatever the server decides.
import type { CharacterTurn, CharacterTurnState, NegotiationEngine } from './engine';
import { apiBaseUrl } from './pocketbase';

/**
 * Thrown by `respond` when the backend rejects the message for being over
 * the session's `max_message_chars` house rule (HTTP 400,
 * `{error: "message_too_long", max_message_chars}`). Callers can catch this
 * specifically to show an inline "keep it shorter" notice instead of the
 * generic "line went quiet" failure message.
 */
export class MessageTooLongError extends Error {
  readonly maxMessageChars: number;

  constructor(maxMessageChars: number) {
    super(`Message too long (max ${maxMessageChars} chars)`);
    this.name = 'MessageTooLongError';
    this.maxMessageChars = maxMessageChars;
  }
}

/**
 * @param sessionToken opaque token returned by POST /api/game/session/start
 * @param startState   initial {patience, currentAsk, turns} from the start response's scenario
 */
export function createLlmEngine(sessionToken: string, startState: CharacterTurnState): NegotiationEngine {
  function start(): CharacterTurn {
    // Mirrors createRuleEngine's start(): returns the initial state with no
    // message (the scenario's opening_message is rendered separately by the
    // caller) and does not consume a turn.
    return {
      message: '',
      done: false,
      state: startState,
    };
  }

  async function respond(userMessage: string): Promise<CharacterTurn> {
    const res = await fetch(`${apiBaseUrl}/api/game/session/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: sessionToken, message: userMessage }),
    });

    if (!res.ok) {
      if (res.status === 400) {
        try {
          const data = await res.json();
          if (data && data.error === 'message_too_long') {
            const max = typeof data.max_message_chars === 'number' ? data.max_message_chars : 280;
            throw new MessageTooLongError(max);
          }
        } catch (err) {
          if (err instanceof MessageTooLongError) throw err;
          // JSON parse failure or other shape mismatch: fall through to the
          // generic error below.
        }
      }
      throw new Error(`Negotiation turn request failed (${res.status})`);
    }

    const data = (await res.json()) as CharacterTurn;
    return data;
  }

  return { start, respond };
}
