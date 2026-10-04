/**
 * Compile-time guard of the public module APIs fixed by docs/contracts/web.md §3.
 *
 * Type-only: nothing here is imported by the application or executed by Vitest, but
 * `tsc --noEmit` (npm run typecheck, npm run build) fails as soon as a module drops a contract
 * name or changes its shape incompatibly. Additive changes (extra exports, extra optional
 * parameters, extra fields) stay allowed.
 */
import type { ReadonlySignal, Signal } from '@preact/signals';
import type * as Auth from './auth';
import type * as Db from './db';
import type * as I18n from './i18n';
import type * as Completeness from './lib/completeness';
import type * as Csv from './lib/csv';
import type * as Geo from './lib/geo';
import type * as Normalize from './lib/normalize';
import type * as Prefs from './lib/prefs';
import type * as Similarity from './lib/similarity';
import type * as Uuid from './lib/uuidv7';
import type * as Routes from './routes';
import type * as Sync from './sync';
import type * as Ui from './ui';

/** `true` when A can be used where the contract expects B. */
type Fits<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

// --- §3.1 src/lib ------------------------------------------------------------------------------
export type _Lib = [
  Assert<Fits<typeof Uuid.uuidv7, () => string>>,
  Assert<Fits<typeof Normalize.norm, (text: string) => string>>,
  Assert<Fits<typeof Similarity.similarity, (a: string, b: string) => number>>,
  Assert<Fits<typeof Geo.haversineMeters, (a: Geo.LonLat, b: Geo.LonLat) => number>>,
  Assert<
    Fits<
      typeof Geo.pointInPolygon,
      (p: Geo.LonLat, geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) => boolean
    >
  >,
  Assert<Fits<Geo.LonLat, { lon: number; lat: number }>>,
  Assert<Fits<typeof Completeness.projectCompleteness, (bundle: Db.ProjectBundle) => number>>,
  Assert<Fits<typeof Prefs.getPref<number>, (key: string, fallback: number) => number>>,
  Assert<Fits<typeof Prefs.setPref<number>, (key: string, value: number) => void>>,
  Assert<Fits<typeof Csv.toCsv, (rows: unknown[][]) => string>>,
];

// --- §3.2 src/i18n -----------------------------------------------------------------------------
export type _I18n = [
  Assert<Fits<I18n.Locale, 'ar' | 'sw' | 'en'>>,
  Assert<Fits<'ar' | 'sw' | 'en', I18n.Locale>>,
  Assert<Fits<typeof I18n.locale, Signal<I18n.Locale>>>,
  Assert<Fits<typeof I18n.setLocale, (l: I18n.Locale) => Promise<void>>>,
  Assert<Fits<typeof I18n.t, (key: string, params?: Record<string, string | number>) => string>>,
  Assert<Fits<typeof I18n.dir, () => 'rtl' | 'ltr'>>,
  Assert<
    Fits<
      typeof I18n.pickName,
      (
        row:
          | {
              name_ar?: string | null;
              name_en?: string | null;
              name_sw?: string | null;
              name_latin?: string | null;
            }
          | undefined,
      ) => string
    >
  >,
  Assert<
    Fits<
      typeof I18n.fmt,
      {
        number(n: number): string;
        percent(n: number): string;
        date(d: string | Date): string;
        dateTime(d: string | Date): string;
        relative(d: string | Date): string;
        currency(amount: number, currency: string): string;
        bytes(n: number): string;
      }
    >
  >,
];

// --- §3.3 src/ui -------------------------------------------------------------------------------
export type _Ui = [
  Assert<Fits<typeof Ui.toast, (message: string, kind?: 'info' | 'success' | 'error') => void>>,
  Assert<
    Fits<
      typeof Ui.confirm,
      (options: {
        title: string;
        message: string;
        confirmLabel: string;
        danger: boolean;
      }) => Promise<boolean>
    >
  >,
  Assert<Fits<typeof Ui.SyncBadge, () => unknown>>,
  Assert<Fits<typeof Ui.useDebounced<string>, (value: string, ms: number) => string>>,
];

// --- §3.4 src/db -------------------------------------------------------------------------------
type ProjectRow = Db.Row<'projects'>;
export type _Db = [
  Assert<Fits<typeof Db.db, Db.IstiqamaDexie>>,
  Assert<Fits<(typeof Db.SYNC_TABLES)[number], Db.SyncTableDef>>,
  Assert<Fits<ProjectRow, { id: string; lon: number | null; lat: number | null }>>,
  Assert<
    Fits<
      typeof Db.mutate<'projects'>,
      (
        table: 'projects',
        id: string,
        patch: Partial<ProjectRow>,
        opts?: { insert?: boolean },
      ) => Promise<void>
    >
  >,
  Assert<Fits<typeof Db.softDelete, (table: Db.TableName, id: string) => Promise<void>>>,
  Assert<
    Fits<
      Db.ProjectBundle,
      {
        project: ProjectRow;
        maintenance: Db.Row<'project_maintenance'>[];
        photos: Db.Row<'project_photos'>[];
        donors: Array<Db.Row<'project_donors'>>;
        staff: Array<Db.Row<'project_staff'>>;
      }
    >
  >,
  Assert<Fits<typeof Db.loadProjectBundle, (id: string) => Promise<Db.ProjectBundle | undefined>>>,
  Assert<Fits<typeof Db.saveProjectBundle, (next: Db.ProjectBundle) => Promise<void>>>,
  Assert<
    Fits<
      {
        q: string;
        countryId: string;
        branchId: string;
        adminAreaId: string;
        type: string;
        status: string;
        recordState: string;
        incomplete: boolean;
        mine: boolean;
        openMaintenance: boolean;
      },
      Db.ProjectFilter
    >
  >,
  Assert<
    Fits<
      typeof Db.listProjects,
      (
        filter: Db.ProjectFilter,
        after: Db.ListCursor | null,
        limit?: number,
      ) => Promise<{ rows: Db.ProjectListItem[]; next: Db.ListCursor | null; total: number }>
    >
  >,
  Assert<
    Fits<
      typeof Db.projectsInBounds,
      (
        bbox: [number, number, number, number],
        filter: Db.ProjectFilter,
        limit: number,
      ) => Promise<Db.ProjectListItem[]>
    >
  >,
  Assert<Fits<typeof Db.searchLocal, (q: string, limit?: number) => Promise<Db.SearchHit[]>>>,
  Assert<
    Fits<
      typeof Db.findLocalDuplicates,
      (input: {
        type: string;
        lon: number;
        lat: number;
        name: string;
        localityId?: string | null;
        excludeId?: string;
      }) => Promise<Db.DuplicateHit[]>
    >
  >,
  Assert<
    Fits<
      typeof Db.findLocalPersonCandidates,
      (input: {
        name: string;
        phone?: string;
        adminAreaId?: string | null;
      }) => Promise<Db.PersonCandidate[]>
    >
  >,
  Assert<
    Fits<
      typeof Db.drafts,
      {
        get(key: string): Promise<unknown>;
        put(key: string, value: unknown): Promise<void>;
        remove(key: string): Promise<void>;
        list(): Promise<Array<{ key: string; updatedAt: number }>>;
      }
    >
  >,
];

// --- §3.5 src/sync -----------------------------------------------------------------------------
export type _Sync = [
  Assert<
    Fits<
      typeof Sync.syncStatus,
      ReadonlySignal<{
        online: boolean;
        state: 'idle' | 'pushing' | 'pulling' | 'error';
        pendingOps: number;
        pendingPhotos: number;
        failedOps: number;
        lastSyncAt: number | null;
        lastError: string | null;
      }>
    >
  >,
  Assert<Fits<typeof Sync.startSync, () => void>>,
  Assert<Fits<typeof Sync.stopSync, () => void>>,
  Assert<Fits<typeof Sync.syncNow, () => Promise<void>>>,
  Assert<Fits<typeof Sync.resetLocalData, () => Promise<void>>>,
  Assert<Fits<typeof Sync.enqueuePhotoUpload, (photoId: string) => Promise<void>>>,
  Assert<
    Fits<
      typeof Sync.transport,
      {
        push(ops: Sync.PushOp[], deviceId: string): Promise<Sync.PushResult[]>;
        pull(cursor: unknown | null, limit: number): Promise<Sync.PullPage>;
        rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
      }
    >
  >,
];

// --- §3.6 src/auth -----------------------------------------------------------------------------
export type _Auth = [
  Assert<Fits<typeof Auth.session, ReadonlySignal<unknown>>>,
  Assert<Fits<typeof Auth.me, ReadonlySignal<Auth.MyContext | null>>>,
  Assert<
    Fits<
      typeof Auth.can,
      {
        review: ReadonlySignal<boolean>;
        seeRestricted: ReadonlySignal<boolean>;
        seePeople: ReadonlySignal<boolean>;
        write: ReadonlySignal<boolean>;
        admin: ReadonlySignal<boolean>;
      }
    >
  >,
  Assert<Fits<typeof Auth.signInWithEmailOtp, (email: string) => Promise<void>>>,
  Assert<Fits<typeof Auth.signInWithPhoneOtp, (phone: string) => Promise<void>>>,
  Assert<
    Fits<
      typeof Auth.verifyOtp,
      (identifier: string, code: string, kind: 'email' | 'sms') => Promise<void>
    >
  >,
  Assert<Fits<typeof Auth.signOut, () => Promise<void>>>,
  Assert<
    Fits<
      typeof Auth.pin,
      {
        isSet(): Promise<boolean>;
        set(pin: string): Promise<void>;
        unlock(pin: string): Promise<boolean>;
        lock(): void;
        locked: ReadonlySignal<boolean>;
      }
    >
  >,
  Assert<Fits<typeof Auth.deviceId, () => string>>,
];

// --- §3.9 routes ---------------------------------------------------------------------------------
export type _Routes = [
  Assert<Fits<typeof Routes.navigate, (path: string, opts?: { replace?: boolean }) => void>>,
  Assert<Fits<(typeof Routes.routes)[number], { path: string; load: () => Promise<unknown> }>>,
];
