# Web app contract (`apps/web`)

Binding module boundaries and public APIs so that several engineers can build features in
parallel. Read together with `docs/ARCHITECTURE.md` §4–5 and the server contracts in this
folder (`schema.md`, `sync.md`, `authz.md`, `geo-search-tiles.md`, `people-admin.md`,
`reports-import-export.md`).

## 1. Stack and rules

- Preact 11 + `@preact/signals` 2, TypeScript `strict` + `noUncheckedIndexedAccess`, Vite 8,
  `vite-plugin-pwa` (`injectManifest`, service worker source `src/sw.ts`).
- `src/contract.typecheck.ts` re-states §3 as type assertions: `tsc` (typecheck, build) fails
  when a module drops a name or changes a shape incompatibly. Additive changes are allowed;
  change that file together with this contract.
- `npm run size -w apps/web` (after a build) reports the gzip size of every chunk and fails
  when the initial JS (entry + modulepreloads + their static imports) exceeds 200 kB.
- JSX runtime: `preact` (`jsxImportSource: "preact"`). Function components + hooks only.
- **Initial JS ≤ 200 kB gzip.** Everything below is a lazy chunk (dynamic `import()`):
  MapLibre + PMTiles + RTL-text plugin, `xlsx`, Sentry, every route view except the shell and
  login. Never import `maplibre-gl` or `xlsx` statically outside their own modules.
- No UI string literals in code. Every visible string comes from `t('namespace.key')`.
  Locale sources are fragments `apps/web/locales/_parts/<namespace>.{ar,sw,en}.json`
  (one namespace per feature, flat `"key": "text"` objects, `{name}` placeholders);
  `npm run locales -w apps/web` merges them into the shipped `locales/{ar,sw,en}.json`
  (keys become `namespace.key`). A unit test fails when the three languages differ in keys.
  Add your strings ONLY to your own namespace fragment.
- CSS: one stylesheet per feature imported by its view (`*.css` next to the component),
  design tokens in `src/ui/tokens.css`. Logical properties only (`margin-inline-start`,
  `padding-inline`, `inset-inline-end`, `text-align: start`) — never `left`/`right`.
  Latin-only fragments (codes, coordinates, phone numbers) get `dir="ltr"` +
  `unicode-bidi: isolate`. Colour contrast AA. Corporate palette: navy `#0f2545`, gold
  `#c8a24a`, background `#f6f7f9`, text `#1b2433`; status colours: active `#1f7a4d`,
  maintenance `#b54708`, building `#175cd3`, inactive `#667085`.
- `localStorage` is allowed only through `src/lib/prefs.ts` (UI preferences: language
  `locale`, per-view filters `filters.*`, Wi-Fi-only flag `sync.wifiOnly`, dismissed hints;
  keys are namespaced by module). All data lives in IndexedDB (Dexie).
- Without a connection (`navigator.onLine === false`) no module starts a request: cached data
  stays in use and the refresh runs on the `online` event (an offline unlock is silent).
- Every interactive element has a stable `data-testid` (kebab-case, listed per feature below).
- Accessibility: keyboard operable, visible focus, `aria-current="page"` on active nav item,
  dialogs trap focus and restore it, form errors linked with `aria-describedby`,
  `role="status"` live region for toasts and sync state.
- Unit tests live next to the code as `*.test.ts(x)` (Vitest, `happy-dom`,
  `fake-indexeddb/auto`). E2E tests live in `apps/web/tests/e2e` (Playwright,
  `channel: 'chrome'` — browsers are not downloaded).

## 2. Directory ownership

| Path                                                                                                                                   | Contents                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/main.tsx`, `src/app.tsx`, `src/routes.ts`, `src/env.ts`, `src/version.ts`, `index.html`, `vite.config.ts`, `src/sw.ts`, `public/` | shell, routing, PWA                                                                                     |
| `src/lib/`                                                                                                                             | pure utilities (`uuidv7`, `normalize`, `geo`, `similarity`, `csv`, `prefs`, `debounce`, `completeness`) |
| `src/i18n/`                                                                                                                            | `t`, locale switching, direction, `Intl` formatters, `pickName`                                         |
| `src/ui/`                                                                                                                              | design tokens and shared components                                                                     |
| `src/db/`                                                                                                                              | Dexie schema, row types, repositories, local search                                                     |
| `src/sync/`                                                                                                                            | engine, outbox, push/pull, transport, photo upload queue, status                                        |
| `src/auth/`                                                                                                                            | Supabase client, session, login, MFA, PIN lock, capability flags                                        |
| `src/photos/`                                                                                                                          | compression, EXIF, photo editor component, thumbnail/full image loading                                 |
| `src/map/`                                                                                                                             | MapLibre view, layers, picker, locate, offline packs                                                    |
| `src/projects/`                                                                                                                        | form, details, register list, maintenance view, incomplete list, review queue                           |
| `src/people/`                                                                                                                          | directory, candidate picker, merge UI                                                                   |
| `src/reports/`                                                                                                                         | dashboard, heat-map toggles, print/PDF views, export                                                    |
| `src/import/`                                                                                                                          | CSV/XLSX import wizard, template                                                                        |
| `src/migration/`                                                                                                                       | v2 → v3 migration                                                                                       |
| `src/admin/`                                                                                                                           | users, roles, countries, branches, options, FX, devices, sync status                                    |
| `src/settings/`                                                                                                                        | language, storage, map packs, Wi-Fi only, PIN, about                                                    |

## 3. Public APIs between modules

Names and shapes below are binding. Internal structure is free.

### 3.1 `src/lib`

```ts
// uuidv7.ts
export function uuidv7(): string;
// normalize.ts — twin of SQL private.norm(); fixture supabase/tests/fixtures/normalize.json
export function norm(text: string): string;
// similarity.ts — trigram similarity compatible with pg_trgm (0..1)
export function similarity(a: string, b: string): number;
// geo.ts
export function haversineMeters(a: LonLat, b: LonLat): number;
export function pointInPolygon(
  p: LonLat,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean;
export type LonLat = { lon: number; lat: number };
// completeness.ts — twin of the SQL formula in docs/contracts/schema.md
export function projectCompleteness(bundle: ProjectBundle): number; // 0..100
// prefs.ts
export function getPref<T>(key: string, fallback: T): T;
export function setPref<T>(key: string, value: T): void;
// csv.ts — UTF-8 BOM, RFC 4180 quoting, formula-injection guard (prefix ' for = + - @)
export function toCsv(rows: unknown[][]): string;
```

### 3.2 `src/i18n`

```ts
export type Locale = 'ar' | 'sw' | 'en';
export const locale: Signal<Locale>; // persisted via prefs
export function setLocale(l: Locale): Promise<void>; // loads JSON, sets <html lang dir>
export function t(key: string, params?: Record<string, string | number>): string;
export function dir(): 'rtl' | 'ltr';
export function pickName(
  row:
    | {
        name_ar?: string | null;
        name_en?: string | null;
        name_sw?: string | null;
        name_latin?: string | null;
      }
    | undefined,
): string;
export const fmt: {
  number(n: number): string;
  percent(n: number): string;
  date(d: string | Date): string;
  dateTime(d: string | Date): string;
  relative(d: string | Date): string;
  currency(amount: number, currency: string): string;
  bytes(n: number): string;
};
```

### 3.3 `src/ui`

```tsx
<Modal open title onClose closeOnBackdrop={false} confirmClose?={() => boolean | Promise<boolean>} testId />
<ConfirmDialog />            // imperative: await confirm({ title, message, confirmLabel, danger })
toast(message: string, kind?: 'info' | 'success' | 'error'): void
<Field label required error hint htmlFor>{control}</Field>      // inline error under the control
<VirtualList items | itemCount rowHeight renderRow onEndReached testId />   // windowed, keyboard friendly
<Chips options value onChange multiple />   <Select />  <Button variant />  <Badge />  <Spinner />  <EmptyState />
<SyncBadge />               // permanent indicator: online/offline, pending ops, pending photos, last sync, "sync now"
useFocusTrap(ref), useDebounced(value, ms), useLiveQuery(fn, deps)   // useLiveQuery re-runs on Dexie changes
```

### 3.4 `src/db`

```ts
export const db: IstiqamaDexie;                   // database name "istiqama-map"
export const SYNC_TABLES: readonly SyncTableDef[]; // must match private.sync_tables (order, restricted flag)
export type Row<T extends TableName> = …;          // one interface per table, columns as on the wire (lon/lat, no geom)

// THE write primitive. Writes the local row (optimistic) and appends/coalesces an outbox op.
export function mutate<T extends TableName>(table: T, id: string, patch: Partial<Row<T>>, opts?: { insert?: boolean }): Promise<void>;
export function softDelete(table: TableName, id: string): Promise<void>;

export interface ProjectBundle {
  project: Row<'projects'>;
  land?: Row<'project_land'>;
  facilities?: Row<'project_facilities'>;
  community?: Row<'community_profiles'>;
  sensitive?: Row<'community_sensitive'>;            // only what this device entered and has not pushed yet, or what a manager pulled
  maintenance: Row<'project_maintenance'>[];
  photos: Row<'project_photos'>[];
  donors: Array<Row<'project_donors'> & { donor?: Row<'donors'> }>;
  staff: Array<Row<'project_staff'> & { person?: Row<'persons'>; compensation?: Row<'staff_compensation'> }>;
}
export function loadProjectBundle(id: string): Promise<ProjectBundle | undefined>;
/** Diffs against what is stored and calls mutate()/softDelete() for every changed row. */
export function saveProjectBundle(next: ProjectBundle): Promise<void>;

export interface ProjectFilter { q?: string; countryId?: string; branchId?: string; adminAreaId?: string; type?: string; status?: string; recordState?: string; incomplete?: boolean; mine?: boolean; openMaintenance?: boolean }
export function listProjects(filter: ProjectFilter, after: ListCursor | null, limit?: number): Promise<{ rows: ProjectListItem[]; next: ListCursor | null; total: number }>;
export function projectsInBounds(bbox: [number, number, number, number], filter: ProjectFilter, limit: number): Promise<ProjectListItem[]>;
export function searchLocal(q: string, limit?: number): Promise<SearchHit[]>;   // projects, localities, staff, donors
export function findLocalDuplicates(input: { type: string; lon: number; lat: number; name: string; localityId?: string | null; excludeId?: string }): Promise<DuplicateHit[]>;
export function findLocalPersonCandidates(input: { name: string; phone?: string; adminAreaId?: string | null }): Promise<PersonCandidate[]>;
export const drafts: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>; list(): Promise<Array<{ key: string; updatedAt: number }>> };
```

Local-only stores: `outbox`, `failed_ops`, `photo_blobs`, `drafts`, `meta`,
`restricted_local`, `packs`. Each synced row keeps the server `version`; rows changed locally
and not yet acknowledged carry `_dirty: 1`.

### 3.5 `src/sync`

```ts
export const syncStatus: Signal<{
  online: boolean;
  state: 'idle' | 'pushing' | 'pulling' | 'error';
  pendingOps: number;
  pendingPhotos: number;
  failedOps: number;
  lastSyncAt: number | null;
  lastError: string | null;
}>;
export function startSync(): void; // online event, every 2 minutes while online, visibilitychange
export function stopSync(): void;
export function syncNow(): Promise<void>; // "sync now" button
export function resetLocalData(): Promise<void>; // scope_epoch changed or sign-out
export function enqueuePhotoUpload(photoId: string): Promise<void>;
export interface Transport {
  push(ops: PushOp[], deviceId: string): Promise<PushResult[]>;
  pull(cursor: unknown | null, limit: number): Promise<PullPage>;
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
}
export const transport: Transport; // supabase-js implementation; replaceable in tests
```

### 3.6 `src/auth`

```ts
export const supabase: SupabaseClient; // the only place that creates the client
export const session: Signal<Session | null>;
export const me: Signal<MyContext | null>; // result of rpc my_context()
export const can: {
  review: ReadonlySignal<boolean>;
  seeRestricted: ReadonlySignal<boolean>;
  seePeople: ReadonlySignal<boolean>;
  write: ReadonlySignal<boolean>;
  admin: ReadonlySignal<boolean>;
};
export function signInWithEmailOtp(email: string): Promise<void>;
export function signInWithPhoneOtp(phone: string): Promise<void>;
export function verifyOtp(identifier: string, code: string, kind: 'email' | 'sms'): Promise<void>;
export function signOut(): Promise<void>;
export const pin: {
  isSet(): Promise<boolean>;
  set(pin: string): Promise<void>;
  unlock(pin: string): Promise<boolean>;
  lock(): void;
  locked: Signal<boolean>;
};
export function deviceId(): string; // stable per installation, sent as x-device-id header
```

### 3.7 `src/photos`

```ts
export function compressPhoto(file: Blob): Promise<{ full: Blob; thumb: Blob; width: number; height: number; takenAt: string | null; mime: 'image/webp' | 'image/jpeg' }>;
export function addPhoto(projectId: string, file: Blob, meta?: { category?: string; caption?: string }): Promise<Row<'project_photos'>>;  // compress → photo_blobs → mutate() → enqueuePhotoUpload()
export function photoUrl(photo: Row<'project_photos'>, kind: 'thumb' | 'full'): Promise<string | null>;   // local blob URL first, else thumbnail fetch / signed URL
<PhotoEditor projectId photos onChange max={10} />
```

### 3.8 `src/map`

```ts
<MapView filter onSelectProject />                               // default export of src/map/MapView.tsx
export function pickLocation(initial: LonLat | null): Promise<(LonLat & { source: 'map' }) | null>;   // opens pick mode: choose → confirm / cancel
export function flyToProject(p: LonLat): void;
export function fitToFilter(filter: ProjectFilter): Promise<void>;
```

### 3.9 Routes (`src/routes.ts`)

| Path                                  | Lazy module (default export)  | Test id of nav item |
| ------------------------------------- | ----------------------------- | ------------------- |
| `/login`                              | `auth/LoginView`              | —                   |
| `/` , `/map`                          | `map/MapPage`                 | `nav-map`           |
| `/projects`                           | `projects/ProjectsPage`       | `nav-projects`      |
| `/projects/new`, `/projects/:id/edit` | `projects/ProjectFormPage`    | `add-project`       |
| `/projects/:id`                       | `projects/ProjectDetailsPage` | —                   |
| `/maintenance`                        | `projects/MaintenancePage`    | `nav-maintenance`   |
| `/incomplete`                         | `projects/IncompletePage`     | `nav-incomplete`    |
| `/review`                             | `projects/ReviewPage`         | `nav-review`        |
| `/people`                             | `people/PeoplePage`           | `nav-people`        |
| `/reports`                            | `reports/ReportsPage`         | `nav-reports`       |
| `/reports/print/:kind/:id`            | `reports/PrintPage`           | —                   |
| `/import`                             | `import/ImportPage`           | `nav-import`        |
| `/admin/*`                            | `admin/AdminPage`             | `nav-admin`         |
| `/settings`                           | `settings/SettingsPage`       | `nav-settings`      |

Navigation: `navigate(path: string, opts?: { replace?: boolean })`, `useRoute()`.
The mobile bottom bar shows: map, projects, add, maintenance, reports.

## 4. Test ids used by the e2e suite

`login-email`, `login-submit`, `login-code`, `login-verify`, `pin-input`, `pin-confirm`
(PIN setup only), `pin-submit`, `nav-*`, `view-title`, `offline-banner`, `settings-page`,
`add-project`, `form-type-mosque|school|combined`, `form-name`, `form-gps`, `form-pick-map`,
`form-lat`, `form-lon`, `form-country`, `form-area`, `form-status`, `form-photo-input`,
`form-save`, `form-cancel`, `form-completeness`, `map-pick-confirm`, `map-pick-cancel`,
`map-locate`, `project-row`, `search-input`, `filter-type`, `filter-status`, `filter-reset`,
`sync-badge` (`data-state` = `ok | syncing | offline | error`), `sync-last` (`data-at` =
`lastSyncAt` in ms, empty before the first sync), `sync-now`, `sync-pending-ops`,
`sync-pending-photos`, `conflict-row`,
`conflict-keep-server`, `conflict-keep-client`, `review-approve`, `review-return`,
`v2-migrate-accept`, `v2-import-file`, `lang-ar`, `lang-sw`, `lang-en`.

## 5. Unit 3 shared pieces (feature modules)

- **Enumerated values** are translated with `t('enum.<enum_key>.<code>')`, generated from the
  database dictionary `private.enum_labels` by `scripts/gen-enum-locales.ts` (never retype them).
  Keys: `project_type`, `project_status`, `record_state`, `staff_role`, `land_ownership`,
  `student_transport`, `students_origin`, `maintenance_priority`, `maintenance_state`,
  `guest_financial_capacity`, `location_source`, `boolean`, plus UI-only `photo_category`,
  `gender`, `currency`.
- **Option lists** (community multi-select) come from the synced `option_values` rows and are
  shown with `pickName()`; the "other" code reveals the `<list>_other` free-text input.
- `src/people/PersonPicker.tsx` (default export):
  `<PersonPicker value={personId|null} onChange={(sel: { personId: string } | { newPerson: { name_ar: string; name_latin?: string; phone_e164?: string } }) => void} adminAreaId? role? testId? />`
  — typing a name shows "possible matching people" (local `findLocalPersonCandidates`, plus
  server `person_candidates` when online); the user explicitly chooses "same person" or "new
  person". It never merges.
- `src/map/MapView.tsx` default export, `src/map/index.ts` exports `pickLocation`,
  `flyToProject`, `fitToFilter` (§3.8). MapLibre, PMTiles and the basemap style are loaded
  only inside the lazy map chunk.
- `src/photos/index.ts` exports §3.7; `PhotoEditor` keeps v2's flow (multi-select, camera with
  preview → accept / retake / cancel, category + caption, delete, retake keeps the old photo
  until the new one is accepted), max 10 photos, one cover.
- `src/projects/labels.ts`: `typeLabel(code)`, `statusLabel(code)`, `recordStateLabel(code)`,
  `StatusBadge`, `TypeIcon` — shared by list, details, map popups and reports.
- Feature modules never edit `src/db` or `src/sync`; queries they need that do not exist yet go
  in `src/<feature>/queries.ts` on top of the exported `db` (Dexie) instance, read-only.
