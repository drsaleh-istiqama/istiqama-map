/**
 * Turns a parsed table (rows of cells; first non-empty row = header) into the array of
 * objects `import_stage` expects: one object per data row, keyed by the header cells.
 * Works for both CSV (all strings) and XLSX (strings, numbers, booleans).
 */
import { unguardFormula } from './csv.ts';

export type TableCell = string | number | boolean | null | undefined;
export type RowObject = Record<string, string | number | boolean>;

export interface TableObjects {
  /** Header names in column order (unnamed and duplicate columns left out). */
  headers: string[];
  rows: RowObject[];
  /** Row number in the source file (1-based) of every element of `rows`. */
  sourceRows: number[];
  /** Row number of the header in the source file; 0 when the table is empty. */
  headerRow: number;
  skippedBlankRows: number;
  /** Header names that occur more than once (the first column wins). */
  duplicateHeaders: string[];
  /** Columns that carry data but have no header cell (ignored). */
  unnamedColumns: number;
}

function charClass(codes: Array<number | [number, number]>): string {
  return codes
    .map((c) =>
      Array.isArray(c)
        ? `\\u{${c[0].toString(16)}}-\\u{${c[1].toString(16)}}`
        : `\\u{${c.toString(16)}}`,
    )
    .join('');
}

// BOM, zero-width space, direction marks and embeddings: invisible, and common in headers
// copied from right-to-left documents.
const INVISIBLE = new RegExp(
  `[${charClass([0xfeff, 0x200b, 0x200e, 0x200f, [0x202a, 0x202e], [0x2066, 0x2069]])}]`,
  'gu',
);

// Never usable as object keys.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function cleanHeader(cell: TableCell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

function cleanValue(cell: TableCell): string | number | boolean | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'boolean') return cell;
  const text = unguardFormula(cell.replace(INVISIBLE, '').trim());
  return text === '' ? null : text;
}

function isBlank(row: TableCell[]): boolean {
  for (const cell of row) if (cleanValue(cell) !== null) return false;
  return true;
}

/**
 * @param table       rows of cells; ragged rows are fine
 * @param rowNumbers  source row number of every table row (default: 1, 2, 3 …)
 */
export function tableToObjects(table: TableCell[][], rowNumbers?: number[]): TableObjects {
  const numberOf = (i: number): number => rowNumbers?.[i] ?? i + 1;
  let h = 0;
  while (h < table.length && isBlank(table[h]!)) h++;
  const empty: TableObjects = {
    headers: [],
    rows: [],
    sourceRows: [],
    headerRow: 0,
    skippedBlankRows: 0,
    duplicateHeaders: [],
    unnamedColumns: 0,
  };
  if (h >= table.length) return empty;

  const headerCells = table[h]!.map(cleanHeader);
  const keys: Array<string | null> = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of headerCells) {
    if (name === '' || FORBIDDEN_KEYS.has(name)) keys.push(null);
    else if (seen.has(name)) {
      duplicates.add(name);
      keys.push(null);
    } else {
      seen.add(name);
      keys.push(name);
    }
  }

  const rows: RowObject[] = [];
  const sourceRows: number[] = [];
  const unnamed = new Set<number>();
  let skipped = 0;
  for (let i = h + 1; i < table.length; i++) {
    const cells = table[i]!;
    const obj: RowObject = {};
    let any = false;
    for (let c = 0; c < cells.length; c++) {
      const value = cleanValue(cells[c]);
      if (value === null) continue;
      const key = keys[c];
      if (key === null || key === undefined) {
        if (headerCells[c] === undefined || headerCells[c] === '') unnamed.add(c);
        continue;
      }
      obj[key] = value;
      any = true;
    }
    if (!any) {
      skipped++;
      continue;
    }
    rows.push(obj);
    sourceRows.push(numberOf(i));
  }
  return {
    headers: keys.filter((k): k is string => k !== null),
    rows,
    sourceRows,
    headerRow: numberOf(h),
    skippedBlankRows: skipped,
    duplicateHeaders: [...duplicates],
    unnamedColumns: unnamed.size,
  };
}
