/**
 * Turns the form draft into the `ProjectBundle` handed to `saveProjectBundle()`.
 *
 * `saveProjectBundle()` writes every field it gets and treats the lists as complete. A form
 * that stayed open while a pull arrived (or a draft restored days later) would therefore
 * revert other people's changes and delete rows added elsewhere. The bundle is built as a
 * three-way merge instead:
 *
 *   current (stored now)  +  the fields the user changed between `original` and `working`
 *
 *   - a row that only exists in `current` (added elsewhere) is kept;
 *   - a row the user removed is left out (so it is deleted);
 *   - a row that disappeared from `current` while the user kept it untouched stays deleted;
 *   - a 1:1 section the user did not touch is `undefined` ("not touched");
 *   - existing persons and donors are never re-saved (only the ones created in the form);
 *   - a restricted row (salary, sensitive community data) is sent only when the user entered
 *     something: a blind write lands on the stored row by its natural key (sync.md §4.4).
 */
import type { ProjectBundle, Row } from '../../db';

type AnyRow = Record<string, unknown>;

/** Never compared: bookkeeping, nested rows, parent links and server-managed columns. */
const IGNORED = new Set([
  'person',
  'donor',
  'compensation',
  '_dirty',
  '_conflict',
  '_conflict_fields',
  '_conflict_version',
  '_failed',
  'id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'deleted_at',
  'project_id',
  'project_staff_id',
]);

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  return false;
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Fields of `after` that differ from `before`. Without `before` (a row new in the form) the
 * fields that carry a value.
 */
export function changedFields(before: object | null | undefined, after: object): AnyRow {
  const out: AnyRow = {};
  const b = (before ?? null) as AnyRow | null;
  for (const [k, v] of Object.entries(after as AnyRow)) {
    if (IGNORED.has(k) || k.startsWith('_') || v === undefined) continue;
    if (b === null) {
      if (!isEmptyValue(v)) out[k] = v;
    } else if (!sameValue(b[k], v)) {
      out[k] = v;
    }
  }
  return out;
}

export const isDeleted = (row: { deleted_at?: string | null } | null | undefined): boolean =>
  !!row && row.deleted_at !== null && row.deleted_at !== undefined;

function strip<T extends object>(row: T): T {
  const out = { ...(row as AnyRow) };
  delete out.person;
  delete out.donor;
  delete out.compensation;
  return out as T;
}

/** A 1:1 section: `undefined` when the user did not change it. */
function mergeSection<T extends { id: string }>(
  original: T | undefined,
  working: T | undefined,
  current: T | undefined,
): T | undefined {
  if (!working) return undefined;
  const diff = changedFields(original, working);
  if (Object.keys(diff).length === 0) return undefined;
  return { ...(current ?? working), ...diff } as T;
}

function byId<T extends { id: string }>(rows: readonly T[] | undefined): Map<string, T> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}

function mergeList<T extends { id: string; deleted_at?: string | null }>(
  original: readonly T[] | undefined,
  working: readonly T[],
  current: readonly T[] | undefined,
  known: ReadonlySet<string>,
  one: (current: T | undefined, original: T | undefined, working: T) => T,
): T[] {
  const o = byId(original);
  const w = byId(working.filter((r) => !isDeleted(r)));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const c of current ?? []) {
    seen.add(c.id);
    const wr = w.get(c.id);
    if (wr) out.push(one(c, o.get(c.id), wr));
    else if (o.has(c.id) || known.has(c.id))
      continue; // removed by the user
    else out.push(c); // added elsewhere while the form was open
  }
  for (const wr of w.values()) {
    if (seen.has(wr.id)) continue;
    if (o.has(wr.id)) continue; // deleted elsewhere meanwhile: the deletion wins
    out.push(one(undefined, undefined, wr));
  }
  return out;
}

const plainMerge =
  <T extends object>() =>
  (current: T | undefined, original: T | undefined, working: T): T =>
    current ? ({ ...current, ...changedFields(original, working) } as T) : working;

type StaffEntry = ProjectBundle['staff'][number];
type DonorEntry = ProjectBundle['donors'][number];

function mergeCompensation(
  current: Row<'staff_compensation'> | undefined,
  original: Row<'staff_compensation'> | undefined,
  working: Row<'staff_compensation'> | undefined,
  now: string,
): Row<'staff_compensation'> | undefined {
  if (!working) {
    // The user removed a salary that was on the device: delete the stored row.
    return original && current ? { ...current, deleted_at: now } : undefined;
  }
  const diff = changedFields(original, working);
  if (Object.keys(diff).length === 0) return undefined;
  if (current && current.effective_from === working.effective_from) {
    return { ...current, ...diff } as Row<'staff_compensation'>;
  }
  return { ...working };
}

export interface MergeInput {
  original: ProjectBundle | null;
  working: ProjectBundle;
  /** What is stored now (`loadProjectBundle` at save time); undefined for a new project. */
  current: ProjectBundle | undefined;
  newDonorIds: readonly string[];
  newPersonIds: readonly string[];
  /** Photo ids the user saw in this session (see FormExtras.seenPhotoIds). */
  seenPhotoIds?: readonly string[];
  /** ISO timestamp used for deletions (tests pass a fixed value). */
  now?: string;
}

export function buildBundle(input: MergeInput): ProjectBundle {
  const { original, working, current } = input;
  const now = input.now ?? new Date().toISOString();
  const newPersons = new Set(input.newPersonIds);
  const newDonors = new Set(input.newDonorIds);
  const none = new Set<string>();

  const project = current
    ? ({
        ...strip(current.project),
        ...changedFields(original?.project ?? null, working.project),
      } as Row<'projects'>)
    : strip(working.project);

  const staff = mergeList<StaffEntry>(
    original?.staff,
    working.staff,
    current?.staff,
    none,
    (c, o, w) => {
      const entry = (
        c ? { ...strip(c), ...changedFields(o ? strip(o) : undefined, strip(w)) } : strip(w)
      ) as StaffEntry;
      if (w.person && w.person.id === entry.person_id && newPersons.has(w.person.id)) {
        entry.person = w.person;
      }
      const comp = mergeCompensation(c?.compensation, o?.compensation, w.compensation, now);
      if (comp) entry.compensation = { ...comp, project_staff_id: entry.id };
      return entry;
    },
  );

  const donors = mergeList<DonorEntry>(
    original?.donors,
    working.donors,
    current?.donors,
    none,
    (c, o, w) => {
      const entry = (
        c ? { ...strip(c), ...changedFields(o ? strip(o) : undefined, strip(w)) } : strip(w)
      ) as DonorEntry;
      if (w.donor && w.donor.id === entry.donor_id && newDonors.has(w.donor.id)) {
        entry.donor = w.donor;
      }
      return entry;
    },
  );

  const bundle: ProjectBundle = {
    project,
    maintenance: mergeList(
      original?.maintenance,
      working.maintenance,
      current?.maintenance,
      none,
      plainMerge<Row<'project_maintenance'>>(),
    ),
    photos: mergeList(
      original?.photos,
      working.photos,
      current?.photos,
      new Set(input.seenPhotoIds ?? []),
      plainMerge<Row<'project_photos'>>(),
    ),
    donors,
    staff,
  };

  const land = mergeSection(original?.land, working.land, current?.land);
  const facilities = mergeSection(original?.facilities, working.facilities, current?.facilities);
  const community = mergeSection(original?.community, working.community, current?.community);
  const sensitive = mergeSection(original?.sensitive, working.sensitive, current?.sensitive);
  if (land) bundle.land = land;
  if (facilities) bundle.facilities = facilities;
  if (community) bundle.community = community;
  if (sensitive) bundle.sensitive = sensitive;
  return bundle;
}

/** True when the user changed anything compared with `original` (new form: entered anything). */
export function hasChanges(original: ProjectBundle | null, working: ProjectBundle): boolean {
  if (!original) {
    const p = changedFields(null, working.project);
    delete p.status;
    delete p.record_state;
    delete p.builder;
    delete p.country_id;
    delete p.branch_id;
    delete p.completeness;
    delete p.search_norm;
    return (
      Object.keys(p).length > 0 ||
      working.photos.length > 0 ||
      working.maintenance.length > 0 ||
      working.donors.length > 0 ||
      working.staff.length > 0 ||
      [working.land, working.facilities, working.community, working.sensitive].some(
        (s) => !!s && Object.keys(changedFields(null, s)).length > 0,
      )
    );
  }
  const merged = buildBundle({
    original,
    working,
    current: original,
    newDonorIds: [],
    newPersonIds: [],
  });
  if (Object.keys(changedFields(original.project, merged.project)).length > 0) return true;
  if (merged.land || merged.facilities || merged.community || merged.sensitive) return true;
  const listChanged = <T extends { id: string }>(a: readonly T[], b: readonly T[]): boolean =>
    a.length !== b.length ||
    b.some((row) => {
      const before = a.find((x) => x.id === row.id);
      return !before || Object.keys(changedFields(strip(before), strip(row))).length > 0;
    });
  return (
    listChanged(original.maintenance, merged.maintenance) ||
    listChanged(original.photos, merged.photos) ||
    listChanged(original.donors, merged.donors) ||
    listChanged(original.staff, merged.staff) ||
    merged.staff.some((s) => !!s.compensation)
  );
}
