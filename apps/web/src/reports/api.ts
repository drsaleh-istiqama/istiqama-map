/**
 * Every server call of the reports module, behind one replaceable object (tests swap it with
 * `setReportsApi`). RPCs go through `transport.rpc` of src/sync (POST, timeout, typed
 * errors); the export job rows are read through PostgREST (RLS: own rows only), the file is
 * produced by the `export` Edge Function and downloaded through a short-lived signed URL that
 * the SAME function issues (GET ?job=<id>: own, live, finished job only; fixed lifetime ≤ 300 s).
 * The browser never signs export files itself: a self-signed URL could carry any expiry and
 * outlive the job (docs/contracts/reports-import-export.md §4).
 *
 * Nothing here is called while the device is offline (web.md §1): callers check `isOnline()`.
 */
import { supabase } from '../auth';
import { env } from '../env';
import { transport } from '../sync';
import {
  parseExportJob,
  type ExportFormat,
  type ExportJob,
  type ExportLang,
  type ScopeRef,
} from './types';

export const EXPORT_BUCKET = 'exports';

const JOB_COLUMNS =
  'id,format,lang,filters,state,storage_path,file_name,bytes,row_count,error,stats,attempts,created_at,updated_at,finished_at,expires_at';

export type ReportKind = 'project' | 'donor' | 'country';

export interface ExportRequestInput {
  format: ExportFormat;
  lang: ExportLang;
  filters: Record<string, unknown>;
}

export interface ReportsApi {
  dashboard(scope: ScopeRef): Promise<unknown>;
  report(kind: ReportKind, id: string): Promise<unknown>;
  adminAreaShapes(countryId: string, level: number): Promise<unknown>;
  /** `export_request` → the queued job row. */
  exportRequest(input: ExportRequestInput): Promise<ExportJob>;
  /** Asks the `export` Edge Function to build the file of a queued job (POST { job_id }). */
  exportStart(jobId: string): Promise<void>;
  exportJob(jobId: string): Promise<ExportJob | null>;
  exportJobs(limit: number): Promise<ExportJob[]>;
  exportCancel(jobId: string): Promise<void>;
  /** Fresh short-lived download URL of a finished job, issued by the `export` function. */
  exportDownloadUrl(jobId: string): Promise<string>;
}

export class ReportsApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReportsApiError';
    this.code = code;
  }
}

const RPC_BY_KIND: Record<ReportKind, string> = {
  project: 'report_project',
  donor: 'report_donor',
  country: 'report_country',
};

function fail(error: { message?: string; code?: string } | null, fallback: string): never {
  throw new ReportsApiError(error?.code ?? 'error', error?.message ?? fallback);
}

export const supabaseReportsApi: ReportsApi = {
  dashboard: (scope) =>
    transport.rpc<unknown>('dashboard', {
      p_scope_type: scope.type,
      p_scope_id: scope.type === 'global' ? null : scope.id,
    }),

  report: (kind, id) => transport.rpc<unknown>(RPC_BY_KIND[kind], { p_id: id }),

  adminAreaShapes: (countryId, level) =>
    transport.rpc<unknown>('admin_area_shapes', { p_country_id: countryId, p_level: level }),

  async exportRequest(input) {
    const row = await transport.rpc<unknown>('export_request', {
      p_format: input.format,
      p_lang: input.lang,
      p_filters: input.filters,
    });
    const job = parseExportJob(row);
    if (!job) throw new ReportsApiError('bad_response', 'export_request returned no job');
    return job;
  },

  async exportStart(jobId) {
    const { error } = await supabase.functions.invoke('export', {
      method: 'POST',
      body: { job_id: jobId },
    });
    if (error) fail(error as { message?: string }, 'export function failed');
  },

  async exportJob(jobId) {
    const { data, error } = await supabase
      .from('export_jobs')
      .select(JOB_COLUMNS)
      .eq('id', jobId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) fail(error, 'cannot read the export job');
    return parseExportJob(data);
  },

  async exportJobs(limit) {
    const { data, error } = await supabase
      .from('export_jobs')
      .select(JOB_COLUMNS)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail(error, 'cannot read the export jobs');
    return (Array.isArray(data) ? data : [])
      .map(parseExportJob)
      .filter((j): j is ExportJob => j !== null);
  },

  async exportCancel(jobId) {
    await transport.rpc<unknown>('export_cancel', { p_job_id: jobId });
  },

  async exportDownloadUrl(jobId) {
    const { data, error } = await supabase.functions.invoke(
      `export?job=${encodeURIComponent(jobId)}`,
      { method: 'GET' },
    );
    if (error) fail(error as { message?: string }, 'export function failed');
    const url = downloadUrlOf(data, env.supabaseUrl);
    if (!url) throw new ReportsApiError('no_download', 'the export has no downloadable file');
    return url;
  },
};

/**
 * The download URL from the function's answer. The function may see an internal API origin,
 * so the path + query it returns is resolved against the app's own API URL when present.
 */
export function downloadUrlOf(body: unknown, apiUrl: string | undefined): string | null {
  if (!body || typeof body !== 'object') return null;
  const download = (body as { download?: unknown }).download;
  if (!download || typeof download !== 'object') return null;
  const { url, path } = download as { url?: unknown; path?: unknown };
  if (typeof path === 'string' && path.startsWith('/') && apiUrl)
    return `${apiUrl.replace(/\/+$/, '')}${path}`;
  return typeof url === 'string' && url !== '' ? url : null;
}

let current: ReportsApi = supabaseReportsApi;

export function reportsApi(): ReportsApi {
  return current;
}

/** Replace the network layer (tests); null restores the Supabase implementation. */
export function setReportsApi(replacement: ReportsApi | null): void {
  current = replacement ?? supabaseReportsApi;
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
