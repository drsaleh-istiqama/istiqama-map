/**
 * Stable identifier of this installation. Sent as the `x-device-id` header on every request
 * (read by `private.device_id()` / `private.session_ok()`), registered through
 * `register_device`, and what an administrator revokes when a phone is lost.
 *
 * It is an identifier, not a secret: it lives with the UI preferences (src/lib/prefs.ts) so it
 * survives sign-out, a PIN reset and a wipe of the synced data.
 */
import { getPref, setPref } from '../lib/prefs';

const PREF_KEY = 'auth.device_id';
/** Server rule (docs/contracts/sync.md): 1–128 characters of [A-Za-z0-9._:-]. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

let cached: string | null = null;

function randomUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // Insecure contexts (plain http on a LAN address) have no randomUUID: build a v4 by hand.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deviceId(): string {
  if (cached) return cached;
  const stored = getPref<string>(PREF_KEY, '');
  if (typeof stored === 'string' && DEVICE_ID_PATTERN.test(stored)) {
    cached = stored;
    return stored;
  }
  const created = randomUuid();
  setPref(PREF_KEY, created);
  cached = created;
  return created;
}

/** Test hook. */
export function resetDeviceIdCache(): void {
  cached = null;
}
