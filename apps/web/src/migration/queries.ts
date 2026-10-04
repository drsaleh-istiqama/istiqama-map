/**
 * Read-only local queries of the migration (web.md §5: feature queries live next to the
 * feature, on top of the exported Dexie instance). Nothing here writes.
 */
import { db, failedOpsForRow, opsForRow, type Row, type TableName } from '../db';
import type { AreaRef, CountryRef, DonorRef, LocalityRef, OptionRef } from './v2map';

const live = <T extends { deleted_at?: string | null }>(r: T | undefined): r is T =>
  !!r && (r.deleted_at === null || r.deleted_at === undefined);

export interface ReferenceData {
  countries: CountryRef[];
  areas: AreaRef[];
  localities: LocalityRef[];
  options: OptionRef[];
  donors: DonorRef[];
  branches: Row<'branches'>[];
}

/** Everything the mapping looks names up in (areas: levels 1–2 only — level 3 has no shapes). */
export async function loadReference(): Promise<ReferenceData> {
  const countries = (await db.countries.toArray()).filter(live);
  const areas: AreaRef[] = [];
  for (const c of countries) {
    for (const level of [1, 2] as const) {
      const rows = await db.admin_areas.where('[country_id+level]').equals([c.id, level]).toArray();
      for (const a of rows) {
        if (!live(a)) continue;
        areas.push({
          id: a.id,
          country_id: a.country_id,
          level: a.level,
          parent_id: a.parent_id,
          name_ar: a.name_ar,
          name_en: a.name_en,
          name_sw: a.name_sw,
        });
      }
    }
  }
  const localities = (await db.localities.toArray()).filter(live).map((l) => ({
    id: l.id,
    country_id: l.country_id,
    admin_area_id: l.admin_area_id,
    name_ar: l.name_ar,
    name_latin: l.name_latin,
  }));
  const options = (await db.option_values.toArray()).filter(live);
  const donors = (await db.donors.toArray()).filter(live).map((d) => ({
    id: d.id,
    name_ar: d.name_ar,
    name_latin: d.name_latin,
  }));
  const branches = (await db.branches.toArray()).filter(live);
  return { countries, areas, localities, options, donors, branches };
}

/** `external_id`s of projects on this device that start with `prefix`. */
export async function localExternalIds(prefix = 'v2:'): Promise<Set<string>> {
  const out = new Set<string>();
  await db.projects.each((p) => {
    if (typeof p.external_id === 'string' && p.external_id.startsWith(prefix))
      out.add(p.external_id);
  });
  return out;
}

export async function projectStored(id: string): Promise<boolean> {
  return (await db.projects.get(id)) !== undefined;
}

export async function rowStored(
  table: 'persons' | 'donors' | 'localities',
  id: string,
): Promise<boolean> {
  return (await db.table(table).get(id)) !== undefined;
}

export interface QueueState {
  /** Operations still in the outbox (pending or in flight). */
  pending: number;
  /** Operations the server rejected (`failed_ops`). */
  failed: number;
  /** Error codes of the rejected operations (for the report). */
  failures: Array<{ table: TableName; rowId: string; code: string; message?: string }>;
  /**
   * Photos of the projects whose image is not in storage yet: the full-size blob stays in
   * `photo_blobs` until the upload queue has stored both objects (also while an upload keeps
   * failing). Until then the v2 data URL is the only other copy of the image.
   */
  photos: number;
}

/**
 * Queue state of the migrated rows: every operation of the projects (and of all their
 * children, which carry `project_id`) plus the shared rows (persons, donors, localities), and
 * the photos of the projects whose image still waits for the upload. Read-only use of the
 * outbox and of `photo_blobs` (web.md §5).
 */
export async function queueStateOf(input: {
  projectIds: readonly string[];
  rows: ReadonlyArray<[TableName, string]>;
}): Promise<QueueState> {
  const state: QueueState = { pending: 0, failed: 0, failures: [], photos: 0 };
  for (const pid of input.projectIds) {
    state.pending += await db.outbox.where('project_id').equals(pid).count();
    // Primary keys only (`<photo id>:<kind>`): never materialise the image bytes.
    const blobKeys = (await db.photo_blobs
      .where('project_id')
      .equals(pid)
      .primaryKeys()) as string[];
    state.photos += blobKeys.filter((k) => k.endsWith(':full')).length;
    const failed = await db.failed_ops.where('project_id').equals(pid).toArray();
    state.failed += failed.length;
    for (const f of failed)
      state.failures.push({
        table: f.table,
        rowId: f.row_id,
        code: f.error.code,
        ...(f.error.message ? { message: f.error.message } : {}),
      });
  }
  for (const [table, id] of input.rows) {
    state.pending += (await opsForRow(table, id)).length;
    const failed = await failedOpsForRow(table, id);
    state.failed += failed.length;
    for (const f of failed)
      state.failures.push({
        table: f.table,
        rowId: f.row_id,
        code: f.error.code,
        ...(f.error.message ? { message: f.error.message } : {}),
      });
  }
  return state;
}
