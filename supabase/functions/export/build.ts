/**
 * Export file production, independent of HTTP and Supabase: pages of `export_rows` come in
 * through an async iterator, bytes go out. Kept separate so that it can be unit-tested.
 *
 * Memory: a page of rows is converted to cells and encoded immediately; nothing but the
 * current page is kept as objects.
 *   - CSV is a byte stream (uploaded while it is produced).
 *   - XLSX is deflated on the fly; only the compressed archive is held until upload.
 */
import { CsvEncoder } from '../_shared/csv.ts';
import { exportRow, headerRow, type Cell, type ExportColumns } from '../_shared/labels.ts';
import { XLSX_MAX_ROWS, XlsxWriter } from '../_shared/xlsx.ts';

export type ExportFormat = 'csv' | 'xlsx';

/** One page as returned by `export_rows`. */
export interface ExportPage {
  rows: Array<Record<string, unknown>>;
  done: boolean;
  next: unknown;
}

export type PageFetcher = (after: unknown) => Promise<ExportPage>;

/** Pages of cells (already translated to the job language), following `next` until `done`. */
export async function* cellPages(
  columns: ExportColumns,
  fetchPage: PageFetcher,
): AsyncGenerator<Cell[][]> {
  const separator = columns.list_separator ?? ' | ';
  let after: unknown = null;
  for (;;) {
    const page = await fetchPage(after);
    const rows = Array.isArray(page.rows) ? page.rows : [];
    if (rows.length > 0)
      yield rows.map((r) => exportRow(columns.columns, r, columns.enums, separator));
    if (page.done || page.next === null || page.next === undefined) return;
    after = page.next;
  }
}

export interface Progress {
  rows: number;
  bytes: number;
  pages: number;
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

const SHEET_NAMES: Record<string, string> = { ar: 'المشاريع', sw: 'Miradi', en: 'Projects' };

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

export type XlsxOutcome =
  | { overflow: false; chunks: Uint8Array[]; size: number; truncatedCells: number }
  /** More rows than `maxRows`: nothing usable was produced, the caller falls back to CSV. */
  | { overflow: true };

/**
 * XLSX workbook (header row frozen, right-to-left sheet when `columns.dir` is rtl).
 * Stops and reports `overflow` as soon as the data exceeds `maxRows` rows.
 */
export async function buildXlsxExport(
  columns: ExportColumns,
  pages: AsyncIterator<Cell[][]>,
  progress: Progress,
  maxRows: number,
): Promise<XlsxOutcome> {
  const limit = Math.min(maxRows, XLSX_MAX_ROWS - 1);
  const writer = new XlsxWriter({
    sheetName: SHEET_NAMES[columns.lang] ?? SHEET_NAMES.en!,
    rtl: columns.dir === 'rtl',
    columns: columns.columns.map((c) => ({
      header: c.header,
      width: columnWidth(c.kind, c.header),
    })),
  });
  for (;;) {
    const { done, value } = await pages.next();
    if (done) break;
    if (progress.rows + value.length > limit) {
      await pages.return?.(undefined);
      await writer.finish().catch(() => undefined); // release the deflate stream
      return { overflow: true };
    }
    await writer.addRows(value);
    progress.rows += value.length;
    progress.pages += 1;
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

/** `istiqama-projects-20261003-1a2b3c4d.csv` — ASCII only, safe in Content-Disposition. */
export function exportFileName(jobId: string, extension: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `istiqama-projects-${day}-${jobId.replace(/-/g, '').slice(-8)}.${extension}`;
}
