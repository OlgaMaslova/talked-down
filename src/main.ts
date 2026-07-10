import './styles.css';
import logoUrl from './assets/td-logo.jpg';
import { pb, apiBaseUrl } from './pocketbase';
import type { CharacterTurn, CharacterTurnState, NegotiationEngine } from './engine';
import { createLlmEngine, MessageTooLongError } from './llmEngine';
import type { ScoreResult } from './scoring';
import { getIdentity, type DeviceIdentity } from './identity';
import { renderClaimWidget, claimedBadgeHtml, consumeClaimTokenFromUrl } from './claim';
import { bindLeaderboardTrigger } from './leaderboard';
import { bindArchiveTrigger, type ArchiveDayEntry } from './archive';

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
  /** Per-message character cap enforced server-side on session/turn. */
  max_message_chars?: number;
  current_ask: number | null;
}

/** Fallback used when a scenario payload lacks max_message_chars (older backend). */
const DEFAULT_MAX_MESSAGE_CHARS = 280;

interface SessionStartLlm {
  llm: true;
  already_played?: false;
  session_token: string;
  scenario: LlmScenario;
}

interface SessionStartNoLlm {
  llm: false;
}

const REPLAY_DURATION_MS = 3 * 60 * 1000;

type ReplayTimerStatus = 'active' | 'paused' | 'expired';

/** A normalized, client-safe view of the server's replay timer. */
interface ReplayTimerSnapshot {
  /** Remaining time is authoritative whenever the server supplies it. */
  remainingMs: number;
  status: ReplayTimerStatus;
  elapsedMs?: number;
  expiresAtMs?: number;
}

/** Unranked replay returned by POST /api/game/replay/start. */
interface ReplaySessionStart {
  llm: true;
  session_token: string;
  scenario: LlmScenario;
  /** Expected shape: { remaining_ms, status, elapsed_ms, expires_at_ms? }. */
  replay?: Record<string, unknown>;
}

type ReplayStartResult =
  | { ok: true; session: ReplaySessionStart; timer: ReplayTimerSnapshot }
  | { ok: false; error: string };

/** Returned by session/start when this device already finished today's game. */
interface SessionStartAlreadyPlayed {
  llm: true;
  already_played: true;
  result: {
    score: number;
    result_label: string;
    outcome: string; // "deal" | "no_deal"
    turns: number;
    percentile: number;
    day_number: number;
    streak: number;
  };
}

type SessionStartResponse = SessionStartLlm | SessionStartAlreadyPlayed | SessionStartNoLlm;

const EPOCH_MS = Date.UTC(2026, 6, 7); // 2026-07-07T00:00:00Z is day #1
const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_LAST_DAY_KEY = 'td_last_day';
const STREAK_COUNT_KEY = 'td_streak';

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

/** Reads the locally-tracked streak without mutating it (used for already-played renders). */
function getStoredStreak(): number {
  const raw = localStorage.getItem(STREAK_COUNT_KEY);
  const n = raw !== null ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Calls the backend's session/start route. Returns null when the call fails
 * outright (network error, non-2xx, unexpected shape) so the caller can show
 * a graceful "come back later" message instead of a broken game.
 */
async function startBackendSession(identity: DeviceIdentity): Promise<SessionStartResponse | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: identity.deviceId, handle: identity.handle }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.llm === true && data.already_played === true && data.result) {
      return data as SessionStartAlreadyPlayed;
    }
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

/** Start a server-backed, unranked replay of today's completed scenario. */
async function startReplaySession(identity: DeviceIdentity): Promise<ReplayStartResult> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/replay/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: identity.deviceId, handle: identity.handle }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        error: data && typeof data.error === 'string' ? data.error : 'Unable to start a replay right now.',
      };
    }
    if (data && data.llm === true && typeof data.session_token === 'string' && data.scenario) {
      // The start response establishes the only initial visual-clock value.
      // A missing timer is tolerated for older deployments, but all supplied
      // `remaining_ms` values are used verbatim by readReplayTimer.
      return {
        ok: true,
        session: data as ReplaySessionStart,
        timer: readReplayTimer(data) ?? defaultReplayTimer(),
      };
    }
    return { ok: false, error: 'Unable to start a replay right now.' };
  } catch {
    return { ok: false, error: 'Network hiccup — try starting the replay again.' };
  }
}

/** Result of trying to start a replay session for a past (archived) day. */
type ArchiveSessionStart =
  | { ok: true; session_token: string; scenario: LlmScenario; dayNumber: number }
  | { ok: false; error: string };

/**
 * Calls session/start with an explicit past day_number to replay an
 * archived scenario. Unlike startBackendSession, archive starts never
 * return already_played, so any well-formed llm response is a fresh game.
 */
async function startArchiveSession(identity: DeviceIdentity, dayNumber: number): Promise<ArchiveSessionStart> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: identity.deviceId, handle: identity.handle, day_number: dayNumber }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        data && typeof data.error === 'string' ? data.error : 'That negotiation isn\u2019t available right now.';
      return { ok: false, error: message };
    }
    if (data && data.llm === true && data.session_token && data.scenario) {
      return {
        ok: true,
        session_token: data.session_token,
        scenario: data.scenario as LlmScenario,
        dayNumber: typeof data.day_number === 'number' ? data.day_number : dayNumber,
      };
    }
    return { ok: false, error: 'That negotiation isn\u2019t available right now.' };
  } catch {
    return { ok: false, error: 'Network hiccup — try again in a moment.' };
  }
}

interface PercentileResponse {
  day_number: number;
  score: number;
  plays: number;
  percentile: number;
}

async function fetchPercentile(dayNumber: number, score: number): Promise<PercentileResponse | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/percentile?day_number=${dayNumber}&score=${score}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.percentile === 'number' && typeof data.plays === 'number') {
      return data as PercentileResponse;
    }
    return null;
  } catch {
    return null;
  }
}

interface HistoryEntry {
  day_number?: number;
  score: number;
  turns: number;
  result_label: string;
  created: string;
}

async function fetchHistory(deviceId: string): Promise<HistoryEntry[]> {
  try {
    const result = await pb.collection('scores').getList<HistoryEntry>(1, 10, {
      filter: `device_id="${deviceId}"`,
      sort: '-created',
    });
    return result.items;
  } catch {
    return [];
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
  isArchive = false,
): string {
  const line1 = `Talked Down #${dayNumber}${isArchive ? ' (archive)' : ''}`;
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

// A game or result card replaces the entire view. Keep viewport listeners and
// timer intervals in one place so no replaced view keeps ticking.
let activeViewportCleanup: (() => void) | null = null;
const activeResultCountdowns = new Set<number>();

function clearGameRuntime(): void {
  activeViewportCleanup?.();
  activeViewportCleanup = null;
  for (const interval of activeResultCountdowns) window.clearInterval(interval);
  activeResultCountdowns.clear();
}

function formatReplayTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes timer payloads from replay endpoints. The documented payload is
 * nested under `replay`, but accepting a direct timer object and numeric
 * strings keeps the UI compatible with small response-shape variations.
 */
function readReplayTimer(payload: unknown): ReplayTimerSnapshot | null {
  const source = isRecord(payload) && isRecord(payload.replay) ? payload.replay : payload;
  if (!isRecord(source)) return null;

  // `remaining_ms` wins over all fallbacks: it is the server's authoritative
  // value after start, pause, and resume.
  const suppliedRemainingMs = asFiniteNumber(source.remaining_ms);
  const expiresAtMs = asFiniteNumber(source.expires_at_ms);
  const remainingMs = suppliedRemainingMs ?? (expiresAtMs === null ? null : Math.max(0, expiresAtMs - Date.now()));
  if (remainingMs === null) return null;

  const rawStatus = typeof source.status === 'string' ? source.status.toLowerCase() : '';
  const status: ReplayTimerStatus =
    remainingMs <= 0 || rawStatus === 'expired' || rawStatus === 'complete' || rawStatus === 'completed'
      ? 'expired'
      : rawStatus === 'paused' || rawStatus === 'pause'
        ? 'paused'
        : 'active';
  const elapsedMs = asFiniteNumber(source.elapsed_ms);

  return {
    remainingMs: Math.max(0, remainingMs),
    status,
    ...(elapsedMs === null ? {} : { elapsedMs: Math.max(0, elapsedMs) }),
    ...(expiresAtMs === null ? {} : { expiresAtMs }),
  };
}

function defaultReplayTimer(): ReplayTimerSnapshot {
  return { remainingMs: REPLAY_DURATION_MS, status: 'active' };
}

function replayStartActionHtml(): string {
  return `
    <div class="replay-action">
      <button class="replay-btn" id="replay-btn" type="button" aria-describedby="replay-status">↻ Start 3-minute replay</button>
      <p class="replay-status" id="replay-status">Practice this negotiation immediately. Replays are unranked.</p>
    </div>
  `;
}

type ReplayTimerAction = 'pause' | 'resume';
type ReplayTimerActionResult =
  | { ok: true; timer: ReplayTimerSnapshot }
  | { ok: false; code?: string; error: string };

/** Send a server-authoritative replay timer transition using the session token. */
async function changeReplayTimer(sessionToken: string, action: ReplayTimerAction): Promise<ReplayTimerActionResult> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/replay/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: sessionToken }),
    });
    const data: unknown = await res.json().catch(() => null);
    const timer = readReplayTimer(data);

    if (!res.ok) {
      const code = isRecord(data) && typeof data.error === 'string' ? data.error : undefined;
      return {
        ok: false,
        ...(code ? { code } : {}),
        error:
          code === 'replay_expired'
            ? 'This replay has expired.'
            : code === 'replay_paused'
              ? 'This replay is paused.'
              : 'Unable to update the replay timer. Please try again.',
      };
    }
    if (!timer) {
      return { ok: false, error: 'The replay timer could not be synchronized. Please try again.' };
    }
    return { ok: true, timer };
  } catch {
    return { ok: false, error: 'Network hiccup — the replay timer was not changed.' };
  }
}

interface ReplayTimerElements {
  value: HTMLElement;
  status: HTMLElement;
  pauseButton: HTMLButtonElement;
  resumeButton: HTMLButtonElement;
}

/**
 * Keeps the visual clock smooth between server transitions. Each start,
 * pause, and resume response resets it from `remaining_ms`; the clock is
 * deliberately frozen whenever the server says the replay is paused.
 */
class ReplayTimerController {
  private remainingMs: number;
  private status: ReplayTimerStatus;
  private syncedAtMs: number;
  private interval: number | null = null;
  private busy = false;
  private notice = '';

  constructor(
    private readonly sessionToken: string,
    private readonly elements: ReplayTimerElements,
    initial: ReplayTimerSnapshot,
    private readonly onStateChange: () => void,
    private readonly onExpired: () => void,
  ) {
    this.remainingMs = initial.remainingMs;
    this.status = initial.status;
    this.syncedAtMs = Date.now();
    this.elements.pauseButton.addEventListener('click', this.handlePause);
    this.elements.resumeButton.addEventListener('click', this.handleResume);
    this.render();
    if (this.status === 'active') this.startTicking();
    else if (this.status === 'expired') this.onExpired();
  }

  isPaused(): boolean {
    return this.status === 'paused';
  }

  applyServerTimer(timer: ReplayTimerSnapshot): void {
    this.remainingMs = timer.remainingMs;
    this.status = timer.status;
    this.syncedAtMs = Date.now();
    this.notice = '';
    if (this.status === 'active') this.startTicking();
    else this.stopTicking();
    this.render();
    this.onStateChange();
  }

  /** A replay_paused turn response is itself server confirmation to freeze now. */
  freezeFromPausedResponse(): void {
    if (this.status === 'expired') return;
    this.remainingMs = this.currentRemainingMs();
    this.status = 'paused';
    this.syncedAtMs = Date.now();
    this.stopTicking();
    this.render();
    this.onStateChange();
  }

  destroy(): void {
    this.stopTicking();
    this.elements.pauseButton.removeEventListener('click', this.handlePause);
    this.elements.resumeButton.removeEventListener('click', this.handleResume);
  }

  private readonly handlePause = (): void => {
    void this.requestChange('pause');
  };

  private readonly handleResume = (): void => {
    void this.requestChange('resume');
  };

  private currentRemainingMs(): number {
    if (this.status !== 'active') return this.remainingMs;
    return Math.max(0, this.remainingMs - (Date.now() - this.syncedAtMs));
  }

  private startTicking(): void {
    if (this.interval !== null || this.status !== 'active') return;
    this.interval = window.setInterval(() => this.render(), 250);
    activeResultCountdowns.add(this.interval);
  }

  private stopTicking(): void {
    if (this.interval === null) return;
    window.clearInterval(this.interval);
    activeResultCountdowns.delete(this.interval);
    this.interval = null;
  }

  private render(): void {
    const remainingMs = this.currentRemainingMs();
    const timerText = formatReplayTime(remainingMs);
    this.elements.value.textContent = timerText;
    this.elements.value.setAttribute('aria-label', `Replay time remaining: ${timerText}`);

    if (this.status === 'active' && remainingMs <= 0) {
      this.remainingMs = 0;
      this.status = 'expired';
      this.stopTicking();
      this.render();
      this.onStateChange();
      this.onExpired();
      return;
    }

    const paused = this.status === 'paused';
    const expired = this.status === 'expired';
    this.elements.value.closest<HTMLElement>('.replay-timer')?.classList.toggle('is-paused', paused);
    this.elements.value.closest<HTMLElement>('.replay-timer')?.classList.toggle('is-expired', expired);
    this.elements.status.textContent = expired
      ? 'Replay time has expired.'
      : paused
        ? `Replay paused — ${timerText} remaining.`
        : this.busy
          ? 'Updating replay timer…'
          : this.notice || 'Replay is active.';
    this.elements.pauseButton.disabled = this.busy || this.status !== 'active';
    this.elements.resumeButton.disabled = this.busy || this.status !== 'paused';
  }

  private async requestChange(action: ReplayTimerAction): Promise<void> {
    if (this.busy || (action === 'pause' && this.status !== 'active') || (action === 'resume' && this.status !== 'paused')) {
      return;
    }
    this.busy = true;
    this.notice = '';
    this.render();
    const result = await changeReplayTimer(this.sessionToken, action);
    this.busy = false;

    if (!result.ok) {
      if (result.code === 'replay_expired') {
        this.remainingMs = 0;
        this.status = 'expired';
        this.stopTicking();
        this.render();
        this.onStateChange();
        this.onExpired();
        return;
      }
      if (result.code === 'replay_paused') this.freezeFromPausedResponse();
      this.notice = result.error;
      this.render();
      return;
    }

    this.applyServerTimer(result.timer);
  }
}

function startCountdown(el: HTMLElement): void {
  const update = () => {
    if (!el.isConnected) return;
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
  const interval = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(interval);
      activeResultCountdowns.delete(interval);
      return;
    }
    update();
  }, 1000);
  activeResultCountdowns.add(interval);
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/** Transient top-of-screen banner used for claim confirmations/errors. */
function showBanner(message: string, kind: 'success' | 'error'): void {
  const banner = document.createElement('div');
  banner.className = `toast-banner ${kind}`;
  banner.textContent = message;
  document.body.appendChild(banner);
  window.setTimeout(() => {
    banner.classList.add('leaving');
    window.setTimeout(() => banner.remove(), 300);
  }, 4200);
}

/** A replay-specific turn failure that needs different UX from a normal failed turn. */
class ReplayTurnError extends Error {
  constructor(
    readonly code: 'replay_paused' | 'replay_expired',
    readonly timer: ReplayTimerSnapshot | null,
  ) {
    super(code === 'replay_paused' ? 'Replay is paused' : 'Replay has expired');
    this.name = 'ReplayTurnError';
  }
}

/**
 * Replays use the ordinary session/turn contract, while retaining the replay
 * error body so paused/expired states never appear as generic negotiation
 * failures. Daily and archive sessions continue to use createLlmEngine.
 */
function createReplayLlmEngine(sessionToken: string, startState: CharacterTurnState): NegotiationEngine {
  return {
    start: () => ({ message: '', done: false, state: startState }),
    respond: async (userMessage: string): Promise<CharacterTurn> => {
      const res = await fetch(`${apiBaseUrl}/api/game/session/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: sessionToken, message: userMessage }),
      });
      const data: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const errorCode = isRecord(data) && typeof data.error === 'string' ? data.error : '';
        if (errorCode === 'message_too_long') {
          const maxMessageChars = isRecord(data) ? asFiniteNumber(data.max_message_chars) : null;
          throw new MessageTooLongError(maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS);
        }
        if (errorCode === 'replay_paused' || errorCode === 'replay_expired') {
          throw new ReplayTurnError(errorCode, readReplayTimer(data));
        }
        throw new Error(`Negotiation turn request failed (${res.status})`);
      }

      return data as CharacterTurn;
    },
  };
}

interface ReplayGameConfig {
  sessionToken: string;
  timer: ReplayTimerSnapshot;
}

/** Everything renderGame needs, whether the negotiation is rule-engine or LLM driven. */
interface GameContext {
  dayNumber: number;
  streak: number;
  identity: DeviceIdentity;
  title: string;
  characterName: string;
  characterPersona: string;
  playerBrief?: string | null;
  openingMessage: string;
  currency: string | null;
  maxPatience: number;
  maxTurns: number;
  maxMessageChars: number;
  showAsk: boolean;
  engine: NegotiationEngine;
  initialTurn: CharacterTurn;
  scoreTurn: (turn: CharacterTurn) => ScoreResult;
  recordScore: (score: number, label: string, turn: CharacterTurn) => Promise<void>;
  /** True when this session is a replay of a past day: unranked, no streak/percentile/claim. */
  archive?: boolean;
  /** Unranked, timed replay of today's scenario. */
  replay?: ReplayGameConfig;
}

function renderGame(root: HTMLElement, ctx: GameContext): void {
  clearGameRuntime();
  const initialTurn = ctx.initialTurn;

  root.innerHTML = `
    <div class="game">
      <header class="game-header">
        <div class="brand-row">
          <img class="brand-logo" src="${logoUrl}" width="32" height="32" alt="" />
          <div class="brand-copy">
            <span class="brand-word">Talked Down</span>
            <span class="brand-tagline">Talk the AI down. One negotiation a day.</span>
          </div>
        </div>
        <div class="badge-row">
          <span class="day-badge">Talked Down #${ctx.dayNumber}</span>
          ${
            ctx.replay
              ? '<span class="replay-flag">↻ Replay · unranked</span>'
              : ctx.archive
                ? '<span class="archive-flag">🗓️ Archive — unranked</span>'
                : ''
          }
        </div>
        <h1 class="scenario-title">${escapeHtml(ctx.title)}</h1>
        <div class="character-line">
          <span class="char-name">${escapeHtml(ctx.characterName)}</span>
          <span class="char-persona">${escapeHtml(ctx.characterPersona)}</span>
        </div>
        ${ctx.playerBrief ? `<p class="player-brief">${escapeHtml(ctx.playerBrief)}</p>` : ''}
        <p class="house-rules">📜 House rules: ${ctx.maxTurns} message${ctx.maxTurns === 1 ? '' : 's'} max, ${ctx.maxMessageChars} characters each.</p>
        ${
          ctx.replay
            ? `<section class="replay-timer" aria-label="Timed replay controls">
              <div class="replay-timer-heading"><span>Replay time</span><time class="replay-timer-value" id="replay-timer-value" role="timer" aria-live="polite" aria-atomic="true">${formatReplayTime(ctx.replay.timer.remainingMs)}</time></div>
              <p class="replay-timer-status" id="replay-timer-status" role="status" aria-live="polite">Replay is active.</p>
              <div class="replay-timer-controls" aria-label="Replay timer controls">
                <button class="replay-control-btn" id="replay-pause-btn" type="button">Pause</button>
                <button class="replay-control-btn" id="replay-resume-btn" type="button" disabled>Resume</button>
              </div>
            </section>`
            : ''
        }
        <div class="header-buttons">
          <button type="button" class="leaderboard-btn" id="leaderboard-btn-header">🏆 Best negotiators</button>
          <button type="button" class="leaderboard-btn archive-btn" id="archive-btn-header">🗓️ Past negotiations</button>
        </div>
        ${
          ctx.showAsk
            ? `<div class="meters"><div class="ask-display">
            <span class="ask-label">Current ask</span>
            <div class="ask-value" id="ask-value">${formatAsk(initialTurn.state.currentAsk, ctx.currency)}</div>
          </div></div>`
            : ''
        }
      </header>
      <div class="chat-log" id="chat-log"></div>
      <!-- Opener suggestion chips: docs/session-analysis-2026-07-09.md found 115/145
           sessions abandoned with a median of 0 player messages (blank-page
           friction), and that flattery (67%) and logic (50%) openers close the
           most deals. Chips prefill an editable opener and disappear after the
           first message. -->
      <div class="opener-chips" id="opener-chips" role="group" aria-label="Suggested openers">
        <span class="opener-chips-label">Not sure how to start?</span>
        <button type="button" class="opener-chip" data-opener="This is beautiful work — you clearly know your craft. What's your best price for me?">😊 Open with a compliment</button>
        <button type="button" class="opener-chip" data-opener="That price seems high for what this is. Walk me through why it's worth that much?">🧠 Question the price</button>
        <button type="button" class="opener-chip" data-opener="I'm interested, but my budget is tight. Could you do a better deal?">💰 Make a modest offer</button>
      </div>
      <form class="input-row" id="input-row">
        <div class="input-field">
          <input id="chat-input" type="text" placeholder="Type your offer or say something…" autocomplete="off" maxlength="${ctx.maxMessageChars}" />
          <span class="char-counter" id="char-counter">0/${ctx.maxMessageChars}</span>
        </div>
        <button type="button" id="accept-btn" title="Accept the current offer">🤝 Accept</button>
        <button type="submit" id="send-btn" disabled>Send</button>
      </form>
      <div class="end-panel hidden" id="end-panel"></div>
    </div>
  `;

  const gameEl = root.querySelector<HTMLElement>('.game');
  const chatLog = root.querySelector<HTMLElement>('#chat-log');
  const inputRow = root.querySelector<HTMLFormElement>('#input-row');
  const chatInput = root.querySelector<HTMLInputElement>('#chat-input');
  const sendBtn = root.querySelector<HTMLButtonElement>('#send-btn');
  const acceptBtn = root.querySelector<HTMLButtonElement>('#accept-btn');
  const charCounter = root.querySelector<HTMLElement>('#char-counter');
  const askValue = root.querySelector<HTMLElement>('#ask-value');
  const endPanel = root.querySelector<HTMLElement>('#end-panel');
  const leaderboardBtnHeader = root.querySelector<HTMLButtonElement>('#leaderboard-btn-header');
  const archiveBtnHeader = root.querySelector<HTMLButtonElement>('#archive-btn-header');
  const replayTimerValue = root.querySelector<HTMLElement>('#replay-timer-value');
  const replayTimerStatus = root.querySelector<HTMLElement>('#replay-timer-status');
  const replayPauseButton = root.querySelector<HTMLButtonElement>('#replay-pause-btn');
  const replayResumeButton = root.querySelector<HTMLButtonElement>('#replay-resume-btn');

  if (!chatLog || !inputRow || !chatInput || !sendBtn || !charCounter || !endPanel) {
    return;
  }

  if (leaderboardBtnHeader) bindLeaderboardTrigger(leaderboardBtnHeader, ctx.dayNumber);
  if (archiveBtnHeader) {
    bindArchiveTrigger(archiveBtnHeader, getDayNumber(), (day) => {
      void playArchivedDay(root, ctx.identity, day);
    });
  }

  // ---- Mobile keyboard-safe viewport handling ----
  // On phones, opening the on-screen keyboard shrinks the *visual* viewport
  // without the *layout* viewport (100vh) changing, which lets the input
  // row get pushed under the keyboard. We track window.visualViewport and
  // pin the game container's height to it via a CSS custom property, then
  // keep the chat scrolled to the latest message.
  const isDesktopLayout = (): boolean =>
    typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;

  const applyViewportHeight = (): void => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    // The desktop layout uses its own fixed/centered sizing (see the
    // >=1024px media query); only pin .game to the live keyboard-safe
    // height on the single-column mobile layout.
    if (gameEl) gameEl.style.height = isDesktopLayout() ? '' : `${height}px`;
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  if (window.visualViewport) {
    const viewport = window.visualViewport;
    viewport.addEventListener('resize', applyViewportHeight);
    viewport.addEventListener('scroll', applyViewportHeight);
    activeViewportCleanup = () => {
      viewport.removeEventListener('resize', applyViewportHeight);
      viewport.removeEventListener('scroll', applyViewportHeight);
    };
  } else {
    window.addEventListener('resize', applyViewportHeight);
    activeViewportCleanup = () => window.removeEventListener('resize', applyViewportHeight);
  }
  applyViewportHeight();

  // When the input gains focus the keyboard animates in; give it a beat
  // before snapping the chat log to the bottom so the latest message stays
  // visible above it.
  chatInput.addEventListener('focus', () => {
    window.setTimeout(() => {
      applyViewportHeight();
      chatLog.scrollTop = chatLog.scrollHeight;
    }, 300);
  });

  const maxMessageChars = ctx.maxMessageChars;

  // No instant accepts at the opening price: the Accept button unlocks only
  // after the player has sent at least one message of their own.
  let hasNegotiated = false;
  let awaitingTurn = false;
  let gameEnded = false;
  let replayTimer: ReplayTimerController | null = null;

  // Live character counter + send gating: disabled when empty or over the
  // per-message house-rule cap (maxlength on the input already blocks most
  // of the latter, but paste/IME can still exceed it momentarily).
  const updateInputState = (): void => {
    const len = chatInput.value.length;
    charCounter.textContent = `${len}/${maxMessageChars}`;
    const overCap = len > maxMessageChars;
    const nearCap = len >= Math.floor(maxMessageChars * 0.9);
    const locked = awaitingTurn || gameEnded || replayTimer?.isPaused() === true;
    charCounter.classList.toggle('over', overCap);
    charCounter.classList.toggle('warning', !overCap && nearCap);
    chatInput.disabled = locked;
    sendBtn.disabled = locked || len === 0 || overCap;
    if (acceptBtn) acceptBtn.disabled = locked || !hasNegotiated;
  };
  chatInput.addEventListener('input', updateInputState);
  updateInputState();
  if (acceptBtn) {
    acceptBtn.title = 'Negotiate first — send a message before accepting';
  }

  // Opener chips: tap-to-prefill (still editable), removed once the player
  // sends their first message. See the analysis note above the markup.
  const openerChips = root.querySelector<HTMLElement>('#opener-chips');
  if (openerChips) {
    openerChips.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const chip = target.closest<HTMLButtonElement>('.opener-chip');
      if (!chip || chatInput.disabled) return;
      chatInput.value = (chip.dataset.opener ?? '').slice(0, maxMessageChars);
      chatInput.focus();
      updateInputState();
    });
  }
  const hideOpenerChips = (): void => {
    openerChips?.remove();
  };

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

  let lastKnownAsk: number | null = ctx.showAsk ? initialTurn.state.currentAsk : null;

  const applyState = (turn: CharacterTurn): void => {
    lastKnownAsk = turn.state.currentAsk;
    if (askValue) askValue.textContent = formatAsk(turn.state.currentAsk, ctx.currency);
  };

  const renderReplayTerminalCard = (
    title: string,
    detail: string,
    outcomeClass: 'deal' | 'no-deal' | 'timeout',
  ): void => {
    if (!ctx.replay || gameEnded) return;

    gameEnded = true;
    awaitingTurn = false;
    replayTimer?.destroy();
    updateInputState();
    openerChips?.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = true;
    });

    endPanel.classList.remove('hidden');
    endPanel.innerHTML = `
      <div class="end-card replay-end-card">
        <span class="replay-end-badge">↻ Replay · unranked</span>
        <div class="end-result">
          <p class="end-outcome ${outcomeClass}">${title}</p>
          <p class="end-detail">${detail}</p>
        </div>
        <p class="replay-unranked-note">Practice only — no score, percentile, leaderboard placement, streak, history, or claim update.</p>
        <button type="button" class="back-to-today-btn" id="back-to-today-btn">← Back to today</button>
      </div>
    `;

    const backToTodayBtn = endPanel.querySelector<HTMLButtonElement>('#back-to-today-btn');
    if (backToTodayBtn) {
      backToTodayBtn.addEventListener('click', () => {
        clearGameRuntime();
        window.location.href = window.location.pathname;
      });
    }
  };

  const renderReplayEndCard = (turn: CharacterTurn): void => {
    const outcome: 'deal' | 'no_deal' = turn.outcome === 'deal' ? 'deal' : 'no_deal';
    renderReplayTerminalCard(
      outcome === 'deal' ? '🤝 Replay complete' : '💥 Replay complete',
      outcome === 'deal'
        ? `Closed in ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}.`
        : `No deal after ${turn.state.turns} turn${turn.state.turns === 1 ? '' : 's'}.`,
      outcome === 'deal' ? 'deal' : 'no-deal',
    );
  };

  const renderReplayExpiredCard = (): void => {
    renderReplayTerminalCard('⌛ Replay time ended', 'Your three-minute practice replay has expired.', 'timeout');
  };

  if (ctx.replay && replayTimerValue && replayTimerStatus && replayPauseButton && replayResumeButton) {
    replayTimer = new ReplayTimerController(
      ctx.replay.sessionToken,
      {
        value: replayTimerValue,
        status: replayTimerStatus,
        pauseButton: replayPauseButton,
        resumeButton: replayResumeButton,
      },
      ctx.replay.timer,
      updateInputState,
      renderReplayExpiredCard,
    );
    updateInputState();
  }

  const endGame = (turn: CharacterTurn): void => {
    if (ctx.replay) {
      renderReplayEndCard(turn);
      return;
    }

    awaitingTurn = false;
    chatInput.disabled = true;
    sendBtn.disabled = true;
    if (acceptBtn) acceptBtn.disabled = true;

    const outcome: 'deal' | 'no_deal' = turn.outcome === 'deal' ? 'deal' : 'no_deal';
    const { score, label } = ctx.scoreTurn(turn);

    const scoreSaved = ctx.recordScore(score, label, turn);

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
        ${ctx.archive ? '' : '<div class="end-percentile" id="end-percentile"></div>'}
        <div class="end-meta">
          <span class="handle-badge" title="Your handle on this device">🎭 ${escapeHtml(ctx.identity.handle)}${claimedBadgeHtml()}</span>
          ${ctx.archive ? '' : `<span class="streak-badge">🔥 ${ctx.streak} day streak</span>`}
        </div>
        <div class="history-box" id="history-box"></div>
        <div class="share-card" id="share-card"></div>
        ${ctx.archive ? '' : '<div class="claim-box" id="claim-box"></div>'}
        <div class="end-actions">
          <button class="copy-btn" id="copy-btn" type="button">Copy result</button>
          ${ctx.archive ? '' : replayStartActionHtml()}
          <button class="leaderboard-btn" id="leaderboard-btn-end" type="button">🏆 Best negotiators</button>
          <button class="leaderboard-btn archive-btn" id="archive-btn-end" type="button">🗓️ Past negotiations</button>
        </div>
        ${
          ctx.archive
            ? '<button type="button" class="back-to-today-btn" id="back-to-today-btn">← Back to today</button>'
            : `<div class="countdown-box">
          Next negotiation in
          <span class="countdown-value" id="countdown-value">--:--:--</span>
        </div>`
        }
      </div>
    `;

    const shareText = buildShareText(ctx.dayNumber, outcome, turn.state.turns, score, ctx.archive === true);
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

    const replayBtn = endPanel.querySelector<HTMLButtonElement>('#replay-btn');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        void startReplay(root, ctx.identity);
      });
    }

    const claimBox = endPanel.querySelector<HTMLElement>('#claim-box');
    if (claimBox) renderClaimWidget(claimBox, ctx.identity);

    const leaderboardBtnEnd = endPanel.querySelector<HTMLButtonElement>('#leaderboard-btn-end');
    if (leaderboardBtnEnd) bindLeaderboardTrigger(leaderboardBtnEnd, ctx.dayNumber);

    const archiveBtnEnd = endPanel.querySelector<HTMLButtonElement>('#archive-btn-end');
    if (archiveBtnEnd) {
      bindArchiveTrigger(archiveBtnEnd, getDayNumber(), (day) => {
        void playArchivedDay(root, ctx.identity, day);
      });
    }

    const backToTodayBtn = endPanel.querySelector<HTMLButtonElement>('#back-to-today-btn');
    if (backToTodayBtn) {
      backToTodayBtn.addEventListener('click', () => {
        clearGameRuntime();
        window.location.href = window.location.pathname;
      });
    }

    // Anonymous daily percentile vs today's score distribution (no signup).
    // Skipped entirely for archive replays: unranked plays have no daily cohort.
    const percentileEl = endPanel.querySelector<HTMLElement>('#end-percentile');
    if (percentileEl && typeof turn.percentile === 'number') {
      // Server computed the daily percentile deterministically on the final turn.
      percentileEl.innerHTML = `You scored better than <strong>${turn.percentile}%</strong> of today\u2019s negotiators`;
    } else if (percentileEl) {
      percentileEl.textContent = 'Checking today\u2019s standings…';
      void scoreSaved.then(() => fetchPercentile(ctx.dayNumber, score)).then((p) => {
        if (!p) {
          percentileEl.textContent = '';
          return;
        }
        const topPct = Math.max(1, 100 - p.percentile + 1);
        percentileEl.innerHTML = `You scored better than <strong>${p.percentile}%</strong> of today\u2019s ${p.plays} negotiator${p.plays === 1 ? '' : 's'} — top\u00a0${topPct}%`;
      });
    }

    // Play history for this device's silent identity.
    const historyBox = endPanel.querySelector<HTMLElement>('#history-box');
    if (historyBox) {
      void scoreSaved.then(() => fetchHistory(ctx.identity.deviceId)).then((items) => {
        if (items.length === 0) return;
        const rows = items
          .map((h) => {
            const day = h.day_number ? `#${h.day_number}` : new Date(h.created).toISOString().slice(5, 10);
            return `<li><span class="history-day">${escapeHtml(String(day))}</span><span class="history-label">${escapeHtml(h.result_label)}</span><span class="history-score">${h.score}/100</span></li>`;
          })
          .join('');
        historyBox.innerHTML = `<div class="history-title">Your recent negotiations</div><ul class="history-list">${rows}</ul>`;
      });
    }
  };

  const sendPlayerMessage = (text: string): void => {
    if (chatInput.disabled || gameEnded) return;
    if (!text || text.length > maxMessageChars) return;

    hideOpenerChips();
    hasNegotiated = true;
    if (acceptBtn) acceptBtn.title = 'Accept the current offer';
    addBubble(chatLog, 'user', text);
    chatInput.value = '';
    awaitingTurn = true;
    updateInputState();

    const typingBubble = addTypingBubble(chatLog);

    void ctx.engine
      .respond(text)
      .then((turn) => {
        typingBubble.remove();
        if (gameEnded) return;
        addBubble(chatLog, 'character', turn.message);
        applyState(turn);

        if (turn.done) {
          window.setTimeout(() => {
            if (gameEnded) return;
            endGame(turn);
            chatLog.scrollTop = chatLog.scrollHeight;
          }, 1600);
        } else {
          awaitingTurn = false;
          updateInputState();
          chatInput.focus();
        }
      })
      .catch((err) => {
        typingBubble.remove();
        if (gameEnded) return;
        // Turn was not consumed: nothing was applied to state, so the
        // player can simply try sending again.
        awaitingTurn = false;
        if (err instanceof MessageTooLongError) {
          addBubble(chatLog, 'system', `Keep it under ${err.maxMessageChars} characters — house rules.`);
        } else if (err instanceof ReplayTurnError) {
          if (err.code === 'replay_expired') {
            renderReplayExpiredCard();
            return;
          }
          if (err.timer) replayTimer?.applyServerTimer(err.timer);
          else replayTimer?.freezeFromPausedResponse();
          addBubble(chatLog, 'system', 'Replay paused — resume the timer to keep negotiating.');
        } else {
          addBubble(chatLog, 'system', 'The line went quiet — try sending that again.');
        }
        updateInputState();
        chatInput.focus();
      });
  };

  inputRow.addEventListener('submit', (event) => {
    event.preventDefault();
    sendPlayerMessage(chatInput.value.trim());
  });

  // One-tap acceptance: sends an explicit agreement message through the
  // normal turn path (the character only closes when the terms line up,
  // same as a typed "deal").
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      if (chatInput.disabled || !hasNegotiated) return;
      const current = lastKnownAsk;
      const text =
        ctx.showAsk && current !== null
          ? `Deal — I accept your price of ${formatAsk(current, ctx.currency)}.`
          : 'Deal — I accept your offer.';
      sendPlayerMessage(text.slice(0, maxMessageChars));
    });
  }

}

function loadLlmGame(
  root: HTMLElement,
  session: SessionStartLlm,
  dayNumber: number,
  archive = false,
  replay?: ReplayGameConfig,
): void {
  // Neither kind of unranked play may touch the daily streak.
  const streak = archive || replay ? getStoredStreak() : updateStreak(dayNumber);
  const identity = getIdentity();
  const scenario = session.scenario;
  const showAsk = scenario.current_ask !== null;
  const startState: CharacterTurnState = {
    patience: scenario.patience,
    currentAsk: scenario.current_ask ?? 0,
    turns: 0,
  };
  const engine = replay
    ? createReplayLlmEngine(session.session_token, startState)
    : createLlmEngine(session.session_token, startState);
  const initialTurn = engine.start();

  renderGame(root, {
    dayNumber,
    streak,
    identity,
    title: scenario.title,
    characterName: scenario.character_name,
    characterPersona: scenario.character_persona,
    playerBrief: scenario.player_brief ?? null,
    openingMessage: scenario.opening_message,
    currency: scenario.currency,
    maxPatience: scenario.patience,
    maxTurns: scenario.max_turns,
    maxMessageChars: scenario.max_message_chars ?? DEFAULT_MAX_MESSAGE_CHARS,
    showAsk,
    engine,
    initialTurn,
    scoreTurn: (turn) =>
      typeof turn.score === 'number' && typeof turn.label === 'string'
        ? { score: turn.score, label: turn.label }
        : computeLlmScore(turn, scenario.patience, scenario.max_turns),
    // The server writes the score record itself once the session ends;
    // nothing to do client-side. Replays never render or request ranking data.
    recordScore: async () => {},
    archive,
    replay,
  });
}

/** Starts a fresh, unranked replay from a daily result card. */
async function startReplay(root: HTMLElement, identity: DeviceIdentity): Promise<void> {
  clearGameRuntime();
  root.innerHTML = '<div class="loading">Starting your replay…</div>';
  const result = await startReplaySession(identity);
  if (!result.ok) {
    showBanner(result.error, 'error');
    window.location.href = window.location.pathname;
    return;
  }

  const session: SessionStartLlm = {
    llm: true,
    session_token: result.session.session_token,
    scenario: result.session.scenario,
  };
  loadLlmGame(root, session, getDayNumber(), false, {
    sessionToken: result.session.session_token,
    timer: result.timer,
  });
}

/**
 * Starts an unranked replay of a past day chosen from the archive overlay,
 * then renders it through the same renderGame machinery as a live game.
 * Any failure (invalid day, network error) falls back to a full reload,
 * which lands the player back on today's normal game.
 */
async function playArchivedDay(root: HTMLElement, identity: DeviceIdentity, day: ArchiveDayEntry): Promise<void> {
  clearGameRuntime();
  root.innerHTML = `<div class="loading">Loading Talked Down #${day.day_number}\u2026</div>`;
  const result = await startArchiveSession(identity, day.day_number);
  if (!result.ok) {
    showBanner(result.error, 'error');
    window.location.href = window.location.pathname;
    return;
  }
  loadLlmGame(root, { llm: true, session_token: result.session_token, scenario: result.scenario }, result.dayNumber, true);
}

/**
 * Renders the same end-card layout used at the end of a live game, but for
 * a device that already finished today's negotiation: the result comes
 * straight from session/start instead of a just-completed CharacterTurn, so
 * there is no dealPrice and the streak must not be bumped again.
 */
function renderAlreadyPlayed(
  root: HTMLElement,
  result: SessionStartAlreadyPlayed['result'],
  dayNumber: number,
  identity: DeviceIdentity,
): void {
  clearGameRuntime();
  const outcome: 'deal' | 'no_deal' = result.outcome === 'deal' ? 'deal' : 'no_deal';
  const effectiveDay = result.day_number || dayNumber;
  const streak = result.streak && result.streak > 0 ? result.streak : getStoredStreak();
  root.innerHTML = `
    <div class="game">
      <header class="game-header">
        <div class="brand-row">
          <img class="brand-logo" src="${logoUrl}" width="32" height="32" alt="" />
          <div class="brand-copy">
            <span class="brand-word">Talked Down</span>
            <span class="brand-tagline">Talk the AI down. One negotiation a day.</span>
          </div>
        </div>
        <div class="badge-row">
          <span class="day-badge">Talked Down #${effectiveDay}</span>
        </div>
        <h1 class="scenario-title">You\u2019ve already played today\u2019s negotiation.</h1>
        <div class="header-buttons">
          <button type="button" class="leaderboard-btn" id="leaderboard-btn-header">🏆 Best negotiators</button>
          <button type="button" class="leaderboard-btn archive-btn" id="archive-btn-header">🗓️ Past negotiations</button>
        </div>
      </header>
      <div class="end-panel" id="end-panel">
        <div class="end-card">
          <div class="end-result">
            <p class="end-outcome ${outcome === 'deal' ? 'deal' : 'no-deal'}">
              ${outcome === 'deal' ? '\ud83e\udd1d Deal!' : '\ud83d\udca5 No Deal'}
            </p>
            <p class="end-detail">${outcome === 'deal' ? `Closed in ${result.turns} turn${result.turns === 1 ? '' : 's'}` : `Walked away after ${result.turns} turn${result.turns === 1 ? '' : 's'}`}</p>
          </div>
          <div class="end-score">
            <div class="end-score-number">${result.score}/100</div>
            <div class="end-score-label">${escapeHtml(result.result_label)}</div>
          </div>
          <div class="end-percentile" id="end-percentile">You scored better than <strong>${result.percentile}%</strong> of today\u2019s negotiators</div>
          <div class="end-meta">
            <span class="handle-badge" title="Your handle on this device">\ud83c\udfad ${escapeHtml(identity.handle)}${claimedBadgeHtml()}</span>
            <span class="streak-badge">\ud83d\udd25 ${streak} day streak</span>
          </div>
          <div class="history-box" id="history-box"></div>
          <div class="share-card" id="share-card"></div>
          <div class="claim-box" id="claim-box"></div>
          <div class="end-actions">
            <button class="copy-btn" id="copy-btn" type="button">Copy result</button>
            ${replayStartActionHtml()}
            <button class="leaderboard-btn" id="leaderboard-btn-end" type="button">🏆 Best negotiators</button>
            <button class="leaderboard-btn archive-btn" id="archive-btn-end" type="button">🗓️ Past negotiations</button>
          </div>
          <div class="countdown-box">
            Next negotiation in
            <span class="countdown-value" id="countdown-value">--:--:--</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const shareText = buildShareText(effectiveDay, outcome, result.turns, result.score);
  const shareCard = root.querySelector<HTMLElement>('#share-card');
  if (shareCard) shareCard.textContent = shareText;

  const copyBtn = root.querySelector<HTMLButtonElement>('#copy-btn');
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

  const countdownEl = root.querySelector<HTMLElement>('#countdown-value');
  if (countdownEl) startCountdown(countdownEl);

  const replayBtn = root.querySelector<HTMLButtonElement>('#replay-btn');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      void startReplay(root, identity);
    });
  }

  const claimBox = root.querySelector<HTMLElement>('#claim-box');
  if (claimBox) renderClaimWidget(claimBox, identity);

  const leaderboardBtnHeader = root.querySelector<HTMLButtonElement>('#leaderboard-btn-header');
  if (leaderboardBtnHeader) bindLeaderboardTrigger(leaderboardBtnHeader, effectiveDay);

  const leaderboardBtnEnd = root.querySelector<HTMLButtonElement>('#leaderboard-btn-end');
  if (leaderboardBtnEnd) bindLeaderboardTrigger(leaderboardBtnEnd, effectiveDay);

  const archiveBtnHeader = root.querySelector<HTMLButtonElement>('#archive-btn-header');
  if (archiveBtnHeader) {
    bindArchiveTrigger(archiveBtnHeader, getDayNumber(), (day) => {
      void playArchivedDay(root, identity, day);
    });
  }

  const archiveBtnEnd = root.querySelector<HTMLButtonElement>('#archive-btn-end');
  if (archiveBtnEnd) {
    bindArchiveTrigger(archiveBtnEnd, getDayNumber(), (day) => {
      void playArchivedDay(root, identity, day);
    });
  }

  const historyBox = root.querySelector<HTMLElement>('#history-box');
  if (historyBox) {
    void fetchHistory(identity.deviceId).then((items) => {
      if (items.length === 0) return;
      const rows = items
        .map((h) => {
          const day = h.day_number ? `#${h.day_number}` : new Date(h.created).toISOString().slice(5, 10);
          return `<li><span class="history-day">${escapeHtml(String(day))}</span><span class="history-label">${escapeHtml(h.result_label)}</span><span class="history-score">${h.score}/100</span></li>`;
        })
        .join('');
      historyBox.innerHTML = `<div class="history-title">Your recent negotiations</div><ul class="history-list">${rows}</ul>`;
    });
  }
}

async function main(): Promise<void> {
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement)) return;

  clearGameRuntime();
  root.innerHTML = '<div class="loading">Loading today\u2019s negotiation…</div>';

  const dayNumber = getDayNumber();

  // If this load carries a claim magic-link token, verify it BEFORE starting
  // the game session: verification may adopt the claimed identity into local
  // storage, and the session must start as that identity (otherwise a fresh
  // device id + handle gets minted and the player "becomes someone else").
  const claimResult = await consumeClaimTokenFromUrl(getIdentity().deviceId);
  if (claimResult) {
    if (claimResult.ok) {
      showBanner(`✅ Handle claimed: ${claimResult.handle}`, 'success');
    } else {
      showBanner('That link expired — request a new one from your result screen.', 'error');
    }
  }

  // Re-read identity: claim verification may have adopted the claimed one.
  const identity = getIdentity();

  const session = await startBackendSession(identity);
  if (session && session.llm === true) {
    if ('already_played' in session && session.already_played) {
      renderAlreadyPlayed(root, session.result, dayNumber, identity);
      return;
    }
    loadLlmGame(root, session, dayNumber);
    return;
  }

  // session.llm === false, or the start call failed entirely: there is no
  // more client-side rule-engine fallback (engine_config is no longer
  // exposed by the API), so just tell the player to check back.
  root.innerHTML = '<div class="error">Today\u2019s negotiation is being prepared. Check back soon.</div>';
}

void main();
