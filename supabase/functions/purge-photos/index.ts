/**
 * purge-photos — retention job (brief §11; docs/contracts/reports-import-export.md §6).
 * SERVICE ROLE ONLY: the bearer must be the service-role key (scheduler, local gateway timer).
 *
 * 1. Photos: `photos_to_purge` → remove both storage objects (full + thumbnail) from bucket
 *    `photos` → `mark_photos_purged`; repeated until nothing is left or the time budget is
 *    used. A row is only marked after its objects were removed (or were already gone), so
 *    the job is idempotent and safe to re-run after a crash.
 * 2. Export files: jobs that `private.expire_export_jobs()` moved to `expired` still have
 *    their file; it is removed from bucket `exports` and `storage_path` is cleared (the
 *    bookkeeping row stays).
 *
 * Body (optional): `{ "limit": 500, "max_batches": 20 }`.
 * Response: `{ photos: { marked, objects_removed, batches, more }, exports: { files_removed, jobs_cleared }, duration_ms }`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireServiceRole } from '../_shared/auth.ts';
import { serviceClient, withRetry } from '../_shared/clients.ts';
import { intEnv, serveIfEntryPoint } from '../_shared/env.ts';
import { createHandler, fromStorageError, isRecord, json, readJson, unwrap } from '../_shared/http.ts';

const TIME_BUDGET_MS = intEnv('PURGE_TIME_BUDGET_SECONDS', 100, 5, 380) * 1000;
const REMOVE_CHUNK = 200; // object names per storage request

interface PurgeRow {
  id: string;
  project_id: string;
  bucket: string;
  storage_path_full: string | null;
  storage_path_thumb: string | null;
  deleted_at: string | null;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Remove objects; names that do not exist (any more) are not an error. */
async function removeObjects(svc: SupabaseClient, bucket: string, names: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < names.length; i += REMOVE_CHUNK) {
    const { data, error } = await svc.storage.from(bucket).remove(names.slice(i, i + REMOVE_CHUNK));
    if (error) throw fromStorageError(error as { message?: string; statusCode?: string });
    removed += data?.length ?? 0;
  }
  return removed;
}

async function purgePhotos(
  svc: SupabaseClient,
  limit: number,
  maxBatches: number,
  deadline: number,
): Promise<{ marked: number; objects_removed: number; batches: number; more: boolean }> {
  let marked = 0;
  let objects = 0;
  let batches = 0;
  let more = false;
  let previous = '';
  for (;;) {
    const rows = unwrap<PurgeRow[]>(await withRetry<PurgeRow[]>(() => svc.rpc('photos_to_purge', { p_limit: limit })));
    if (!rows || rows.length === 0) break;
    // The same batch twice = marking does not make progress: stop instead of looping forever.
    const signature = `${rows.length}:${rows[0]!.id}:${rows[rows.length - 1]!.id}`;
    if (signature === previous || batches >= maxBatches || Date.now() > deadline) {
      more = true;
      break;
    }
    previous = signature;
    batches++;

    const byBucket = new Map<string, string[]>();
    for (const row of rows) {
      const names = byBucket.get(row.bucket ?? 'photos') ?? [];
      if (row.storage_path_full) names.push(row.storage_path_full);
      if (row.storage_path_thumb) names.push(row.storage_path_thumb);
      byBucket.set(row.bucket ?? 'photos', names);
    }
    for (const [bucket, names] of byBucket) objects += await removeObjects(svc, bucket, [...new Set(names)]);

    marked += unwrap<number>(
      await withRetry<number>(() => svc.rpc('mark_photos_purged', { p_ids: rows.map((r) => r.id) })),
    );
  }
  return { marked, objects_removed: objects, batches, more };
}

async function purgeExpiredExports(
  svc: SupabaseClient,
  limit: number,
): Promise<{ files_removed: number; jobs_cleared: number }> {
  const jobs = unwrap<Array<{ id: string; storage_path: string }>>(
    await withRetry<Array<{ id: string; storage_path: string }>>(() =>
      svc
        .from('export_jobs')
        .select('id, storage_path')
        .eq('state', 'expired')
        .not('storage_path', 'is', null)
        .order('expires_at', { ascending: true })
        .limit(limit),
    ),
  );
  if (!jobs || jobs.length === 0) return { files_removed: 0, jobs_cleared: 0 };
  const removed = await removeObjects(svc, 'exports', jobs.map((j) => j.storage_path));
  const cleared = unwrap<Array<{ id: string }>>(
    await svc
      .from('export_jobs')
      .update({ storage_path: null })
      .in('id', jobs.map((j) => j.id))
      .eq('state', 'expired')
      .select('id'),
  );
  return { files_removed: removed, jobs_cleared: cleared?.length ?? 0 };
}

export const handler = createHandler('purge-photos', ['POST'], async (req) => {
  requireServiceRole(req);
  const started = Date.now();
  const body = await readJson(req, 4096);
  const options = isRecord(body) ? body : {};
  const limit = clamp(options.limit, 500, 1, 5000);
  const maxBatches = clamp(options.max_batches, 20, 1, 1000);
  const svc = serviceClient();

  const photos = await purgePhotos(svc, limit, maxBatches, started + TIME_BUDGET_MS);
  const exports = await purgeExpiredExports(svc, 500);
  return json({ photos, exports, duration_ms: Date.now() - started });
});

export default handler;
serveIfEntryPoint(import.meta, handler);
