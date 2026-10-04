import { describe, expect, it } from 'vitest';
import {
  deviceAttention,
  needsAttention,
  REFRESH_MS,
  sortByAttention,
  sortDevices,
  userAttention,
} from './syncStatus';
import type { SyncStatusDevice, SyncStatusUser } from './types';

function device(patch: Partial<SyncStatusDevice> = {}): SyncStatusDevice {
  return {
    id: patch.device_id ?? 'd',
    device_id: 'd',
    label: null,
    user_agent: null,
    app_version: '3.0.0',
    last_seen_at: '2026-10-04T08:00:00Z',
    last_push_at: null,
    last_pull_at: null,
    pending_ops: 0,
    pending_photos: 0,
    open_conflicts: 0,
    rejected_7d: 0,
    stale: false,
    revoked_at: null,
    ...patch,
  };
}

function user(
  id: string,
  name: string,
  patch: Partial<SyncStatusUser> = {},
  devices: SyncStatusDevice[] = [device()],
): SyncStatusUser {
  const sum = (k: 'pending_ops' | 'pending_photos' | 'open_conflicts' | 'rejected_7d') =>
    devices.reduce((n, d) => n + (k.startsWith('pending') && d.revoked_at ? 0 : d[k]), 0);
  return {
    user_id: id,
    full_name: name,
    active: true,
    roles: [{ role: 'field_collector', scope_type: 'branch', scope_id: 'b' }],
    device_count: devices.length,
    pending_ops: sum('pending_ops'),
    pending_photos: sum('pending_photos'),
    open_conflicts: sum('open_conflicts'),
    rejected_7d: sum('rejected_7d'),
    last_seen_at: devices[0]?.last_seen_at ?? null,
    last_push_at: null,
    last_pull_at: null,
    devices,
    ...patch,
  };
}

describe('sync status board ordering (brief §1)', () => {
  const ok = user('u-ok', 'Amina');
  const noDevice = user('u-none', 'Baraka', {}, []);
  const pendingSmall = user('u-p1', 'Chausiku', {}, [device({ pending_ops: 2 })]);
  const pendingBig = user('u-p2', 'Daudi', {}, [device({ pending_ops: 40, pending_photos: 15 })]);
  const conflict = user('u-c', 'Zuhura', {}, [device({ open_conflicts: 1 })]);
  const rejected = user('u-r', 'Yusuf', {}, [device({ rejected_7d: 3, pending_ops: 5 })]);
  const stale = user('u-s', 'Fatma', {}, [device({ stale: true })]);
  const blocked = user('u-b', 'Hamisi', {}, [
    device({ revoked_at: '2026-10-01T00:00:00Z', pending_ops: 9 }),
  ]);
  const inactive = user('u-i', 'Issa', { active: false });

  it('classifies users', () => {
    expect(userAttention(conflict)).toBe('problems');
    expect(userAttention(rejected)).toBe('problems');
    expect(userAttention(pendingBig)).toBe('pending');
    expect(userAttention(stale)).toBe('stale');
    expect(userAttention(blocked)).toBe('blocked');
    expect(userAttention(inactive)).toBe('blocked');
    expect(userAttention(ok)).toBe('ok');
    expect(userAttention(noDevice)).toBe('no_device');
  });

  it('puts users needing attention first: problems, pending, stale, blocked, ok, no device', () => {
    const order = sortByAttention([
      ok,
      noDevice,
      pendingSmall,
      stale,
      blocked,
      conflict,
      pendingBig,
      inactive,
      rejected,
    ]).map((u) => u.user_id);
    expect(order).toEqual(['u-c', 'u-r', 'u-p2', 'u-p1', 'u-s', 'u-b', 'u-i', 'u-ok', 'u-none']);
  });

  it('inside a group the bigger problem comes first, then the name', () => {
    const a = user('a', 'Zeta', {}, [device({ open_conflicts: 1, rejected_7d: 9 })]);
    const b = user('b', 'Alpha', {}, [device({ open_conflicts: 2 })]);
    const c = user('c', 'Beta', {}, [device({ open_conflicts: 2 })]);
    expect(sortByAttention([a, c, b]).map((u) => u.user_id)).toEqual(['b', 'c', 'a']);
  });

  it('does not change the input array', () => {
    const input = [ok, conflict];
    sortByAttention(input);
    expect(input[0]).toBe(ok);
  });

  it('needsAttention is the filter of the board', () => {
    expect([conflict, pendingSmall, stale, blocked, ok, noDevice].map(needsAttention)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('sorts the devices of a user: attention first, then the most recently seen', () => {
    const devices = sortDevices([
      device({ device_id: 'old', last_seen_at: '2026-09-01T00:00:00Z' }),
      device({ device_id: 'new', last_seen_at: '2026-10-04T00:00:00Z' }),
      device({ device_id: 'bad', open_conflicts: 1, last_seen_at: '2026-08-01T00:00:00Z' }),
      device({ device_id: 'blocked', revoked_at: 'x' }),
    ]).map((d) => d.device_id);
    expect(devices).toEqual(['bad', 'blocked', 'new', 'old']);
    expect(deviceAttention(device({ pending_photos: 1 }))).toBe('pending');
  });

  it('refreshes every 60 s', () => {
    expect(REFRESH_MS).toBe(60_000);
  });
});
