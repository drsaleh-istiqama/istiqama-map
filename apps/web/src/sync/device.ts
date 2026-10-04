/**
 * Device registration and heartbeat (docs/contracts/sync.md §3, people-admin.md §7).
 * `register_device` is called when the engine starts; `report_device_status` after every
 * cycle carries the pending counters shown on the administrators' sync-status board.
 * Both answers can tell the device that it (or the whole session) has been revoked.
 */
import type { AppInfo, AuthPort, SessionProblem } from './ports';
import type { DeviceAnswer, Transport } from './types';

export interface DeviceDeps {
  transport: Transport;
  auth: Pick<AuthPort, 'deviceId'>;
  app: AppInfo;
}

const MAX_LABEL = 120;
const MAX_VERSION = 40;

export async function registerDevice(
  deps: DeviceDeps,
  signal?: AbortSignal,
): Promise<DeviceAnswer> {
  const answer = await deps.transport.rpc<DeviceAnswer | null>(
    'register_device',
    {
      p_device_id: deps.auth.deviceId(),
      p_label: deps.app.deviceLabel().slice(0, MAX_LABEL),
      p_app_version: deps.app.appVersion.slice(0, MAX_VERSION),
    },
    { signal },
  );
  return answer ?? {};
}

export async function reportDeviceStatus(
  deps: DeviceDeps,
  counters: { pendingOps: number; pendingPhotos: number },
  signal?: AbortSignal,
): Promise<DeviceAnswer> {
  const answer = await deps.transport.rpc<DeviceAnswer | null>(
    'report_device_status',
    {
      p_device_id: deps.auth.deviceId(),
      p_pending_ops: Math.max(0, Math.trunc(counters.pendingOps)),
      p_pending_photos: Math.max(0, Math.trunc(counters.pendingPhotos)),
      p_app_version: deps.app.appVersion.slice(0, MAX_VERSION),
    },
    { signal },
  );
  return answer ?? {};
}

/** Does the server's answer mean "stop syncing, wipe, sign out"? */
export function revocationOf(answer: DeviceAnswer): SessionProblem['reason'] | null {
  if (answer.revoked === true) return 'device_revoked';
  if (answer.session_ok === false) return 'session_revoked';
  return null;
}

/** Default device label: platform and browser family, no personal data. */
export function defaultDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean; brands?: Array<{ brand: string }> };
  };
  const data = nav.userAgentData;
  if (data?.platform) {
    const brand = data.brands
      ?.map((b) => b.brand)
      .find((b) => !/not.?a.?brand/i.test(b) && b !== 'Chromium');
    return [data.platform, data.mobile ? 'mobile' : '', brand ?? ''].filter(Boolean).join(' ');
  }
  const ua = nav.userAgent ?? '';
  const os =
    /Android [\d.]+/.exec(ua)?.[0] ??
    /iPhone|iPad|Windows|Mac OS X|Linux/.exec(ua)?.[0] ??
    'device';
  const browser = /Firefox|Edg|Chrome|Safari/.exec(ua)?.[0] ?? '';
  return `${os} ${browser}`.trim();
}
