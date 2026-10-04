/**
 * Export file production, independent of HTTP and Supabase: pages of `export_rows` (and of
 * `export_staff_rows`) come in through async iterators, bytes go out. Kept separate so that
 * it can be unit-tested.
 *
 * Memory: a page of rows is converted to cells and encoded immediately; nothing but the
 * current page is kept as objects.
 *   - CSV is a byte stream (uploaded while it is produced).
 *   - XLSX is deflated on the fly; only the compressed archive is held until upload.
 */
import { CsvEncoder } from '../_shared/csv.ts';
import {
  exportRow,
  headerRow,
  type Cell,
  type ExportColumn,
  type ExportColumns,
} from '../_shared/labels.ts';
import { XLSX_MAX_ROWS, XlsxWriter } from '../_shared/xlsx.ts';

export type ExportFormat = 'csv' | 'xlsx';

/**
 * What a job exports (`filters.dataset`, validated by `export_request`):
 *   - `projects` (default): one row per project (`export_rows`); an XLSX workbook gets a
 *     second sheet with the staff (`export_staff_rows`) when the caller may see staff;
 *   - `staff`: the staff table alone (one row per current assignment) — the way to get the
 *     staff as CSV, since a CSV file holds one table.
 */
export type ExportDataset = 'projects' | 'staff';

/** `export_columns(lang)` with the staff sheet columns (empty / absent without people scope). */
export interface ExportColumnsWithStaff extends ExportColumns {
  staff_columns?: ExportColumn[];
}

/** The dataset of a job, from its stored filters (anything else counts as projects). */
export function datasetOf(filters: unknown): ExportDataset {
  return typeof filters === 'object' &&
    filters !== null &&
    (filters as Record<string, unknown>).dataset === 'staff'
    ? 'staff'
    : 'projects';
}

/** Staff columns of `export_columns`, or an empty list. */
export function staffColumnsOf(columns: ExportColumnsWithStaff): ExportColumn[] {
  return Array.isArray(columns.staff_columns) ? columns.staff_columns : [];
}

/** The same dictionary with the staff columns as the main column list (staff-only export). */
export function asStaffColumns(columns: ExportColumnsWithStaff): ExportColumns {
  return { ...columns, columns: staffColumnsOf(columns) };
}

/** One page as returned by `export_rows` / `export_staff_rows`. */
export interface ExportPage {
  rows: Array<Record<string, unknown>>;
  done: boolean;
  next: unknown;
}

export type PageFetcher = (after: unknown) => Promise<ExportPage>;

/**
 * Pages of cells (already translated to the job language), following `next` until `done`.
 * `list` selects the column list (default: the projects columns). Empty pages are skipped
 * (the staff pages may be empty while more follow).
 */
export async function* cellPages(
  columns: ExportColumns,
  fetchPage: PageFetcher,
  list: ExportColumn[] = columns.columns,
): AsyncGenerator<Cell[][]> {
  const separator = columns.list_separator ?? ' | ';
  let after: unknown = null;
  for (;;) {
    const page = await fetchPage(after);
    const rows = Array.isArray(page.rows) ? page.rows : [];
    if (rows.length > 0) yield rows.map((r) => exportRow(list, r, columns.enums, separator));
    if (page.done || page.next === null || page.next === undefined) return;
    after = page.next;
  }
}

export interface Progress {
  rows: number;
  bytes: number;
  pages: number;
  /** Rows of the staff sheet of an XLSX workbook (not counted in `rows`). */
  staffRows?: number;
}

/**
 * CSV as a stream: BOM + header first, then one chunk per page. `progress` is updated while
 * the stream is consumed; an error of the page source errors the stream (and is kept in
 * `progress` by the caller's own try/catch around the consumer).
 */
export function csvStream(
  columns: ExportColumns,
  pages: AsyncIterator<Cell[][]>,
  progress: Progress,
  onError?: (e: unknown) => void,
): ReadableStream<Uint8Array> {
  const encoder = new CsvEncoder();
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          const head = encoder.encode([headerRow(columns.columns)]);
          progress.bytes += head.byteLength;
          controller.enqueue(head);
          return;
        }
        const { done, value } = await pages.next();
        if (done) {
          controller.close();
          return;
        }
        const chunk = encoder.encode(value);
        progress.rows += value.length;
        progress.pages += 1;
        progress.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (e) {
        onError?.(e);
        controller.error(e);
      }
    },
    async cancel() {
      await pages.return?.(undefined);
    },
  });
}

/** Whole CSV in memory (chunks), for uploads that cannot stream. */
export async function csvChunks(
  columns: ExportColumns,
  pages: AsyncIterator<Cell[][]>,
  progress: Progress,
): Promise<Uint8Array[]> {
  const reader = csvStream(columns, pages, progress, undefined).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

export const PROJECT_SHEET_NAMES: Record<string, string> = {
  ar: 'المشاريع',
  sw: 'Miradi',
  en: 'Projects',
};
export const STAFF_SHEET_NAMES: Record<string, string> = {
  ar: 'الكادر',
  sw: 'Wafanyakazi',
  en: 'Staff',
};

function localName(names: Record<string, string>, lang: string): string {
  return names[lang] ?? names.en!;
}

function columnWidth(kind: string, header: string): number {
  const base = Math.ceil(header.length * 1.3) + 4;
  switch (kind) {
    case 'list':
      return Math.max(base, 40);
    case 'text':
      return Math.max(base, 18);
    case 'datetime':
      return Math.max(base, 22);
    default:
      return Math.max(base, 12);
  }
}

function sheetColumns(list: ExportColumn[]): Array<{ header: string; width: number }> {
  return list.map((c) => ({ header: c.header, width: columnWidth(c.kind, c.header) }));
}

export type XlsxOutcome =
  | { overflow: false; chunks: Uint8Array[]; size: number; truncatedCells: number }
  /** More rows than `maxRows` (in any sheet): nothing usable was produced, fall back to CSV. */
  | { overflow: true; sheet: 'main' | 'staff' };

export interface XlsxExportOptions {
  /** Name of the first sheet (default: «المشاريع» / Miradi / Projects). */
  sheetName?: string;
  /**
   * Second sheet: the staff table (`columns.staff_columns`), filled after the first sheet.
   * Ignored when there are no staff columns.
   */
  staff?: AsyncIterator<Cell[][]>;
}

/**
 * XLSX workbook (header rows frozen, right-to-left sheets when `columns.dir` is rtl).
 * Stops and reports `overflow` as soon as a sheet exceeds `maxRows` rows.
 */
export async function buildXlsxExport(
  columns: ExportColumnsWithStaff,
  pages: AsyncIterator<Cell[][]>,
  progress: Progress,
  maxRows: number,
  options: XlsxExportOptions = {},
): Promise<XlsxOutcome> {
  const limit = Math.min(maxRows, XLSX_MAX_ROWS - 1);
  const rtl = columns.dir === 'rtl';
  const writer = new XlsxWriter({
    sheetName: options.sheetName ?? localName(PROJECT_SHEET_NAMES, columns.lang),
    rtl,
    columns: sheetColumns(columns.columns),
  });
  const abandon = async (sheet: 'main' | 'staff'): Promise<XlsxOutcome> => {
    await pages.return?.(undefined);
    await options.staff?.return?.(undefined);
    await writer.finish().catch(() => undefined); // release the deflate streams
    return { overflow: true, sheet };
  };

  for (;;) {
    const { done, value } = await pages.next();
    if (done) break;
    if (progress.rows + value.length > limit) return abandon('main');
    await writer.addRows(value);
    progress.rows += value.length;
    progress.pages += 1;
  }

  const staffList = staffColumnsOf(columns);
  if (options.staff && staffList.length > 0) {
    const sheet = writer.addSheet({
      sheetName: localName(STAFF_SHEET_NAMES, columns.lang),
      rtl,
      columns: sheetColumns(staffList),
    });
    progress.staffRows = 0;
    for (;;) {
      const { done, value } = await options.staff.next();
      if (done) break;
      if (progress.staffRows + value.length > limit) return abandon('staff');
      await sheet.addRows(value);
      progress.staffRows += value.length;
      progress.pages += 1;
    }
  }

  const result = await writer.finish();
  progress.bytes = result.size;
  return {
    overflow: false,
    chunks: result.chunks,
    size: result.size,
    truncatedCells: result.truncatedCells,
  };
}

/**
 * `istiqama-projects-20261003-1a2b3c4d.csv` (or `istiqama-staff-…` for a staff export) —
 * ASCII only, safe in Content-Disposition.
 */
export function exportFileName(
  jobId: string,
  extension: string,
  now = new Date(),
  dataset: ExportDataset = 'projects',
): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `istiqama-${dataset}-${day}-${jobId.replace(/-/g, '').slice(-8)}.${extension}`;
}
