/**
 * "🗓️ Past negotiations" archive overlay: lets a player browse previously
 * published days and pick one to replay. Replays are clearly unranked —
 * this module only handles listing/selecting a day; main.ts is responsible
 * for actually starting an archive session and rendering the game once a
 * day is picked (mirrors the leaderboard.ts / main.ts split).
 */

import { apiBaseUrl } from './pocketbase';

export interface ArchiveDayEntry {
  day_number: number;
  date: string;
  title: string;
  character_name: string;
}

interface ArchiveDaysResponse {
  days: ArchiveDayEntry[];
}

async function fetchArchiveDays(): Promise<ArchiveDayEntry[] | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/game/archive/days`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && Array.isArray(data.days)) return (data as ArchiveDaysResponse).days;
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

function formatArchiveDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let overlayEl: HTMLElement | null = null;

function closeOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

function renderRows(days: ArchiveDayEntry[]): string {
  if (days.length === 0) {
    return '<p class="archive-empty">No past negotiations yet.</p>';
  }
  const rows = days
    .map(
      (day) => `
      <li class="archive-row">
        <div class="archive-row-info">
          <span class="archive-row-title">#${day.day_number} — ${escapeHtml(day.title)}</span>
          <span class="archive-row-meta">${escapeHtml(day.character_name)} · ${escapeHtml(formatArchiveDate(day.date))}</span>
        </div>
        <button type="button" class="archive-play-btn" data-day="${day.day_number}">Play</button>
      </li>`,
    )
    .join('');
  return `<ul class="archive-list">${rows}</ul>`;
}

/**
 * Opens the archive overlay listing published days other than
 * `excludeDayNumber` (today's day). Calling `onPlay` is the overlay's only
 * side effect on selection — it closes itself immediately and hands the
 * chosen day back to the caller, which owns starting the actual session.
 */
export function openArchiveOverlay(excludeDayNumber: number, onPlay: (day: ArchiveDayEntry) => void): void {
  closeOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'archive-overlay';
  overlay.innerHTML = `
    <div class="archive-card" role="dialog" aria-label="Past negotiations archive">
      <div class="archive-head">
        <h2>🗓️ Past negotiations</h2>
        <button type="button" class="archive-close" id="archive-close" aria-label="Close archive">✕</button>
      </div>
      <p class="archive-subtitle">Replay any past day for fun — these plays are unranked and don\u2019t touch your streak.</p>
      <div class="archive-body" id="archive-body"><p class="archive-loading">Loading…</p></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlayEl = overlay;

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  overlay.querySelector<HTMLButtonElement>('#archive-close')?.addEventListener('click', closeOverlay);

  const body = overlay.querySelector<HTMLElement>('#archive-body');
  if (!body) return;

  void fetchArchiveDays().then((days) => {
    if (!overlayEl) return; // closed while loading
    if (days === null) {
      body.innerHTML = '<p class="archive-empty">Couldn\u2019t load the archive — try again shortly.</p>';
      return;
    }
    const filtered = days.filter((d) => d.day_number !== excludeDayNumber);
    body.innerHTML = renderRows(filtered);

    body.querySelectorAll<HTMLButtonElement>('.archive-play-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const day = filtered.find((d) => String(d.day_number) === btn.dataset.day);
        if (!day) return;
        closeOverlay();
        onPlay(day);
      });
    });
  });
}

/** Wires a "🗓️ Past negotiations" trigger button already present in the DOM. */
export function bindArchiveTrigger(
  button: HTMLElement,
  excludeDayNumber: number,
  onPlay: (day: ArchiveDayEntry) => void,
): void {
  button.addEventListener('click', () => openArchiveOverlay(excludeDayNumber, onPlay));
}
