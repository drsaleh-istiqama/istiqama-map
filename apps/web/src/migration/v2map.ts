/**
 * v2 → v3 mapping (brief §10, acceptance criterion 6). PURE: everything the mapping needs
 * from the device or the server (countries, areas, localities, options, visible donors, the
 * located point of each project, stable ids, phone parsing, translated notes) comes in
 * through `MapContext`; the result is a plan of complete rows that the runner hands to
 * `saveProjectBundle()` and `addPhoto()`.
 *
 * Rules (each one is covered by v2map.test.ts):
 *  - every v2 project becomes ONE draft (`record_state 'draft'`) with `external_id`
 *    `"v2:<v2 id>"` (or `"v2:h:<hash>"` when v2 had no id), so a second run skips it;
 *  - name → `name_ar` (a Latin-only name is also kept in `name_latin`), type, status,
 *    capacity, lon/lat (`location_source 'import'`; a missing point stays null — allowed for
 *    drafts), builder, build year/date;
 *  - country: the located point wins (the server derives it from the point anyway), else the
 *    Arabic (or English/Swahili) name against the synced countries, else the user's only
 *    country; admin area from the located point, else the region name; locality by name inside
 *    the country, otherwise ONE proposed locality per distinct name;
 *  - `maintenanceNotes` → one open `project_maintenance` entry;
 *  - donor text → a donor the user can already see with the same normalised name, else one new
 *    donor per distinct name, + `project_donors`;
 *  - land / facilities / community / sensitive sections with value mapping (yes/no strings,
 *    v2 option labels → `option_values` ids by Arabic label, unknown labels → `<list>_other`);
 *  - staff and the manager → persons WITHOUT any automatic merge by name (brief §2.4, §10,
 *    §12): every staff row and every manager becomes its own NEW person + `project_staff`
 *    with its role. The only link is inside ONE project, for entries with the same
 *    normalised name AND the same valid phone. Persons of the plan that share a normalised
 *    name in the same country become merge SUGGESTIONS (`mergeSuggestions` → the runner files
 *    `request_person_merge` for a reviewer to decide); different countries are never
 *    suggested. The v2 person directory (itself keyed by name in v2) enriches a person only
 *    when exactly one staff/manager entry of the input bears that name; its entries that no
 *    entry bears become persons of their own;
 *  - salary > 0 → `staff_compensation` in the country's default currency, flagged for review
 *    in `migration_note` (OWNER_DECISIONS item أ; migration 0073 — `review_note` is a
 *    reviewer field);
 *  - photos (`photos[]` and the legacy `photo`) must be `data:image/(jpeg|png|webp|gif);base64`
 *    URLs (v2 parity 5.10); at most 10 per project; category and caption kept.
 */
import {
  CURRENCIES,
  GUEST_FINANCIAL_CAPACITIES,
  LAND_OWNERSHIPS,
  PHOTO_CATEGORIES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  STAFF_ROLES,
  STUDENTS_ORIGINS,
  STUDENT_TRANSPORTS,
  newRow,
  type OptionListKey,
  type PhotoCategory,
  type ProjectBundle,
  type Row,
  type StaffRole,
} from '../db';
import { isValidLonLat } from '../lib/geo';
import { norm } from '../lib/normalize';
import { fingerprintOf } from './v2read';
import type {
  V2Community,
  V2Data,
  V2Facilities,
  V2Land,
  V2Person,
  V2Photo,
  V2Project,
  V2SourceKind,
  V2Staff,
} from './v2types';

// ---------------------------------------------------------------------------------------
// Context and result types
// ---------------------------------------------------------------------------------------

/** Where the point of a project lies (server `locate_point` or the cached shapes). */
export interface GeoHint {
  countryId: string | null;
  /** `[level 1, level 2, level 3]` ids. */
  areaPath: readonly [string | null, string | null, string | null];
  adminAreaId: string | null;
  /** Localities near the point (server answer only). */
  localities?: ReadonlyArray<{ id: string; name_ar: string | null; name_latin: string | null }>;
}

export type CountryRef = Pick<
  Row<'countries'>,
  'id' | 'iso2' | 'name_ar' | 'name_en' | 'name_sw' | 'default_currency'
>;
export type AreaRef = Pick<
  Row<'admin_areas'>,
  'id' | 'country_id' | 'level' | 'parent_id' | 'name_ar' | 'name_en' | 'name_sw'
>;
export type LocalityRef = Pick<
  Row<'localities'>,
  'id' | 'country_id' | 'admin_area_id' | 'name_ar' | 'name_latin'
>;
export type OptionRef = Pick<
  Row<'option_values'>,
  'id' | 'list_key' | 'code' | 'name_ar' | 'name_en' | 'name_sw'
>;
export type DonorRef = Pick<Row<'donors'>, 'id' | 'name_ar' | 'name_latin'>;

export interface MapContext {
  countries: readonly CountryRef[];
  areas: readonly AreaRef[];
  localities: readonly LocalityRef[];
  options: readonly OptionRef[];
  /** Donors the signed-in user can see (live rows of the device). */
  donors: readonly DonorRef[];
  /** Located point per project key (`external_id`). */
  geo: ReadonlyMap<string, GeoHint>;
  /** `external_id`s that already exist (on the device or on the server): skipped. */
  existingKeys: ReadonlySet<string>;
  /** Branch of a new project: the user's branch in that country / the one covering the area. */
  branchFor(countryId: string | null, areaPath: readonly (string | null)[]): string | null;
  /** The user's only write country / branch (fallbacks), or null. */
  defaultCountryId: string | null;
  defaultBranchId: string | null;
  /** Stable id of a shared row (project, person, donor, locality) — the same on a resumed run. */
  idFor(key: string): string;
  /** Fresh id for a child row. */
  newId(): string;
  /** E.164 of a typed phone number in the country `iso2`, or null. */
  phone(raw: string, iso2: string | null): string | null;
  /** `YYYY-MM-DD` of today (device). */
  today: string;
  texts: {
    /** Name of a v2 project that had none. */
    fallbackName(v2Id: string): string;
    /** Review note of a project whose salaries got the country's default currency. */
    salaryReviewNote(currencies: readonly string[]): string;
  };
}

export type WarningCode =
  | 'name_missing'
  | 'type_unknown'
  | 'status_unknown'
  | 'value_invalid'
  | 'location_missing'
  | 'location_invalid'
  | 'country_unknown'
  | 'country_mismatch'
  | 'area_unknown'
  | 'locality_new'
  | 'locality_skipped'
  | 'option_unknown'
  | 'date_invalid'
  | 'phone_invalid'
  | 'staff_without_name'
  | 'salary_currency_assumed'
  | 'salary_no_currency'
  | 'photo_rejected'
  | 'photos_over_limit'
  | 'duplicate_v2_id'
  | 'already_migrated'
  | 'person_without_project'
  | 'person_directory_ambiguous'
  | 'person_possible_duplicate';

export interface MigrationWarning {
  /** `external_id` of the project, or `person:<name>` for a directory entry. */
  key: string;
  /** Project (or person) name as in v2, for the report. */
  name: string;
  code: WarningCode;
  /** v2 field concerned (`land.area`, `staff[2].salary`, `photos[4]`, …). */
  field?: string;
  /** Offending value / extra detail (short). */
  value?: string;
}

export interface PlannedPhoto {
  /** Position in the v2 list (photos first, then the legacy photo). */
  index: number;
  /** The validated data URL. */
  data: string;
  mime: string;
  category: PhotoCategory;
  caption: string | null;
}

export interface PlannedProject {
  key: string;
  v2Id: string;
  name: string;
  projectId: string;
  bundle: ProjectBundle;
  /** Proposed locality the project points to; the runner inserts it when not stored yet. */
  newLocality: Row<'localities'> | null;
  /** v2 `createdAt` (ISO) — the offline entry time sent with the insert. */
  createdAt: string | null;
  photos: PlannedPhoto[];
  warnings: MigrationWarning[];
}

export interface PlanCounts {
  /** v2 projects in the input. */
  input: number;
  /** Projects that will be created. */
  projects: number;
  /** Skipped (already migrated, duplicate v2 id). */
  skipped: number;
  /** New persons (staff + managers + directory entries). */
  persons: number;
  staff: number;
  salaries: number;
  photos: number;
  photosRejected: number;
  donorsNew: number;
  donorsReused: number;
  localitiesNew: number;
  maintenance: number;
  withoutLocation: number;
  /** Same-name persons of one country proposed to a reviewer (never merged here). */
  mergeSuggestions: number;
}

/** Two persons of the plan that MAY be one: filed as `request_person_merge`, never merged. */
export interface MergeSuggestion {
  /** Person proposed to be merged … */
  sourceId: string;
  /** … into this one (the first person of the group). */
  targetId: string;
  /** Name as written in v2 (for the reason text). */
  name: string;
}

export interface MigrationPlan {
  source: V2SourceKind;
  fingerprint: string;
  projects: PlannedProject[];
  skipped: Array<{ key: string; name: string; reason: 'already_migrated' | 'duplicate_v2_id' }>;
  /** Every new person once: staff and managers of the planned projects + directory entries. */
  persons: Row<'persons'>[];
  /** Directory entries that belong to no planned project (saved on their own). */
  standalonePersons: Row<'persons'>[];
  newDonors: Row<'donors'>[];
  newLocalities: Row<'localities'>[];
  /** Same-name persons in the same country, for a reviewer to confirm or reject. */
  mergeSuggestions: MergeSuggestion[];
  /** All warnings (projects first, then directory entries). */
  warnings: MigrationWarning[];
  counts: PlanCounts;
}

// ---------------------------------------------------------------------------------------
// Value helpers (exported for the tests)
// ---------------------------------------------------------------------------------------

/** Arabic, Arabic Supplement, Extended-A, Presentation Forms A and B (code points, no literals). */
const ARABIC_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfefc],
];
const ARABIC_LETTER = new RegExp(
  '[' +
    ARABIC_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('') +
    ']',
);

export function hasArabic(s: string): boolean {
  return ARABIC_LETTER.test(s);
}

/** Trimmed text with collapsed white space; null for empty / non-text values. */
export function text(v: unknown, max = 2000): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
}

/** Maps Arabic-Indic / Extended Arabic-Indic digits and the Arabic decimal separator. */
function asciiDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0660 && c <= 0x0669) out += String(c - 0x0660);
    else if (c >= 0x06f0 && c <= 0x06f9) out += String(c - 0x06f0);
    else if (c === 0x066b) out += '.';
    else if (c === 0x066c) continue;
    else out += ch;
  }
  return out;
}

export type NumResult = { value: number | null; invalid: boolean };

/** A number from a v2 value (numbers, numeric strings with any digits). Empty = null. */
export function num(v: unknown): NumResult {
  if (v === null || v === undefined || v === '') return { value: null, invalid: false };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, invalid: false } : bad();
  if (typeof v === 'string') {
    const t = asciiDigits(v).replace(/[\s,]/g, '');
    if (t === '') return { value: null, invalid: false };
    const n = Number(t);
    return Number.isFinite(n) ? { value: n, invalid: false } : bad();
  }
  return bad();
}
const bad = (): NumResult => ({ value: null, invalid: true });

const YES = new Set(['true', 'yes', 'y', '1', 'نعم', 'متوفر', 'موجودة', 'موجود', 'ndiyo']);
const NO = new Set([
  'false',
  'no',
  'n',
  '0',
  'لا',
  'غير متوفر',
  'غير موجودة',
  'غير موجود',
  'hapana',
]);

/** v2 yes/no: booleans, `'yes'/'no'` select values, Arabic labels. Unknown = null. */
export function yesNo(v: unknown): { value: boolean | null; invalid: boolean } {
  if (v === true || v === false) return { value: v, invalid: false };
  if (v === null || v === undefined || v === '') return { value: null, invalid: false };
  if (typeof v === 'number') {
    if (v === 1) return { value: true, invalid: false };
    if (v === 0) return { value: false, invalid: false };
    return { value: null, invalid: true };
  }
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === '') return { value: null, invalid: false };
    if (YES.has(t)) return { value: true, invalid: false };
    if (NO.has(t)) return { value: false, invalid: false };
  }
  return { value: null, invalid: true };
}

/** `YYYY-MM-DD` of a real calendar date (also the date part of an ISO timestamp), else null. */
export function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(asciiDigits(v.trim()));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** ISO 8601 timestamp (with `Z`) of a parsable date-time, else null. */
export function isoTimestamp(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** v2 `normalizeMultiValue`: array or text split on `، , ; | newline`, trimmed, unique. */
export function multiValues(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[،,;\n|]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parts) {
    const t = typeof item === 'string' || typeof item === 'number' ? text(item, 240) : null;
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** v2 accepted only these data URLs for photos (domain.js `validateProject`). */
const DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/]+=*$/i;

export function photoDataUrl(v: unknown): { data: string; mime: string } | null {
  if (typeof v !== 'string') return null;
  const m = DATA_URL.exec(v);
  if (!m) return null;
  return { data: v, mime: `image/${m[1]!.toLowerCase()}` };
}

/** Project key (= `external_id`) of a v2 project. */
export function projectKey(p: V2Project): { key: string; v2Id: string } {
  const id = text(p.id, 200);
  if (id) return { key: `v2:${id}`, v2Id: id };
  // v2 always assigned ids; a hand-made file may not. A content hash keeps re-runs idempotent.
  const { photos: _photos, photo: _photo, ...rest } = p as Record<string, unknown>;
  let json: string;
  try {
    json = JSON.stringify(rest) ?? '';
  } catch {
    json = String(p.name ?? '');
  }
  const h = fingerprintOf(json);
  return { key: `v2:h:${h}`, v2Id: `h:${h}` };
}

// v2 labels of the few enumerations a hand-edited file may carry as text (app.js).
const OWNERSHIP_LABELS: Record<string, string> = {
  'ملك الجمعية': 'association',
  وقف: 'waqf',
  'ملك شخص': 'person',
  حكومية: 'government',
  أخرى: 'other',
};
const TRANSPORT_LABELS: Record<string, string> = {
  'حافلة متوفرة': 'available',
  'توجد حاجة لحافلة': 'needed',
  'لا توجد حاجة': 'not_needed',
};
const ORIGIN_LABELS: Record<string, string> = {
  'من المنطقة القريبة': 'nearby',
  'قريبون ومن مناطق بعيدة': 'mixed',
  'غالبهم من مناطق بعيدة': 'distant',
};
const CAPACITY_LABELS: Record<string, string> = {
  جيدة: 'good',
  محدودة: 'limited',
  'غير متوفرة': 'none',
};

function enumValue<T extends string>(
  v: unknown,
  allowed: readonly T[],
  labels: Record<string, string> = {},
): { value: T | null; invalid: boolean } {
  const t = text(v, 100);
  if (t === null) return { value: null, invalid: false };
  if ((allowed as readonly string[]).includes(t)) return { value: t as T, invalid: false };
  const lower = t.toLowerCase();
  if ((allowed as readonly string[]).includes(lower)) return { value: lower as T, invalid: false };
  const fromLabel = labels[t];
  if (fromLabel && (allowed as readonly string[]).includes(fromLabel))
    return { value: fromLabel as T, invalid: false };
  return { value: null, invalid: true };
}

const V2_LISTS: ReadonlyArray<[keyof V2Community, OptionListKey]> = [
  ['daawaActivities', 'daawa_activities'],
  ['socialFeatures', 'social_features'],
  ['livelihoods', 'livelihoods'],
  ['religiousIssues', 'religious_issues'],
  ['religiousChallenges', 'religious_challenges'],
  ['socialChallenges', 'social_challenges'],
  ['proposedActivities', 'proposed_activities'],
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_PHOTOS = 10;
const CAPTION_MAX = 160;

// ---------------------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------------------

interface PersonInput {
  name: string;
  phone?: unknown;
  birthDate?: unknown;
  region?: unknown;
  education?: unknown;
  graduation?: unknown;
}

/** Builds the plan. Never throws for bad v2 values: they become warnings. */
export function mapV2(data: V2Data, ctx: MapContext): MigrationPlan {
  const warnings: MigrationWarning[] = [];
  const plannedProjects: PlannedProject[] = [];
  const skipped: MigrationPlan['skipped'] = [];

  /** Every new person of the plan, in creation order. */
  const allPersons: Row<'persons'>[] = [];
  /** Normalised name and first owner (project + field) of each new person, by id. */
  const personInfo = new Map<string, { n: string; owner: { key: string; name: string } }>();
  /** Same name + same valid phone inside ONE project → one person (`<key>|<norm>|<e164>`). */
  const linkedInProject = new Map<string, Row<'persons'>>();
  const donorsNew = new Map<string, Row<'donors'>>();
  const localitiesNew = new Map<string, Row<'localities'>>();
  /** Distinct visible donors the plan links to. */
  const donorsReused = new Set<string>();

  // --- lookups ----------------------------------------------------------------------------
  const countryById = new Map(ctx.countries.map((c) => [c.id, c]));
  const countryByName = new Map<string, CountryRef>();
  for (const c of ctx.countries) {
    for (const n of [c.name_ar, c.name_en, c.name_sw, c.iso2]) {
      if (n && !countryByName.has(norm(n))) countryByName.set(norm(n), c);
    }
  }
  const areaById = new Map(ctx.areas.map((a) => [a.id, a]));
  const optionsByList = new Map<string, OptionRef[]>();
  for (const o of ctx.options) {
    const list = optionsByList.get(o.list_key) ?? [];
    list.push(o);
    optionsByList.set(o.list_key, list);
  }
  const visibleDonors = new Map<string, DonorRef>();
  for (const d of ctx.donors) {
    for (const n of [d.name_ar, d.name_latin]) {
      if (n && !visibleDonors.has(norm(n))) visibleDonors.set(norm(n), d);
    }
  }
  const directory = new Map<string, V2Person>();
  for (const person of data.people) {
    const name = text(person.name, 300);
    if (name && !directory.has(norm(name))) directory.set(norm(name), person);
  }
  // How many staff/manager entries of the whole input bear each normalised name. The v2
  // directory was itself keyed by name, so its data is only trusted for a name borne by
  // exactly one entry; otherwise it may describe several different people.
  const nameCount = new Map<string, number>();
  const countName = (v: unknown): void => {
    const t = text(v, 300);
    if (t) nameCount.set(norm(t), (nameCount.get(norm(t)) ?? 0) + 1);
  };
  for (const raw of data.projects) {
    if (!isRecord(raw)) continue;
    for (const s of Array.isArray(raw.staff) ? (raw.staff as unknown[]) : [])
      if (isRecord(s)) countName(s.name);
    countName(raw.manager);
  }

  const areaPathOf = (id: string | null): [string | null, string | null, string | null] => {
    const path: [string | null, string | null, string | null] = [null, null, null];
    let cur = id ? areaById.get(id) : undefined;
    let guard = 0;
    while (cur && guard++ < 4) {
      if (cur.level >= 1 && cur.level <= 3) path[cur.level - 1] = cur.id;
      cur = cur.parent_id ? areaById.get(cur.parent_id) : undefined;
    }
    return path;
  };

  const areaByName = (countryId: string, name: string): AreaRef | undefined => {
    const n = norm(name);
    let best: AreaRef | undefined;
    for (const a of ctx.areas) {
      if (a.country_id !== countryId || a.level > 2) continue;
      if ([a.name_ar, a.name_en, a.name_sw].some((x) => x && norm(x) === n)) {
        if (!best || a.level < best.level) best = a;
      }
    }
    return best;
  };

  // --- persons ----------------------------------------------------------------------------
  const personFor = (
    input: PersonInput,
    where: { countryId: string | null; branchId: string | null; iso2: string | null },
    owner: { key: string; name: string; field: string },
    /** Stable id key of this entry (`person:<project key>:<field>` / `person:dir:<norm>`). */
    idKey: string,
    /** Project of a staff/manager entry (links same name + same phone inside it), else null. */
    projectKey: string | null,
  ): Row<'persons'> => {
    const n = norm(input.name);
    // The directory only describes this person when no other entry bears the name.
    const dir = (nameCount.get(n) ?? 0) <= 1 ? directory.get(n) : undefined;
    const rawPhone = text(input.phone, 40);
    const e164 = rawPhone ? ctx.phone(rawPhone, where.iso2) : null;
    const linkKey = projectKey && e164 ? `${projectKey}|${n}|${e164}` : null;
    let row = linkKey ? linkedInProject.get(linkKey) : undefined;
    if (!row) {
      const nameIsArabic = hasArabic(input.name);
      row = newRow('persons', {
        id: ctx.idFor(idKey),
        name_ar: nameIsArabic ? input.name : null,
        name_latin: nameIsArabic ? null : input.name,
        country_id: where.countryId,
        branch_id: where.branchId,
      });
      allPersons.push(row);
      personInfo.set(row.id, { n, owner: ownerOf(owner) });
      if (linkKey) linkedInProject.set(linkKey, row);
    }
    // Fill what is still empty: the row's own value first, then the directory entry.
    const fill = (
      col: 'phone_e164' | 'birth_date' | 'home_area_text' | 'education_level' | 'graduated_from',
      values: unknown[],
    ): void => {
      if (row![col] !== null) return;
      for (const v of values) {
        if (col === 'phone_e164') {
          const raw = text(v, 40);
          if (!raw) continue;
          const e164 = ctx.phone(raw, where.iso2);
          if (e164) {
            row!.phone_e164 = e164;
            return;
          }
          warnings.push({
            ...ownerOf(owner),
            code: 'phone_invalid',
            field: owner.field,
            value: raw,
          });
          continue;
        }
        if (col === 'birth_date') {
          if (v === null || v === undefined || v === '') continue;
          const d = isoDate(v);
          if (d) {
            row!.birth_date = d;
            const y = Number(d.slice(0, 4));
            if (y >= 1900 && y <= 2100) row!.birth_year = y;
            else row!.birth_date = null;
            if (row!.birth_date) return;
          }
          warnings.push({
            ...ownerOf(owner),
            code: 'date_invalid',
            field: `${owner.field}.birthDate`,
            value: String(v).slice(0, 40),
          });
          continue;
        }
        const t = text(v, 500);
        if (t) {
          row![col] = t;
          return;
        }
      }
    };
    fill('phone_e164', [input.phone, dir?.phone]);
    fill('birth_date', [input.birthDate, dir?.birthDate]);
    fill('home_area_text', [input.region, dir?.region]);
    fill('education_level', [input.education, dir?.education]);
    fill('graduated_from', [input.graduation, dir?.graduationInstitution]);
    return row;
  };

  const ownerOf = (o: { key: string; name: string }): { key: string; name: string } => ({
    key: o.key,
    name: o.name,
  });

  // --- projects ---------------------------------------------------------------------------
  const seenKeys = new Set<string>();
  data.projects.forEach((raw) => {
    const p: V2Project = isRecord(raw) ? raw : {};
    const { key, v2Id } = projectKey(p);
    const givenName = text(p.name, 300);
    const name = givenName ?? ctx.texts.fallbackName(v2Id);
    if (seenKeys.has(key)) {
      skipped.push({ key, name, reason: 'duplicate_v2_id' });
      warnings.push({ key, name, code: 'duplicate_v2_id', value: v2Id });
      return;
    }
    seenKeys.add(key);
    if (ctx.existingKeys.has(key)) {
      skipped.push({ key, name, reason: 'already_migrated' });
      warnings.push({ key, name, code: 'already_migrated' });
      // Its people were created with it then: `nameCount` already keeps a directory entry of
      // the same name from becoming a second person.
      return;
    }
    const w: MigrationWarning[] = [];
    const warn = (code: WarningCode, field?: string, value?: unknown): void => {
      const entry: MigrationWarning = { key, name, code };
      if (field) entry.field = field;
      if (value !== undefined && value !== null && value !== '')
        entry.value = String(value).slice(0, 80);
      w.push(entry);
    };
    if (!givenName) warn('name_missing', 'name');

    const projectId = ctx.idFor(`project:${key}`);

    // type / status
    const type = enumValue(p.type, PROJECT_TYPES);
    if (type.invalid || type.value === null) warn('type_unknown', 'type', p.type);
    const status = enumValue(p.status, PROJECT_STATUSES);
    if (status.invalid) warn('status_unknown', 'status', p.status);

    // capacity
    const cap = num(p.capacity);
    let capacity: number | null = null;
    if (cap.invalid || (cap.value !== null && cap.value < 0))
      warn('value_invalid', 'capacity', p.capacity);
    else if (cap.value !== null) capacity = Math.round(cap.value);

    // location
    const lat = num(p.lat);
    const lon = num(p.lng);
    let point: { lon: number; lat: number } | null = null;
    if (
      lat.value !== null &&
      lon.value !== null &&
      isValidLonLat({ lon: lon.value, lat: lat.value })
    ) {
      point = { lon: lon.value, lat: lat.value };
    } else if (lat.value === null && lon.value === null && !lat.invalid && !lon.invalid) {
      warn('location_missing', 'lat');
    } else {
      warn('location_invalid', 'lat', `${String(p.lat ?? '')}, ${String(p.lng ?? '')}`);
    }

    // country
    const geo = point ? ctx.geo.get(key) : undefined;
    const countryText = text(p.country, 120);
    const named = countryText ? countryByName.get(norm(countryText)) : undefined;
    let countryId: string | null = geo?.countryId ?? named?.id ?? null;
    if (geo?.countryId && named && geo.countryId !== named.id)
      warn('country_mismatch', 'country', countryText);
    if (!countryId) {
      if (countryText) warn('country_unknown', 'country', countryText);
      countryId = ctx.defaultCountryId;
    }
    const country = countryId ? countryById.get(countryId) : undefined;

    // admin area
    const regionText = text(p.region, 200);
    let adminAreaId: string | null = geo?.adminAreaId ?? null;
    let areaPath: [string | null, string | null, string | null] = geo
      ? [geo.areaPath[0] ?? null, geo.areaPath[1] ?? null, geo.areaPath[2] ?? null]
      : [null, null, null];
    if (!adminAreaId && regionText && countryId) {
      const area = areaByName(countryId, regionText);
      if (area) {
        adminAreaId = area.id;
        areaPath = areaPathOf(area.id);
      }
    }
    if (!adminAreaId && regionText) warn('area_unknown', 'region', regionText);

    // locality
    const localityText = text(p.locality, 200);
    let localityId: string | null = null;
    let newLocality: Row<'localities'> | null = null;
    if (localityText) {
      const n = norm(localityText);
      const pathIds = new Set(areaPath.filter((a): a is string => !!a));
      const matches = (l: { name_ar: string | null; name_latin: string | null }): boolean =>
        [l.name_ar, l.name_latin].some((x) => x && norm(x) === n);
      const near = (geo?.localities ?? []).find(matches);
      const inCountry = ctx.localities.filter((l) => l.country_id === countryId && matches(l));
      const found =
        near ??
        inCountry.find((l) => l.admin_area_id && pathIds.has(l.admin_area_id)) ??
        inCountry[0];
      if (found) localityId = found.id;
      else if (countryId) {
        const lkey = `${countryId}:${n}`;
        let loc = localitiesNew.get(lkey);
        if (!loc) {
          const arabic = hasArabic(localityText);
          loc = newRow('localities', {
            id: ctx.idFor(`locality:${lkey}`),
            country_id: countryId,
            admin_area_id: adminAreaId,
            name_ar: arabic ? localityText : null,
            name_latin: arabic ? null : localityText,
            status: 'proposed',
            lon: point?.lon ?? null,
            lat: point?.lat ?? null,
          });
          localitiesNew.set(lkey, loc);
        }
        localityId = loc.id;
        newLocality = loc;
        warn('locality_new', 'locality', localityText);
      } else warn('locality_skipped', 'locality', localityText);
    }

    const branchId =
      ctx.branchFor(countryId, areaPath) ??
      (countryId !== null && countryId === ctx.defaultCountryId ? ctx.defaultBranchId : null);

    // build date / year
    let buildDate: string | null = null;
    let buildYear: number | null = null;
    const bd = p.buildDate;
    if (bd !== undefined && bd !== null && bd !== '') {
      const d = isoDate(bd);
      const yearOnly = typeof bd === 'number' || /^\s*\d{4}\s*$/.test(String(bd));
      const y = d ? Number(d.slice(0, 4)) : yearOnly ? Number(String(bd).trim()) : NaN;
      if (Number.isInteger(y) && y >= 1800 && y <= 2200) {
        buildYear = y;
        buildDate = d;
      } else warn('date_invalid', 'buildDate', bd);
    }

    const updated = isoDate(p.updatedAt) ?? isoDate(p.createdAt);
    const pastDate = updated && updated <= ctx.today ? updated : ctx.today;

    // --- project row --------------------------------------------------------------------
    const project = newRow('projects', {
      id: projectId,
      external_id: key,
      name_ar: name,
      name_latin: givenName && !hasArabic(givenName) ? givenName : null,
      type: type.value ?? 'mosque',
      status: status.value ?? 'active',
      capacity,
      lon: point?.lon ?? null,
      lat: point?.lat ?? null,
      location_source: point ? 'import' : null,
      country_id: countryId,
      admin_area_id: adminAreaId,
      locality_id: localityId,
      branch_id: branchId,
      builder: text(p.builder, 200),
      build_year: buildYear,
      build_date: buildDate,
      record_state: 'draft',
    });

    const bundle: ProjectBundle = { project, maintenance: [], photos: [], donors: [], staff: [] };

    // --- maintenance --------------------------------------------------------------------
    const notes = text(p.maintenanceNotes, 4000);
    if (notes) {
      bundle.maintenance.push(
        newRow('project_maintenance', {
          id: ctx.newId(),
          project_id: projectId,
          reported_on: pastDate,
          description: notes,
          priority: 'medium',
          state: 'open',
        }),
      );
    }

    // --- donor --------------------------------------------------------------------------
    const donorText = text(p.donor, 300);
    if (donorText) {
      const n = norm(donorText);
      const visible = visibleDonors.get(n);
      let donorId: string;
      let donor: Row<'donors'> | undefined;
      if (visible) {
        donorId = visible.id;
        donorsReused.add(visible.id);
      } else {
        donor = donorsNew.get(n);
        if (!donor) {
          const arabic = hasArabic(donorText);
          donor = newRow('donors', {
            id: ctx.idFor(`donor:${n}`),
            name_ar: arabic ? donorText : null,
            name_latin: arabic ? null : donorText,
          });
          donorsNew.set(n, donor);
        }
        donorId = donor.id;
      }
      const link = newRow('project_donors', {
        id: ctx.newId(),
        project_id: projectId,
        donor_id: donorId,
      });
      bundle.donors.push(donor ? { ...link, donor } : link);
    }

    // --- sections -----------------------------------------------------------------------
    const land = mapLand(isRecord(p.land) ? (p.land as V2Land) : {}, warn);
    if (land)
      bundle.land = newRow('project_land', { ...land, id: ctx.newId(), project_id: projectId });
    const fac = mapFacilities(isRecord(p.facilities) ? (p.facilities as V2Facilities) : {}, warn);
    if (fac)
      bundle.facilities = newRow('project_facilities', {
        ...fac,
        id: ctx.newId(),
        project_id: projectId,
      });
    const comm = isRecord(p.community) ? (p.community as V2Community) : {};
    const profile = mapCommunity(comm, optionsByList, warn);
    if (profile)
      bundle.community = newRow('community_profiles', {
        ...profile,
        id: ctx.newId(),
        project_id: projectId,
      });
    const sensitive = mapSensitive(comm, warn);
    if (sensitive)
      bundle.sensitive = newRow('community_sensitive', {
        ...sensitive,
        id: ctx.newId(),
        project_id: projectId,
      });

    // --- staff + manager ----------------------------------------------------------------
    const where = { countryId, branchId, iso2: country?.iso2 ?? null };
    const links = new Set<string>();
    const currencies = new Set<string>();
    const staffList = Array.isArray(p.staff) ? (p.staff as unknown[]) : [];
    const addStaff = (
      personRow: Row<'persons'>,
      role: StaffRole,
      salary: unknown,
      field: string,
    ): void => {
      const linkKey = `${personRow.id}|${role}`;
      let entry = bundle.staff.find((s) => `${s.person_id}|${s.role}` === linkKey);
      if (!links.has(linkKey)) {
        links.add(linkKey);
        const link = newRow('project_staff', {
          id: ctx.newId(),
          project_id: projectId,
          person_id: personRow.id,
          role,
        });
        entry = { ...link, person: personRow };
        bundle.staff.push(entry);
      }
      const s = num(salary);
      if (s.invalid || (s.value !== null && s.value < 0)) {
        warn('value_invalid', `${field}.salary`, salary);
        return;
      }
      if (s.value === null || s.value === 0 || !entry || entry.compensation) return;
      const currency = country?.default_currency ?? null;
      if (!currency || !(CURRENCIES as readonly string[]).includes(currency)) {
        warn('salary_no_currency', `${field}.salary`, salary);
        return;
      }
      entry.compensation = newRow('staff_compensation', {
        id: ctx.newId(),
        project_staff_id: entry.id,
        monthly_amount: Math.round(s.value * 100) / 100,
        currency: currency as Row<'staff_compensation'>['currency'],
        effective_from: pastDate,
      });
      currencies.add(currency);
      warn('salary_currency_assumed', `${field}.salary`, `${s.value} ${currency}`);
    };

    staffList.forEach((rawStaff, i) => {
      const s: V2Staff = isRecord(rawStaff) ? rawStaff : {};
      const staffName = text(s.name, 300);
      const field = `staff[${i}]`;
      if (!staffName) {
        const hasData =
          [s.role, s.birthDate, s.region, s.education, s.graduationInstitution].some(
            (v) => text(v) !== null,
          ) || (num(s.salary).value ?? 0) > 0;
        if (hasData) warn('staff_without_name', field);
        return;
      }
      const role = enumValue(s.role, STAFF_ROLES).value ?? 'other';
      const personRow = personFor(
        {
          name: staffName,
          phone: s.phone,
          birthDate: s.birthDate,
          region: s.region,
          education: s.education,
          graduation: s.graduationInstitution,
        },
        where,
        { key, name, field },
        `person:${key}:${field}`,
        key,
      );
      addStaff(personRow, role, s.salary, field);
    });

    const managerName = text(p.manager, 300);
    if (managerName) {
      const personRow = personFor(
        { name: managerName, phone: p.phone },
        where,
        { key, name, field: 'manager' },
        `person:${key}:manager`,
        key,
      );
      addStaff(personRow, 'manager', undefined, 'manager');
    } else if (text(p.phone, 40)) {
      // A phone without a manager name has no person to belong to.
      warn('phone_invalid', 'phone', p.phone);
    }

    if (currencies.size > 0) {
      project.migration_note = ctx.texts.salaryReviewNote([...currencies].sort());
    }

    // --- photos -------------------------------------------------------------------------
    const photos: PlannedPhoto[] = [];
    const v2Photos: V2Photo[] = Array.isArray(p.photos)
      ? (p.photos as unknown[]).map((x) => (isRecord(x) ? (x as V2Photo) : { data: x }))
      : [];
    const legacy = typeof p.photo === 'string' && p.photo.trim() !== '' ? p.photo.trim() : null;
    if (legacy && !v2Photos.some((x) => x.data === legacy))
      v2Photos.push({ data: legacy, category: 'unspecified', caption: '' });
    let accepted = 0;
    v2Photos.forEach((ph, i) => {
      const field =
        Array.isArray(p.photos) && i < (p.photos as unknown[]).length ? `photos[${i}]` : 'photo';
      const ok = photoDataUrl(ph.data);
      if (!ok) {
        const shown = typeof ph.data === 'string' ? ph.data.slice(0, 60) : typeof ph.data;
        warn('photo_rejected', field, shown);
        return;
      }
      if (accepted >= MAX_PHOTOS) return;
      accepted++;
      const category = enumValue(ph.category, PHOTO_CATEGORIES).value ?? 'unspecified';
      photos.push({
        index: i,
        data: ok.data,
        mime: ok.mime,
        category,
        caption: text(ph.caption, CAPTION_MAX),
      });
    });
    const validCount = v2Photos.filter((ph) => photoDataUrl(ph.data)).length;
    if (validCount > MAX_PHOTOS) warn('photos_over_limit', 'photos', `${validCount}`);

    plannedProjects.push({
      key,
      v2Id,
      name,
      projectId,
      bundle,
      newLocality,
      createdAt: isoTimestamp(p.createdAt),
      photos,
      warnings: w,
    });
    warnings.push(...w);
  });

  // --- directory entries that belong to no planned project --------------------------------
  const standalone: Row<'persons'>[] = [];
  for (const [n, entry] of directory) {
    const name = text(entry.name, 300)!;
    const owner = { key: `person:${name}`, name, field: 'person' };
    const bearers = nameCount.get(n) ?? 0;
    if (bearers > 0) {
      // Borne by one entry: it enriched that person. Borne by several: v2 kept ONE record for
      // possibly different people — its details are not given to any of them.
      const hasDetails = [
        entry.phone,
        entry.birthDate,
        entry.region,
        entry.education,
        entry.graduationInstitution,
      ].some((v) => text(v) !== null);
      if (bearers > 1 && hasDetails)
        warnings.push({ key: owner.key, name, code: 'person_directory_ambiguous' });
      continue;
    }
    const country = ctx.defaultCountryId ? countryById.get(ctx.defaultCountryId) : undefined;
    const row = personFor(
      {
        name,
        phone: entry.phone,
        birthDate: entry.birthDate,
        region: entry.region,
        education: entry.education,
        graduation: entry.graduationInstitution,
      },
      {
        countryId: ctx.defaultCountryId,
        branchId: ctx.defaultBranchId,
        iso2: country?.iso2 ?? null,
      },
      owner,
      `person:dir:${n}`,
      null,
    );
    standalone.push(row);
    warnings.push({ key: owner.key, name, code: 'person_without_project' });
  }

  // --- same-name persons of one country: suggestions for a reviewer, never a merge --------
  const mergeSuggestions: MergeSuggestion[] = [];
  const firstOfGroup = new Map<string, Row<'persons'>>();
  for (const row of allPersons) {
    const info = personInfo.get(row.id)!;
    if (!row.country_id) continue; // the country cannot be confirmed: nothing is suggested
    const group = `${row.country_id}|${info.n}`;
    const target = firstOfGroup.get(group);
    if (!target) {
      firstOfGroup.set(group, row);
      continue;
    }
    const name = row.name_ar ?? row.name_latin ?? '';
    mergeSuggestions.push({ sourceId: row.id, targetId: target.id, name });
    warnings.push({ ...info.owner, code: 'person_possible_duplicate', value: name });
  }

  const staffCount = plannedProjects.reduce((sum, pp) => sum + pp.bundle.staff.length, 0);
  const salaryCount = plannedProjects.reduce(
    (sum, pp) => sum + pp.bundle.staff.filter((s) => s.compensation).length,
    0,
  );
  const counts: PlanCounts = {
    input: data.projects.length,
    projects: plannedProjects.length,
    skipped: skipped.length,
    persons: allPersons.length,
    staff: staffCount,
    salaries: salaryCount,
    photos: plannedProjects.reduce((sum, pp) => sum + pp.photos.length, 0),
    photosRejected: warnings.filter((x) => x.code === 'photo_rejected').length,
    donorsNew: donorsNew.size,
    donorsReused: donorsReused.size,
    localitiesNew: localitiesNew.size,
    maintenance: plannedProjects.reduce((sum, pp) => sum + pp.bundle.maintenance.length, 0),
    withoutLocation: plannedProjects.filter((pp) => pp.bundle.project.lon === null).length,
    mergeSuggestions: mergeSuggestions.length,
  };

  return {
    source: data.source,
    fingerprint: data.fingerprint,
    projects: plannedProjects,
    skipped,
    persons: allPersons,
    standalonePersons: standalone,
    newDonors: [...donorsNew.values()],
    newLocalities: [...localitiesNew.values()],
    mergeSuggestions,
    warnings,
    counts,
  };
}

// ---------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------

type Warn = (code: WarningCode, field?: string, value?: unknown) => void;

function ranged(
  v: unknown,
  field: string,
  warn: Warn,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | null {
  const r = num(v);
  if (r.invalid) {
    warn('value_invalid', field, v);
    return null;
  }
  if (r.value === null) return null;
  if (
    (opts.min !== undefined && r.value < opts.min) ||
    (opts.max !== undefined && r.value > opts.max)
  ) {
    warn('value_invalid', field, v);
    return null;
  }
  return opts.integer ? Math.round(r.value) : Math.round(r.value * 100) / 100;
}

function bool(v: unknown, field: string, warn: Warn): boolean | null {
  const r = yesNo(v);
  if (r.invalid) warn('value_invalid', field, v);
  return r.value;
}

function choice<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field: string,
  warn: Warn,
  labels?: Record<string, string>,
): T | null {
  const r = enumValue(v, allowed, labels);
  if (r.invalid) warn('value_invalid', field, v);
  return r.value;
}

const anyValue = (o: Record<string, unknown>): boolean =>
  Object.values(o).some(
    (v) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
  );

export function mapLand(land: V2Land, warn: Warn): Partial<Row<'project_land'>> | null {
  const row = {
    ownership: choice(land.ownership, LAND_OWNERSHIPS, 'land.ownership', warn, OWNERSHIP_LABELS),
    owner_name: text(land.ownerName, 300),
    area_m2: ranged(land.area, 'land.area', warn, { min: 0, max: 999_999_999_999 }),
    utilization_pct: ranged(land.utilization, 'land.utilization', warn, { min: 0, max: 100 }),
    expandable: bool(land.expandable, 'land.expandable', warn),
    notes: text(land.notes, 4000),
  };
  return anyValue(row) ? row : null;
}

export function mapFacilities(
  fac: V2Facilities,
  warn: Warn,
): Partial<Row<'project_facilities'>> | null {
  const row = {
    teacher_housing: bool(fac.teacherHousing, 'facilities.teacherHousing', warn),
    imam_housing: bool(fac.imamHousing, 'facilities.imamHousing', warn),
    guest_housing: bool(fac.guestHousing, 'facilities.guestHousing', warn),
    library: bool(fac.library, 'facilities.library', warn),
    hall: bool(fac.hall, 'facilities.hall', warn),
    quran_count: ranged(fac.quranCount, 'facilities.quranCount', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    quran_need: ranged(fac.quranNeed, 'facilities.quranNeed', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    hall_capacity: ranged(fac.hallCapacity, 'facilities.hallCapacity', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    student_transport: choice(
      fac.studentTransport,
      STUDENT_TRANSPORTS,
      'facilities.studentTransport',
      warn,
      TRANSPORT_LABELS,
    ),
    students_origin: choice(
      fac.studentsLocal,
      STUDENTS_ORIGINS,
      'facilities.studentsLocal',
      warn,
      ORIGIN_LABELS,
    ),
  };
  return anyValue(row) ? row : null;
}

export function mapCommunity(
  c: V2Community,
  optionsByList: ReadonlyMap<string, readonly OptionRef[]>,
  warn: Warn,
): Partial<Row<'community_profiles'>> | null {
  const row: Record<string, unknown> = {
    branch_name: text(c.branchName, 300),
    population: ranged(c.population, 'community.population', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    muslim_pct: ranged(c.muslimPercentage, 'community.muslimPercentage', warn, {
      min: 0,
      max: 100,
    }),
  };
  for (const [v2Key, listKey] of V2_LISTS) {
    const values = multiValues(c[v2Key]);
    const options = optionsByList.get(listKey) ?? [];
    const ids: string[] = [];
    const others: string[] = [];
    for (const value of values) {
      const n = norm(value);
      const opt = options.find(
        (o) =>
          o.code !== 'other' &&
          [o.name_ar, o.name_en, o.name_sw, o.code].some((x) => x && norm(x) === n),
      );
      if (opt) {
        if (!ids.includes(opt.id)) ids.push(opt.id);
      } else others.push(value);
    }
    if (others.length > 0) {
      const other = options.find((o) => o.code === 'other');
      if (other && !ids.includes(other.id)) ids.push(other.id);
      warn('option_unknown', `community.${v2Key}`, others.join('، '));
    }
    row[listKey] = ids;
    row[`${listKey}_other`] = others.length > 0 ? others.join('، ').slice(0, 1000) : null;
  }
  return anyValue(row) ? (row as Partial<Row<'community_profiles'>>) : null;
}

export function mapSensitive(
  c: V2Community,
  warn: Warn,
): Partial<Row<'community_sensitive'>> | null {
  const row = {
    ibadi_families: ranged(c.ibadiFamilies, 'community.ibadiFamilies', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    omani_families: ranged(c.omaniFamilies, 'community.omaniFamilies', warn, {
      min: 0,
      integer: true,
      max: 2_147_483_647,
    }),
    omani_student_pct: ranged(c.omaniStudentPercentage, 'community.omaniStudentPercentage', warn, {
      min: 0,
      max: 100,
    }),
    ibadi_student_pct: ranged(c.ibadiStudentPercentage, 'community.ibadiStudentPercentage', warn, {
      min: 0,
      max: 100,
    }),
    omani_teacher_pct: ranged(c.omaniTeacherPercentage, 'community.omaniTeacherPercentage', warn, {
      min: 0,
      max: 100,
    }),
    ibadi_teacher_pct: ranged(c.ibadiTeacherPercentage, 'community.ibadiTeacherPercentage', warn, {
      min: 0,
      max: 100,
    }),
    guest_financial_capacity: choice(
      c.financialCapacity,
      GUEST_FINANCIAL_CAPACITIES,
      'community.financialCapacity',
      warn,
      CAPACITY_LABELS,
    ),
  };
  return anyValue(row) ? row : null;
}
