/**
 * Live tests of the sync engine against the running local stack (gateway + PostgREST + seed):
 * the real supabase-js client (password grant of the seeded staging accounts), the real
 * `sync_push` / `sync_pull` RPCs, the real TUS endpoint.
 *
 *   npx vitest run --config apps/web/vitest.integration.config.ts
 *
 * Each simulated device = its own supabase client (own `x-device-id`), its own Dexie
 * database (fake-indexeddb) and its own engine. The local database behind the engine is the
 * reference `DbPort` implementation of `src/sync/testing/localStore.ts` (two instances with
 * different database names = two devices in one process).
 *
 * Covers acceptance criteria 3 and 4 of the brief at engine level, and the device rule for
 * restricted tables. Created projects are soft-deleted through the API at the end; photo
 * objects stay in storage (users cannot delete them — the retention job does).
 */
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as realDb from '../../src/db';
import { uuidv7 } from '../../src/lib/uuidv7';
import { systemClock } from '../../src/sync/clock';
import { createDbAdapter } from '../../src/sync/dbAdapter';
import { type EngineOptions, type SyncEngine, createSyncEngine } from '../../src/sync/engine';
import { SyncError } from '../../src/sync/errors';
import type { SessionProblem } from '../../src/sync/ports';
import { FakeLock, FakeNetwork, FakePrefs } from '../../src/sync/testing/fakes';
import { LocalStore } from '../../src/sync/testing/localStore';
import { createTransport, supabaseRpcClient } from '../../src/sync/transport';
import { createTusUploader } from '../../src/sync/tusUploader';
import type { PullPage, Transport } from '../../src/sync/types';

const API = process.env.VITE_SUPABASE_URL ?? '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? '';
const PASSWORD = 'Passw0rd!dev';
const COLLECTOR = 'collector.pemba@example.org';
const SUPERVISOR = 'supervisor.pemba@example.org';

/** Unique marker of this run: lets the assertions find exactly the rows created here. */
const RUN = `sync-live-${Date.now().toString(36)}`;
/** A point on Pemba island (inside the scope of branch PEMBA). */
const PEMBA = { lon: 39.75, lat: -5.05 };

interface Device {
  name: string;
  deviceId: string;
  userId: string;
  client: SupabaseClient;
  store: LocalStore;
  engine: SyncEngine;
  net: FakeNetwork;
  problems: SessionProblem[];
  /** Tables seen in pull pages. */
  pulledTables: Set<string>;
  /** Swap to make the transport misbehave. */
  hooks: { afterPush?: () => void };
  /** Close the database and build a fresh store + engine on it ("browser restart"). */
  restart(): void;
}

const devices: Device[] = [];
const ENGINE_OPTIONS: EngineOptions = {
  intervalMs: 3_600_000,
  writeKickDelayMs: 0,
  push: { minIntervalMs: 0, maxAttempts: 1 },
  pull: { minIntervalMs: 0, maxPages: 10_000 },
};

async function makeDevice(
  name: string,
  email: string,
  options: { collector: boolean },
): Promise<Device> {
  const deviceId = `${RUN}-${name}`;
  const client = createClient(API, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-device-id': deviceId } },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error || !signedIn.data.user)
    throw new Error(`sign-in of ${email} failed: ${signedIn.error?.message}`);
  const userId = signedIn.data.user.id;
  const accessToken = async (): Promise<string | null> =>
    (await client.auth.getSession()).data.session?.access_token ?? null;

  const pulledTables = new Set<string>();
  const hooks: Device['hooks'] = {};
  const real = createTransport(supabaseRpcClient(client));
  const transport: Transport = {
    async push(ops, device, opts) {
      const results = await real.push(ops, device, opts);
      hooks.afterPush?.();
      return results;
    },
    async pull(cursor, limit, opts): Promise<PullPage> {
      const page = await real.pull(cursor, limit, opts);
      for (const change of page.changes) pulledTables.add(change.table);
      return page;
    },
    rpc: (fn, args, opts) => real.rpc(fn, args, opts),
  };

  const net = new FakeNetwork();
  const problems: SessionProblem[] = [];
  const dbName = `${RUN}-${name}`;
  const device = {
    name,
    deviceId,
    userId,
    client,
    net,
    problems,
    pulledTables,
    hooks,
  } as Device;
  const build = (): void => {
    device.store = new LocalStore(dbName, { collector: options.collector });
    device.engine = createSyncEngine(
      {
        db: device.store,
        transport,
        auth: {
          deviceId: () => deviceId,
          userId: () => userId,
          accessToken,
          onSessionProblem: (p) => {
            problems.push(p);
          },
        },
        net,
        prefs: new FakePrefs(),
        app: {
          supabaseUrl: API,
          anonKey: ANON,
          appVersion: '3.0.0-live-test',
          deviceLabel: () => `live test ${name}`,
        },
        lock: new FakeLock(),
        uploader: createTusUploader({
          supabaseUrl: API,
          anonKey: ANON,
          accessToken,
          deviceId: () => deviceId,
        }),
        clock: systemClock,
      },
      ENGINE_OPTIONS,
    );
  };
  device.restart = () => {
    device.engine.stop();
    device.store.close();
    build();
  };
  build();
  devices.push(device);
  return device;
}

function newProject(label: string): { id: string; fields: Record<string, unknown> } {
  return {
    id: uuidv7(),
    fields: {
      name_ar: `مسجد اختبار المزامنة ${label}`,
      name_latin: `${RUN}-${label}`,
      type: 'mosque',
      status: 'active',
      record_state: 'draft',
      location_source: 'gps',
      lon: PEMBA.lon,
      lat: PEMBA.lat,
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * One sync cycle. The shared development stack is restarted now and then by other work in
 * progress: a cycle that failed for a transient reason (network, 5xx) is simply run again,
 * exactly as the engine's own backoff would do.
 */
async function sync(device: Device): Promise<void> {
  const transient = [
    'sync.error_network',
    'sync.error_server',
    'sync.error_timeout',
    'sync.error_rate_limited',
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    await device.engine.syncNow();
    const { state, lastError } = device.engine.status.value;
    if (state !== 'error' || !transient.includes(lastError ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
}

async function expectClean(device: Device): Promise<void> {
  expect(await device.store.failedOps(), `${device.name}: rejected operations`).toEqual([]);
  expect(device.engine.status.value, `${device.name}: status`).toMatchObject({
    state: 'idle',
    lastError: null,
    pendingOps: 0,
    failedOps: 0,
  });
  expect(device.problems).toEqual([]);
}

async function serverProjects(
  client: SupabaseClient,
  prefix: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client
    .from('projects')
    .select('id, name_latin, builder, capacity, version, deleted_at, record_state')
    .like('name_latin', `${prefix}%`)
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  return data ?? [];
}

let a: Device;
let b: Device;
let supervisor: Device;
const createdProjects: string[] = [];

beforeAll(async () => {
  expect(API, 'VITE_SUPABASE_URL (.env.local)').not.toBe('');
  expect(ANON, 'VITE_SUPABASE_ANON_KEY (.env.local)').not.toBe('');
  const health = await fetch(`${API}/dev/health`).catch(() => null);
  if (!health?.ok)
    throw new Error(`the local stack is not reachable at ${API} (npm run stack:start)`);
  a = await makeDevice('a', COLLECTOR, { collector: true });
  b = await makeDevice('b', COLLECTOR, { collector: true });
  supervisor = await makeDevice('sup', SUPERVISOR, { collector: true });
}, 120_000);

afterAll(async () => {
  // Soft-delete what this run created (through the API, as the creator), then drop the local databases.
  try {
    if (a && createdProjects.length > 0) {
      await sync(a);
      for (const id of createdProjects) {
        if (await a.store.getRow('projects', id)) await a.store.softDelete('projects', id);
      }
      await sync(a);
    }
  } finally {
    for (const device of devices) {
      device.engine.stop();
      await device.engine.whenIdle();
      await device.client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      await device.store.destroy();
    }
  }
}, 180_000);

describe('two devices of one collector (acceptance criterion 4)', () => {
  const project = newProject('conflict');

  it('first sync pulls the scope of the user and registers the device', async () => {
    await sync(a);
    await expectClean(a);
    expect(a.engine.status.value.lastSyncAt).not.toBeNull();
    expect((await a.store.allRows('countries')).length).toBeGreaterThan(0);
    expect((await a.store.allRows('projects')).length).toBeGreaterThan(0);
    const { data } = await a.client
      .from('devices')
      .select('device_id, revoked_at')
      .eq('device_id', a.deviceId);
    expect(data).toEqual([{ device_id: a.deviceId, revoked_at: null }]);
  }, 180_000);

  it('a project created on device A reaches device B', async () => {
    await a.store.mutate('projects', project.id, project.fields);
    createdProjects.push(project.id);
    await sync(a);
    await expectClean(a);
    const local = await a.store.getRow('projects', project.id);
    expect(local).toMatchObject({ name_latin: project.fields.name_latin });
    expect(local?.version).toBeGreaterThanOrEqual(1);
    expect(typeof local?.code).toBe('string'); // generated by the server, arrived with the pull

    await sync(b);
    await expectClean(b);
    expect(await b.store.getRow('projects', project.id)).toMatchObject({
      name_latin: project.fields.name_latin,
    });
  }, 180_000);

  it('different fields edited offline on both devices are merged without a conflict', async () => {
    a.net.online = false;
    b.net.online = false;
    await a.store.mutate('projects', project.id, { builder: 'builder from device A' });
    await b.store.mutate('projects', project.id, { capacity: 321 });
    await a.engine.syncNow(); // offline: nothing happens
    expect((await a.store.counts()).pendingOps).toBe(1);

    a.net.online = true;
    b.net.online = true;
    await sync(a);
    await sync(b);
    await sync(a);
    await expectClean(a);
    await expectClean(b);

    const [server] = await serverProjects(a.client, String(project.fields.name_latin));
    expect(server).toMatchObject({ builder: 'builder from device A', capacity: 321 });
    for (const device of [a, b]) {
      expect(await device.store.getRow('projects', project.id)).toMatchObject({
        builder: 'builder from device A',
        capacity: 321,
        version: server!.version,
      });
    }
    await sync(supervisor);
    const conflicts = (await supervisor.store.allRows('sync_conflicts')).filter(
      (c) => c.row_id === project.id,
    );
    expect(conflicts).toEqual([]);
  }, 180_000);

  it('the same field edited offline on both devices raises a conflict the supervisor can see', async () => {
    a.net.online = false;
    b.net.online = false;
    await a.store.mutate('projects', project.id, { builder: 'A wins the race' });
    await b.store.mutate('projects', project.id, {
      builder: 'B was offline longer',
      name_latin: `${RUN}-conflict-renamed`,
    });
    a.net.online = true;
    b.net.online = true;

    await sync(a);
    await sync(b);
    await expectClean(b); // a conflict is not a failure: the op is acknowledged

    // The conflicting field was not written; the other field of the same op was.
    const [server] = await serverProjects(a.client, `${RUN}-conflict`);
    expect(server).toMatchObject({
      builder: 'A wins the race',
      name_latin: `${RUN}-conflict-renamed`,
    });
    // Device B shows the server's value for the conflicting field.
    expect(await b.store.getRow('projects', project.id)).toMatchObject({
      builder: 'A wins the race',
      name_latin: `${RUN}-conflict-renamed`,
    });

    await sync(supervisor);
    await expectClean(supervisor);
    const conflicts = (await supervisor.store.allRows('sync_conflicts')).filter(
      (c) => c.row_id === project.id,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      table_name: 'projects',
      field: 'builder',
      state: 'open',
      server_value: 'A wins the race',
      client_value: 'B was offline longer',
      client_device_id: b.deviceId,
    });

    // The supervisor decides; the decision reaches the collector's devices through pull.
    const decision = await createTransport(supabaseRpcClient(supervisor.client)).rpc<{
      state: string;
    }>('resolve_conflict', { p_conflict_id: conflicts[0]!.id, p_choice: 'client' });
    expect(decision.state).toBe('resolved_client');
    await sync(a);
    expect(await a.store.getRow('projects', project.id)).toMatchObject({
      builder: 'B was offline longer',
    });
  }, 180_000);
});

describe('20 projects with photos created offline, restart, then online (acceptance criterion 3)', () => {
  const COUNT = 20;
  const projects = Array.from({ length: COUNT }, (_, i) =>
    newProject(`bulk-${String(i + 1).padStart(2, '0')}`),
  );
  const photos: Array<{ id: string; projectId: string; full: string; thumb: string }> = [];

  it('queues everything while offline', async () => {
    a.net.online = false;
    for (const [i, p] of projects.entries()) {
      await a.store.mutate('projects', p.id, p.fields);
      createdProjects.push(p.id);
      // two photos for every fourth project, one for the others
      for (let k = 0; k < (i % 4 === 0 ? 2 : 1); k++) {
        const id = uuidv7();
        const photo = {
          id,
          projectId: p.id,
          full: `projects/TZ/${p.id}/${id}_full.webp`,
          thumb: `projects/TZ/${p.id}/${id}_thumb.webp`,
        };
        photos.push(photo);
        await a.store.mutate('project_photos', id, {
          project_id: p.id,
          storage_path_full: photo.full,
          storage_path_thumb: photo.thumb,
          width: 1600,
          height: 1200,
          bytes: 4096,
          is_cover: k === 0,
          category: 'mosque_front',
          upload_state: 'pending',
          created_at: new Date().toISOString(),
        });
        await a.store.putPhotoBlob(
          id,
          'full',
          new Blob([new Uint8Array(4096).fill(i + 1)], { type: 'image/webp' }),
        );
        await a.store.putPhotoBlob(
          id,
          'thumb',
          new Blob([new Uint8Array(512).fill(i + 1)], { type: 'image/webp' }),
        );
        await a.engine.enqueuePhotoUpload(id);
      }
    }
    await a.engine.syncNow(); // offline: a no-op
    expect(a.engine.status.value).toMatchObject({
      pendingOps: COUNT + photos.length,
      pendingPhotos: photos.length,
    });
    expect(await serverProjects(a.client, `${RUN}-bulk-`)).toHaveLength(0);
  }, 120_000);

  it('survives a lost response and a browser restart, then uploads everything exactly once', async () => {
    // Online again, but the answer of the first push never arrives and the "browser" is closed.
    a.net.online = true;
    a.hooks.afterPush = () => {
      a.hooks.afterPush = undefined;
      throw new SyncError('network', 'TypeError: fetch failed (response lost)');
    };
    await a.engine.syncNow();
    expect(a.engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_network',
    });
    expect((await a.store.counts()).pendingOps).toBe(COUNT + photos.length); // nothing acknowledged
    expect((await serverProjects(a.client, `${RUN}-bulk-`)).length).toBeGreaterThan(0); // …but the server applied the batch

    a.restart();
    expect((await a.store.counts()).pendingOps).toBe(COUNT + photos.length);
    expect(await a.engine.photos.pendingCount()).toBe(photos.length);

    await sync(a);
    await expectClean(a);
    expect(a.engine.status.value.pendingPhotos).toBe(0);
    expect(await a.store.allOps()).toEqual([]);

    // Exactly 20 projects, no duplicates.
    const onServer = await serverProjects(a.client, `${RUN}-bulk-`);
    expect(onServer.map((p) => p.name_latin).sort()).toEqual(
      projects.map((p) => p.fields.name_latin).sort(),
    );
    expect(new Set(onServer.map((p) => p.id)).size).toBe(COUNT);

    // Their photo rows, each exactly once, all marked uploaded.
    const { data: photoRows, error } = await a.client
      .from('project_photos')
      .select('id, project_id, upload_state, storage_path_full, storage_path_thumb, deleted_at')
      .in(
        'project_id',
        projects.map((p) => p.id),
      );
    expect(error).toBeNull();
    expect((photoRows ?? []).map((r) => r.id).sort()).toEqual(photos.map((p) => p.id).sort());
    expect(
      (photoRows ?? []).every((r) => r.upload_state === 'uploaded' && r.deleted_at === null),
    ).toBe(true);

    // The objects exist in storage with the right content.
    for (const photo of photos) {
      const full = await a.client.storage.from('photos').download(photo.full);
      const thumb = await a.client.storage.from('photos').download(photo.thumb);
      expect(full.error, photo.full).toBeNull();
      expect(thumb.error, photo.thumb).toBeNull();
      expect(full.data?.size).toBe(4096);
      expect(thumb.data?.size).toBe(512);
    }

    // On the device: full-size blobs freed, thumbnails kept, rows in sync with the server.
    for (const photo of photos) {
      expect(await a.store.photoBlob(photo.id, 'full')).toBeUndefined();
      expect(await a.store.photoBlob(photo.id, 'thumb')).toBeDefined();
      expect(await a.store.getRow('project_photos', photo.id)).toMatchObject({
        upload_state: 'uploaded',
      });
    }
  }, 300_000);

  it('a second cycle changes nothing (idempotent)', async () => {
    await sync(a);
    await expectClean(a);
    expect(await serverProjects(a.client, `${RUN}-bulk-`)).toHaveLength(COUNT);
  }, 120_000);
});

describe('restricted tables on a collector device', () => {
  it('never receives staff_compensation or community_sensitive rows', async () => {
    expect(
      [...a.pulledTables].filter((t) => t === 'staff_compensation' || t === 'community_sensitive'),
    ).toEqual([]);
    expect(await a.store.allRows('staff_compensation')).toEqual([]);
    expect(await a.store.allRows('community_sensitive')).toEqual([]);
    // …and cannot read them directly either.
    const direct = await a.client.from('community_sensitive').select('id').limit(1);
    expect(direct.error).not.toBeNull();
    expect(direct.data ?? []).toEqual([]);
  });

  it('keeps its own entry only until the server acknowledged it', async () => {
    const projectId = createdProjects[1]!; // one of the bulk projects created by this collector
    const id = uuidv7();
    await a.store.mutate('community_sensitive', id, {
      project_id: projectId,
      ibadi_families: 7,
      omani_families: 2,
      guest_financial_capacity: 'limited',
      created_at: new Date().toISOString(),
    });
    expect(await a.store.restrictedLocal()).toHaveLength(1);
    expect(await a.store.allRows('community_sensitive')).toEqual([]);

    await sync(a);
    await expectClean(a); // acknowledged, not rejected
    expect(await a.store.restrictedLocal()).toEqual([]);
    expect(await a.store.allRows('community_sensitive')).toEqual([]);

    await sync(a);
    expect(
      [...a.pulledTables].filter((t) => t === 'staff_compensation' || t === 'community_sensitive'),
    ).toEqual([]);
    expect(await a.store.allRows('community_sensitive')).toEqual([]);
  }, 120_000);
});

/**
 * The production wiring: `src/db` (the real Dexie database of the app, one per process) behind
 * `createDbAdapter`, the real transport and the real TUS uploader.
 */
describe('the real local database (src/db) end to end', () => {
  let client: SupabaseClient;
  let engine: SyncEngine;
  let userId = '';
  const net = new FakeNetwork();
  const deviceId = `${RUN}-realdb`;
  const project = realDb.newRow('projects', {
    name_ar: 'مدرسة اختبار قاعدة البيانات المحلية',
    name_latin: `${RUN}-realdb`,
    type: 'school',
    lon: PEMBA.lon,
    lat: PEMBA.lat,
    location_source: 'map',
    capacity: 45,
  });
  const photo = realDb.newRow('project_photos', {
    project_id: project.id,
    width: 800,
    height: 600,
    bytes: 3000,
  });

  beforeAll(async () => {
    client = createClient(API, ANON, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-device-id': deviceId } },
    });
    const signedIn = await client.auth.signInWithPassword({ email: COLLECTOR, password: PASSWORD });
    if (signedIn.error || !signedIn.data.user)
      throw new Error(`sign-in failed: ${signedIn.error?.message}`);
    userId = signedIn.data.user.id;
    const accessToken = async (): Promise<string | null> =>
      (await client.auth.getSession()).data.session?.access_token ?? null;
    await realDb.wipeAllLocalData();
    await realDb.setLocalSession({ userId, canSeeRestricted: false });
    engine = createSyncEngine(
      {
        db: createDbAdapter({ userId: () => userId }),
        transport: createTransport(supabaseRpcClient(client)),
        auth: {
          deviceId: () => deviceId,
          userId: () => userId,
          accessToken,
          onSessionProblem: () => undefined,
        },
        net,
        prefs: new FakePrefs(),
        app: {
          supabaseUrl: API,
          anonKey: ANON,
          appVersion: '3.0.0-live-test',
          deviceLabel: () => 'live test real db',
        },
        lock: new FakeLock(),
        uploader: createTusUploader({
          supabaseUrl: API,
          anonKey: ANON,
          accessToken,
          deviceId: () => deviceId,
        }),
        clock: systemClock,
      },
      ENGINE_OPTIONS,
    );
  }, 60_000);

  afterAll(async () => {
    try {
      if (await realDb.db.projects.get(project.id)) {
        await realDb.softDelete('projects', project.id);
        await engine.syncNow();
      }
    } finally {
      engine.stop();
      await engine.whenIdle();
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      await realDb.wipeAllLocalData();
    }
  }, 120_000);

  async function syncReal(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await engine.syncNow();
      if (engine.status.value.state !== 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }

  it('first sync fills the local database with the scope of the user', async () => {
    await syncReal();
    expect(engine.status.value).toMatchObject({ state: 'idle', lastError: null, failedOps: 0 });
    expect(await realDb.db.countries.count()).toBeGreaterThan(0);
    expect(await realDb.db.projects.count()).toBeGreaterThan(0);
    expect(await realDb.db.staff_compensation.count()).toBe(0);
    expect(await realDb.db.community_sensitive.count()).toBe(0);
  }, 180_000);

  it('a project, its photo and a restricted entry written through mutate() reach the server', async () => {
    net.online = false;
    await realDb.mutate('projects', project.id, project, { insert: true });
    const paths = {
      storage_path_full: `projects/TZ/${project.id}/${photo.id}_full.webp`,
      storage_path_thumb: `projects/TZ/${project.id}/${photo.id}_thumb.webp`,
    };
    await realDb.mutate('project_photos', photo.id, { ...photo, ...paths }, { insert: true });
    await realDb.putPhotoBlob(
      photo.id,
      'full',
      new Blob([new Uint8Array(3000).fill(9)], { type: 'image/webp' }),
    );
    await realDb.putPhotoBlob(
      photo.id,
      'thumb',
      new Blob([new Uint8Array(400).fill(9)], { type: 'image/webp' }),
    );
    await engine.enqueuePhotoUpload(photo.id);
    const sensitive = realDb.newRow('community_sensitive', {
      project_id: project.id,
      ibadi_families: 3,
    });
    await realDb.mutate('community_sensitive', sensitive.id, sensitive, { insert: true });
    expect(await realDb.db.restricted_local.count()).toBe(1);
    await engine.syncNow();
    expect(engine.status.value).toMatchObject({ pendingOps: 3, pendingPhotos: 1 });

    net.online = true;
    await syncReal();
    expect(await realDb.listFailedOps()).toEqual([]);
    expect(engine.status.value).toMatchObject({
      state: 'idle',
      lastError: null,
      pendingOps: 0,
      pendingPhotos: 0,
    });

    const [server] = await serverProjects(client, `${RUN}-realdb`);
    expect(server).toMatchObject({ id: project.id, capacity: 45, record_state: 'draft' });
    const local = await realDb.db.projects.get(project.id);
    expect(local).toMatchObject({ version: server!.version, capacity: 45 });
    expect(typeof local?.code).toBe('string');
    expect(local?._dirty).toBeUndefined();

    const { data: rows } = await client
      .from('project_photos')
      .select('id, upload_state')
      .eq('project_id', project.id);
    expect(rows).toEqual([{ id: photo.id, upload_state: 'uploaded' }]);
    const stored = await client.storage.from('photos').download(paths.storage_path_full);
    expect(stored.error).toBeNull();
    expect(stored.data?.size).toBe(3000);
    expect((await realDb.db.photo_blobs.toArray()).map((b) => b.kind)).toEqual(['thumb']);
    expect(await realDb.db.restricted_local.count()).toBe(0);
  }, 180_000);

  it('an edit made here and an edit made by a supervisor elsewhere are merged', async () => {
    await realDb.mutate('projects', project.id, { builder: 'edited on the device' });
    // Another device (the supervisor's) changes a different field of the same project.
    await sync(supervisor);
    await supervisor.store.mutate('projects', project.id, { capacity: 60 });
    await sync(supervisor);
    await expectClean(supervisor);

    await syncReal();
    expect(await realDb.listFailedOps()).toEqual([]);
    const [server] = await serverProjects(client, `${RUN}-realdb`);
    expect(server).toMatchObject({ builder: 'edited on the device', capacity: 60 });
    expect(await realDb.db.projects.get(project.id)).toMatchObject({
      builder: 'edited on the device',
      capacity: 60,
      version: server!.version,
    });
  }, 180_000);
});
