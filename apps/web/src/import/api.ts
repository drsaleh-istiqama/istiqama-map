/**
 * Every server call of the import wizard, behind one replaceable object (tests swap it with
 * `setImportApi`). The file is parsed on the server by the `import` Edge Function (which
 * calls `import_stage` with the caller's JWT); everything after staging goes through the
 * RPCs of docs/contracts/reports-import-export.md §5 (`transport.rpc` of src/sync: POST,
 * timeout, typed errors). The batch history is read through PostgREST (RLS: own batches).
 *
 * Nothing here is called while the device is offline (web.md §1): callers check first.
 */
import { supabase } from '../auth';
import { transport } from '../sync';
import {
  parseBatch,
  parseCommit,
  parsePreview,
  parseRollback,
  parseTemplate,
  parseUpload,
  type BatchRow,
  type CommitResult,
  type ImportLang,
  type ImportTemplate,
  type PreviewFilter,
  type PreviewPage,
  type PreviewRow,
  type RollbackResult,
  type RowAction,
  type UploadResult,
  parseRow,
} from './types';

/** Limits of the `import` function (supabase/functions/README.md §5.4). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 5000;
/** Rows per preview page. */
export const PREVIEW_PAGE = 50;

export interface UploadOptions {
  lang: ImportLang;
  fileName?: string;
}

export interface ImportApi {
  template(lang: ImportLang): Promise<ImportTemplate>;
  /** Sends the file to the `import` function → staged + validated batch. */
  upload(file: Blob, options: UploadOptions): Promise<UploadResult>;
  preview(
    batchId: string,
    after: number,
    limit: number,
    only: PreviewFilter | null,
  ): Promise<PreviewPage>;
  setAction(
    batchId: string,
    rowNo: number,
    action: RowAction,
    targetId?: string | null,
  ): Promise<PreviewRow>;
  commit(batchId: string): Promise<CommitResult>;
  rollback(batchId: string): Promise<RollbackResult>;
  /** The caller's own batches, newest first. */
  batches(limit: number): Promise<BatchRow[]>;
}

/** A refused call: `code` = PostgREST / project code (`PT422`), `message` = the reason key. */
export class ImportApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: string | null;
  constructor(code: string, message: string, status = 0, details: string | null = null) {
    super(message);
    this.name = 'ImportApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const BATCH_COLUMNS =
  'id,state,source_kind,file_name,row_count,stats,created_at,committed_at,rolled_back_at';

/** Reads the error body of a failed function call (`{ code, message, details }`). */
async function functionError(error: unknown): Promise<ImportApiError> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx instanceof Response) {
    let body: Record<string, unknown> = {};
    try {
      body = (await ctx.clone().json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return new ImportApiError(
      typeof body.code === 'string' ? body.code : `HTTP${ctx.status}`,
      typeof body.message === 'string' ? body.message : 'import_failed',
      ctx.status,
      typeof body.details === 'string' ? body.details : null,
    );
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError') return new ImportApiError('network', 'network');
  return new ImportApiError('error', error instanceof Error ? error.message : 'import_failed');
}

/** `import?lang=…&file_name=…` — the function reads its options from the query string. */
export function uploadPath(file: Blob, options: UploadOptions): string {
  const name =
    options.fileName ?? (typeof (file as File).name === 'string' ? (file as File).name : 'import');
  const query = new URLSearchParams({ lang: options.lang, file_name: name });
  return `import?${query.toString()}`;
}

export const supabaseImportApi: ImportApi = {
  async template(lang) {
    return parseTemplate(await transport.rpc<unknown>('import_template', { p_lang: lang }));
  },

  async upload(file, options) {
    const { data, error } = await supabase.functions.invoke(uploadPath(file, options), {
      method: 'POST',
      // The raw file as the body (README §5.4, input 2). Not multipart: a browser's
      // multipart body is refused by the function under the local gateway
      // (`invalid_multipart`), and a custom `x-file-name` header fails the CORS preflight —
      // so the name and the language travel in the query string.
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (error) throw await functionError(error);
    return parseUpload(data);
  },

  async preview(batchId, after, limit, only) {
    return parsePreview(
      await transport.rpc<unknown>('import_preview', {
        p_batch_id: batchId,
        p_after: after,
        p_limit: limit,
        p_only: only,
      }),
    );
  },

  async setAction(batchId, rowNo, action, targetId) {
    const args: Record<string, unknown> = {
      p_batch_id: batchId,
      p_row_no: rowNo,
      p_action: action,
    };
    if (targetId) args.p_target_id = targetId;
    const row = parseRow(await transport.rpc<unknown>('import_set_action', args));
    if (!row) throw new ImportApiError('bad_response', 'bad_response');
    return row;
  },

  async commit(batchId) {
    return parseCommit(await transport.rpc<unknown>('import_commit', { p_batch_id: batchId }));
  },

  async rollback(batchId) {
    return parseRollback(await transport.rpc<unknown>('import_rollback', { p_batch_id: batchId }));
  },

  async batches(limit) {
    const { data, error } = await supabase
      .from('import_batches')
      .select(BATCH_COLUMNS)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new ImportApiError(error.code ?? 'error', error.message ?? 'error');
    return (Array.isArray(data) ? data : [])
      .map(parseBatch)
      .filter((b): b is BatchRow => b !== null);
  },
};

let current: ImportApi = supabaseImportApi;

export function importApi(): ImportApi {
  return current;
}

/** Replace the server layer (tests); null restores the real one. */
export function setImportApi(api: ImportApi | null): void {
  current = api ?? supabaseImportApi;
}
