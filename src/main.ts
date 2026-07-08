import './styles.css';
import { pb, apiBaseUrl } from './pocketbase';
import { createRuleEngine, type CharacterTurn, type CharacterTurnState, type EngineConfig, type NegotiationEngine } from './engine';
import { createLlmEngine } from './llmEngine';
import { computeScore, type ScoringConfig, type ScoreResult } from './scoring';

interface ScenarioRecord {
  id: string;
  day_index: number;
  title: string;
  character_name: string;
  character_persona: string;
  opening_message: string;
  engine_config: EngineConfig;
  scoring_config: ScoringConfig;
}

/** Public fields of an LLM-generated scenario, as returned by session/start. */
interface LlmScenario {
  title: string;
  character_name: string;
  character_persona: string;
  opening_message: string;
  player_brief?: string | null;
  currency: string;
  patience: number;
  max_turns: number;
  current_ask: number | null;
}

interface SessionStartLlm {
  llm: true;
  session_token: string;
  scenario: LlmScenario;
}

interface SessionStartNoLlm {
  llm: false;
}

type SessionStartResponse = SessionStartLlm | SessionStartNoLlm;

const EPOCH_MS = Date.UTC(2026, 6, 7); // 2026-07-07T00:00:00Z is day #1
const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_LAST_DAY_KEY = 'td_last_day';
const STREAK_COUNT_KEY = 'td_streak';

function safeMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function getDayNumber(): number {
  return Math.floor((Date.now() - EPOCH_MS) / DAY_MS) + 1;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatAsk(value: number, currency: string | null): string {
  const rounded = Math.round(value);
  const symbol = (currency ?? '').trim();
  if (!symbol) return rounded.toLocaleString();
  const isPrefixSymbol = symbol.length <= 2 && /[^a-zA-Z0-9\s]/.test(symbol);
  return isPrefixSymbol ? `${symbol}${rounded.toLocaleString()}` : `${rounded.toLocaleString()} ${symbol}`;
}

function updateStreak(dayNumber: number): number {
  const lastDayRaw = localStorage.getItem(STREAK_LAST_DAY_KEY);
  const streakRaw = localStorage.getItem(STREAK_COUNT_KEY);
  const lastDay = lastDayRaw !== null ? parseInt(lastDayRaw, 10) : null;
  let streak = streakRaw !== null ? parseInt(streakRaw, 10) : 0;

  if (lastDay === dayNumber) {
    // Already recorded a play for today; leave streak untouched.
    if (streak <= 0) streak = 1;
  } else if (lastDay !== null && dayNumber === lastDay + 1) {
    streak += 1;
  } else {
    streak = 1;
  }

  localStorage.setItem(STREAK_LAST_DAY_KEY, String(dayNumber));
  localStorage.setItem(STREAK_COUNT_KEY, String(streak));
  return streak;
}

async function fetchTodayScenario(dayNumber: number): Promise<ScenarioRecord> {
  const dayIndex = safeMod(dayNumber - 1, 7);
  return pb.collection('scenarios').getFirstListItem<ScenarioRecord>(`day_index=${dayIndex}`);
}

/**
 * Calls the backend's session/start route. Returns null when the call fails
 * outright (network error, non-2xx, unexpected shape) so callers can fall
 * back to the existing seeded rule-engine flow.
 */
async function startBackendSession(): Promise<SessionStartResponse | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.llm === true && data.session_token && data.scenario) {
      return data as SessionStartLlm;
    }
    if (data && data.llm === false) {
      return { llm: false };
    }
    return null;
  } catch {
    return null;
  }
}

async function submitScore(
  dayIndex: number,
  score: number,
  turns: number,
  resultLabel: string,
  scenarioId?: string,
): Promise<void> {
  const payload: Record<string, unknown> = { day_index: dayIndex, score, turns, result_label: resultLabel };
  if (scenarioId) payload.scenario = scenarioId;
  try {
    await pb.collection('scores').create(payload);
  } catch {
    try {
      const fallbackPayload: Record<string, unknown> = { score, turns, result_label: resultLabel };
      if (scenarioId) fallbackPayload.scenario = scenarioId;
      await pb.collection('scores').create(fallbackPayload);
    } catch {
      // Saving the score is best-effort; never let it break the game.
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Deterministic client-side score for LLM sessions.
 *
 * LLM scenarios don't ship an opening/floor price pair client-side (only a
 * possibly-null `current_ask`), so `computeScore`'s price-fraction formula
 * can't be reused as-is. This is a simple, clearly-labeled heuristic based
 * only on the outcome, turns used, and patience left that the server
 * returned on the final turn — no LLM call, no hidden parameters.
 */
function computeLlmScore(turn: CharacterTurn, maxPatience: number, maxTurns: number): ScoreResult {
  const patienceLeft = Math.max(0, turn.state.patience);
  const patienceRatio = maxPatience > 0 ? clamp01(patienceLeft / maxPatience) : 0;
  const turnsUsed = Math.max(1, turn.state.turns);
  const turnsRatio = clamp01(1 - (turnsUsed - 1) / Math.max(1, maxTurns - 1));

  if (turn.outcome === 'deal') {
    const score = Math.max(0, Math.min(100, Math.round(60 + patienceRatio * 25 + turnsRatio * 15)));
    let label: string;
    if (score >= 85) label = 'Master Negotiator';
    else if (score >= 65) label = 'Smooth Talker';
    else label = 'Fair Dealer';
    return { score, label };
  }

  const score = Math.max(0, Math.min(20, Math.round(patienceRatio * 20)));
  return { score, label: 'No Deal' };
}

function buildShareText(
  dayNumber: number,
  outcome: 'deal' | 'no_deal',
  turns: number,
  score: number,
): string {
  const line1 = `Talked Down #${dayNumber}`;
  const line2 = outcome === 'deal' ? `🤝 Deal in ${turns} turn${turns === 1 ? '' : 's'}` : '💥 No deal';

  const moneyFilled = Math.min(5, Math.max(0, Math.round(score / 20)));
  const moneyBar = '💰'.repeat(moneyFilled) + '⬜'.repeat(5 - moneyFilled);
  const line3 = `${moneyBar} ${score}/100`;

  return [line1, line2, line3].join('\n');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy fallback
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function startCountdown(el: HTMLElement): void {
  const update = () => {
    const now = new Date();
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
    const diff = Math.max(0, nextMidnight - Date.now());
    const totalSeconds = Math.floor(diff / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    el.textContent = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  };
  update();
  window.setInterval(update, 1000);
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/** Everything renderGame needs, whether the negotiation is rule-engine or LLM driven. */
interface GameContext {
  dayNumber: number;
  streak: number;
  title: string;
  characterName: string;
  characterPersona: string;
  playerBrief?: string | null;
  openingMessage: string;
  currency: string | null;
  maxPatience: number;
  showAsk: boolean;
  engine: NegotiationEngine;
  initialTurn: CharacterTurn;
  scoreTurn: (turn: CharacterTurn) => ScoreResult;
  recordScore: (score: number, label: string, turn: CharacterTurn) => void;
}

function renderGame(root: HTMLElement, ctx: GameContext): void {
  const initialTurn = ctx.initialTurn;

  root.innerHTML = `
    <div class="game">
      <header class="game-header">
        <span class="day-badge">Talked Down #${ctx.dayNumber}</span>
        <h1 class="scenario-title">${escapeHtml(ctx.title)}</h1>
        <div class="character-line">
          <span class="char-name">${escapeHtml(ctx.characterName)}</span>
          <span class="char-persona">${escapeHtml(ctx.characterPersona)}</span>
        </div>
        ${ctx.playerBrief ? `<p class="player-brief">${escapeHtml(ctx.playerBrief)}</p>` : ''}
        <div class="meters">
          ${
            ctx.showAsk
              ? `<div class="ask-display">
            <span class="ask-label">Current ask</span>
            <div class="ask-value" id="ask-value">${formatAsk(initialTurn.state.currentAsk, ctx.currency)}</div>
          </div>`
              : ''
          }
        </div>
      </header>
      <div class="chat-log" id="chat-log"></div>
      <form class="input-row" id="input-row">
        <input id="chat-input" type="text" placeholder="Type your offer or say something…" autocomplete="off" />
        <button type="submit" id="send-btn">Send</button>
      </form>
      <div class="end-panel hidden" id="end-panel"></div>
    </div>
  `;

  const chatLog = root.querySelector<HTMLElement>('#chat-log');
  const inputRow = root.querySelector<HTMLFormElement>('#input-row');
  const chatInput = root.querySelector<HTMLInputElement>('#chat-input');
  const sendBtn = root.querySelector<HTMLButtonElement>('#send-btn');
  const askValue = root.querySelector<HTMLElement>('#ask-value');
  const endPanel = root.querySelector<HTMLElement>('#end-panel');

  if (!chatLog || !inputRow || !chatInput || !sendBtn || !endPanel) {
    return;
  }

  const addBubble = (container: HTMLElement, sender: 'character' | 'user' | 'system', text: string): HTMLElement => {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${sender}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  };

  const addTypingBubble = (container: HTMLElement): HTMLElement => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble character typing';
    bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  };

  addBubble(chatLog, 'character', ctx.openingMessage);

  const applyState = (turn: CharacterTurn): void => {
    if (askValue) askValue.textContent = formatAsk(turn.state.currentAsk, ctx.currency);
  };

  const endGame = (turn: CharacterTurn): void => {
    chatInput.disabled = true;
    sendBtn.disabled = true;

    const outcome: 'deal' | 'no_deal' = turn.outcome === 'deal' ? 'deal' : 'no_deal';
    const { score, label } = ctx.scoreTurn(turn);

    ctx.recordScore(score, label, turn);

    endPanel.classList.remove('hidden');
    endPanel.innerHTML = `
      <div class="end-card">
        <div class="end-result">
          <p class="end-outcome ${outcome === 'deal' ? 'deal' : 'no-deal'}">
            ${outcome === 'deal' ? (turn.dealPrice != null ? `🤝 Deal at ${formatAsk(turn.dealPrice, ctx.currency)}` : '🤝 Deal!') : '💥 No Deal'}
          </p>
          <p class="end-detail">${outcome === 'deal' ? `Closed in ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}` : `Walked away after ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}`}</p>
        </div>
        <div class="end-score">
          <div class="end-score-number">${score}/100</div>
          <div class="end-score-label">${label}</div>
        </div>
        <div class="end-meta">
          <span class="streak-badge">🔥 ${ctx.streak} day streak</span>
        </div>
        <div class="share-card" id="share-card"></div>
        <div class="end-actions">
          <button class="copy-btn" id="copy-btn" type="button">Copy result</button>
        </div>
        <div class="countdown-box">
          Next negotiation in
          <span class="countdown-value" id="countdown-value">--:--:--</span>
        </div>
      </div>
    `;

    const shareText = buildShareText(ctx.dayNumber, outcome, turn.state.turns, score);
    const shareCard = endPanel.querySelector<HTMLElement>('#share-card');
    if (shareCard) shareCard.textContent = shareText;

    const copyBtn = endPanel.querySelector<HTMLButtonElement>('#copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        void copyToClipboard(shareText).then((ok) => {
          if (ok) {
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            window.setTimeout(() => {
              copyBtn.textContent = 'Copy result';
              copyBtn.classList.remove('copied');
            }, 1800);
          }
        });
      });
    }

    const countdownEl = endPanel.querySelector<HTMLElement>('#countdown-value');
    if (countdownEl) startCountdown(countdownEl);
  };

  inputRow.addEventListener('submit', (event) => {
    event.preventDefault();
    if (chatInput.disabled) return;
    const text = chatInput.value.trim();
    if (!text) return;

    addBubble(chatLog, 'user', text);
    chatInput.value = '';
    chatInput.disabled = true;
    sendBtn.disabled = true;

    const typingBubble = addTypingBubble(chatLog);

    void ctx.engine
      .respond(text)
      .then((turn) => {
        typingBubble.remove();
        addBubble(chatLog, 'character', turn.message);
        applyState(turn);

        if (turn.done) {
          // Let the closing message land before the end panel appears.
          window.setTimeout(() => {
            endGame(turn);
            chatLog.scrollTop = chatLog.scrollHeight;
          }, 1600);
        } else {
          chatInput.disabled = false;
          sendBtn.disabled = false;
          chatInput.focus();
        }
      })
      .catch(() => {
        // Turn was not consumed: nothing was applied to state, so the
        // player can simply try sending again.
        typingBubble.remove();
        addBubble(chatLog, 'system', 'The line went quiet — try sending that again.');
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
      });
  });
}

async function loadRuleEngineGame(root: HTMLElement, dayNumber: number): Promise<void> {
  let scenario: ScenarioRecord;
  try {
    scenario = await fetchTodayScenario(dayNumber);
  } catch {
    root.innerHTML = '<div class="error">Could not load today\u2019s negotiation. Please refresh to try again.</div>';
    return;
  }

  const streak = updateStreak(dayNumber);
  const config = scenario.engine_config;
  const scoringConfig = scenario.scoring_config;
  const engine = createRuleEngine(config);
  const initialTurn = engine.start();

  renderGame(root, {
    dayNumber,
    streak,
    title: scenario.title,
    characterName: scenario.character_name,
    characterPersona: scenario.character_persona,
    openingMessage: scenario.opening_message,
    currency: config.currency,
    maxPatience: config.patience,
    showAsk: true,
    engine,
    initialTurn,
    scoreTurn: (turn) => computeScore(scoringConfig, config, turn.dealPrice, turn.state.turns, turn.state.patience),
    recordScore: (score, label, turn) => {
      void submitScore(scenario.day_index, score, turn.state.turns, label, scenario.id);
    },
  });
}

function loadLlmGame(root: HTMLElement, session: SessionStartLlm, dayNumber: number): void {
  const streak = updateStreak(dayNumber);
  const scenario = session.scenario;
  const showAsk = scenario.current_ask !== null;
  const startState: CharacterTurnState = {
    patience: scenario.patience,
    currentAsk: scenario.current_ask ?? 0,
    turns: 0,
  };
  const engine = createLlmEngine(session.session_token, startState);
  const initialTurn = engine.start();

  renderGame(root, {
    dayNumber,
    streak,
    title: scenario.title,
    characterName: scenario.character_name,
    characterPersona: scenario.character_persona,
    playerBrief: scenario.player_brief ?? null,
    openingMessage: scenario.opening_message,
    currency: scenario.currency,
    maxPatience: scenario.patience,
    showAsk,
    engine,
    initialTurn,
    scoreTurn: (turn) => computeLlmScore(turn, scenario.patience, scenario.max_turns),
    recordScore: (score, label, turn) => {
      void submitScore(dayNumber, score, turn.state.turns, label);
    },
  });
}

async function main(): Promise<void> {
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement)) return;

  root.innerHTML = '<div class="loading">Loading today\u2019s negotiation…</div>';

  const dayNumber = getDayNumber();

  const session = await startBackendSession();
  if (session && session.llm === true) {
    loadLlmGame(root, session, dayNumber);
    return;
  }

  // session.llm === false, or the start call failed entirely: fall back to
  // today's existing seeded rule-engine flow, unchanged.
  await loadRuleEngineGame(root, dayNumber);
}

void main();
