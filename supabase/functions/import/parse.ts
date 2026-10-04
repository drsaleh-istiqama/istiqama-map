/**
 * Import file → rows for `import_stage` (docs/contracts/reports-import-export.md §5).
 *
 * CSV (BOM, quoted fields, Arabic, `,` `;` or tab) or XLSX (first visible sheet); the first
 * non-empty row is the header, every further non-empty row becomes an object keyed by the
 * header cells. Cells are data only: formulas are never evaluated (an XLSX formula cell
 * contributes its cached value), macros are never opened.
 */
import { decodeText, parseCsv } from '../_shared/csv.ts';
import { errors, type HttpError } from '../_shared/http.ts';
import { tableToObjects, type RowObject, type TableCell } from '../_shared/table.ts';
import { XlsxReadError, readXlsx } from '../_shared/xlsx-read.ts';
import { isZip } from '../_shared/zip.ts';

export type ImportKind = 'csv' | 'xlsx';

export interface ImportFileInfo {
  kind: ImportKind;
  /** Header cells that are used as keys, in file order. */
  headers: string[];
  /** Row number of the header in the file (1-based). */
  header_row: number;
  /** Number of data rows sent to `import_stage` (`row_no` 1…rows). */
  rows: number;
  skipped_blank_rows: number;
  /**
   * File row number of every data row (`source_rows[row_no - 1]`), only present when it is
   * not simply `header_row + row_no` (blank rows were skipped).
   */
  source_rows?: number[];
  sheet?: string;
  sheets?: string[];
  encoding?: string;
  delimiter?: string;
  /** Machine-readable notes: translate by code. */
  warnings: string[];
}

export interface ParsedImport {
  rows: RowObject[];
  info: ImportFileInfo;
}

export interface ParseOptions {
  maxRows: number;
  sheet?: string | number;
  delimiter?: string;
}

function isLegacyOrEncrypted(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

function tooManyRows(max: number, found?: number): HttpError {
  return errors.validation(
    'too_many_rows',
    found === undefined
      ? `The file has more than ${max} data rows (maximum ${max} per batch).`
      : `The file has ${found} data rows (maximum ${max} per batch).`,
  );
}

function finish(
  kind: ImportKind,
  table: TableCell[][],
  rowNumbers: number[] | undefined,
  maxRows: number,
  extra: Partial<ImportFileInfo>,
  warnings: string[],
): ParsedImport {
  const t = tableToObjects(table, rowNumbers);
  if (t.headerRow === 0) throw errors.validation('empty_file', 'The file contains no rows.');
  if (t.headers.length === 0)
    throw errors.validation('no_header_row', 'The first row has no column titles.');
  if (t.rows.length === 0)
    throw errors.validation('empty_file', 'The file has a header row but no data rows.');
  if (t.rows.length > maxRows) throw tooManyRows(maxRows, t.rows.length);
  if (t.duplicateHeaders.length > 0) warnings.push('duplicate_headers');
  if (t.unnamedColumns > 0) warnings.push('unnamed_columns');
  if (t.skippedBlankRows > 0) warnings.push('blank_rows_skipped');
  const contiguous = t.sourceRows.every((n, i) => n === t.headerRow + i + 1);
  return {
    rows: t.rows,
    info: {
      kind,
      headers: t.headers,
      header_row: t.headerRow,
      rows: t.rows.length,
      skipped_blank_rows: t.skippedBlankRows,
      ...(contiguous ? {} : { source_rows: t.sourceRows }),
      ...extra,
      warnings,
    },
  };
}

export async function parseImportFile(
  bytes: Uint8Array,
  opts: ParseOptions,
): Promise<ParsedImport> {
  if (bytes.byteLength === 0) throw errors.validation('empty_file', 'The file is empty.');
  if (isLegacyOrEncrypted(bytes))
    throw errors.unsupportedMedia(
      'unsupported_file_type',
      'Legacy .xls files and password-protected workbooks are not supported. Save the file as .xlsx or .csv.',
    );

  if (isZip(bytes)) {
    const warnings: string[] = [];
    // header + data rows + a margin for rows that only hold white space
    const slack = 200;
    let sheet;
    try {
      sheet = await readXlsx(bytes, { maxRows: opts.maxRows + 1 + slack, sheet: opts.sheet });
    } catch (e) {
      if (!(e instanceof XlsxReadError)) throw e;
      switch (e.code) {
        case 'too_large':
          throw errors.tooLarge('file_too_large', 'The workbook is too large when unpacked.');
        case 'not_xlsx':
        case 'encrypted_or_legacy':
          throw errors.unsupportedMedia(
            'unsupported_file_type',
            'Only .xlsx and .csv files can be imported.',
          );
        case 'no_sheet':
          throw errors.validation('no_sheet', e.message);
        default:
          throw errors.validation('invalid_file', 'The workbook cannot be read (damaged file?).');
      }
    }
    if (sheet.truncated) throw tooManyRows(opts.maxRows);
    if (sheet.formulaCells > 0) warnings.push('formulas_ignored');
    if (sheet.hasMacros) warnings.push('macros_ignored');
    if (sheet.columnsTruncated) warnings.push('columns_truncated');
    return finish(
      'xlsx',
      sheet.rows,
      sheet.rowNumbers,
      opts.maxRows,
      { sheet: sheet.name, sheets: sheet.sheetNames },
      warnings,
    );
  }

  const warnings: string[] = [];
  const decoded = decodeText(bytes);
  if (decoded.text.indexOf(String.fromCharCode(0)) >= 0)
    throw errors.unsupportedMedia(
      'unsupported_file_type',
      'Only .xlsx and .csv files can be imported.',
    );
  if (decoded.encoding === 'windows-1256') warnings.push('encoding_windows_1256');
  const csv = parseCsv(decoded.text, { delimiter: opts.delimiter });
  if (csv.rows.length > opts.maxRows * 2 + 1000) throw tooManyRows(opts.maxRows);
  return finish(
    'csv',
    csv.rows,
    csv.lines,
    opts.maxRows,
    { encoding: decoded.encoding, delimiter: csv.delimiter === '\t' ? 'tab' : csv.delimiter },
    warnings,
  );
}
