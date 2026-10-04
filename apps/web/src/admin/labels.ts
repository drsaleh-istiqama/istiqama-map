/** Display helpers shared by the panels (all text through `t()`). */
import type { RoleName } from '../auth';
import { pickName, t } from '../i18n';
import type { AdminRole, BranchRec, CountryRec, OptionListKey, ScopeType } from './types';

export function roleLabel(role: RoleName | string): string {
  return t(`admin.role_${role}`);
}

export function scopeTypeLabel(scope: ScopeType | string): string {
  return t(`admin.scope_${scope}`);
}

export function listLabel(list: OptionListKey | string): string {
  return t(`admin.list_${list}`);
}

/** Name of the scope of a grant as `admin_users()` returns it. */
export function grantScopeName(
  grant: Pick<AdminRole, 'scope_type' | 'scope_name_ar' | 'scope_name_en' | 'scope_name_sw'>,
): string {
  if (grant.scope_type === 'global') return t('admin.scope_global_all');
  const name = pickName({
    name_ar: grant.scope_name_ar,
    name_en: grant.scope_name_en,
    name_sw: grant.scope_name_sw,
  });
  return name || t('admin.scope_unknown');
}

type Named = { name_ar?: string | null; name_en?: string | null; name_sw?: string | null };

export function countryName(country: Named | undefined | null): string {
  return country ? pickName(country) : '';
}

/** "فرع بيمبا — تنزانيا" */
export function branchLabel(
  branch: BranchRec | Named,
  country: CountryRec | Named | undefined,
): string {
  const b = pickName(branch);
  const c = country ? pickName(country) : '';
  return c ? t('admin.branchInCountry', { branch: b, country: c }) : b;
}

export function deviceName(device: { label: string | null; device_id: string }): string {
  return device.label?.trim() || t('admin.deviceUnnamed');
}
