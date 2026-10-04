/** User-facing texts of the v2 migration (namespace `migration`). */
import { t } from '../i18n';
import type { MigrationWarning, WarningCode } from './v2map';
import type { V2ReadError } from './v2read';

function tOr(key: string, fallback: string, params?: Record<string, string | number>): string {
  const s = t(key, params);
  return s === key ? fallback : s;
}

export function warningText(w: MigrationWarning): string {
  return tOr(`migration.w_${w.code}`, w.code, { value: w.value ?? '', field: w.field ?? '' });
}

/** Warnings grouped by project (or person) for the summary / report, in input order. */
export function groupWarnings(
  warnings: readonly MigrationWarning[],
): Array<{ key: string; name: string; items: MigrationWarning[] }> {
  const groups = new Map<string, { key: string; name: string; items: MigrationWarning[] }>();
  for (const w of warnings) {
    let g = groups.get(w.key);
    if (!g) {
      g = { key: w.key, name: w.name, items: [] };
      groups.set(w.key, g);
    }
    g.items.push(w);
  }
  return [...groups.values()];
}

/** Codes that only inform (nothing was lost). */
const INFO_CODES = new Set<WarningCode>([
  'already_migrated',
  'locality_new',
  'salary_currency_assumed',
  'person_without_project',
  'person_possible_duplicate',
]);

export function isInfo(w: MigrationWarning): boolean {
  return INFO_CODES.has(w.code);
}

export function readErrorText(error: V2ReadError): string {
  return t(`migration.read_${error}`);
}

export function flowErrorText(code: string): string {
  return tOr(`migration.error_${code}`, t('migration.error_unknown'));
}
