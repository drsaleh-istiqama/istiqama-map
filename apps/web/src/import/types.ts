/**
 * Shapes of the import RPCs and of the `import` Edge Function
 * (docs/contracts/reports-import-export.md §5). Parsed defensively: the server is trusted for
 * authorisation, but the page must never crash on a field it does not know.
 */

export type ImportLang = 'ar' | 'sw' | 'en';
export type RowState =
  'staged' | 'valid' | 'invalid' | 'duplicate' | 'applied' | 'skipped' | 'failed' | 'reverted';
export type RowAction = 'create' | 'update' | 'skip';
export type PreviewFilter =
  'invalid' | 'duplicate' | 'valid' | 'warnings' | 'create' | 'update' | 'skip';
export type BatchState =
  'staged' | 'validated' | 'committing' | 'committed' | 'rolling_back' | 'rolled_back' | 'failed';

export interface TemplateColumn {
  key: string;
  header: string;
  headers: Partial<Record<ImportLang, string>>;
  required: boolean;
  kind: string;
  example: string | null;
  allowed: Array<{ code: string; label: string }>;
  min: number | null;
  max: number | null;
}

export interface ImportTemplate {
  version: number;
  lang: ImportLang;
  dir: 'rtl' | 'ltr';
  maxRows: number;
  listSeparator: string;
  dateFormat: string;
  mergeKey: string;
  columns: TemplateColumn[];
}

export interface ImportIssue {
  field: string | null;
  code: string;
  message: string;
  /** `possible_duplicate`: first results of `project_duplicates`. */
  candidates?: DuplicateCandidate[];
  /** `duplicate_in_file`: the other row. */
  rowNo?: number;
}

export interface DuplicateCandidate {
  id: string;
  code: string | null;
  name_ar: string | null;
  name_latin: string | null;
  type: string | null;
  status: string | null;
  record_state: string | null;
  distance_m: number | null;
  similarity: number | null;
  reason: string | null;
}

export interface ImportCounts {
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  with_warnings: number;
  create: number;
  update: number;
  skip: number;
  applied_created: number;
  applied_updated: number;
  skipped: number;
  reverted: number;
}

export interface ImportSummary {
  batchId: string;
  state: BatchState | string;
  sourceKind: string;
  fileName: string | null;
  rowCount: number;
  counts: ImportCounts;
  ignoredColumns: string[];
  firstErrors: Array<{ rowNo: number; errors: ImportIssue[] }>;
  committedAt: string | null;
  rolledBackAt: string | null;
}

export interface FileInfo {
  kind: string | null;
  headers: string[];
  rows: number | null;
  sheet: string | null;
  encoding: string | null;
  warnings: string[];
}

export interface UploadResult extends ImportSummary {
  file: FileInfo | null;
}

export interface PreviewRow {
  rowNo: number;
  state: RowState | string;
  action: RowAction | null;
  externalId: string | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  duplicateOf: string | null;
  targetId: string | null;
  raw: Record<string, unknown>;
  parsed: Record<string, unknown> | null;
}

export interface PreviewPage extends ImportSummary {
  rows: PreviewRow[];
  next: number | null;
}

export interface CommitResult extends ImportSummary {
  committed: boolean;
  failedRow: number | null;
  error: { code: string; message: string } | null;
}

export interface RollbackResult extends ImportSummary {
  rolledBack: boolean;
  reverted: number;
  kept: number;
  noAccess: number;
  conflictingFields: number;
}

export interface BatchRow {
  id: string;
  state: BatchState | string;
  sourceKind: string;
  fileName: string | null;
  rowCount: number;
  counts: ImportCounts;
  createdAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
}

// ---------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const COUNT_KEYS: Array<keyof ImportCounts> = [
  'total',
  'valid',
  'invalid',
  'duplicate',
  'with_warnings',
  'create',
  'update',
  'skip',
  'applied_created',
  'applied_updated',
  'skipped',
  'reverted',
];

export function parseCounts(v: unknown): ImportCounts {
  const src = isRecord(v) ? v : {};
  const out = {} as ImportCounts;
  for (const k of COUNT_KEYS) out[k] = numOr(src[k], 0);
  return out;
}

function parseCandidate(v: unknown): DuplicateCandidate | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  return {
    id: v.id,
    code: str(v.code),
    name_ar: str(v.name_ar),
    name_latin: str(v.name_latin),
    type: str(v.type),
    status: str(v.status),
    record_state: str(v.record_state),
    distance_m: numOrNull(v.distance_m),
    similarity: numOrNull(v.similarity),
    reason: str(v.reason),
  };
}

export function parseIssues(v: unknown): ImportIssue[] {
  if (!Array.isArray(v)) return [];
  const out: ImportIssue[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.code !== 'string') continue;
    const issue: ImportIssue = {
      field: str(item.field),
      code: item.code,
      message: typeof item.message === 'string' ? item.message : '',
    };
    if (Array.isArray(item.candidates))
      issue.candidates = item.candidates
        .map(parseCandidate)
        .filter((c): c is DuplicateCandidate => c !== null);
    const rowNo = numOrNull(item.row_no);
    if (rowNo !== null) issue.rowNo = rowNo;
    out.push(issue);
  }
  return out;
}

export function parseSummary(v: unknown): ImportSummary {
  const src = isRecord(v) ? v : {};
  const firstErrors: ImportSummary['firstErrors'] = [];
  if (Array.isArray(src.first_errors)) {
    for (const e of src.first_errors) {
      if (!isRecord(e)) continue;
      const rowNo = numOrNull(e.row_no);
      if (rowNo !== null) firstErrors.push({ rowNo, errors: parseIssues(e.errors) });
    }
  }
  return {
    batchId: typeof src.batch_id === 'string' ? src.batch_id : '',
    state: typeof src.state === 'string' ? src.state : 'staged',
    sourceKind: typeof src.source_kind === 'string' ? src.source_kind : 'csv',
    fileName: str(src.file_name),
    rowCount: numOr(src.row_count, 0),
    counts: parseCounts(src.counts),
    ignoredColumns: strList(src.ignored_columns),
    firstErrors,
    committedAt: str(src.committed_at),
    rolledBackAt: str(src.rolled_back_at),
  };
}

export function parseUpload(v: unknown): UploadResult {
  const summary = parseSummary(v);
  const f = isRecord(v) && isRecord(v.file) ? v.file : null;
  return {
    ...summary,
    file: f
      ? {
          kind: str(f.kind),
          headers: strList(f.headers),
          rows: numOrNull(f.rows),
          sheet: str(f.sheet),
          encoding: str(f.encoding),
          warnings: strList(f.warnings),
        }
      : null,
  };
}

const ACTIONS = new Set<string>(['create', 'update', 'skip']);

export function parseRow(v: unknown): PreviewRow | null {
  if (!isRecord(v)) return null;
  const rowNo = numOrNull(v.row_no);
  if (rowNo === null) return null;
  return {
    rowNo,
    state: typeof v.state === 'string' ? v.state : 'staged',
    action: typeof v.action === 'string' && ACTIONS.has(v.action) ? (v.action as RowAction) : null,
    externalId: str(v.external_id),
    errors: parseIssues(v.errors),
    warnings: parseIssues(v.warnings),
    duplicateOf: str(v.duplicate_of),
    targetId: str(v.target_id),
    raw: isRecord(v.raw) ? v.raw : {},
    parsed: isRecord(v.parsed) ? v.parsed : null,
  };
}

export function parsePreview(v: unknown): PreviewPage {
  const src = isRecord(v) ? v : {};
  return {
    ...parseSummary(v),
    rows: Array.isArray(src.rows)
      ? src.rows.map(parseRow).filter((r): r is PreviewRow => r !== null)
      : [],
    next: numOrNull(src.next),
  };
}

export function parseCommit(v: unknown): CommitResult {
  const src = isRecord(v) ? v : {};
  const err = isRecord(src.error) ? src.error : null;
  return {
    ...parseSummary(v),
    committed: src.committed === true,
    failedRow: numOrNull(src.failed_row),
    error: err
      ? {
          code: typeof err.code === 'string' ? err.code : '',
          message: typeof err.message === 'string' ? err.message : '',
        }
      : null,
  };
}

export function parseRollback(v: unknown): RollbackResult {
  const src = isRecord(v) ? v : {};
  return {
    ...parseSummary(v),
    rolledBack: src.rolled_back === true,
    reverted: numOr(src.reverted, 0),
    kept: numOr(src.kept, 0),
    noAccess: numOr(src.no_access, 0),
    conflictingFields: numOr(src.conflicting_fields, 0),
  };
}

const LANGS = new Set<string>(['ar', 'sw', 'en']);

export function parseTemplate(v: unknown): ImportTemplate {
  const src = isRecord(v) ? v : {};
  const columns: TemplateColumn[] = [];
  if (Array.isArray(src.columns)) {
    for (const c of src.columns) {
      if (!isRecord(c) || typeof c.key !== 'string') continue;
      const headers: TemplateColumn['headers'] = {};
      if (isRecord(c.headers)) {
        for (const l of ['ar', 'sw', 'en'] as const) {
          const h = str(c.headers[l]);
          if (h) headers[l] = h;
        }
      }
      columns.push({
        key: c.key,
        header: str(c.header) ?? c.key,
        headers,
        required: c.required === true,
        kind: typeof c.kind === 'string' ? c.kind : 'text',
        example: c.example === undefined || c.example === null ? null : String(c.example),
        allowed: Array.isArray(c.allowed)
          ? c.allowed
              .filter(isRecord)
              .map((a) => ({ code: String(a.code ?? ''), label: String(a.label ?? a.code ?? '') }))
              .filter((a) => a.code !== '')
          : [],
        min: numOrNull(c.min),
        max: numOrNull(c.max),
      });
    }
  }
  const lang =
    typeof src.lang === 'string' && LANGS.has(src.lang) ? (src.lang as ImportLang) : 'ar';
  return {
    version: numOr(src.version, 1),
    lang,
    dir: src.dir === 'rtl' || src.dir === 'ltr' ? src.dir : lang === 'ar' ? 'rtl' : 'ltr',
    maxRows: numOr(src.max_rows, 5000),
    listSeparator: typeof src.list_separator === 'string' ? src.list_separator : '|',
    dateFormat: typeof src.date_format === 'string' ? src.date_format : 'YYYY-MM-DD',
    mergeKey: typeof src.merge_key === 'string' ? src.merge_key : 'external_id',
    columns,
  };
}

export function parseBatch(v: unknown): BatchRow | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  return {
    id: v.id,
    state: typeof v.state === 'string' ? v.state : 'staged',
    sourceKind: typeof v.source_kind === 'string' ? v.source_kind : 'csv',
    fileName: str(v.file_name),
    rowCount: numOr(v.row_count, 0),
    counts: parseCounts(v.stats),
    createdAt: typeof v.created_at === 'string' ? v.created_at : '',
    committedAt: str(v.committed_at),
    rolledBackAt: str(v.rolled_back_at),
  };
}
