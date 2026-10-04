/**
 * CSV writing and reading.
 *
 * Writing (brief §9, contract §4): UTF-8 with BOM, RFC 4180 quoting, CRLF line ends, and the
 * v2 formula-injection guard — a TEXT cell that starts with `=`, `+`, `-`, `@` (also after
 * leading white space, as v2 did), a tab or a carriage return is prefixed with an apostrophe
 * so that spreadsheet programs show it instead of evaluating it. Numbers are not text and are
 * written as they are (a latitude of -5.05 stays a number).
 *
 * Reading (brief §10): tolerant RFC 4180 parser (BOM, quoted fields with embedded
 * delimiters / quotes / line breaks, CRLF | LF | CR), `,` `;` or tab as delimiter, UTF-8,
 * UTF-16 (BOM) and — for files saved by Arabic Windows — windows-1256. Nothing is ever
 * evaluated: a cell is text.
 */
import type { Cell } from './labels.ts';

export const BOM = String.fromCharCode(0xfeff);
const TAB = 9;
const LF = 10;
const CR = 13;
const QUOTE = 34;

// "= + - @" and their full-width forms (Excel treats those as formula starters as well).
const FORMULA_STARTERS = new Set<number>([0x3d, 0x2b, 0x2d, 0x40, 0xff1d, 0xff0b, 0xff0d, 0xff20]);

function isSpace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x3000
  );
}

/** True when a spreadsheet program could take `text` for a formula / DDE payload. */
export function looksLikeFormula(text: string): boolean {
  if (text.length === 0) return false;
  const first = text.charCodeAt(0);
  if (first === TAB || first === CR) return true;
  let i = 0;
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i < text.length && FORMULA_STARTERS.has(text.charCodeAt(i));
}

/** The formula-injection guard: prefix an apostrophe when needed. */
export function guardFormula(text: string): string {
  return looksLikeFormula(text) ? `'${text}` : text;
}

/** Inverse of `guardFormula` for re-imported exports: drop the apostrophe we added. */
export function unguardFormula(text: string): string {
  return text.charCodeAt(0) === 0x27 && looksLikeFormula(text.slice(1)) ? text.slice(1) : text;
}

export function csvField(value: Cell | boolean | undefined, delimiter = ','): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = guardFormula(typeof value === 'boolean' ? String(value) : value);
  let needsQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE || c === LF || c === CR || text[i] === delimiter) {
      needsQuotes = true;
      break;
    }
  }
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, terminated by CRLF. */
export function csvLine(cells: ReadonlyArray<Cell | boolean | undefined>, delimiter = ','): string {
  let line = '';
  for (let i = 0; i < cells.length; i++) {
    if (i > 0) line += delimiter;
    line += csvField(cells[i], delimiter);
  }
  return `${line}\r\n`;
}

/** Whole document as a string: BOM + records. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<Cell | boolean | undefined>>): string {
  let out = BOM;
  for (const row of rows) out += csvLine(row);
  return out;
}

/** Incremental encoder for large exports: bytes of the BOM + header, then of each page. */
export class CsvEncoder {
  private readonly encoder = new TextEncoder();
  private started = false;

  encode(rows: ReadonlyArray<ReadonlyArray<Cell | boolean | undefined>>): Uint8Array {
    let text = this.started ? '' : BOM;
    this.started = true;
    for (const row of rows) text += csvLine(row);
    return this.encoder.encode(text);
  }
}

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1256';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

/** Decode the bytes of a text file; the BOM (if any) is removed. */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Not UTF-8: "CSV (comma delimited)" written by Excel on an Arabic Windows.
    try {
      return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'windows-1256' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
    }
  }
}

const DELIMITERS = [',', ';', '\t'] as const;

/**
 * The delimiter of a CSV text: honours Excel's `sep=;` first line, otherwise the candidate
 * that occurs most often outside quotes in the first records.
 */
export function detectDelimiter(text: string): string {
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) return sep[1]!;
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 5 && i < 65_536; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\n') lines++;
      else if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d)!;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export interface CsvParseResult {
  rows: string[][];
  delimiter: string;
  /** Line number (1-based) on which each record starts — for messages about a row. */
  lines: number[];
}

/**
 * Parse CSV text into records of strings. Quotes are special only at the start of a field;
 * a doubled quote inside a quoted field is a literal quote; text after a closing quote is
 * kept (lenient). Completely empty lines are skipped.
 */
export function parseCsv(input: string, opts: { delimiter?: string } = {}): CsvParseResult {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let line = 1;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) {
    text = text.slice(sep[0].length);
    line = 2;
  }
  const delimiter = opts.delimiter ?? (sep ? sep[1]! : detectDelimiter(text));
  const delim = delimiter.charCodeAt(0);

  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = '';
  let rowLine = line;
  let fieldStart = true; // nothing of the current field has been read yet
  let quoted = false; // the current field started with a quote
  let inQuotes = false;
  const n = text.length;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStart = true;
    quoted = false;
  };
  const endRow = (): void => {
    endField();
    if (row.length > 1 || row[0] !== '') {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
  };

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (inQuotes) {
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === LF || (c === CR && text.charCodeAt(i + 1) !== LF)) line++;
        field += text[i];
      }
      continue;
    }
    if (c === QUOTE && fieldStart) {
      inQuotes = true;
      quoted = true;
      fieldStart = false;
    } else if (c === delim) {
      endField();
    } else if (c === LF || c === CR) {
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += text[i];
      fieldStart = false;
    }
  }
  // last record without a trailing line break
  if (field !== '' || row.length > 0 || quoted) endRow();
  return { rows, delimiter, lines };
}
