/**
 * Validation of every administration form (pure, unit-tested). Each validator returns the
 * normalised values to send plus one error per field; an error is a locale key of the
 * `admin` namespace with optional parameters, shown under its field (brief §7.6).
 * The database checks the same rules again (CHECK constraints, unique indexes, RPC checks).
 */
import type { RoleName } from '../auth';
import { norm } from '../lib/normalize';
import { hasGrant, isValidRoleScope } from './roles';
import type {
  AdminUser,
  BranchRec,
  CountryRec,
  FxRateRec,
  OptionListKey,
  OptionRec,
  ScopeType,
} from './types';

export interface FieldError {
  key: string;
  params?: Record<string, string | number>;
}

export type Errors<F extends string> = Partial<Record<F, FieldError>>;

export interface Validated<T, F extends string> {
  value: T;
  errors: Errors<F>;
  ok: boolean;
}

function done<T, F extends string>(value: T, errors: Errors<F>): Validated<T, F> {
  return { value, errors, ok: Object.keys(errors).length === 0 };
}

const err = (key: string, params?: FieldError['params']): FieldError =>
  params ? { key: `admin.${key}`, params } : { key: `admin.${key}` };

function text(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim();
}

/** Optional text: '' → null. */
function optional(v: string | null | undefined): string | null {
  const s = text(v);
  return s === '' ? null : s;
}

function upper(v: string | null | undefined): string {
  return text(v).toUpperCase();
}

export const NAME_MAX = 120;
/** Currencies of the brief (§2.4); others may be typed as ISO 4217 codes. */
export const KNOWN_CURRENCIES = ['TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN', 'OMR', 'USD'] as const;

function nameError(value: string, required: boolean): FieldError | undefined {
  if (required && value === '') return err('v_required');
  if (value.length > NAME_MAX) return err('v_too_long', { max: NAME_MAX });
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------------------------

export interface CountryDraft {
  iso2: string;
  iso3: string;
  name_ar: string;
  name_en: string;
  name_sw: string;
  default_currency: string;
  active: boolean;
}

export type CountryField = 'iso2' | 'iso3' | 'name_ar' | 'name_en' | 'name_sw' | 'default_currency';

export interface CountryValues {
  iso2: string;
  iso3: string;
  name_ar: string;
  name_en: string;
  name_sw: string | null;
  default_currency: string;
  active: boolean;
}

/**
 * New country (brief §0: added from the console without new code) or an edit. The codes are
 * unique also among deleted rows (the database index is not partial); on an edit they are
 * not changed (photo paths, project codes and area ids are derived from them).
 */
export function validateCountry(
  draft: CountryDraft,
  existing: readonly CountryRec[],
  editingId: string | null,
): Validated<CountryValues, CountryField> {
  const value: CountryValues = {
    iso2: upper(draft.iso2),
    iso3: upper(draft.iso3),
    name_ar: text(draft.name_ar),
    name_en: text(draft.name_en),
    name_sw: optional(draft.name_sw),
    default_currency: upper(draft.default_currency),
    active: draft.active,
  };
  const errors: Errors<CountryField> = {};
  const others = existing.filter((c) => c.id !== editingId);

  if (value.iso2 === '') errors.iso2 = err('v_required');
  else if (!/^[A-Z]{2}$/.test(value.iso2)) errors.iso2 = err('v_iso2');
  else {
    const clash = others.find((c) => c.iso2 === value.iso2);
    if (clash)
      errors.iso2 = err(clash.deleted_at ? 'v_taken_deleted' : 'v_taken', { name: clash.name_en });
  }

  if (value.iso3 === '') errors.iso3 = err('v_required');
  else if (!/^[A-Z]{3}$/.test(value.iso3)) errors.iso3 = err('v_iso3');
  else {
    const clash = others.find((c) => c.iso3 === value.iso3);
    if (clash)
      errors.iso3 = err(clash.deleted_at ? 'v_taken_deleted' : 'v_taken', { name: clash.name_en });
  }

  const ar = nameError(value.name_ar, true);
  if (ar) errors.name_ar = ar;
  const en = nameError(value.name_en, true);
  if (en) errors.name_en = en;
  const sw = nameError(value.name_sw ?? '', false);
  if (sw) errors.name_sw = sw;

  if (value.default_currency === '') errors.default_currency = err('v_required');
  else if (!/^[A-Z]{3}$/.test(value.default_currency)) errors.default_currency = err('v_currency');

  return done(value, errors);
}

// ---------------------------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------------------------

export interface BranchDraft {
  country_id: string;
  code: string;
  name_ar: string;
  name_en: string;
  name_sw: string;
  admin_area_ids: string[];
  active: boolean;
}

export type BranchField =
  'country_id' | 'code' | 'name_ar' | 'name_en' | 'name_sw' | 'admin_area_ids';

export interface BranchValues {
  country_id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  admin_area_ids: string[];
  active: boolean;
}

export function validateBranch(
  draft: BranchDraft,
  existing: readonly BranchRec[],
  editingId: string | null,
): Validated<BranchValues, BranchField> {
  const value: BranchValues = {
    country_id: draft.country_id,
    code: upper(draft.code).replace(/\s+/g, '-'),
    name_ar: text(draft.name_ar),
    name_en: optional(draft.name_en),
    name_sw: optional(draft.name_sw),
    admin_area_ids: [...new Set(draft.admin_area_ids)],
    active: draft.active,
  };
  const errors: Errors<BranchField> = {};
  if (!value.country_id) errors.country_id = err('v_required');
  if (value.code === '') errors.code = err('v_required');
  else if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(value.code)) errors.code = err('v_branch_code');
  else if (value.country_id) {
    const clash = existing.find(
      (b) => b.id !== editingId && b.country_id === value.country_id && b.code === value.code,
    );
    if (clash)
      errors.code = err(clash.deleted_at ? 'v_taken_deleted' : 'v_taken', { name: clash.name_ar });
  }
  const ar = nameError(value.name_ar, true);
  if (ar) errors.name_ar = ar;
  const en = nameError(value.name_en ?? '', false);
  if (en) errors.name_en = en;
  const sw = nameError(value.name_sw ?? '', false);
  if (sw) errors.name_sw = sw;
  return done(value, errors);
}

// ---------------------------------------------------------------------------------------------
// Option values (brief §2.5)
// ---------------------------------------------------------------------------------------------

export interface OptionDraft {
  code: string;
  name_ar: string;
  name_en: string;
  name_sw: string;
  sort_order: string;
  active: boolean;
}

export type OptionField = 'code' | 'name_ar' | 'name_en' | 'name_sw' | 'sort_order';

export interface OptionValues {
  list_key: OptionListKey;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  sort_order: number;
  active: boolean;
}

/** Next free sort position after the last option (`other` stays at the end, 990). */
export function nextSortOrder(
  options: readonly Pick<OptionRec, 'code' | 'sort_order' | 'deleted_at'>[],
): number {
  let max = 0;
  for (const o of options) {
    if (o.deleted_at || o.code === 'other') continue;
    if (o.sort_order > max) max = o.sort_order;
  }
  return Math.min(9999, Math.floor(max / 10) * 10 + 10);
}

export function validateOption(
  listKey: OptionListKey,
  draft: OptionDraft,
  existing: readonly OptionRec[],
  editingId: string | null,
): Validated<OptionValues, OptionField> {
  const rawSort = text(draft.sort_order);
  const sort = Number(rawSort);
  const value: OptionValues = {
    list_key: listKey,
    code: text(draft.code).toLowerCase(),
    name_ar: text(draft.name_ar),
    name_en: optional(draft.name_en),
    name_sw: optional(draft.name_sw),
    sort_order: Number.isInteger(sort) ? sort : 0,
    active: draft.active,
  };
  const errors: Errors<OptionField> = {};
  if (value.code === '') errors.code = err('v_required');
  else if (!/^[a-z][a-z0-9_]{0,59}$/.test(value.code)) errors.code = err('v_option_code');
  else {
    const clash = existing.find(
      (o) => o.id !== editingId && o.list_key === listKey && o.code === value.code,
    );
    if (clash)
      errors.code = err(clash.deleted_at ? 'v_taken_deleted' : 'v_taken', { name: clash.name_ar });
  }
  const ar = nameError(value.name_ar, true);
  if (ar) errors.name_ar = ar;
  else {
    const same = existing.find(
      (o) =>
        o.id !== editingId &&
        o.list_key === listKey &&
        !o.deleted_at &&
        norm(o.name_ar) === norm(value.name_ar),
    );
    if (same) errors.name_ar = err('v_name_duplicate');
  }
  const en = nameError(value.name_en ?? '', false);
  if (en) errors.name_en = en;
  const sw = nameError(value.name_sw ?? '', false);
  if (sw) errors.name_sw = sw;
  if (rawSort === '' || !/^\d+$/.test(rawSort) || sort < 0 || sort > 9999)
    errors.sort_order = err('v_integer_range', { min: 0, max: 9999 });
  return done(value, errors);
}

// ---------------------------------------------------------------------------------------------
// Exchange rates (brief §2.4)
// ---------------------------------------------------------------------------------------------

export interface FxDraft {
  currency: string;
  usd_per_unit: string;
  effective_date: string;
}

export type FxField = 'currency' | 'usd_per_unit' | 'effective_date';

export interface FxValues {
  currency: string;
  usd_per_unit: number;
  effective_date: string;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Accepts `0.00038`, `0,00038`, `2.6008`; at most 10 decimals (numeric(20,10)). */
export function parseDecimal(raw: string): number | null {
  const s = text(raw).replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,10})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function validateFxRate(
  draft: FxDraft,
  existing: readonly FxRateRec[],
  editingId: string | null,
): Validated<FxValues, FxField> {
  const rate = parseDecimal(draft.usd_per_unit);
  const value: FxValues = {
    currency: upper(draft.currency),
    usd_per_unit: rate ?? 0,
    effective_date: text(draft.effective_date),
  };
  const errors: Errors<FxField> = {};
  if (value.currency === '') errors.currency = err('v_required');
  else if (!/^[A-Z]{3}$/.test(value.currency)) errors.currency = err('v_currency');

  if (text(draft.usd_per_unit) === '') errors.usd_per_unit = err('v_required');
  else if (rate === null || rate <= 0) errors.usd_per_unit = err('v_rate');
  else if (value.currency === 'USD' && rate !== 1) errors.usd_per_unit = err('v_rate_usd');

  if (value.effective_date === '') errors.effective_date = err('v_required');
  else if (!isIsoDate(value.effective_date)) errors.effective_date = err('v_date');
  else if (!errors.currency) {
    const clash = existing.find(
      (r) =>
        r.id !== editingId &&
        r.currency === value.currency &&
        r.effective_date === value.effective_date,
    );
    if (clash)
      errors.effective_date = err(clash.deleted_at ? 'v_rate_taken_deleted' : 'v_rate_taken');
  }
  return done(value, errors);
}

// ---------------------------------------------------------------------------------------------
// Roles and accounts
// ---------------------------------------------------------------------------------------------

export interface RoleDraft {
  role: RoleName | '';
  scope_type: ScopeType | '';
  scope_id: string;
}

export type RoleField = 'role' | 'scope_type' | 'scope_id';

export interface RoleValues {
  role: RoleName;
  scope_type: ScopeType;
  scope_id: string | null;
}

export function validateRole(
  draft: RoleDraft,
  user: Pick<AdminUser, 'roles'> | null,
): Validated<RoleValues, RoleField> {
  const errors: Errors<RoleField> = {};
  const role = draft.role;
  const scopeType = draft.scope_type;
  const scopeId = scopeType === 'global' ? null : draft.scope_id || null;
  if (!role) errors.role = err('v_required');
  if (!scopeType) errors.scope_type = err('v_required');
  else if (role && !isValidRoleScope(role, scopeType)) errors.scope_type = err('v_scope_type');
  if (scopeType && scopeType !== 'global' && !scopeId) errors.scope_id = err('v_required');
  if (role && scopeType && !errors.scope_type && !errors.scope_id && user) {
    if (hasGrant(user, role, scopeType, scopeId)) errors.role = err('v_grant_exists');
  }
  return done(
    {
      role: (role || 'viewer') as RoleName,
      scope_type: (scopeType || 'global') as ScopeType,
      scope_id: scopeId,
    },
    errors,
  );
}

export interface NewUserDraft {
  full_name: string;
  email: string;
  phone: string;
  preferred_language: 'ar' | 'sw' | 'en';
  role: RoleName | '';
  scope_type: ScopeType | '';
  scope_id: string;
}

export type NewUserField = 'full_name' | 'email' | 'phone' | 'role' | 'scope_type' | 'scope_id';

export interface NewUserValues {
  full_name: string;
  email: string | null;
  phone: string | null;
  preferred_language: 'ar' | 'sw' | 'en';
  role: RoleName | null;
  scope_type: ScopeType | null;
  scope_id: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/** Same rules as the `create_user` action of the admin Edge Function. */
export function validateNewUser(
  draft: NewUserDraft,
  users: readonly Pick<AdminUser, 'email' | 'phone'>[],
): Validated<NewUserValues, NewUserField> {
  const email = text(draft.email).toLowerCase();
  const phone = text(draft.phone).replace(/[\s-]/g, '');
  const errors: Errors<NewUserField> = {};
  const name = nameError(text(draft.full_name), true);
  if (name) errors.full_name = name;
  if (email === '' && phone === '') {
    errors.email = err('v_email_or_phone');
    errors.phone = err('v_email_or_phone');
  }
  if (email !== '') {
    if (!EMAIL_RE.test(email) || email.length > 254) errors.email = err('v_email');
    else if (users.some((u) => (u.email ?? '').toLowerCase() === email))
      errors.email = err('v_email_taken');
  }
  if (phone !== '') {
    if (!PHONE_RE.test(phone)) errors.phone = err('v_phone');
    else if (users.some((u) => (u.phone ?? '') === phone)) errors.phone = err('v_phone_taken');
  }
  let role: RoleName | null = null;
  let scopeType: ScopeType | null = null;
  let scopeId: string | null = null;
  if (draft.role) {
    const r = validateRole(
      { role: draft.role, scope_type: draft.scope_type, scope_id: draft.scope_id },
      null,
    );
    Object.assign(errors, r.errors);
    role = r.value.role;
    scopeType = r.value.scope_type;
    scopeId = r.value.scope_id;
  }
  return done(
    {
      full_name: text(draft.full_name),
      email: email || null,
      phone: phone || null,
      preferred_language: draft.preferred_language,
      role,
      scope_type: scopeType,
      scope_id: scopeId,
    },
    errors,
  );
}
