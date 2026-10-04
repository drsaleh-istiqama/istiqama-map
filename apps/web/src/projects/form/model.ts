/**
 * The form's working state ("draft"): what the user sees, what is autosaved to the `drafts`
 * store (brief §7.4) and what `buildBundle()` turns into a `ProjectBundle` at save time.
 *
 * The draft keeps the bundle exactly as it was when the form opened (`original`) next to the
 * user's copy (`working`): saving applies only the user's changes on top of what is stored at
 * that moment, so a pull that arrived meanwhile is never reverted (see merge.ts).
 */
import { newRow, tableDef, type ProjectBundle, type Row, type TableName } from '../../db';
import type { PersonPickerDraft } from '../../people/pickerDraft';

/** Bumped when the stored draft shape changes incompatibly (older drafts are then ignored). */
export const DRAFT_VERSION = 1;
export const DRAFT_PREFIX = 'project-form:';
/**
 * Stored default of `projects.builder` for new records (brief / v2: "الاستقامة"). Data, not UI
 * text: it is the same proper name in every language so that reports group it once.
 */
export const DEFAULT_BUILDER = 'الاستقامة';

export type FormMode = 'new' | 'edit';

export interface NewLocality {
  id: string;
  name_ar: string;
  name_latin: string;
}

/**
 * The maintenance entry being typed in its dialog (brief §7.10). Kept in the draft so that
 * the autosave holds it too: after the back button, a reload or a killed app the dialog opens
 * again with what was typed (§7.4). `base` is the entry as the dialog opened (blank for a new
 * one) — "changed" and "is it new" are decided against it.
 */
export interface PendingMaintenance {
  base: Row<'project_maintenance'>;
  row: Row<'project_maintenance'>;
}

/** True when the open maintenance dialog holds input that is not in the entry yet. */
export function pendingMaintenanceChanged(p: PendingMaintenance | null | undefined): boolean {
  return !!p && JSON.stringify(p.row) !== JSON.stringify(p.base);
}

export interface FormExtras {
  /** Chosen administrative areas, level 1..3 (`null` = not chosen). */
  areaPath: [string | null, string | null, string | null];
  /** Typed locality that becomes a `proposed` locality on save (brief §2.1). */
  newLocality: NewLocality | null;
  /** Donors / persons created in this form (saved with the bundle; existing ones never are). */
  newDonorIds: string[];
  newPersonIds: string[];
  /** Photo ids the editor showed during this session (a stored photo missing later was removed). */
  seenPhotoIds: string[];
  /** The point the country and area were last filled from automatically. */
  geofillFor: { lon: number; lat: number } | null;
  /** The user changed the country / area by hand after the automatic fill. */
  manualArea: boolean;
  /** Open maintenance dialog (absent in drafts stored before it existed = none). */
  pendingMaintenance?: PendingMaintenance | null;
  /**
   * What is typed in the person picker of a staff row and not chosen yet (search text, or a
   * half-filled "new person" form), by staff row id — `<PersonPicker draft onDraftChange>`
   * (src/people/pickerDraft.ts). Autosaved with the rest of the draft, so Back, a reload or a
   * phone call never lose it (brief §7.4). Absent in older drafts = nothing typed.
   */
  pickerDrafts?: Record<string, PersonPickerDraft>;
}

/** True when a person picker of the form holds typed input worth keeping. */
export function pickerDraftsPending(extras: Pick<FormExtras, 'pickerDrafts'>): boolean {
  const all = extras.pickerDrafts;
  return !!all && typeof all === 'object' && Object.values(all).some((d) => !!d);
}

export interface FormDraft {
  v: typeof DRAFT_VERSION;
  userId: string | null;
  mode: FormMode;
  projectId: string;
  /** Edit: the bundle when the form was opened. New: null. */
  original: ProjectBundle | null;
  working: ProjectBundle;
  extras: FormExtras;
  /** Epoch ms of the autosave that wrote this copy (set by drafts.ts). */
  savedAt?: number;
}

export function draftKey(mode: FormMode, projectId: string): string {
  return `${DRAFT_PREFIX}${mode}:${projectId}`;
}

export function parseDraftKey(key: string): { mode: FormMode; projectId: string } | null {
  const m = /^project-form:(new|edit):([0-9a-f-]{36})$/i.exec(key);
  return m ? { mode: m[1] as FormMode, projectId: m[2]! } : null;
}

const emptyExtras = (): FormExtras => ({
  areaPath: [null, null, null],
  newLocality: null,
  newDonorIds: [],
  newPersonIds: [],
  seenPhotoIds: [],
  geofillFor: null,
  manualArea: false,
  pendingMaintenance: null,
});

/** A blank form for a new project. `type` stays empty until the user picks one. */
export function newDraft(opts: {
  userId: string | null;
  countryId?: string | null;
  branchId?: string | null;
}): FormDraft {
  const project = newRow('projects', {
    status: 'active',
    record_state: 'draft',
    builder: DEFAULT_BUILDER,
    country_id: opts.countryId ?? null,
    branch_id: opts.branchId ?? null,
  } as Partial<Row<'projects'>>);
  // `type` is NOT NULL on the server; the form starts without a choice (validation asks for it).
  (project as { type: string | null }).type = null;
  return {
    v: DRAFT_VERSION,
    userId: opts.userId,
    mode: 'new',
    projectId: project.id,
    original: null,
    working: { project, maintenance: [], photos: [], donors: [], staff: [] },
    extras: emptyExtras(),
  };
}

/** The form for an existing project. */
export function editDraft(bundle: ProjectBundle, userId: string | null): FormDraft {
  const original = clone(bundle);
  return {
    v: DRAFT_VERSION,
    userId,
    mode: 'edit',
    projectId: bundle.project.id,
    original,
    working: clone(bundle),
    extras: { ...emptyExtras(), seenPhotoIds: bundle.photos.map((p) => p.id) },
  };
}

/** Runtime check of a value read back from the drafts store. */
export function isFormDraft(value: unknown): value is FormDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<FormDraft>;
  return (
    d.v === DRAFT_VERSION &&
    (d.mode === 'new' || d.mode === 'edit') &&
    typeof d.projectId === 'string' &&
    !!d.working &&
    typeof d.working === 'object' &&
    !!d.working.project &&
    Array.isArray(d.working.maintenance) &&
    Array.isArray(d.working.photos) &&
    Array.isArray(d.working.donors) &&
    Array.isArray(d.working.staff) &&
    !!d.extras &&
    Array.isArray(d.extras.areaPath)
  );
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export const isLive = (row: { deleted_at?: string | null } | null | undefined): boolean =>
  !!row && (row.deleted_at === null || row.deleted_at === undefined);

export type SectionTable =
  'project_land' | 'project_facilities' | 'community_profiles' | 'community_sensitive';

export type SectionKey = 'land' | 'facilities' | 'community' | 'sensitive';

export const SECTION_TABLES: Record<SectionKey, SectionTable> = {
  land: 'project_land',
  facilities: 'project_facilities',
  community: 'community_profiles',
  sensitive: 'community_sensitive',
};

/** The 1:1 section row, created on first edit (opening a section creates nothing). */
export function sectionRow<K extends SectionKey>(
  working: ProjectBundle,
  key: K,
): NonNullable<ProjectBundle[K]> {
  const existing = working[key];
  if (existing) return existing as NonNullable<ProjectBundle[K]>;
  return newRow(SECTION_TABLES[key], {
    project_id: working.project.id,
  } as never) as unknown as NonNullable<ProjectBundle[K]>;
}

/** Data columns of a table (everything except the standard columns and the parent link). */
export function dataColumns(table: TableName): string[] {
  return tableDef(table).columns.filter((c) => c !== 'project_id' && c !== 'project_staff_id');
}

/** Country default currency, else USD (staff salaries, donations, maintenance costs). */
export function defaultCurrency(country: Row<'countries'> | undefined | null): string {
  const c = country?.default_currency;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

/** Local date `YYYY-MM-DD` (inputs of type date). */
export function today(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const META_KEYS = new Set([
  'id',
  'project_id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'deleted_at',
]);

/** True when a 1:1 section row carries any data. */
export function rowHasData(row: object | null | undefined): boolean {
  return (
    !!row &&
    Object.entries(row).some(
      ([k, v]) =>
        !META_KEYS.has(k) &&
        !k.startsWith('_') &&
        v !== null &&
        v !== undefined &&
        v !== '' &&
        !(Array.isArray(v) && v.length === 0),
    )
  );
}

/** Which optional sections hold data (badges on the folded sections). */
export function sectionFilled(b: ProjectBundle): Record<string, boolean> {
  return {
    basics:
      (b.project.capacity !== null && b.project.capacity !== undefined) ||
      (b.project.build_year !== null && b.project.build_year !== undefined),
    donors: b.donors.some(isLive),
    staff: b.staff.some(isLive),
    land: rowHasData(b.land),
    facilities: rowHasData(b.facilities),
    community: rowHasData(b.community),
    sensitive: rowHasData(b.sensitive),
  };
}
