/**
 * Export cells: translate enum codes and booleans through the `enums` dictionary returned by
 * `export_columns(lang)` and normalise every value to a spreadsheet cell.
 *
 * Contract (docs/contracts/reports-import-export.md §4): header = `columns[].header`; cell =
 * `row[key]`; for `kind = "enum" | "boolean"` translate through
 * `enums[column.enum][String(value)]`; `null` → empty cell.
 */

export type ColumnKind =
  | 'text'
  | 'integer'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'enum'
  | 'list';

export interface ExportColumn {
  key: string;
  header: string;
  kind: ColumnKind | string;
  enum?: string;
}

export type EnumDictionary = Record<string, Record<string, string>>;

export interface ExportColumns {
  lang: string;
  dir: 'rtl' | 'ltr';
  list_separator?: string;
  capabilities?: { people?: boolean; restricted?: boolean };
  columns: ExportColumn[];
  enums: EnumDictionary;
}

/** A cell as the writers accept it: text, a finite number, or empty. */
export type Cell = string | number | null;

/** Label of an enum / boolean code; the code itself when the dictionary has no entry. */
export function translateCode(enums: EnumDictionary, enumKey: string | undefined, value: unknown): string {
  const code = String(value);
  if (!enumKey) return code;
  const labels = enums[enumKey];
  if (!labels || !Object.prototype.hasOwnProperty.call(labels, code)) return code;
  const label = labels[code];
  return typeof label === 'string' && label !== '' ? label : code;
}

function plain(value: unknown, separator: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (Array.isArray(value)) return value.map((v) => plain(v, separator)).join(separator);
  return JSON.stringify(value) ?? '';
}

/** One cell of the export file for `column`, in the job language. */
export function exportCell(
  column: ExportColumn,
  value: unknown,
  enums: EnumDictionary,
  listSeparator = ' | ',
): Cell {
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case 'enum':
      return translateCode(enums, column.enum, value);
    case 'boolean':
      return translateCode(enums, column.enum ?? 'boolean', value);
    case 'integer':
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        // numeric columns that PostgREST serialised as text (huge numerics): keep the digits
        const n = Number(value);
        return Number.isSafeInteger(n) || /\./.test(value) ? n : value.trim();
      }
      return plain(value, listSeparator);
    default:
      return plain(value, listSeparator);
  }
}

export function headerRow(columns: ExportColumn[]): string[] {
  return columns.map((c) => c.header);
}

/** Cells of one `export_rows` row, in column order. */
export function exportRow(
  columns: ExportColumn[],
  row: Record<string, unknown>,
  enums: EnumDictionary,
  listSeparator = ' | ',
): Cell[] {
  const out: Cell[] = new Array<Cell>(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    out[i] = exportCell(column, row[column.key], enums, listSeparator);
  }
  return out;
}
