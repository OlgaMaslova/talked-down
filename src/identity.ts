/**
 * Silent device identity: a random device ID plus a generated handle,
 * minted on first play and persisted in localStorage. No signup screen —
 * this powers streaks, history, and (later) handle claiming.
 */

const DEVICE_ID_KEY = 'td_device_id';
const HANDLE_KEY = 'td_handle';

const ADJECTIVES = [
  'Shrewd', 'Calm', 'Bold', 'Sly', 'Patient', 'Crafty', 'Steady', 'Sharp',
  'Cool', 'Wily', 'Deft', 'Slick', 'Canny', 'Suave', 'Stoic', 'Quick',
];

const NOUNS = [
  'Haggler', 'Dealer', 'Closer', 'Trader', 'Broker', 'Bargainer', 'Fox',
  'Negotiator', 'Merchant', 'Diplomat', 'Peddler', 'Mediator', 'Shark', 'Owl',
];

export interface DeviceIdentity {
  deviceId: string;
  handle: string;
}

function randomInt(maxExclusive: number): number {
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function mintDeviceId(): string {
  if (window.crypto && 'randomUUID' in window.crypto) {
    return window.crypto.randomUUID();
  }
  return `td-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function mintHandle(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const num = String(randomInt(100)).padStart(2, '0');
  return `${adjective}${noun}${num}`;
}

/**
 * Overwrites the stored identity with one claimed via email magic link,
 * so the claimed handle follows the user onto this browser/profile.
 */
export function adoptIdentity(deviceId: string, handle: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    localStorage.setItem(HANDLE_KEY, handle);
  } catch {
    // Best-effort: the claim is still recorded server-side.
  }
}

/** Returns the persistent device identity, minting one on first play. */
export function getIdentity(): DeviceIdentity {
  let deviceId: string | null = null;
  let handle: string | null = null;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY);
    handle = localStorage.getItem(HANDLE_KEY);
  } catch {
    // localStorage unavailable: fall through to ephemeral identity.
  }

  if (!deviceId) {
    deviceId = mintDeviceId();
    try {
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    } catch {}
  }
  if (!handle) {
    handle = mintHandle();
    try {
      localStorage.setItem(HANDLE_KEY, handle);
    } catch {}
  }

  return { deviceId, handle };
}
