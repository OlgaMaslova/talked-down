/**
 * "🏆 Best negotiators" overlay: a read-only leaderboard of all players
 * (claimed handles get a ✓ badge; unclaimed show their auto-handle),
 * scoped to today's day number or all-time. Mounted as a full-screen
 * overlay appended to <body> so it can be opened from any screen.
 */

import { apiBaseUrl } from './pocketbase';

interface LeaderboardEntry {
  handle: string;
  claimed?: boolean;
  best_score: number;
  plays: number;
}

interface LeaderboardResponse {
  scope: string;
  entries: LeaderboardEntry[];
}

type Scope = 'day' | 'all';

async function fetchLeaderboard(scope: Scope, dayNumber: number): Promise<LeaderboardResponse | null> {
  try {
    const url =
      scope === 'day'
        ? `${apiBaseUrl}/api/game/leaderboard?scope=day&day_number=${dayNumber}`
        : `${apiBaseUrl}/api/game/leaderboard?scope=all`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && Array.isArray(data.entries)) return data as LeaderboardResponse;
    return null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderRows(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) {
    return '<p class="leaderboard-empty">No negotiators yet — be the first.</p>';
  }
  const rows = entries
    .map(
      (entry, index) => `
      <li class="leaderboard-row">
        <span class="lb-rank">${index + 1}</span>
        <span class="lb-handle">${escapeHtml(entry.handle)}${entry.claimed ? '<span class="claimed-badge" title="Handle claimed">✓</span>' : ''}</span>
        <span class="lb-score">${entry.best_score}/100</span>
        <span class="lb-plays">${entry.plays} play${entry.plays === 1 ? '' : 's'}</span>
      </li>`,
    )
    .join('');
  return `<ul class="leaderboard-list">${rows}</ul>`;
}

let overlayEl: HTMLElement | null = null;

function closeOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

function openOverlay(dayNumber: number): void {
  closeOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'leaderboard-overlay';
  overlay.innerHTML = `
    <div class="leaderboard-card" role="dialog" aria-label="Best negotiators leaderboard">
      <div class="leaderboard-head">
        <h2>🏆 Best negotiators</h2>
        <button type="button" class="leaderboard-close" id="lb-close" aria-label="Close leaderboard">✕</button>
      </div>
      <div class="leaderboard-tabs">
        <button type="button" class="lb-tab active" id="lb-tab-day">Today</button>
        <button type="button" class="lb-tab" id="lb-tab-all">All-time</button>
      </div>
      <div class="leaderboard-body" id="lb-body"><p class="leaderboard-loading">Loading…</p></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlayEl = overlay;

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  overlay.querySelector<HTMLButtonElement>('#lb-close')?.addEventListener('click', closeOverlay);

  const tabDay = overlay.querySelector<HTMLButtonElement>('#lb-tab-day');
  const tabAll = overlay.querySelector<HTMLButtonElement>('#lb-tab-all');
  const body = overlay.querySelector<HTMLElement>('#lb-body');
  if (!tabDay || !tabAll || !body) return;

  const load = (scope: Scope): void => {
    tabDay.classList.toggle('active', scope === 'day');
    tabAll.classList.toggle('active', scope === 'all');
    body.innerHTML = '<p class="leaderboard-loading">Loading…</p>';
    void fetchLeaderboard(scope, dayNumber).then((data) => {
      if (!overlayEl) return; // closed while loading
      if (!data) {
        body.innerHTML = '<p class="leaderboard-empty">Couldn\u2019t load the leaderboard — try again shortly.</p>';
        return;
      }
      body.innerHTML = renderRows(data.entries);
    });
  };

  tabDay.addEventListener('click', () => load('day'));
  tabAll.addEventListener('click', () => load('all'));

  load('day');
}

/** Wires a "🏆 Best negotiators" trigger button already present in the DOM. */
export function bindLeaderboardTrigger(button: HTMLElement, dayNumber: number): void {
  button.addEventListener('click', () => openOverlay(dayNumber));
}
