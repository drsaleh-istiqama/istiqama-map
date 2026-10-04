/**
 * The public application settings of docs/contracts/reference-data.md §5 that the console
 * lets the head office change, with their limits. Values are JSON numbers; keys that are
 * not listed here (`fx.placeholder`, `boundaries.sources`, `app.environment`, …) are shown
 * read-only.
 */
import type { FieldError } from './validate';

export interface SettingDef {
  key: string;
  /** Default of migration 0063 (and of `DEFAULT_SETTINGS` in src/db). */
  fallback: number;
  min: number;
  max: number;
  integer: boolean;
  /** Locale key suffix of the unit (`admin.unit_<unit>`). */
  unit: 'meters' | 'ratio' | 'minutes' | 'seconds' | 'ms' | 'pixels' | 'count' | 'zoom';
  /** The server compiles the same number in as a constant (reference-data.md §5 caveat). */
  serverConstant?: boolean;
}

export const SETTING_DEFS: readonly SettingDef[] = [
  {
    key: 'duplicates.radius_m',
    fallback: 150,
    min: 10,
    max: 2000,
    integer: true,
    unit: 'meters',
    serverConstant: true,
  },
  {
    key: 'duplicates.name_similarity',
    fallback: 0.6,
    min: 0.4,
    max: 1,
    integer: false,
    unit: 'ratio',
    serverConstant: true,
  },
  {
    key: 'persons.name_similarity',
    fallback: 0.6,
    min: 0.4,
    max: 1,
    integer: false,
    unit: 'ratio',
  },
  { key: 'gps.accuracy_warn_m', fallback: 30, min: 5, max: 500, integer: true, unit: 'meters' },
  {
    key: 'security.pin_lock_minutes',
    fallback: 15,
    min: 1,
    max: 120,
    integer: true,
    unit: 'minutes',
  },
  {
    key: 'photos.max_per_project',
    fallback: 10,
    min: 1,
    max: 10,
    integer: true,
    unit: 'count',
    serverConstant: true,
  },
  { key: 'photos.full_max_px', fallback: 1600, min: 800, max: 4096, integer: true, unit: 'pixels' },
  { key: 'photos.thumb_max_px', fallback: 400, min: 120, max: 800, integer: true, unit: 'pixels' },
  { key: 'photos.quality', fallback: 0.8, min: 0.5, max: 0.95, integer: false, unit: 'ratio' },
  { key: 'sync.push_batch_size', fallback: 50, min: 1, max: 200, integer: true, unit: 'count' },
  { key: 'sync.pull_page_size', fallback: 500, min: 50, max: 2000, integer: true, unit: 'count' },
  {
    key: 'sync.interval_seconds',
    fallback: 120,
    min: 30,
    max: 3600,
    integer: true,
    unit: 'seconds',
  },
  { key: 'form.autosave_seconds', fallback: 5, min: 1, max: 60, integer: true, unit: 'seconds' },
  { key: 'list.page_size', fallback: 50, min: 10, max: 200, integer: true, unit: 'count' },
  { key: 'search.debounce_ms', fallback: 250, min: 0, max: 2000, integer: true, unit: 'ms' },
  { key: 'map.local_points_min_zoom', fallback: 14, min: 10, max: 18, integer: true, unit: 'zoom' },
];

/** Keys the console never edits as numbers (shown read-only, some edited elsewhere). */
export const READ_ONLY_SETTINGS = [
  'fx.placeholder',
  'boundaries.sources',
  'app.environment',
] as const;

export function settingDef(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((d) => d.key === key);
}

/** Locale key of the label of a setting (`admin.setting_duplicates_radius_m`). */
export function settingLabelKey(key: string): string {
  return `admin.setting_${key.replace(/[^a-z0-9]+/g, '_')}`;
}

/** Parses what the administrator typed; returns the number to store or the error to show. */
export function validateSettingInput(
  def: SettingDef,
  raw: string,
): { value: number; error: null } | { value: null; error: FieldError } {
  const s = raw.trim().replace(',', '.');
  if (s === '') return { value: null, error: { key: 'admin.v_required' } };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { value: null, error: { key: 'admin.v_number' } };
  const n = Number(s);
  if (def.integer && !Number.isInteger(n))
    return { value: null, error: { key: 'admin.v_integer' } };
  if (n < def.min || n > def.max)
    return { value: null, error: { key: 'admin.v_range', params: { min: def.min, max: def.max } } };
  return { value: n, error: null };
}

/** Current number of a setting row (non-numbers fall back to the default). */
export function currentNumber(def: SettingDef, value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : def.fallback;
}

/** `fx.placeholder` → is the flag still set? (reference-data.md §4) */
export function fxPlaceholderActive(value: unknown): boolean {
  if (value === true) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { placeholder?: unknown }).placeholder === true
  );
}

/** The same JSON with the flag cleared (the other keys — date, currencies, note — are kept). */
export function clearFxPlaceholder(value: unknown): Record<string, unknown> {
  const base =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { ...base, placeholder: false, cleared_at: new Date().toISOString().slice(0, 10) };
}
