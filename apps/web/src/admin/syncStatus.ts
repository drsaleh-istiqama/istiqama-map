/**
 * Ordering and classification of the sync-status board (brief §1, people-admin.md §7):
 * users who need attention come first, so a supervisor sees problems without scrolling.
 *
 *   1. open conflicts or operations rejected in the last 7 days   ("problems")
 *   2. work waiting on a device (pending operations or photos)    ("pending")
 *   3. a device not seen for more than 7 days                      ("stale")
 *   4. revoked devices / deactivated accounts                      ("blocked")
 *   5. everybody else, then users without any device
 * Inside a group: the larger problem first, then the name.
 */
import type { SyncStatusDevice, SyncStatusUser } from './types';

export type Attention = 'problems' | 'pending' | 'stale' | 'blocked' | 'ok' | 'no_device';

const RANK: Record<Attention, number> = {
  problems: 0,
  pending: 1,
  stale: 2,
  blocked: 3,
  ok: 4,
  no_device: 5,
};

export function deviceAttention(device: SyncStatusDevice): Attention {
  if (device.open_conflicts > 0 || device.rejected_7d > 0) return 'problems';
  if (device.revoked_at) return 'blocked';
  if (device.pending_ops > 0 || device.pending_photos > 0) return 'pending';
  if (device.stale) return 'stale';
  return 'ok';
}

export function userAttention(user: SyncStatusUser): Attention {
  if (user.open_conflicts > 0 || user.rejected_7d > 0) return 'problems';
  if (user.pending_ops > 0 || user.pending_photos > 0) return 'pending';
  const devices = user.devices ?? [];
  if (devices.some((d) => d.stale && !d.revoked_at)) return 'stale';
  if (!user.active || (devices.length > 0 && devices.every((d) => d.revoked_at))) return 'blocked';
  if (devices.length === 0 && user.device_count === 0) return 'no_device';
  return 'ok';
}

function weight(user: SyncStatusUser, attention: Attention): number {
  switch (attention) {
    case 'problems':
      return user.open_conflicts * 1000 + user.rejected_7d;
    case 'pending':
      return user.pending_ops * 10 + user.pending_photos;
    default:
      return 0;
  }
}

function nameOf(user: SyncStatusUser): string {
  return (user.full_name ?? '').trim();
}

/** Sorted copy: attention first (see the module comment). */
export function sortByAttention(users: readonly SyncStatusUser[]): SyncStatusUser[] {
  const keyed = users.map((user) => {
    const attention = userAttention(user);
    return { user, rank: RANK[attention], weight: weight(user, attention), name: nameOf(user) };
  });
  keyed.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.weight - a.weight ||
      a.name.localeCompare(b.name) ||
      a.user.user_id.localeCompare(b.user.user_id),
  );
  return keyed.map((k) => k.user);
}

/** Devices of one user: the ones that need attention first, then the most recently seen. */
export function sortDevices(devices: readonly SyncStatusDevice[]): SyncStatusDevice[] {
  return [...devices].sort((a, b) => {
    const r = RANK[deviceAttention(a)] - RANK[deviceAttention(b)];
    if (r !== 0) return r;
    return (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '');
  });
}

export function needsAttention(user: SyncStatusUser): boolean {
  const a = userAttention(user);
  return a === 'problems' || a === 'pending' || a === 'stale';
}

/** Auto-refresh period of the board while the page is visible. */
export const REFRESH_MS = 60_000;
