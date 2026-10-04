/**
 * Hardened XLSX reader for the import function: first sheet → rows of plain values.
 *
 * Why not the `xlsx` package (SheetJS CE 0.18.5) for reading uploaded files: the npm build
 * has known vulnerabilities when parsing crafted workbooks (prototype pollution
 * CVE-2023-30533, ReDoS CVE-2024-22363) and inflates every part of the archive into memory.
 * This reader only understands what an import needs and enforces limits while it reads:
 *   - ZIP: central directory only, no ZIP64 / encryption, inflated bytes counted (zip bombs);
 *   - the sheet is inflated and scanned as a stream and reading stops at the row limit;
 *   - values only: a formula cell yields its cached value, nothing is ever evaluated;
 *     macros (`vbaProject.bin`) are never opened, their presence is only reported.
 */
import { ZipError, openZipEntry, readZipDirectory, readZipEntry, type ZipEntry } from './zip.ts';

export type SheetCell = string | number | boolean | null;

export type XlsxReadErrorCode =
  | 'not_xlsx'
  | 'encrypted_or_legacy'
  | 'too_large'
  | 'corrupt'
  | 'no_sheet';

export class XlsxReadError extends Error {
  constructor(
    readonly code: XlsxReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

export interface XlsxReadOptions {
  /** Maximum number of non-empty rows returned (header included). */
  maxRows: number;
  /** Cells beyond this column are ignored (default 512). */
  maxColumns?: number;
  /** Cap on the inflated size of the sheet part (default 256 MiB; reading stops earlier at the row limit). */
  maxSheetBytes?: number;
  /** Cap on the inflated size of the shared-strings part (default 64 MiB). */
  maxStringsBytes?: number;
  /** Sheet to read: name or 0-based index. Default: the first visible sheet. */
  sheet?: string | number;
}

export interface XlsxSheet {
  name: string;
  sheetNames: string[];
  rows: SheetCell[][];
  /** Spreadsheet row number (1-based) of each returned row. */
  rowNumbers: number[];
  /** More non-empty rows exist than `maxRows`. */
  truncated: boolean;
  /** Cells beyond `maxColumns` were ignored. */
  columnsTruncated: boolean;
  /** Number of cells that carry a formula (their cached values were used). */
  formulaCells: number;
  hasMacros: boolean;
}

// ------------------------------------------------------------------------------------------
// XML helpers (the parts are machine-written and regular; a scanner is enough)
// ------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  if (text.indexOf('&') < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Excel writes characters XML cannot carry as `_xHHHH_`. */
function decodeExcelEscapes(text: string): string {
  if (text.indexOf('_x') < 0) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

const ATTR_RE = new Map<string, RegExp>();

/** Value of attribute `name` (a literal name or a regex fragment without capture groups). */
function attr(tag: string, name: string): string | undefined {
  let re = ATTR_RE.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    ATTR_RE.set(name, re);
  }
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeXml(m[1] ?? m[2] ?? '');
}

const P = '(?:[A-Za-z_][\\w.-]*:)?'; // optional namespace prefix

const RE_RPH = new RegExp(`<${P}rPh[\\s>][\\s\\S]*?</${P}rPh>`, 'g');
const RE_T = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>`, 'g');
const RE_SI = new RegExp(`<${P}si(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${P}si>)`, 'g');
const RE_V = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>`);
const RE_IS = new RegExp(`<${P}is(?:\\s[^>]*)?>([\\s\\S]*?)</${P}is>`);
const RE_F = new RegExp(`<${P}f[\\s>/]`);
const RE_CELL = new RegExp(`<${P}c(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g');
const RE_ROW_OPEN = new RegExp(`<${P}row[\\s>/]`, 'g');
const RE_ROW_CLOSE = new RegExp(`</${P}row>`, 'g');

/** Text of a string item (`<si>` / `<is>`): all `<t>` runs, phonetic runs excluded. */
function stringItemText(xml: string): string {
  const body = xml.indexOf('rPh') >= 0 ? xml.replace(RE_RPH, '') : xml;
  let text = '';
  RE_T.lastIndex = 0;
  for (let m = RE_T.exec(body); m; m = RE_T.exec(body)) text += m[1];
  return decodeExcelEscapes(decodeXml(text));
}

export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  RE_SI.lastIndex = 0;
  for (let m = RE_SI.exec(xml); m; m = RE_SI.exec(xml)) {
    out.push(m[1] === undefined ? '' : stringItemText(m[1]));
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Number formats: which cell styles are dates
// ------------------------------------------------------------------------------------------

const BUILTIN_DATE_FORMATS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_.|\*./g, '');
  if (/general/i.test(bare)) return false;
  return /[ymdhs]/i.test(bare);
}

/** For every cell style index (`s` attribute): is it a date / time format? */
export function parseDateStyles(stylesXml: string): boolean[] {
  const custom = new Map<number, string>();
  const reFmt = new RegExp(`<${P}numFmt\\s([^>]*?)/?>`, 'g');
  for (let m = reFmt.exec(stylesXml); m; m = reFmt.exec(stylesXml)) {
    const id = Number(attr(m[1]!, 'numFmtId'));
    const code = attr(m[1]!, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const block = new RegExp(`<${P}cellXfs[\\s>][\\s\\S]*?</${P}cellXfs>`).exec(stylesXml);
  if (!block) return [];
  const out: boolean[] = [];
  const reXf = new RegExp(`<${P}xf\\s([^>]*?)/?>`, 'g');
  for (let m = reXf.exec(block[0]); m; m = reXf.exec(block[0])) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? '0');
    const code = custom.get(id);
    out.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Excel serial date → ISO text: `YYYY-MM-DD` for whole days, `HH:MM:SS` for pure times,
 * `YYYY-MM-DDTHH:MM:SS` otherwise. Null when the serial is not a representable date.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465.999) return null;
  const totalSeconds = Math.round(serial * 86_400);
  let days = Math.floor(totalSeconds / 86_400);
  const seconds = totalSeconds - days * 86_400;
  const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  if (days === 0 && !date1904 && seconds > 0) return time;
  if (date1904) days += 1462;
  else if (days < 60) days += 1; // 1900 is not a leap year, Excel pretends it is
  const date = new Date((days - 25_569) * 86_400_000);
  if (Number.isNaN(date.getTime())) return null;
  const ymd = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return seconds === 0 ? ymd : `${ymd}T${time}`;
}

// ------------------------------------------------------------------------------------------
// Workbook structure
// ------------------------------------------------------------------------------------------

interface SheetRef {
  name: string;
  path: string;
  hidden: boolean;
}

function resolveTarget(target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function parseWorkbook(
  workbookXml: string,
  relsXml: string,
): { sheets: SheetRef[]; date1904: boolean; sharedStrings?: string; styles?: string } {
  const rels = new Map<string, { type: string; target: string }>();
  const reRel = new RegExp(`<${P}Relationship\\s([^>]*?)/?>`, 'g');
  for (let m = reRel.exec(relsXml); m; m = reRel.exec(relsXml)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) rels.set(id, { type: attr(m[1]!, 'Type') ?? '', target });
  }
  const sheets: SheetRef[] = [];
  const reSheet = new RegExp(`<${P}sheet\\s([^>]*?)/?>`, 'g');
  for (let m = reSheet.exec(workbookXml); m; m = reSheet.exec(workbookXml)) {
    const tag = m[1]!;
    const name = attr(tag, 'name') ?? '';
    const rid = attr(tag, '(?:[A-Za-z_][\\w.-]*:)?id');
    const rel = rid ? rels.get(rid) : undefined;
    if (!rel || !/\/worksheet$/.test(rel.type)) continue; // chart sheets, macro sheets…
    const state = attr(tag, 'state');
    sheets.push({ name, path: resolveTarget(rel.target), hidden: state !== undefined && state !== 'visible' });
  }
  const pr = new RegExp(`<${P}workbookPr\\s([^>]*?)/?>`).exec(workbookXml);
  const d1904 = pr ? attr(pr[1]!, 'date1904') : undefined;
  let sharedStrings: string | undefined;
  let styles: string | undefined;
  for (const rel of rels.values()) {
    if (/\/sharedStrings$/.test(rel.type)) sharedStrings = resolveTarget(rel.target);
    else if (/\/styles$/.test(rel.type)) styles = resolveTarget(rel.target);
  }
  return { sheets, date1904: d1904 === '1' || d1904 === 'true', sharedStrings, styles };
}

function columnIndex(ref: string): number {
  let n = 0;
  let seen = false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i) & ~0x20; // upper case
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
    seen = true;
  }
  return seen ? n - 1 : -1;
}

interface RowContext {
  strings: string[];
  dateStyles: boolean[];
  date1904: boolean;
  maxColumns: number;
  stats: { formulaCells: number; columnsTruncated: boolean };
}

/** Values of one `<row>` element body; null when the row has no value at all. */
function parseRow(body: string, ctx: RowContext): SheetCell[] | null {
  const cells: SheetCell[] = [];
  let position = -1;
  let any = false;
  RE_CELL.lastIndex = 0;
  for (let m = RE_CELL.exec(body); m; m = RE_CELL.exec(body)) {
    const attrs = m[1] ?? '';
    const inner = m[2];
    const ref = attr(attrs, 'r');
    const col = ref ? columnIndex(ref) : -1;
    position = col >= 0 ? col : position + 1;
    if (inner === undefined) continue; // empty, styled cell
    if (position >= ctx.maxColumns) {
      ctx.stats.columnsTruncated = true;
      continue;
    }
    if (RE_F.test(inner)) ctx.stats.formulaCells++;
    const type = attr(attrs, 't') ?? 'n';
    let value: SheetCell;
    if (type === 'inlineStr') {
      const is = RE_IS.exec(inner);
      value = is ? stringItemText(is[1]!) : null;
    } else {
      const v = RE_V.exec(inner);
      const raw = v ? v[1]! : null;
      if (raw === null) value = null;
      else if (type === 's') value = ctx.strings[Number(raw)] ?? null;
      else if (type === 'str') value = decodeExcelEscapes(decodeXml(raw));
      else if (type === 'b') value = raw.trim() === '1' || raw.trim().toLowerCase() === 'true';
      else if (type === 'e') value = null; // #N/A, #REF!… are not data
      else if (type === 'd') value = decodeXml(raw).replace(/T00:00:00(?:\.0+)?Z?$/, '');
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) value = decodeXml(raw);
        else if (ctx.dateStyles[Number(attr(attrs, 's') ?? '0')] === true)
          value = excelSerialToIso(n, ctx.date1904) ?? n;
        else value = n;
      }
    }
    if (value === null || value === '') continue;
    while (cells.length < position) cells.push(null);
    cells[position] = value;
    any = true;
  }
  return any ? cells : null;
}

function wrapZipError(e: unknown): never {
  if (e instanceof XlsxReadError) throw e;
  if (e instanceof ZipError) {
    if (e.code === 'too_large') throw new XlsxReadError('too_large', e.message);
    if (e.code === 'encrypted') throw new XlsxReadError('encrypted_or_legacy', e.message);
    if (e.code === 'not_a_zip') throw new XlsxReadError('not_xlsx', e.message);
    throw new XlsxReadError('corrupt', e.message);
  }
  throw new XlsxReadError('corrupt', e instanceof Error ? e.message : String(e));
}

async function readPart(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8').decode(await readZipEntry(bytes, entry, maxBytes));
}

/** Read one sheet of an XLSX workbook as rows of values. */
export async function readXlsx(bytes: Uint8Array, opts: XlsxReadOptions): Promise<XlsxSheet> {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new XlsxReadError(
      'encrypted_or_legacy',
      'password-protected workbooks and the legacy .xls format are not supported',
    );
  try {
    const entries = readZipDirectory(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const workbookEntry = byName.get('xl/workbook.xml');
    if (!workbookEntry) throw new XlsxReadError('not_xlsx', 'xl/workbook.xml is missing');
    const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
    const SMALL = 8 * 1024 * 1024;
    const workbookXml = await readPart(bytes, workbookEntry, SMALL);
    const relsXml = relsEntry ? await readPart(bytes, relsEntry, SMALL) : '';
    const wb = parseWorkbook(workbookXml, relsXml);
    if (wb.sheets.length === 0) throw new XlsxReadError('no_sheet', 'the workbook has no worksheet');

    let chosen: SheetRef | undefined;
    if (typeof opts.sheet === 'number') chosen = wb.sheets[opts.sheet];
    else if (typeof opts.sheet === 'string') chosen = wb.sheets.find((s) => s.name === opts.sheet);
    else chosen = wb.sheets.find((s) => !s.hidden) ?? wb.sheets[0];
    if (!chosen) throw new XlsxReadError('no_sheet', 'the requested sheet does not exist');
    const sheetEntry = byName.get(chosen.path);
    if (!sheetEntry) throw new XlsxReadError('corrupt', `sheet part ${chosen.path} is missing`);

    const stringsEntry = byName.get(wb.sharedStrings ?? 'xl/sharedStrings.xml');
    const strings = stringsEntry
      ? parseSharedStrings(await readPart(bytes, stringsEntry, opts.maxStringsBytes ?? 64 * 1024 * 1024))
      : [];
    const stylesEntry = byName.get(wb.styles ?? 'xl/styles.xml');
    const dateStyles = stylesEntry ? parseDateStyles(await readPart(bytes, stylesEntry, SMALL * 2)) : [];

    const stats = { formulaCells: 0, columnsTruncated: false };
    const ctx: RowContext = {
      strings,
      dateStyles,
      date1904: wb.date1904,
      maxColumns: opts.maxColumns ?? 512,
      stats,
    };
    const rows: SheetCell[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;
    let lastRowNumber = 0;

    const reader = openZipEntry(bytes, sheetEntry, opts.maxSheetBytes ?? 256 * 1024 * 1024).getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finished = false;

    /** Consume every complete row in `buffer`; returns false when reading can stop. */
    const drain = (): boolean => {
      let cursor = 0;
      for (;;) {
        RE_ROW_OPEN.lastIndex = cursor;
        const open = RE_ROW_OPEN.exec(buffer);
        if (!open) {
          // keep a short tail: a "<row" may be split across chunks
          buffer = buffer.slice(Math.max(cursor, buffer.length - 64));
          return true;
        }
        const tagEnd = buffer.indexOf('>', open.index);
        if (tagEnd < 0) {
          buffer = buffer.slice(open.index);
          return true;
        }
        const tag = buffer.slice(open.index, tagEnd + 1);
        let body = '';
        let next: number;
        if (tag.endsWith('/>')) next = tagEnd + 1;
        else {
          RE_ROW_CLOSE.lastIndex = tagEnd + 1;
          const close = RE_ROW_CLOSE.exec(buffer);
          if (!close) {
            buffer = buffer.slice(open.index);
            return true;
          }
          body = buffer.slice(tagEnd + 1, close.index);
          next = close.index + close[0].length;
        }
        cursor = next;
        const declared = Number(attr(tag, 'r'));
        lastRowNumber = Number.isInteger(declared) && declared > 0 ? declared : lastRowNumber + 1;
        if (body === '') continue;
        const cells = parseRow(body, ctx);
        if (!cells) continue;
        if (rows.length >= opts.maxRows) {
          truncated = true;
          return false;
        }
        rows.push(cells);
        rowNumbers.push(lastRowNumber);
      }
    };

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        finished = true;
      } else buffer += decoder.decode(value, { stream: true });
      if (!drain()) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }

    return {
      name: chosen.name,
      sheetNames: wb.sheets.map((s) => s.name),
      rows,
      rowNumbers,
      truncated,
      columnsTruncated: stats.columnsTruncated,
      formulaCells: stats.formulaCells,
      hasMacros: entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name)),
    };
  } catch (e) {
    wrapZipError(e);
  }
}
