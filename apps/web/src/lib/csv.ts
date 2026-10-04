/**
 * CSV writer for client-side exports (import template, small lists). Same guarantees as
 * v2's `projectsToCsv`: UTF-8 byte-order mark so that Excel detects the encoding, RFC 4180
 * quoting with CRLF line ends, and neutralised spreadsheet formulas.
 */

/** U+FEFF, written as a code so no tool can drop or duplicate the invisible character. */
export const CSV_BOM = String.fromCharCode(0xfeff);

const NEEDS_QUOTES = /[",\r\n]/;
/**
 * A text cell is treated as a formula by Excel / LibreOffice / Google Sheets when its first
 * significant character is one of `= + - @` (also after leading white space), or when it
 * starts with a tab or carriage return (OWASP "CSV injection").
 */
const FORMULA_START = /^(?:\s*[=+\-@]|[\t\r])/;

function cellText(value: unknown): { text: string; guard: boolean } {
  if (value === null || value === undefined) return { text: '', guard: false };
  switch (typeof value) {
    case 'number':
      // Real numbers cannot carry a formula; "-5.05" must stay numeric for spreadsheets.
      return { text: Number.isFinite(value) ? String(value) : '', guard: false };
    case 'bigint':
      return { text: value.toString(), guard: false };
    case 'boolean':
      return { text: value ? 'true' : 'false', guard: false };
    case 'string':
      return { text: value, guard: true };
    default:
      break;
  }
  if (value instanceof Date) {
    return { text: Number.isNaN(value.getTime()) ? '' : value.toISOString(), guard: false };
  }
  if (Array.isArray(value)) {
    // Multi-choice answers stay readable in one cell (v2 behaviour).
    return { text: value.map((v) => cellText(v).text).join(' | '), guard: true };
  }
  try {
    return { text: JSON.stringify(value) ?? '', guard: true };
  } catch {
    return { text: String(value), guard: true };
  }
}

/** One CSV field: formula guard first, then quoting. */
export function csvCell(value: unknown): string {
  const cell = cellText(value);
  let text = cell.text;
  if (cell.guard && FORMULA_START.test(text)) text = "'" + text;
  return NEEDS_QUOTES.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * Serialises rows (first row = header) to CSV text starting with a UTF-8 BOM.
 * Rows are joined with CRLF; there is no trailing line break.
 */
export function toCsv(rows: unknown[][]): string {
  return CSV_BOM + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
