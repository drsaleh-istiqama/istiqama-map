/**
 * Runs a v2 → v3 migration (brief §10): prepare (reference data, located points, already
 * migrated keys → plan), execute (one transaction per project: proposed locality + bundle +
 * created_at + progress record; then its photos one by one; then directory persons), and
 * finalize (wait for the server to acknowledge every operation of the migrated rows, then —
 * and only then — remove the v2 localStorage keys).
 *
 * Every dependency on the network, the session or the photo pipeline is injected
 * (`RunnerDeps`), so the whole flow runs in unit tests against the real local database with a
 * fake sync. `runtime.ts` wires the real implementations.
 */
import { db, mutate, saveProjectBundle, type Row, type TableName } from '../db';
import type { LonLat } from '../lib/geo';
import {
  localExternalIds,
  loadReference,
  projectStored,
  queueStateOf,
  rowStored,
  type QueueState,
} from './queries';
import { stampInsertCreatedAt } from './stamp';
import {
  addUnique,
  loadRunState,
  newRunState,
  saveRunState,
  stateKey,
  unfiledSuggestions,
  type ProjectProgress,
  type RunState,
} from './state';
import {
  mapV2,
  projectKey,
  type GeoHint,
  type MapContext,
  type MigrationPlan,
  type MigrationWarning,
  type PlanCounts,
} from './v2map';
import { readV2Local } from './v2read';
import type { V2Data } from './v2types';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY } from './v2types';

export interface RunnerDeps {
  userId(): string | null;
  online(): boolean;
  /** One full sync cycle (push + pull). */
  syncNow(): Promise<void>;
  /** Which of these `external_id`s already exist on the server (visible to the user). */
  serverExternalIds(keys: readonly string[]): Promise<Set<string>>;
  /** Where a point lies (server first when online, else the cached shapes); null = unknown. */
  locate(p: LonLat, preferCountries: readonly string[]): Promise<GeoHint | null>;
  /** src/photos `addPhoto` (compress again, store blobs, queue the upload). */
  addPhoto(
    projectId: string,
    file: Blob,
    meta: { category?: string; caption?: string },
  ): Promise<unknown>;
  /** Write scope of the signed-in user (`my_context().scopes.write`). */
  writeScope(): { countries: string[]; branches: string[] };
  phone(raw: string, iso2: string | null): string | null;
  texts: MapContext['texts'];
  readLegacy(key: string): string | null;
  removeLegacy(key: string): void;
  newId(): string;
  today(): string;
  /** Upper bound for the sync done before planning (ms). */
  preSyncTimeoutMs?: number;
  /**
   * Files a merge suggestion for a reviewer (`request_person_merge`; nothing is merged).
   * Resolves true when filed or refused for good (not asked again), false to retry later.
   */
  requestMerge?(sourceId: string, targetId: string, name: string): Promise<boolean>;
}

export interface Prepared {
  data: V2Data;
  plan: MigrationPlan;
  state: RunState;
  /** An earlier attempt of this very input exists (ids reused, saved projects skipped). */
  resumed: boolean;
}

export type RunPhase = 'preparing' | 'saving' | 'uploading' | 'done' | 'waiting' | 'error';

export interface RunProgress {
  phase: RunPhase;
  done: number;
  total: number;
  /** Name of the project being written. */
  current?: string;
}

export interface PushCheck extends QueueState {
  /** Every operation of the migrated rows was acknowledged. */
  done: boolean;
}

export interface RunReport {
  source: V2Data['source'];
  fingerprint: string;
  fileName?: string;
  counts: PlanCounts;
  /** Projects stored by this call. */
  saved: number;
  /** Projects stored by an earlier, interrupted attempt. */
  resumedSaved: number;
  skipped: MigrationPlan['skipped'];
  failed: Array<{ key: string; name: string; message: string }>;
  photosAdded: number;
  photosFailed: Array<{
    key: string;
    name: string;
    index: number;
    message: string;
    permanent: boolean;
  }>;
  personsSaved: number;
  push: PushCheck;
  keysRemoved: boolean;
  warnings: MigrationWarning[];
}

export type MigrationErrorCode = 'reference_missing' | 'migration_running' | 'not_signed_in';

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode) {
    super(code);
    this.name = 'MigrationError';
  }
}

// ---------------------------------------------------------------------------------------

const PERMANENT_PHOTO_ERRORS = new Set([
  'not_image',
  'too_large',
  'decode_failed',
  'limit_reached',
]);

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function errorText(e: unknown): string {
  const code = errorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

/** `data:image/...;base64,...` → Blob (the URL was validated by the mapping). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const mime = /^data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------

/** Builds the plan (nothing is written). */
export async function prepareMigration(data: V2Data, deps: RunnerDeps): Promise<Prepared> {
  // Pull first when online, so that "already migrated" also sees what another device pushed.
  if (deps.online()) {
    await withTimeout(
      deps.syncNow().catch(() => undefined),
      deps.preSyncTimeoutMs ?? 30_000,
    );
  }
  const stored = await loadRunState(data.source, data.fingerprint);
  // A run whose upload was confirmed is history: the same data again (the v2 app restored the
  // keys, the file is chosen a second time) is planned afresh, so every project shows as
  // "already migrated" instead of being "resumed".
  const existingState = stored && stored.pushedAt === null ? stored : undefined;
  const state =
    existingState ?? newRunState(data.source, data.fingerprint, deps.userId(), data.fileName);
  const resumed = existingState !== undefined && Object.keys(existingState.ids).length > 0;

  const ref = await loadReference();
  // Without the synced reference lists the names cannot be mapped (every option would end up
  // as "other" text): wait for the first sync instead of producing a poor plan.
  if (ref.countries.length === 0 || ref.options.length === 0)
    throw new MigrationError('reference_missing');
  const scope = deps.writeScope();
  const branchRows = new Map(ref.branches.map((b) => [b.id, b]));
  const myBranches = scope.branches
    .map((id) => branchRows.get(id))
    .filter((b): b is Row<'branches'> => !!b);
  const defaultBranchId = scope.branches.length === 1 ? scope.branches[0]! : null;
  const defaultCountryId =
    scope.countries.length === 1
      ? scope.countries[0]!
      : defaultBranchId
        ? (branchRows.get(defaultBranchId)?.country_id ?? null)
        : myBranches.length > 0 &&
            myBranches.every((b) => b.country_id === myBranches[0]!.country_id)
          ? myBranches[0]!.country_id
          : null;
  const preferCountries = [
    ...new Set([...scope.countries, ...myBranches.map((b) => b.country_id)]),
  ];

  // Keys that exist already (device + server) — except those of this very run, which the
  // executor resumes itself.
  const keyOf = (p: V2Data['projects'][number]): string =>
    typeof p === 'object' && p !== null ? projectKey(p).key : '';
  const allKeys = [...new Set(data.projects.map(keyOf).filter((k) => k !== ''))];
  const existing = await localExternalIds('v2:');
  if (deps.online() && allKeys.length > 0) {
    try {
      for (const k of await deps.serverExternalIds(allKeys)) existing.add(k);
    } catch {
      // Offline after all / server unreachable: the local check stands; a duplicate key is
      // refused by the server (unique external_id) and reported, never stored twice.
    }
  }
  for (const k of Object.keys(state.projects)) existing.delete(k);

  // Located points (server when online — with the level-3 area and nearby localities).
  const geo = new Map<string, GeoHint>();
  const located: Array<{ key: string; p: LonLat }> = [];
  for (const raw of data.projects) {
    const key = keyOf(raw);
    const lat = Number(raw.lat);
    const lon = Number(raw.lng);
    if (!key || existing.has(key)) continue;
    if (raw.lat === '' || raw.lng === '' || raw.lat == null || raw.lng == null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    located.push({ key, p: { lon, lat } });
  }
  await pool(located, 4, async ({ key, p }) => {
    try {
      const hint = await deps.locate(p, preferCountries);
      if (hint) geo.set(key, hint);
    } catch {
      /* unknown → the names decide */
    }
  });

  const ids = state.ids;
  const ctx: MapContext = {
    countries: ref.countries,
    areas: ref.areas,
    localities: ref.localities,
    options: ref.options,
    donors: ref.donors,
    geo,
    existingKeys: existing,
    branchFor(countryId, areaPath) {
      if (!countryId) return null;
      const mine = myBranches.filter((b) => b.country_id === countryId);
      if (mine.length === 1) return mine[0]!.id;
      const pool = mine.length > 1 ? mine : ref.branches.filter((b) => b.country_id === countryId);
      const covering = pool.filter((b) => b.admin_area_ids.some((a) => areaPath.includes(a)));
      return covering.length === 1 ? covering[0]!.id : null;
    },
    defaultCountryId,
    defaultBranchId,
    idFor: (key) => (ids[key] ??= deps.newId()),
    newId: deps.newId,
    phone: deps.phone,
    today: deps.today(),
    texts: deps.texts,
  };
  const plan = mapV2(data, ctx);
  return { data, plan, state, resumed };
}

// ---------------------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------------------

let active: Promise<RunReport> | null = null;

/** True while a migration is being written on this page. */
export function migrationActive(): boolean {
  return active !== null;
}

/**
 * Writes the plan. Never deletes anything; resumable. Rejects only for a run that is
 * already active or a broken database — per-project failures are in the report.
 */
export function executeMigration(
  prepared: Prepared,
  deps: RunnerDeps,
  onProgress: (p: RunProgress) => void = () => undefined,
): Promise<RunReport> {
  if (active) return Promise.reject(new MigrationError('migration_running'));
  const run = runExecute(prepared, deps, onProgress).finally(() => {
    active = null;
  });
  active = run;
  return run;
}

async function runExecute(
  prepared: Prepared,
  deps: RunnerDeps,
  onProgress: (p: RunProgress) => void,
): Promise<RunReport> {
  const { plan, state } = prepared;
  state.userId ??= deps.userId();
  const report: RunReport = {
    source: plan.source,
    fingerprint: plan.fingerprint,
    ...(state.fileName ? { fileName: state.fileName } : {}),
    counts: plan.counts,
    saved: 0,
    resumedSaved: 0,
    skipped: plan.skipped,
    failed: [],
    photosAdded: 0,
    photosFailed: [],
    personsSaved: 0,
    push: { pending: 0, failed: 0, failures: [], photos: 0, done: false },
    keysRemoved: false,
    warnings: plan.warnings,
  };
  const total =
    plan.projects.length +
    plan.projects.reduce((s, p) => s + p.photos.length, 0) +
    plan.standalonePersons.length;
  let done = 0;
  const tick = (current?: string): void =>
    onProgress({ phase: 'saving', done, total, ...(current ? { current } : {}) });

  // The ids of the plan are final from here on: store them before the first row.
  state.mergeSuggestions = plan.mergeSuggestions.map((s) => ({ ...s }));
  await saveRunState(state);
  tick();

  for (const pp of plan.projects) {
    let progress: ProjectProgress | undefined = state.projects[pp.key];
    if (progress?.saved) {
      report.resumedSaved++;
    } else {
      tick(pp.name);
      try {
        await db.transaction('rw', db.tables, async () => {
          const loc = pp.newLocality;
          if (loc && !(await rowStored('localities', loc.id))) {
            await mutate('localities', loc.id, loc, { insert: true });
          }
          await saveProjectBundle(pp.bundle);
          if (pp.createdAt) await stampInsertCreatedAt(pp.projectId, pp.createdAt);
          const shared: { persons: string[]; donors: string[]; localities: string[] } = {
            persons: pp.bundle.staff.map((s) => s.person_id),
            donors: pp.bundle.donors.filter((d) => d.donor).map((d) => d.donor_id),
            localities: loc ? [loc.id] : [],
          };
          addUnique(state.rows.persons, shared.persons);
          addUnique(state.rows.donors, shared.donors);
          addUnique(state.rows.localities, shared.localities);
          progress = {
            projectId: pp.projectId,
            name: pp.name,
            saved: true,
            photosDone: 0,
            photosTotal: pp.photos.length,
            photosFailed: 0,
          };
          state.projects[pp.key] = progress;
          delete state.failures[pp.key];
          await saveRunState(state);
        });
        report.saved++;
      } catch (e) {
        const message = errorText(e);
        report.failed.push({ key: pp.key, name: pp.name, message });
        state.failures[pp.key] = message;
        await saveRunState(state).catch(() => undefined);
        done += 1 + pp.photos.length;
        tick();
        continue;
      }
    }
    done++;
    tick(pp.name);

    // --- photos: one by one, the position is stored after each ---------------------------
    const prog = progress!;
    const waiting = new Set(prog.retry ?? []);
    const todo = pp.photos.map((_, i) => i).filter((i) => i >= prog.photosDone || waiting.has(i));
    done += pp.photos.length - todo.length;
    const again: number[] = [];
    for (const i of todo) {
      const ph = pp.photos[i]!;
      tick(pp.name);
      try {
        const meta: { category?: string; caption?: string } = { category: ph.category };
        if (ph.caption) meta.caption = ph.caption;
        await deps.addPhoto(pp.projectId, dataUrlToBlob(ph.data), meta);
        report.photosAdded++;
      } catch (e) {
        const permanent = PERMANENT_PHOTO_ERRORS.has(errorCode(e));
        report.photosFailed.push({
          key: pp.key,
          name: pp.name,
          index: ph.index,
          message: errorText(e),
          permanent,
        });
        if (permanent) prog.photosFailed++;
        else again.push(i);
      }
      waiting.delete(i);
      prog.photosDone = Math.max(prog.photosDone, i + 1);
      prog.retry = [...waiting, ...again];
      await saveRunState(state);
      done++;
      tick(pp.name);
    }
  }

  // --- directory persons without a project ---------------------------------------------
  for (const person of plan.standalonePersons) {
    if (!state.rows.persons.includes(person.id)) {
      try {
        await db.transaction('rw', db.tables, async () => {
          if (!(await rowStored('persons', person.id))) {
            await mutate('persons', person.id, person, { insert: true });
          }
          addUnique(state.rows.persons, [person.id]);
          await saveRunState(state);
        });
        report.personsSaved++;
      } catch (e) {
        report.failed.push({
          key: `person:${person.id}`,
          name: person.name_ar ?? person.name_latin ?? '',
          message: errorText(e),
        });
        state.failures[`person:${person.id}`] = errorText(e);
        await saveRunState(state).catch(() => undefined);
      }
    }
    done++;
    tick();
  }

  if (Object.keys(state.failures).length === 0) {
    state.savedAt ??= Date.now();
    await saveRunState(state);
  }

  // --- upload and finalize ---------------------------------------------------------------
  onProgress({ phase: 'uploading', done, total });
  const fin = await finalizeMigration(state, deps, { sync: true });
  report.push = fin.push;
  report.keysRemoved = fin.keysRemoved;
  onProgress({ phase: fin.push.done ? 'done' : 'waiting', done, total });
  return report;
}

// ---------------------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------------------

function rowsOf(state: RunState): Array<[TableName, string]> {
  return [
    ...state.rows.persons.map((id): [TableName, string] => ['persons', id]),
    ...state.rows.donors.map((id): [TableName, string] => ['donors', id]),
    ...state.rows.localities.map((id): [TableName, string] => ['localities', id]),
  ];
}

/** Queue state of everything a run wrote (read-only). */
export async function pushCheck(state: RunState): Promise<PushCheck> {
  const projectIds = Object.values(state.projects)
    .filter((p) => p.saved)
    .map((p) => p.projectId);
  const q = await queueStateOf({ projectIds, rows: rowsOf(state) });
  // A saved project the device no longer holds without any failed operation cannot be told
  // apart from a successful push followed by a scope change: the queue is what counts.
  // The v2 keys hold the original images: every migrated photo must be in storage too.
  return { ...q, done: q.pending === 0 && q.failed === 0 && q.photos === 0 };
}

const hasRetries = (state: RunState): boolean =>
  Object.values(state.projects).some((p) => (p.retry ?? []).length > 0);

/**
 * When everything of the run is stored on the device AND acknowledged by the server, marks
 * the run as pushed and — for the device's own v2 data — removes the two v2 keys. Safe to
 * call at any time (e.g. whenever the sync status changes): it never removes the keys
 * earlier, and never when they hold different data than the run migrated.
 */
export async function finalizeMigration(
  state: RunState,
  deps: Pick<RunnerDeps, 'online' | 'syncNow' | 'readLegacy' | 'removeLegacy' | 'requestMerge'>,
  opts: { sync?: boolean } = {},
): Promise<{ push: PushCheck; keysRemoved: boolean }> {
  if (opts.sync && deps.online()) await deps.syncNow().catch(() => undefined);
  const push = await pushCheck(state);
  const complete =
    state.savedAt !== null && Object.keys(state.failures).length === 0 && !hasRetries(state);
  let keysRemoved = state.keysRemovedAt !== null;
  if (complete && push.done) {
    state.pushedAt ??= Date.now();
    if (state.source === 'v2_local' && state.keysRemovedAt === null) {
      const local = readV2Local(deps.readLegacy);
      const sameData = local.data?.fingerprint === state.fingerprint;
      if (sameData || local.data === null) {
        if (sameData) {
          deps.removeLegacy(V2_PROJECTS_KEY);
          deps.removeLegacy(V2_PEOPLE_KEY);
        }
        state.keysRemovedAt = Date.now();
        keysRemoved = true;
      }
    }
    await saveRunState(state);
  }
  // Both persons exist on the server only now: file the same-name suggestions for a reviewer
  // (brief §2.4 — never an automatic merge). Advisory: never holds back the keys.
  if (complete && push.done && deps.requestMerge && deps.online()) {
    await fileMergeSuggestions(state, deps.requestMerge);
  }
  return { push, keysRemoved };
}

async function fileMergeSuggestions(
  state: RunState,
  requestMerge: NonNullable<RunnerDeps['requestMerge']>,
): Promise<void> {
  const saved = new Set(state.rows.persons);
  let changed = false;
  for (const s of unfiledSuggestions(state)) {
    // A person whose project could not be stored does not exist: nothing to propose.
    const ok =
      saved.has(s.sourceId) && saved.has(s.targetId)
        ? await requestMerge(s.sourceId, s.targetId, s.name).catch(() => false)
        : true;
    if (!ok) continue;
    (state.mergeFiled ??= []).push(`${s.sourceId}|${s.targetId}`);
    changed = true;
  }
  if (changed) await saveRunState(state);
}

/** For the UI: the stored state of an input (resumable run), if any. */
export async function runStateOf(data: V2Data): Promise<RunState | undefined> {
  return loadRunState(data.source, data.fingerprint);
}

export { stateKey, projectStored };
