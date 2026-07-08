import './styles.css';
import { pb } from './pocketbase';
import { createRuleEngine, type CharacterTurn, type EngineConfig } from './engine';
import { computeScore, type ScoringConfig } from './scoring';

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

function formatAsk(value: number, currency: string): string {
  const rounded = Math.round(value);
  const symbol = currency.trim();
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

async function submitScore(scenarioId: string, dayIndex: number, score: number, turns: number, resultLabel: string): Promise<void> {
  try {
    await pb.collection('scores').create({
      scenario: scenarioId,
      day_index: dayIndex,
      score,
      turns,
      result_label: resultLabel,
    });
  } catch {
    try {
      await pb.collection('scores').create({ scenario: scenarioId, score, turns, result_label: resultLabel });
    } catch {
      // Saving the score is best-effort; never let it break the game.
    }
  }
}

function buildShareText(
  dayNumber: number,
  outcome: 'deal' | 'no_deal',
  turns: number,
  score: number,
  patienceRemaining: number,
  initialPatience: number,
): string {
  const line1 = `Talked Down #${dayNumber}`;
  const line2 = outcome === 'deal' ? `🤝 Deal in ${turns} turn${turns === 1 ? '' : 's'}` : '💥 No deal';

  const moneyFilled = Math.min(5, Math.max(0, Math.round(score / 20)));
  const moneyBar = '💰'.repeat(moneyFilled) + '⬜'.repeat(5 - moneyFilled);
  const line3 = `${moneyBar} ${score}/100`;

  const patienceFraction = initialPatience > 0 ? patienceRemaining / initialPatience : 0;
  const patienceFilled = Math.min(5, Math.max(0, Math.round(patienceFraction * 5)));
  const patienceBar = '😤'.repeat(patienceFilled) + '⬜'.repeat(5 - patienceFilled);
  const line4 = `${patienceBar} patience left`;

  return [line1, line2, line3, line4].join('\n');
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

function renderPatience(patience: number, maxPatience: number): string {
  const bounded = Math.max(0, Math.min(maxPatience, patience));
  return '❤️'.repeat(bounded) + '🤍'.repeat(Math.max(0, maxPatience - bounded));
}

function renderGame(root: HTMLElement, scenario: ScenarioRecord, dayNumber: number, streak: number): void {
  const config = scenario.engine_config;
  const scoringConfig = scenario.scoring_config;
  const maxPatience = config.patience;
  const engine = createRuleEngine(config);
  const initialTurn = engine.start();

  root.innerHTML = `
    <div class="game">
      <header class="game-header">
        <span class="day-badge">Talked Down #${dayNumber}</span>
        <h1 class="scenario-title">${escapeHtml(scenario.title)}</h1>
        <div class="character-line">
          <span class="char-name">${escapeHtml(scenario.character_name)}</span>
          <span class="char-persona">${escapeHtml(scenario.character_persona)}</span>
        </div>
        <div class="meters">
          <div>
            <span class="patience-label">Patience</span>
            <div class="patience-meter" id="patience-meter">${renderPatience(initialTurn.state.patience, maxPatience)}</div>
          </div>
          <div class="ask-display">
            <span class="ask-label">Current ask</span>
            <div class="ask-value" id="ask-value">${formatAsk(initialTurn.state.currentAsk, config.currency)}</div>
          </div>
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
  const patienceMeter = root.querySelector<HTMLElement>('#patience-meter');
  const askValue = root.querySelector<HTMLElement>('#ask-value');
  const endPanel = root.querySelector<HTMLElement>('#end-panel');

  if (!chatLog || !inputRow || !chatInput || !sendBtn || !patienceMeter || !askValue || !endPanel) {
    return;
  }

  const addBubble = (container: HTMLElement, sender: 'character' | 'user' | 'system', text: string): void => {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${sender}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  };

  addBubble(chatLog, 'character', scenario.opening_message);

  const applyState = (turn: CharacterTurn): void => {
    patienceMeter.innerHTML = renderPatience(turn.state.patience, maxPatience);
    askValue.textContent = formatAsk(turn.state.currentAsk, config.currency);
  };

  const endGame = (turn: CharacterTurn): void => {
    chatInput.disabled = true;
    sendBtn.disabled = true;

    const outcome: 'deal' | 'no_deal' = turn.outcome === 'deal' ? 'deal' : 'no_deal';
    const { score, label } = computeScore(scoringConfig, config, turn.dealPrice, turn.state.turns, turn.state.patience);

    void submitScore(scenario.id, scenario.day_index, score, turn.state.turns, label);

    endPanel.classList.remove('hidden');
    endPanel.innerHTML = `
      <div class="end-card">
        <div class="end-result">
          <p class="end-outcome ${outcome === 'deal' ? 'deal' : 'no-deal'}">
            ${outcome === 'deal' ? `🤝 Deal at ${formatAsk(turn.dealPrice ?? 0, config.currency)}` : '💥 No Deal'}
          </p>
          <p class="end-detail">${outcome === 'deal' ? `Closed in ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}` : `Walked away after ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}`}</p>
        </div>
        <div class="end-score">
          <div class="end-score-number">${score}/100</div>
          <div class="end-score-label">${label}</div>
        </div>
        <div class="end-meta">
          <span class="streak-badge">🔥 ${streak} day streak</span>
          <span>Patience left: ${Math.max(0, turn.state.patience)}/${maxPatience}</span>
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

    const shareText = buildShareText(dayNumber, outcome, turn.state.turns, score, Math.max(0, turn.state.patience), maxPatience);
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
    const text = chatInput.value.trim();
    if (!text) return;
    addBubble(chatLog, 'user', text);
    chatInput.value = '';

    const turn = engine.respond(text);
    addBubble(chatLog, 'character', turn.message);
    applyState(turn);

    if (turn.done) {
      endGame(turn);
    }
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

async function main(): Promise<void> {
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement)) return;

  root.innerHTML = '<div class="loading">Loading today\u2019s negotiation…</div>';

  const dayNumber = getDayNumber();

  let scenario: ScenarioRecord;
  try {
    scenario = await fetchTodayScenario(dayNumber);
  } catch {
    root.innerHTML = '<div class="error">Could not load today\u2019s negotiation. Please refresh to try again.</div>';
    return;
  }

  const streak = updateStreak(dayNumber);
  renderGame(root, scenario, dayNumber, streak);
}

void main();
