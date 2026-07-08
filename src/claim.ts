/**
 * Handle-claiming flow: turns a device's silent, locally-minted handle into
 * something durable by attaching an email via a magic-link style verify
 * step. Nothing here ever creates a password or a login screen — claiming
 * just lets the same handle survive a lost device.
 */

import { apiBaseUrl } from './pocketbase';
import { adoptIdentity } from './identity';
import type { DeviceIdentity } from './identity';

const CLAIMED_KEY = 'td_claimed';
const CLAIMED_EMAIL_KEY = 'td_claimed_email';

export function isClaimed(): boolean {
  try {
    return localStorage.getItem(CLAIMED_KEY) === '1';
  } catch {
    return false;
  }
}

export function getClaimedEmail(): string | null {
  try {
    return localStorage.getItem(CLAIMED_EMAIL_KEY);
  } catch {
    return null;
  }
}

function markClaimed(email: string): void {
  try {
    localStorage.setItem(CLAIMED_KEY, '1');
    localStorage.setItem(CLAIMED_EMAIL_KEY, email);
  } catch {
    // Best-effort only: worst case the claim banner won't persist locally,
    // but the account is still claimed server-side.
  }
}

type ClaimStartResult =
  | { status: 'ok' }
  | { status: 'unavailable' }
  | { status: 'send_failed' }
  | { status: 'rate_limited' }
  | { status: 'error' };

async function claimStart(deviceId: string, handle: string, email: string): Promise<ClaimStartResult> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/claim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, email, handle }),
    });
    if (res.status === 200) return { status: 'ok' };
    if (res.status === 503) return { status: 'unavailable' };
    if (res.status === 502) return { status: 'send_failed' };
    if (res.status === 429) return { status: 'rate_limited' };
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

export interface ClaimVerifyResult {
  handle: string;
  email: string;
  deviceId: string;
}

/** Calls claim/verify; returns null when the token is invalid/expired or the request fails. */
export async function verifyClaimToken(token: string, deviceId: string): Promise<ClaimVerifyResult | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/claim/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, device_id: deviceId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok === true && typeof data.handle === 'string' && typeof data.email === 'string') {
      return {
        handle: data.handle,
        email: data.email,
        deviceId: typeof data.device_id === 'string' && data.device_id ? data.device_id : deviceId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Small ✓ badge markup shown next to a claimed handle. Empty string when unclaimed. */
export function claimedBadgeHtml(): string {
  return isClaimed() ? '<span class="claimed-badge" title="Handle claimed">✓</span>' : '';
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Mounts the "Claim your handle" control into `container`. Renders nothing
 * when the device is already claimed. The container is expected to be
 * empty; this function owns its full contents.
 */
export function renderClaimWidget(container: HTMLElement, identity: DeviceIdentity): void {
  if (isClaimed()) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <button type="button" class="claim-btn" id="claim-open-btn">🎖️ Claim ${escapeHtml(identity.handle)} — save your record forever</button>
    <form class="claim-form hidden" id="claim-form">
      <input type="email" id="claim-email" class="claim-email-input" placeholder="you@example.com" autocomplete="email" required />
      <button type="submit" class="claim-submit-btn" id="claim-submit-btn">Send magic link</button>
    </form>
    <p class="claim-status" id="claim-status"></p>
  `;

  const openBtn = container.querySelector<HTMLButtonElement>('#claim-open-btn');
  const form = container.querySelector<HTMLFormElement>('#claim-form');
  const emailInput = container.querySelector<HTMLInputElement>('#claim-email');
  const submitBtn = container.querySelector<HTMLButtonElement>('#claim-submit-btn');
  const statusEl = container.querySelector<HTMLElement>('#claim-status');
  if (!openBtn || !form || !emailInput || !submitBtn || !statusEl) return;

  openBtn.addEventListener('click', () => {
    openBtn.classList.add('hidden');
    form.classList.remove('hidden');
    emailInput.focus();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!isValidEmail(email)) {
      statusEl.textContent = 'Enter a valid email to claim your handle.';
      statusEl.className = 'claim-status error';
      return;
    }

    emailInput.disabled = true;
    submitBtn.disabled = true;
    statusEl.textContent = 'Sending…';
    statusEl.className = 'claim-status pending';

    void claimStart(identity.deviceId, identity.handle, email).then((result) => {
      if (result.status === 'ok') {
        form.classList.add('hidden');
        statusEl.textContent = '📬 Check your email — magic link sent';
        statusEl.className = 'claim-status success';
        return;
      }
      emailInput.disabled = false;
      submitBtn.disabled = false;
      if (result.status === 'unavailable') {
        statusEl.textContent = 'Claiming is unavailable right now';
      } else if (result.status === 'rate_limited') {
        statusEl.textContent = 'Hold on — try again in a couple of minutes';
      } else {
        statusEl.textContent = 'Something went sideways — try again in a moment.';
      }
      statusEl.className = 'claim-status error';
    });
  });
}

/**
 * If the URL carries a `?claim_token=`, verifies it against this device,
 * persists the claimed state on success, and always strips the param from
 * the URL bar afterward. Returns a status the caller can use to show a
 * banner; does nothing (returns null) when there's no token to check.
 */
export async function consumeClaimTokenFromUrl(
  deviceId: string,
): Promise<{ ok: true; handle: string } | { ok: false } | null> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('claim_token');
  if (!token) return null;

  const result = await verifyClaimToken(token, deviceId);

  url.searchParams.delete('claim_token');
  window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);

  if (result) {
    // The link may be opened in a different browser/profile (e.g. an email
    // app's in-app browser) than the one that played. Adopt the claim's
    // original identity so the handle, history, and streak follow the user.
    adoptIdentity(result.deviceId, result.handle);
    markClaimed(result.email);
    return { ok: true, handle: result.handle };
  }
  return { ok: false };
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
