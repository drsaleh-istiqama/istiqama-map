import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backoffDelay, CYCLE_BACKOFF, REQUEST_BACKOFF } from './backoff';
import { defaultDeviceLabel, registerDevice, reportDeviceStatus, revocationOf } from './device';
import { leaseLock, webLock, createSyncLock, META_LEASE, type LockManagerLike } from './locks';
import { createBrowserNetwork, photoUploadGate } from './network';
import { FakeNetwork, FakePrefs, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { LocalStore } from './testing/localStore';
import { TestClock } from './testing/testClock';

describe('device registration and heartbeat', () => {
  it('sends the device id, a label and the app version', async () => {
    const server = new FakeServer();
    const deps = {
      transport: server.transportFor('dev-1'),
      auth: { deviceId: () => 'dev-1' },
      app: fakeApp,
    };
    expect(await registerDevice(deps)).toMatchObject({ device_id: 'dev-1', revoked: false });
    expect(await reportDeviceStatus(deps, { pendingOps: 3.9, pendingPhotos: -2 })).toMatchObject({
      session_ok: true,
    });
    expect(server.calls.rpc).toEqual([
      {
        fn: 'register_device',
        args: { p_device_id: 'dev-1', p_label: 'test device', p_app_version: '3.0.0-test' },
      },
      {
        fn: 'report_device_status',
        args: {
          p_device_id: 'dev-1',
          p_pending_ops: 3,
          p_pending_photos: 0,
          p_app_version: '3.0.0-test',
        },
      },
    ]);
  });

  it('recognises revocation answers', () => {
    expect(revocationOf({ revoked: false, session_ok: true })).toBeNull();
    expect(revocationOf({})).toBeNull();
    expect(revocationOf({ revoked: true })).toBe('device_revoked');
    expect(revocationOf({ revoked: false, session_ok: false })).toBe('session_revoked');
  });

  it('builds a short device label without personal data', () => {
    const label = defaultDeviceLabel();
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThan(120);
  });
});

describe('backoff', () => {
  it('grows exponentially, is capped, and stays inside the jitter window', () => {
    expect(backoffDelay(CYCLE_BACKOFF, 0, () => 0)).toBe(2_500);
    expect(backoffDelay(CYCLE_BACKOFF, 0, () => 0.999999)).toBe(5_000);
    expect(backoffDelay(CYCLE_BACKOFF, 3, () => 0.5)).toBe(30_000);
    expect(backoffDelay(CYCLE_BACKOFF, 30, () => 0.5)).toBe(450_000); // capped at 10 min
    expect(backoffDelay(REQUEST_BACKOFF, 10, () => 0.999999)).toBe(8_000);
  });

  it('never waits less than the server asked', () => {
    const delay = backoffDelay(REQUEST_BACKOFF, 0, () => 0.5, 20_000);
    expect(delay).toBeGreaterThanOrEqual(20_000);
    expect(delay).toBeLessThanOrEqual(21_000);
  });
});

describe('photo upload gate', () => {
  it('blocks offline and on metered connections when Wi-Fi only is on', () => {
    const net = new FakeNetwork();
    const prefs = new FakePrefs();
    expect(photoUploadGate(net, prefs)).toEqual({ ok: true });
    net.online = false;
    expect(photoUploadGate(net, prefs)).toEqual({ ok: false, reason: 'offline' });
    net.online = true;
    net.type = 'none';
    expect(photoUploadGate(net, prefs)).toEqual({ ok: false, reason: 'offline' });
    prefs.wifi = true;
    net.type = 'cellular';
    expect(photoUploadGate(net, prefs)).toEqual({ ok: false, reason: 'wifi_only' });
    net.type = 'wifi';
    expect(photoUploadGate(net, prefs)).toEqual({ ok: true });
  });

  it('reads connectivity from the browser without throwing', () => {
    const net = createBrowserNetwork();
    expect(typeof net.isOnline()).toBe('boolean');
    expect([
      'wifi',
      'ethernet',
      'cellular',
      'bluetooth',
      'wimax',
      'other',
      'none',
      'unknown',
    ]).toContain(net.connectionType());
    expect(net.saveData()).toBe(false);
    let events = 0;
    const off = net.onChange(() => events++);
    const offVisible = net.onVisible(() => events++);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    document.dispatchEvent(new Event('visibilitychange'));
    off();
    offVisible();
    window.dispatchEvent(new Event('online'));
    expect(events).toBeGreaterThanOrEqual(2);
    expect(events).toBeLessThanOrEqual(3);
  });
});

describe('cross-tab lock', () => {
  let store: LocalStore;
  let clock: TestClock;

  beforeEach(() => {
    store = new LocalStore(`lock-${Math.random().toString(36).slice(2)}`);
    clock = new TestClock();
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('lease: only one holder at a time; the second tab skips or waits', async () => {
    const tabA = leaseLock(store, clock, { ownerId: 'A' });
    const tabB = leaseLock(store, clock, { ownerId: 'B' });
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const a = tabA.run(
      async () => {
        order.push('A start');
        await new Promise<void>((r) => (releaseA = r));
        order.push('A end');
        return 'a';
      },
      { wait: false },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await tabB.run(async () => 'b', { wait: false })).toEqual({ acquired: false });

    const waiting = tabB.run(
      async () => {
        order.push('B start');
        return 'b';
      },
      { wait: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    releaseA();
    expect(await a).toEqual({ acquired: true, value: 'a' });
    expect(await waiting).toEqual({ acquired: true, value: 'b' });
    expect(order).toEqual(['A start', 'A end', 'B start']);
    expect(await store.getMeta(META_LEASE)).toBeUndefined(); // released
  });

  it('lease: a crashed holder is replaced once its lease expired', async () => {
    const manual = new TestClock(0);
    await store.setMeta(META_LEASE, { owner: 'dead-tab', expiresAt: manual.now() + 30_000 });
    const tab = leaseLock(store, manual, { ownerId: 'B', ttlMs: 30_000 });
    expect(await tab.run(async () => 1, { wait: false })).toEqual({ acquired: false });
    manual.time += 30_001;
    expect(await tab.run(async () => 1, { wait: false })).toEqual({ acquired: true, value: 1 });
  });

  it('lease: is released when the work throws', async () => {
    const tab = leaseLock(store, clock, { ownerId: 'A' });
    await expect(
      tab.run(
        async () => {
          throw new Error('boom');
        },
        { wait: false },
      ),
    ).rejects.toThrow('boom');
    expect(await store.getMeta(META_LEASE)).toBeUndefined();
  });

  it('web locks: maps ifAvailable to wait=false and reports a busy lock', async () => {
    const seen: Array<{ name: string; ifAvailable?: boolean }> = [];
    let busy = false;
    const manager: LockManagerLike = {
      request: (name, options, callback) => {
        seen.push({ name, ifAvailable: options.ifAvailable });
        return callback(busy ? null : {});
      },
    };
    const lock = webLock(manager, 'test-lock');
    expect(await lock.run(async () => 5, { wait: true })).toEqual({ acquired: true, value: 5 });
    busy = true;
    expect(await lock.run(async () => 5, { wait: false })).toEqual({ acquired: false });
    expect(seen).toEqual([
      { name: 'test-lock', ifAvailable: false },
      { name: 'test-lock', ifAvailable: true },
    ]);
  });

  it('prefers Web Locks and falls back to the lease when they are missing', async () => {
    let used = 0;
    const manager: LockManagerLike = {
      request: (_n, _o, cb) => {
        used++;
        return cb({});
      },
    };
    await createSyncLock(store, clock, manager).run(async () => 1, { wait: false });
    expect(used).toBe(1);
    expect(await createSyncLock(store, clock, null).run(async () => 2, { wait: false })).toEqual({
      acquired: true,
      value: 2,
    });
  });
});
