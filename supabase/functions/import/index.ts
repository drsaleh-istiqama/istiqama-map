/**
 * import — server-side parsing of an import file, then `import_stage` with the caller's JWT
 * (brief §10; docs/contracts/reports-import-export.md §5). Everything after staging (preview
 * pages, per-row actions, commit, rollback) is called by the web app directly.
 *
 * Accepted requests (POST):
 *   1. multipart/form-data: `file` (CSV or XLSX), optional `lang`, optional `options` (JSON)
 *   2. the raw file as the body (`text/csv`, the XLSX media type or `application/octet-stream`),
 *      options in the query string (`file_name`, `lang`, `country_id`, `branch_id`, `sheet`)
 *   3. application/json `{ "storage_path": "<uid>/file.xlsx", "options": { … } }` — a file the
 *      caller uploaded (resumably) to bucket `imports`; it is read with the caller's token
 *   4. application/json `{ "rows": [ { header: cell, … } ], "meta": { … } }` — rows parsed on
 *      the device (small files, v2 migration)
 *
 * `options`: `{ file_name?, country_id?, branch_id?, column_map?, sheet?, delimiter? }`.
 * Response: the `import_stage` summary plus `file` (what was read from the file).
 */
import { requireUser } from '../_shared/auth.ts';
import { userClient } from '../_shared/clients.ts';
import { intEnv, serveIfEntryPoint } from '../_shared/env.ts';
import {
  createHandler,
  errors,
  fromStorageError,
  isRecord,
  isUuid,
  json,
  readBytes,
  unwrap,
} from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { parseImportFile, type ImportFileInfo } from './parse.ts';

const MAX_ROWS = 5000; // import_stage refuses more
const MAX_FILE_BYTES = intEnv('IMPORT_MAX_BYTES', 10 * 1024 * 1024, 1024, 25 * 1024 * 1024);
const MAX_JSON_BYTES = intEnv('IMPORT_MAX_JSON_BYTES', 16 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const SOURCE_KINDS = new Set(['csv', 'xlsx', 'v2_json', 'v2_local']);
const LANGS = new Set(['ar', 'sw', 'en']);

interface Options {
  file_name?: string;
  lang?: string;
  country_id?: string;
  branch_id?: string;
  column_map?: Record<string, string>;
  sheet?: string | number;
  delimiter?: string;
  source_kind?: string;
  storage_path?: string;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, max);
}

/** Validate and normalise the caller's options (unknown keys are dropped). */
function readOptions(raw: unknown): Options {
  if (raw === undefined || raw === null || raw === '') return {};
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw errors.validation('invalid_options', 'options is not valid JSON.');
    }
  }
  if (!isRecord(value))
    throw errors.validation('invalid_options', 'options must be a JSON object.');
  const out: Options = {};
  out.file_name = text(value.file_name, 255);
  const lang = text(value.lang, 5);
  if (lang !== undefined) {
    if (!LANGS.has(lang))
      throw errors.validation('invalid_lang', 'lang must be "ar", "sw" or "en".');
    out.lang = lang;
  }
  for (const key of ['country_id', 'branch_id'] as const) {
    const id = text(value[key], 64);
    if (id === undefined) continue;
    if (!isUuid(id)) throw errors.validation('invalid_options', `${key} must be a UUID.`);
    out[key] = id;
  }
  if (value.column_map !== undefined && value.column_map !== null) {
    if (!isRecord(value.column_map))
      throw errors.validation('invalid_options', 'column_map must be an object.');
    const entries = Object.entries(value.column_map);
    if (
      entries.length > 300 ||
      entries.some(([k, v]) => typeof v !== 'string' || k.length > 200 || v.length > 100)
    )
      throw errors.validation(
        'invalid_options',
        'column_map must map file headers to template keys.',
      );
    out.column_map = value.column_map as Record<string, string>;
  }
  if (typeof value.sheet === 'number' && Number.isInteger(value.sheet) && value.sheet >= 0)
    out.sheet = value.sheet;
  else if (text(value.sheet, 64) !== undefined) out.sheet = text(value.sheet, 64);
  const delimiter = typeof value.delimiter === 'string' ? value.delimiter : undefined;
  if (delimiter !== undefined) {
    const d = delimiter === 'tab' ? '\t' : delimiter;
    if (![',', ';', '\t'].includes(d))
      throw errors.validation('invalid_options', 'delimiter must be "," ";" or "tab".');
    out.delimiter = d;
  }
  const kind = text(value.source_kind, 20);
  if (kind !== undefined) {
    if (!SOURCE_KINDS.has(kind))
      throw errors.validation('invalid_options', 'unsupported source_kind.');
    out.source_kind = kind;
  }
  out.storage_path = text(value.storage_path, 500);
  return out;
}

function metaFor(options: Options, sourceKind: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { source_kind: sourceKind };
  if (options.file_name) meta.file_name = options.file_name;
  if (options.country_id) meta.country_id = options.country_id;
  if (options.branch_id) meta.branch_id = options.branch_id;
  if (options.column_map) meta.column_map = options.column_map;
  if (options.storage_path) meta.storage_path = options.storage_path;
  if (options.lang) meta.lang = options.lang;
  return meta;
}

function baseName(name: string): string {
  return name.replace(/^.*[\\/]/, '').slice(0, 255);
}

export const handler = createHandler('import', ['POST'], async (req, { timing }) => {
  const caller = await requireUser(req);
  // The database allows 30 batches per hour; this only stops bursts before a file is parsed.
  enforceRateLimit('import', caller.userId, 20);
  const user = userClient(req);
  const url = new URL(req.url);
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();

  let options: Options = {};
  let fileBytes: Uint8Array | null = null;
  let rows: unknown[] | null = null;
  let sourceKind: string | null = null;

  if (contentType.startsWith('multipart/form-data')) {
    const raw = await readBytes(req, MAX_FILE_BYTES + 256 * 1024);
    let form: FormData;
    try {
      form = await new Response(raw as BodyInit, {
        headers: { 'content-type': contentType },
      }).formData();
    } catch {
      throw errors.badRequest('invalid_multipart', 'The multipart body cannot be parsed.');
    }
    options = readOptions(form.get('options'));
    const lang = form.get('lang');
    if (typeof lang === 'string' && lang !== '') options = { ...options, ...readOptions({ lang }) };
    const file = form.get('file');
    if (file === null || typeof file === 'string')
      throw errors.validation('file_required', 'Send the file in the form field "file".');
    if (file.size > MAX_FILE_BYTES)
      throw errors.tooLarge('file_too_large', `The file exceeds ${MAX_FILE_BYTES} bytes.`);
    fileBytes = new Uint8Array(await file.arrayBuffer());
    if (!options.file_name && file.name) options.file_name = baseName(file.name);
  } else if (contentType.startsWith('application/json')) {
    const raw = await readBytes(req, MAX_JSON_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw errors.badRequest('invalid_json', 'The request body is not valid JSON.');
    }
    if (!isRecord(body))
      throw errors.validation('invalid_body', 'The request body must be a JSON object.');
    options = readOptions({
      ...(isRecord(body.options) ? body.options : {}),
      ...(isRecord(body.meta) ? body.meta : {}),
      ...(body.file_name !== undefined ? { file_name: body.file_name } : {}),
      ...(body.lang !== undefined ? { lang: body.lang } : {}),
      ...(body.source_kind !== undefined ? { source_kind: body.source_kind } : {}),
      ...(body.storage_path !== undefined ? { storage_path: body.storage_path } : {}),
    });
    if (Array.isArray(body.rows)) {
      rows = body.rows;
      sourceKind = options.source_kind ?? 'csv';
    } else if (options.storage_path) {
      // A file the caller uploaded to its own folder of bucket `imports` (storage policy).
      const { data, error } = await timing.measure('download', () =>
        user.storage.from('imports').download(options.storage_path!),
      );
      if (error || !data)
        throw fromStorageError((error ?? {}) as { message?: string; statusCode?: string });
      if (data.size > MAX_FILE_BYTES)
        throw errors.tooLarge('file_too_large', `The file exceeds ${MAX_FILE_BYTES} bytes.`);
      fileBytes = new Uint8Array(await data.arrayBuffer());
      if (!options.file_name) options.file_name = baseName(options.storage_path);
    } else {
      throw errors.validation('rows_required', 'Send "rows" (array of objects) or "storage_path".');
    }
  } else {
    // The raw file as the request body.
    options = readOptions(Object.fromEntries(url.searchParams.entries()));
    const header = req.headers.get('x-file-name');
    if (!options.file_name && header) options.file_name = baseName(decodeURIComponent(header));
    fileBytes = await readBytes(req, MAX_FILE_BYTES);
  }

  let file: ImportFileInfo | null = null;
  if (fileBytes) {
    const bytes = fileBytes;
    const parsed = await timing.measure('parse', () =>
      parseImportFile(bytes, {
        maxRows: MAX_ROWS,
        sheet: options.sheet,
        delimiter: options.delimiter,
      }),
    );
    rows = parsed.rows;
    file = parsed.info;
    sourceKind = parsed.info.kind;
  }

  if (!rows || rows.length === 0)
    throw errors.validation('empty_file', 'There are no rows to import.');
  if (rows.length > MAX_ROWS)
    throw errors.validation(
      'too_many_rows',
      `${rows.length} rows (maximum ${MAX_ROWS} per batch).`,
    );
  if (rows.some((r) => !isRecord(r)))
    throw errors.validation(
      'invalid_rows',
      'Every row must be a JSON object keyed by the column titles.',
    );

  // Not retried: import_stage creates a batch on every call.
  const summary = unwrap<Record<string, unknown>>(
    await timing.measure('stage', async () =>
      user.rpc('import_stage', { p_meta: metaFor(options, sourceKind ?? 'csv'), p_rows: rows }),
    ),
  );
  return json({ ...summary, file });
});

export default handler;
serveIfEntryPoint(import.meta, handler);
