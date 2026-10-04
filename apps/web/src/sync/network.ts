/**
 * Connectivity: the browser implementation of `NetworkPort` and the "Wi-Fi only" gate of
 * the photo queue (brief §4.4).
 */
import type { ConnectionType, NetworkPort, PrefsPort } from './ports';

/** Key of the "upload photos over Wi-Fi only" preference in src/lib/prefs. */
export const WIFI_ONLY_PREF_KEY = 'sync.wifiOnly';

interface NetworkInformationLike {
  type?: string;
  saveData?: boolean;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'wifi',
  'ethernet',
  'cellular',
  'bluetooth',
  'wimax',
  'other',
  'none',
]);

function connection(): NetworkInformationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

/** `NetworkPort` backed by `navigator` / `window` events. Safe to create without a DOM. */
export function createBrowserNetwork(): NetworkPort {
  return {
    isOnline() {
      // `onLine === false` is reliable; `true` only means "there is some network interface".
      return typeof navigator === 'undefined' || navigator.onLine !== false;
    },
    connectionType(): ConnectionType {
      const type = connection()?.type;
      return typeof type === 'string' && KNOWN_TYPES.has(type)
        ? (type as ConnectionType)
        : 'unknown';
    },
    saveData() {
      return connection()?.saveData === true;
    },
    onChange(listener) {
      if (typeof window === 'undefined') return () => undefined;
      const up = (): void => listener(true);
      const down = (): void => listener(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    },
    onVisible(listener) {
      if (typeof document === 'undefined') return () => undefined;
      const handler = (): void => {
        if (document.visibilityState === 'visible') listener();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

export type UploadGate = { ok: true } | { ok: false; reason: 'offline' | 'wifi_only' };

/**
 * May photos be uploaded right now?
 *  - offline → no;
 *  - "Wi-Fi only" off → yes;
 *  - "Wi-Fi only" on → yes on Wi-Fi/Ethernet; no on a connection known to be metered
 *    (cellular, Bluetooth tethering, WiMAX…); when the browser does not tell the connection
 *    type (most desktop browsers, iOS) it is treated as allowed — unless the user asked the
 *    browser to save data (`saveData`), which we respect.
 */
export function photoUploadGate(net: NetworkPort, prefs: PrefsPort): UploadGate {
  const type = net.connectionType();
  if (!net.isOnline() || type === 'none') return { ok: false, reason: 'offline' };
  if (!prefs.wifiOnly()) return { ok: true };
  if (type === 'wifi' || type === 'ethernet') return { ok: true };
  if (type === 'unknown') return net.saveData() ? { ok: false, reason: 'wifi_only' } : { ok: true };
  return { ok: false, reason: 'wifi_only' };
}
