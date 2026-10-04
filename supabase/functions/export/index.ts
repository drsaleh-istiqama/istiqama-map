/**
 * export — asynchronous server-side export (brief §9; docs/contracts/reports-import-export.md §4).
 *
 *   POST { "format": "csv" | "xlsx", "lang": "ar" | "sw" | "en", "filters": { … } }
 *        → `export_request` with the caller's JWT, then 202 { job } at once; the file is built
 *          in the background.
 *   POST { "job_id": "<uuid>" }
 *        → same for a job the client already created with `export_request` (contract flow).
 *   GET  ?job=<uuid>
 *        → { job } and, when the job is done, `download` with a short-lived signed URL.
 *
 * Who does what:
 *   - `export_columns` / `export_rows` run with the CALLER's JWT: scope and column visibility
 *     (people / restricted columns) are decided by the database for that caller.
 *   - The upload to `exports/{user_id}/{job_id}.{ext}` and `export_finish` (which creates the
 *     notification) use the service role, as the contract prescribes. The owner id comes from
 *     the job row the database returned for the caller's token.
 *   - The signed URL is created HERE, with the service role and a fixed short lifetime
 *     (≤ 300 s), and only for a job the CALLER's token can still read: own job (RLS), not
 *     soft-deleted, state `done`, file inside the owner's folder. Clients never sign export
 *     files themselves (a self-signed URL could carry any expiry and outlive the job).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireUser } from '../_shared/auth.ts';
import {
  callerHeaders,
  serviceClient,
  userClient,
  userClientFor,
  withRetry,
  type CallerHeaders,
} from '../_shared/clients.ts';
import { env, intEnv, runInBackground, serveIfEntryPoint } from '../_shared/env.ts';
import {
  HttpError,
  createHandler,
  errors,
  fromStorageError,
  isRecord,
  isUuid,
  json,
  readJson,
  toHttpError,
  unwrap,
} from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { XLSX_MIME } from '../_shared/xlsx.ts';
import {
  STAFF_SHEET_NAMES,
  asStaffColumns,
  buildXlsxExport,
  cellPages,
  csvChunks,
  csvStream,
  datasetOf,
  exportFileName,
  staffColumnsOf,
  type ExportColumnsWithStaff,
  type ExportFormat,
  type ExportPage,
  type Progress,
} from './build.ts';

const BUCKET = 'exports';
const PAGE_SIZE = intEnv('EXPORT_PAGE_SIZE', 1000, 1, 2000);
/**
 * Practical XLSX limit. Excel itself stops at 1,048,575 data rows, but a sheet of this width
 * (≈ 85 columns) becomes unusable in Excel on ordinary laptops long before that; beyond the
 * limit the job is delivered as CSV instead (see `fallback` in the status response).
 */
const XLSX_MAX_ROWS = intEnv('EXPORT_XLSX_MAX_ROWS', 200_000, 1, 1_048_575);
const SIGNED_URL_SECONDS = intEnv('EXPORT_SIGNED_URL_SECONDS', 300, 30, 300);
const MAX_ATTEMPTS = intEnv('EXPORT_MAX_ATTEMPTS', 3, 1, 10);
/** A `running` job whose row has not been touched for this long is considered abandoned. */
const STALE_MS = intEnv('EXPORT_STALE_SECONDS', 120, 10) * 1000;
/** `stream` (default): CSV is uploaded while it is produced. `buffer`: built in memory first. */
const CSV_UPLOAD = (env('EXPORT_CSV_UPLOAD') ?? 'stream').toLowerCase();

const JOB_COLUMNS =
  'id,user_id,format,lang,filters,state,storage_path,file_name,bytes,row_count,stats,error,attempts,started_at,finished_at,expires_at,created_at,updated_at';

interface Job {
  id: string;
  user_id: string;
  format: ExportFormat;
  lang: string;
  filters: unknown;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
  storage_path: string | null;
  file_name: string | null;
  bytes: number | null;
  row_count: number | null;
  stats: Record<string, unknown> | null;
  error: unknown;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Jobs being processed by this isolate (guards against double invocation). */
const inFlight = new Set<string>();

async function loadJob(user: SupabaseClient, id: string): Promise<Job> {
  const job = unwrap(
    await withRetry<Job>(() =>
      user
        .from('export_jobs')
        .select(JOB_COLUMNS)
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle(),
    ),
  );
  // RLS: users only see their own jobs — an unknown id and somebody else's job look the same.
  if (!job) throw errors.notFound('export_job_not_found', 'No such export job.');
  return job;
}

function extensionOf(path: string | null): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The job plus what the client needs to act on it. `job` must come from `loadJob` /
 * `export_request` with the caller's token (that is the authorization for signing).
 */
async function describe(job: Job): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { job };
  const delivered = extensionOf(job.storage_path);
  if (delivered && delivered !== job.format) {
    // The file is not in the requested format: tell the user why (translate by `reason`).
    out.fallback = isRecord(job.stats?.fallback)
      ? job.stats.fallback
      : { from: job.format, to: delivered, reason: 'row_limit', limit: XLSX_MAX_ROWS };
  }
  if (job.state === 'done' && job.storage_path) {
    if (!job.storage_path.startsWith(`${job.user_id}/`)) {
      out.download = null;
      out.download_error = 'storage path outside the owner folder';
      return out;
    }
    const { data, error } = await serviceClient()
      .storage.from(BUCKET)
      .createSignedUrl(job.storage_path, SIGNED_URL_SECONDS, { download: job.file_name ?? true });
    if (error || !data) {
      out.download = null;
      out.download_error = error?.message ?? 'signing failed';
    } else {
      let path: string | null;
      try {
        const u = new URL(data.signedUrl);
        path = `${u.pathname}${u.search}`;
      } catch {
        path = null;
      }
      out.download = {
        url: data.signedUrl,
        // Path + query on the API origin, for deployments where the functions see an internal URL.
        path,
        expires_in: SIGNED_URL_SECONDS,
        bucket: BUCKET,
        storage_path: job.storage_path,
        file_name: job.file_name,
        bytes: job.bytes,
        row_count: job.row_count,
      };
    }
  }
  return out;
}

function describeError(e: unknown): string {
  const err = toHttpError(e);
  const text = err.details ? `${err.message}: ${err.details}` : err.message;
  return `${err.code} ${text}`.slice(0, 1000);
}

async function uploadFile(
  svc: SupabaseClient,
  path: string,
  body: Blob | ReadableStream<Uint8Array>,
  contentType: string,
): Promise<void> {
  const { error } = await svc.storage
    .from(BUCKET)
    .upload(path, body, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw fromStorageError(error as { message?: string; statusCode?: string });
}

/** Build the file, upload it, report the outcome. Never throws. */
async function processExport(job: Job, creds: CallerHeaders): Promise<void> {
  const svc = serviceClient();
  const user = userClientFor(creds);
  const started = Date.now();
  let progress: Progress = { rows: 0, bytes: 0, pages: 0 };
  let uploaded: string | null = null;
  try {
    const running = unwrap(
      await withRetry<Job>(() =>
        svc.rpc('export_finish', { p_job_id: job.id, p_state: 'running' }),
      ),
    );
    if (running.attempts > MAX_ATTEMPTS)
      throw new HttpError(500, 'PT500', 'too_many_attempts', {
        details: `The export was abandoned after ${MAX_ATTEMPTS} attempts.`,
      });

    const dictionary = unwrap(
      await withRetry<ExportColumnsWithStaff>(() =>
        user.rpc('export_columns', { p_lang: job.lang }),
      ),
    );
    if (!Array.isArray(dictionary.columns) || dictionary.columns.length === 0)
      throw new HttpError(500, 'PT500', 'no_columns', {
        details: 'export_columns returned no columns.',
      });

    const rpcPages =
      (fn: 'export_rows' | 'export_staff_rows') =>
      async (after: unknown): Promise<ExportPage> =>
        unwrap(
          await withRetry<ExportPage>(() =>
            user.rpc(fn, { p_job_id: job.id, p_after: after, p_limit: PAGE_SIZE }),
          ),
        );

    // dataset "staff": the staff table is the (only) table of the file
    const dataset = datasetOf(job.filters);
    const staffColumns = staffColumnsOf(dictionary);
    if (dataset === 'staff' && staffColumns.length === 0)
      throw new HttpError(403, 'PT403', 'no_staff_access', {
        details: 'The staff table is not available to this account.',
      });
    const columns = dataset === 'staff' ? asStaffColumns(dictionary) : dictionary;
    const fetchPage = rpcPages(dataset === 'staff' ? 'export_staff_rows' : 'export_rows');

    let format: ExportFormat = job.format;
    let fallback: Record<string, unknown> | null = null;
    let truncatedCells = 0;

    if (format === 'xlsx') {
      // projects: second sheet with the staff when the caller may see staff
      const withStaff = dataset === 'projects' && staffColumns.length > 0;
      const outcome = await buildXlsxExport(
        dataset === 'staff' ? { ...columns, staff_columns: [] } : dictionary,
        cellPages(columns, fetchPage),
        progress,
        XLSX_MAX_ROWS,
        {
          sheetName:
            dataset === 'staff' ? (STAFF_SHEET_NAMES[job.lang] ?? STAFF_SHEET_NAMES.en) : undefined,
          staff: withStaff
            ? cellPages(dictionary, rpcPages('export_staff_rows'), staffColumns)
            : undefined,
        },
      );
      if (outcome.overflow) {
        // The CSV fallback holds one table: the job's main table (a staff sheet is dropped;
        // the user can request the staff as their own export, filters.dataset = "staff").
        fallback = { from: 'xlsx', to: 'csv', reason: 'row_limit', limit: XLSX_MAX_ROWS };
        if (withStaff) fallback.staff_omitted = true;
        format = 'csv';
        progress = { rows: 0, bytes: 0, pages: 0 };
      } else {
        const path = `${job.user_id}/${job.id}.xlsx`;
        uploaded = path;
        await uploadFile(
          svc,
          path,
          new Blob(outcome.chunks as BlobPart[], { type: XLSX_MIME }),
          XLSX_MIME,
        );
        truncatedCells = outcome.truncatedCells;
      }
    }

    if (format === 'csv') {
      const path = `${job.user_id}/${job.id}.csv`;
      const type = 'text/csv; charset=utf-8';
      uploaded = path;
      const pages = cellPages(columns, fetchPage);
      if (CSV_UPLOAD === 'buffer') {
        const chunks = await csvChunks(columns, pages, progress);
        await uploadFile(svc, path, new Blob(chunks as BlobPart[], { type }), type);
      } else {
        let sourceError: unknown = null;
        const stream = csvStream(columns, pages, progress, (e) => {
          sourceError = e;
        });
        try {
          await uploadFile(svc, path, stream, type);
        } catch (e) {
          throw sourceError ?? e; // the page that failed explains more than "fetch failed"
        }
        if (sourceError) throw sourceError;
      }
    }

    const extension = format;
    const stats: Record<string, unknown> = {
      pages: progress.pages,
      duration_ms: Date.now() - started,
      format_delivered: format,
    };
    if (fallback) stats.fallback = fallback;
    if (truncatedCells > 0) stats.truncated_cells = truncatedCells;
    if (dataset !== 'projects') stats.dataset = dataset;
    if (progress.staffRows !== undefined) stats.staff_rows = progress.staffRows;
    // Bookkeeping only; a failure here must not fail the export.
    await svc
      .from('export_jobs')
      .update({ stats })
      .eq('id', job.id)
      .then(
        () => undefined,
        () => undefined,
      );

    unwrap(
      await withRetry<Job>(() =>
        svc.rpc('export_finish', {
          p_job_id: job.id,
          p_state: 'done',
          p_storage_path: uploaded,
          p_row_count: progress.rows,
          p_error: null,
          p_file_name: exportFileName(job.id, extension, new Date(), dataset),
          p_bytes: progress.bytes,
        }),
      ),
    );
  } catch (e) {
    const message = describeError(e);
    console.error(`[export] job ${job.id} failed: ${message}`);
    if (uploaded)
      await svc.storage
        .from(BUCKET)
        .remove([uploaded])
        .catch(() => undefined);
    // A cancelled (or already finished) job answers PT409 here: nothing more to do.
    await withRetry(() =>
      svc.rpc('export_finish', {
        p_job_id: job.id,
        p_state: 'failed',
        p_row_count: progress.rows,
        p_error: message,
      }),
    ).then(
      (r) => {
        if (r.error && r.error.code !== 'PT409')
          console.error(`[export] job ${job.id}: export_finish(failed) → ${r.error.message}`);
      },
      () => undefined,
    );
  } finally {
    inFlight.delete(job.id);
  }
}

function isStale(job: Job): boolean {
  const touched = Date.parse(job.updated_at);
  return Number.isFinite(touched) && Date.now() - touched > STALE_MS;
}

export const handler = createHandler('export', ['GET', 'POST'], async (req) => {
  const caller = await requireUser(req);
  const user = userClient(req);

  if (req.method === 'GET') {
    enforceRateLimit('export_status', caller.userId, 240);
    const params = new URL(req.url).searchParams;
    const id = params.get('job') ?? params.get('job_id');
    if (!isUuid(id)) throw errors.validation('invalid_job_id', 'Pass ?job=<export job id>.');
    return json(await describe(await loadJob(user, id)));
  }

  enforceRateLimit('export', caller.userId, 30);
  const body = await readJson(req, 64 * 1024);
  if (!isRecord(body))
    throw errors.validation('invalid_body', 'The request body must be a JSON object.');

  let job: Job;
  if (body.job_id !== undefined && body.job_id !== null) {
    if (!isUuid(body.job_id)) throw errors.validation('invalid_job_id', 'job_id must be a UUID.');
    job = await loadJob(user, body.job_id);
  } else {
    const format = typeof body.format === 'string' ? body.format.toLowerCase() : '';
    if (format !== 'csv' && format !== 'xlsx')
      throw errors.validation('invalid_format', 'format must be "csv" or "xlsx".');
    const lang = body.lang === undefined || body.lang === null ? 'ar' : body.lang;
    if (lang !== 'ar' && lang !== 'sw' && lang !== 'en')
      throw errors.validation('invalid_lang', 'lang must be "ar", "sw" or "en".');
    const filters = body.filters ?? {};
    if (!isRecord(filters))
      throw errors.validation('invalid_filters', 'filters must be a JSON object.');
    // Not retried: export_request is not idempotent (it would create a second job).
    job = unwrap<Job>(
      await user.rpc('export_request', { p_format: format, p_lang: lang, p_filters: filters }),
    );
  }

  if (job.state === 'done') return json(await describe(job), 200);
  if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired')
    throw errors.conflict(
      'export_not_active',
      `The export job is ${job.state}; request a new one.`,
    );

  const alreadyRunning = inFlight.has(job.id) || (job.state === 'running' && !isStale(job));
  if (!alreadyRunning) {
    inFlight.add(job.id);
    runInBackground(processExport(job, callerHeaders(req)), 'export');
  }
  return json({ job, status: `?job=${job.id}` }, 202);
});

export default handler;
serveIfEntryPoint(import.meta, handler);
