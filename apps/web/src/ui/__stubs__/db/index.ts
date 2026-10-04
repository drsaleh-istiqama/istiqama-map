// TEMPORARY STUB of src/db (docs/contracts/web.md §3.4) — only what the shell uses. See ../README.md.
export interface ProjectFilter {
  q?: string;
  countryId?: string;
  branchId?: string;
  adminAreaId?: string;
  type?: string;
  status?: string;
  recordState?: string;
  incomplete?: boolean;
  mine?: boolean;
  openMaintenance?: boolean;
}

export type ListCursor = unknown;

export async function listProjects(
  _filter: ProjectFilter,
  _after: ListCursor | null,
  _limit?: number,
): Promise<{ rows: unknown[]; next: ListCursor | null; total: number }> {
  return { rows: [], next: null, total: 0 };
}

// Cached public app settings (the real ones live in src/db/meta.ts).
let settings: Record<string, unknown> = {};

export async function saveAppSettings(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): Promise<void> {
  settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function getAppSetting<T>(key: string, fallback: T): Promise<T> {
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}
