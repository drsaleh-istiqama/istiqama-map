/**
 * Form validation (brief §7.6): the rules of v2's `validateProject` (name, type, location,
 * capacity, percentages, counts) plus the server's CHECK constraints (docs/contracts/schema.md
 * §3), and the mapping of server rejection codes (sync.md §4.5) back to the fields.
 *
 * Errors are `field key → translation key`; field keys are dotted paths (`land.area_m2`,
 * `staff.<row id>.role`). `fieldId(key)` is the id of the control, so `<Field htmlFor>` wires
 * `aria-describedby` and the form can focus the first error.
 */
import type { FailedOp, ProjectBundle } from '../../db';
import { PROJECT_STATUSES, PROJECT_TYPES } from '../../db';
import type { FormExtras } from './model';

export type FieldErrors = Record<string, string>;

export type SaveIntent = 'draft' | 'submit';

export function fieldId(key: string): string {
  return `pf-${key.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '';

/** Order in which errors are reported (= order of the sections on screen). */
export const FIELD_ORDER: readonly string[] = [
  'type',
  'name_ar',
  'name_latin',
  'location',
  'country',
  'area',
  'locality',
  'status',
  'maintenance',
  'photos',
  'capacity',
  'builder',
  'build_year',
  'build_date',
  'donors',
  'staff',
  'land',
  'facilities',
  'community',
  'sensitive',
];

function orderOf(key: string): number {
  const head = key.split('.')[0]!;
  const i = FIELD_ORDER.indexOf(head);
  return i < 0 ? FIELD_ORDER.length : i;
}

/** Field keys of `errors` in screen order. */
export function orderedErrorKeys(errors: FieldErrors): string[] {
  return Object.keys(errors).sort((a, b) => orderOf(a) - orderOf(b));
}

function nonNegative(errors: FieldErrors, key: string, v: unknown, integer = true): void {
  if (v === null || v === undefined) return;
  if (!isNum(v) || v < 0 || (integer && !Number.isInteger(v))) {
    errors[key] = integer ? 'form.errNonNegativeInt' : 'form.errNonNegative';
  }
}

function percent(errors: FieldErrors, key: string, v: unknown): void {
  if (v === null || v === undefined) return;
  if (!isNum(v) || v < 0 || v > 100) errors[key] = 'form.errPercent';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** One maintenance entry (keys: `description`, `reported_on`, `estimated_cost`). */
export function validateMaintenance(
  m: Pick<ProjectBundle['maintenance'][number], 'description' | 'reported_on' | 'estimated_cost'>,
): FieldErrors {
  const errors: FieldErrors = {};
  if (blank(m.description)) errors.description = 'form.errRequired';
  if (!validDate(m.reported_on)) errors.reported_on = 'form.errDate';
  nonNegative(errors, 'estimated_cost', m.estimated_cost, false);
  return errors;
}

export interface ValidateContext {
  intent: SaveIntent;
  extras: Pick<FormExtras, 'newLocality' | 'areaPath'>;
  /** Restricted sections are shown (and therefore validated) only when the user may write them. */
  restrictedWrite: boolean;
  /** Current year (tests pass a fixed one). */
  year?: number;
}

/** Validates the working bundle. An empty object means "ready to save". */
export function validateForm(b: ProjectBundle, ctx: ValidateContext): FieldErrors {
  const errors: FieldErrors = {};
  const p = b.project;
  const year = ctx.year ?? new Date().getFullYear();

  if (!(PROJECT_TYPES as readonly string[]).includes(p.type as string))
    errors.type = 'form.errTypeRequired';
  if (blank(p.name_ar)) errors.name_ar = 'form.errNameRequired';
  else if (String(p.name_ar).trim().length > 200) errors.name_ar = 'form.errTooLong';
  if (!blank(p.name_latin) && String(p.name_latin).trim().length > 200)
    errors.name_latin = 'form.errTooLong';

  const hasLon = p.lon !== null && p.lon !== undefined;
  const hasLat = p.lat !== null && p.lat !== undefined;
  if (hasLon || hasLat) {
    if (
      !isNum(p.lon) ||
      !isNum(p.lat) ||
      p.lon < -180 ||
      p.lon > 180 ||
      p.lat < -90 ||
      p.lat > 90 ||
      (p.lon === 0 && p.lat === 0)
    ) {
      errors.location = 'form.errLocationInvalid';
    }
  } else if (ctx.intent === 'submit') {
    // A record cannot leave `draft` without a location (projects_geom_required_ck).
    errors.location = 'form.errLocationRequired';
  }

  if (blank(p.country_id)) errors.country = 'form.errCountryRequired';
  if (ctx.intent === 'submit' && blank(p.admin_area_id) && !errors.country)
    errors.area = 'form.errAreaRequired';

  if (ctx.extras.newLocality && p.locality_id === ctx.extras.newLocality.id) {
    const nl = ctx.extras.newLocality;
    if (blank(nl.name_ar) && blank(nl.name_latin)) errors.locality = 'form.errLocalityName';
  }

  if (!(PROJECT_STATUSES as readonly string[]).includes(p.status as string))
    errors.status = 'form.errStatusRequired';

  nonNegative(errors, 'capacity', p.capacity);
  if (p.build_year !== null && p.build_year !== undefined) {
    if (
      !isNum(p.build_year) ||
      !Number.isInteger(p.build_year) ||
      p.build_year < 1800 ||
      p.build_year > Math.min(2200, year + 5)
    ) {
      errors.build_year = 'form.errBuildYear';
    }
  }
  if (!blank(p.build_date)) {
    if (!validDate(p.build_date)) errors.build_date = 'form.errDate';
    else if (isNum(p.build_year) && Number(String(p.build_date).slice(0, 4)) !== p.build_year)
      errors.build_date = 'form.errBuildDateYear';
  }

  // --- maintenance entries ------------------------------------------------------------
  for (const m of b.maintenance) {
    if (m.deleted_at) continue;
    for (const [k, v] of Object.entries(validateMaintenance(m)))
      errors[`maintenance.${m.id}.${k}`] = v;
  }

  // --- donors ---------------------------------------------------------------------------
  for (const d of b.donors) {
    if (d.deleted_at) continue;
    if (blank(d.donor_id)) errors[`donors.${d.id}.donor`] = 'form.errDonorRequired';
    nonNegative(errors, `donors.${d.id}.amount`, d.amount, false);
    if (isNum(d.amount) && blank(d.currency))
      errors[`donors.${d.id}.currency`] = 'form.errRequired';
    if (d.year !== null && d.year !== undefined) {
      if (!isNum(d.year) || !Number.isInteger(d.year) || d.year < 1900 || d.year > year + 1)
        errors[`donors.${d.id}.year`] = 'form.errYear';
    }
  }

  // --- staff ----------------------------------------------------------------------------
  for (const s of b.staff) {
    if (s.deleted_at) continue;
    if (blank(s.person_id)) errors[`staff.${s.id}.person`] = 'form.errPersonRequired';
    if (blank(s.role)) errors[`staff.${s.id}.role`] = 'form.errRoleRequired';
    if (!blank(s.start_date) && !validDate(s.start_date))
      errors[`staff.${s.id}.start_date`] = 'form.errDate';
    if (!blank(s.end_date)) {
      if (!validDate(s.end_date)) errors[`staff.${s.id}.end_date`] = 'form.errDate';
      else if (!blank(s.start_date) && String(s.end_date) < String(s.start_date))
        errors[`staff.${s.id}.end_date`] = 'form.errEndBeforeStart';
    }
    const c = s.compensation;
    if (ctx.restrictedWrite && c && !c.deleted_at) {
      const amount = c.monthly_amount as unknown;
      if (amount === null || amount === undefined)
        errors[`staff.${s.id}.salary`] = 'form.errRequired';
      else nonNegative(errors, `staff.${s.id}.salary`, amount, false);
      if (blank(c.currency)) errors[`staff.${s.id}.salary_currency`] = 'form.errRequired';
      if (!validDate(c.effective_from)) errors[`staff.${s.id}.salary_from`] = 'form.errDate';
    }
  }

  // --- land, facilities, community --------------------------------------------------------
  if (b.land) {
    nonNegative(errors, 'land.area_m2', b.land.area_m2, false);
    percent(errors, 'land.utilization_pct', b.land.utilization_pct);
  }
  if (b.facilities) {
    nonNegative(errors, 'facilities.quran_count', b.facilities.quran_count);
    nonNegative(errors, 'facilities.quran_need', b.facilities.quran_need);
    nonNegative(errors, 'facilities.hall_capacity', b.facilities.hall_capacity);
  }
  if (b.community) {
    nonNegative(errors, 'community.population', b.community.population);
    percent(errors, 'community.muslim_pct', b.community.muslim_pct);
  }
  if (ctx.restrictedWrite && b.sensitive) {
    nonNegative(errors, 'sensitive.ibadi_families', b.sensitive.ibadi_families);
    nonNegative(errors, 'sensitive.omani_families', b.sensitive.omani_families);
    for (const k of [
      'omani_student_pct',
      'ibadi_student_pct',
      'omani_teacher_pct',
      'ibadi_teacher_pct',
    ] as const) {
      percent(errors, `sensitive.${k}`, b.sensitive[k]);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------
// Server rejections (sync.md §4.1: a rejected op lands in failed_ops "needs attention")
// ---------------------------------------------------------------------------------------

const SECTION_OF: Record<string, string> = {
  project_land: 'land',
  project_facilities: 'facilities',
  community_profiles: 'community',
  community_sensitive: 'sensitive',
};

const PROJECT_COLUMN_FIELD: Record<string, string> = {
  lon: 'location',
  lat: 'location',
  geom: 'location',
  country_id: 'country',
  admin_area_id: 'area',
  locality_id: 'locality',
  branch_id: 'country',
};

const CODE_MESSAGE: Record<string, string> = {
  invalid_coordinates: 'form.srvInvalidCoordinates',
  locality_country_mismatch: 'form.srvLocalityCountry',
  branch_country_mismatch: 'form.srvOutOfScope',
  out_of_scope: 'form.srvOutOfScope',
  forbidden_transition: 'form.srvTransition',
  invalid_transition: 'form.srvTransition',
  invalid_record_state: 'form.srvTransition',
  invalid_option_value: 'form.srvOptionValue',
  photo_limit_exceeded: 'form.srvPhotoLimit',
  person_not_available: 'form.srvPersonUnavailable',
  donor_not_available: 'form.srvDonorUnavailable',
  check_violation: 'form.srvInvalidValue',
  not_null_violation: 'form.srvInvalidValue',
  invalid_value: 'form.srvInvalidValue',
};

/** Column named by a CHECK constraint `<table>_<column>_ck`, if any. */
function constraintColumn(table: string, constraint: string | undefined): string | null {
  if (!constraint) return null;
  const m = new RegExp(`^${table}_(.+)_ck$`).exec(constraint);
  return m ? m[1]! : null;
}

export interface ServerProblem {
  field: string;
  message: string;
  code: string;
}

/** Maps one rejected operation of this project to a field and a message. */
export function serverProblem(op: Pick<FailedOp, 'table' | 'row_id' | 'error'>): ServerProblem {
  const code = op.error?.code ?? 'unknown';
  const message = CODE_MESSAGE[code] ?? 'form.srvGeneric';
  const column = op.error?.column ?? constraintColumn(op.table, op.error?.constraint) ?? null;
  let field = '_general';
  switch (op.table) {
    case 'projects':
      if (code === 'invalid_coordinates' || op.error?.constraint === 'projects_geom_required_ck')
        field = 'location';
      else if (code === 'locality_country_mismatch') field = 'locality';
      else if (code === 'out_of_scope' || code === 'branch_country_mismatch') field = 'country';
      else if (code.endsWith('_transition') || code === 'invalid_record_state') field = '_record';
      else if (column) field = PROJECT_COLUMN_FIELD[column] ?? column;
      break;
    case 'project_land':
    case 'project_facilities':
    case 'community_profiles':
    case 'community_sensitive':
      field = column ? `${SECTION_OF[op.table]}.${column}` : SECTION_OF[op.table]!;
      if (code === 'invalid_option_value') field = 'community';
      break;
    case 'project_photos':
      field = 'photos';
      break;
    case 'project_staff':
      field = code === 'person_not_available' ? `staff.${op.row_id}.person` : 'staff';
      break;
    case 'staff_compensation':
      field = 'staff';
      break;
    case 'project_donors':
    case 'donors':
      field = code === 'donor_not_available' ? `donors.${op.row_id}.donor` : 'donors';
      break;
    case 'project_maintenance':
      field = column ? `maintenance.${op.row_id}.${column}` : 'maintenance';
      break;
    case 'localities':
      field = 'locality';
      break;
    default:
      field = '_general';
  }
  if (op.error?.constraint === 'projects_geom_required_ck') {
    return { field: 'location', message: 'form.errLocationRequired', code };
  }
  return { field, message, code };
}

/** Field errors of every rejected operation (first problem per field wins). */
export function serverErrors(failed: ReadonlyArray<Pick<FailedOp, 'table' | 'row_id' | 'error'>>): {
  fields: FieldErrors;
  general: string[];
} {
  const fields: FieldErrors = {};
  const general: string[] = [];
  for (const op of failed) {
    const p = serverProblem(op);
    if (p.field === '_general' || p.field === '_record') {
      if (!general.includes(p.message)) general.push(p.message);
    } else if (!(p.field in fields)) {
      fields[p.field] = p.message;
    }
  }
  return { fields, general };
}
