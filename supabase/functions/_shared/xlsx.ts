/**
 * Streaming XLSX (SpreadsheetML) writer for the export function.
 *
 * Why not the `xlsx` package (SheetJS CE 0.18.5) for writing:
 *   - it cannot freeze panes (the header row must stay visible, brief §9);
 *   - it keeps one object per cell in memory (100,000 projects x 85 columns does not fit in
 *     an Edge Function worker);
 * so the workbook is written directly: the sheet XML is produced page by page and deflated
 * on the fly (`_shared/zip.ts`), memory use is the size of the COMPRESSED file.
 * The unit tests read the result back with SheetJS and with `_shared/xlsx-read.ts`.
 *
 * Layout: one sheet; row 1 = bold header, frozen; right-to-left sheet view for Arabic;
 * text as inline strings (never formulas), numbers as numbers. Text cells get the same
 * formula-injection guard as the CSV export, so a file that is later saved as CSV stays safe.
 */
import { guardFormula } from './csv.ts';
import type { Cell } from './labels.ts';
import { ZipEntryStream, ZipWriter } from './zip.ts';

/** Excel limits. */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_CELL_CHARS = 32_767;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Characters that XML 1.0 cannot carry (C0 controls except tab, LF, CR; U+FFFE, U+FFFF). */
function isInvalidXmlChar(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

/** Escape text for an XML text node or attribute value; invalid characters are dropped. */
export function xmlEscape(text: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep: string | null = null;
    if (c === 0x26) rep = '&amp;';
    else if (c === 0x3c) rep = '&lt;';
    else if (c === 0x3e) rep = '&gt;';
    else if (c === 0x22) rep = '&quot;';
    else if (c === 0x0d) rep = text.charCodeAt(i + 1) === 0x0a ? '' : '\n';
    else if (isInvalidXmlChar(c)) rep = '';
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++; // valid pair: keep both
      else rep = String.fromCharCode(0xfffd);
    } else if (c >= 0xdc00 && c <= 0xdfff) rep = String.fromCharCode(0xfffd);
    if (rep !== null) {
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** Sheet names: at most 31 characters, none of `[ ] : * ? / \`, not empty, no edge quotes. */
export function safeSheetName(name: string): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31);
  return cleaned === '' ? 'Sheet1' : cleaned;
}

export interface XlsxColumn {
  header: string;
  /** Column width in characters; derived from the header when omitted. */
  width?: number;
}

export interface XlsxOptions {
  sheetName: string;
  /** Right-to-left sheet (Arabic): column A is on the right. */
  rtl: boolean;
  columns: XlsxColumn[];
}

export interface XlsxResult {
  chunks: Uint8Array[];
  size: number;
  /** Data rows written (the header is not counted). */
  rows: number;
  /** Cells whose text was cut at Excel's 32,767 character limit. */
  truncatedCells: number;
}

export class XlsxWriter {
  private readonly encoder = new TextEncoder();
  private readonly sheet = new ZipEntryStream('xl/worksheets/sheet1.xml');
  private readonly columnNames: string[];
  private rowNumber = 0;
  private truncated = 0;
  private started = false;
  private closed = false;

  constructor(private readonly opts: XlsxOptions) {
    if (opts.columns.length === 0 || opts.columns.length > XLSX_MAX_COLUMNS)
      throw new RangeError('an XLSX sheet needs 1…16384 columns');
    this.columnNames = opts.columns.map((_c, i) => columnName(i));
  }

  /** Data rows written so far. */
  get rows(): number {
    return Math.max(0, this.rowNumber - 1);
  }

  private cellXml(ref: string, value: Cell | boolean | undefined, style: number): string {
    if (value === null || value === undefined) return '';
    const s = style ? ` s="${style}"` : '';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
    }
    let text = guardFormula(typeof value === 'boolean' ? String(value) : value);
    if (text === '') return '';
    if (text.length > XLSX_MAX_CELL_CHARS) {
      text = text.slice(0, XLSX_MAX_CELL_CHARS - 1) + String.fromCharCode(0x2026);
      this.truncated++;
    }
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  }

  private rowXml(cells: ReadonlyArray<Cell | boolean | undefined>, style: number): string {
    if (this.rowNumber >= XLSX_MAX_ROWS) throw new RangeError('XLSX row limit exceeded');
    const r = ++this.rowNumber;
    let xml = `<row r="${r}">`;
    const n = Math.min(cells.length, this.columnNames.length);
    for (let i = 0; i < n; i++) xml += this.cellXml(`${this.columnNames[i]}${r}`, cells[i], style);
    return `${xml}</row>`;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const cols = this.opts.columns
      .map((c, i) => {
        const width = Math.min(60, Math.max(8, c.width ?? Math.ceil(c.header.length * 1.3) + 4));
        return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
      })
      .join('');
    const head =
      XML_HEADER +
      `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<sheetViews><sheetView workbookViewId="0"${this.opts.rtl ? ' rightToLeft="1"' : ''}>` +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols>` +
      '<sheetData>' +
      this.rowXml(
        this.opts.columns.map((c) => c.header),
        1,
      );
    await this.sheet.write(this.encoder.encode(head));
  }

  /** Append data rows (one array of cells per row, in column order). */
  async addRows(rows: ReadonlyArray<ReadonlyArray<Cell | boolean | undefined>>): Promise<void> {
    if (this.closed) throw new Error('workbook already finished');
    await this.start();
    // Encode in slices so that one page never builds a single enormous string.
    let xml = '';
    for (const row of rows) {
      xml += this.rowXml(row, 0);
      if (xml.length > 262_144) {
        await this.sheet.write(this.encoder.encode(xml));
        xml = '';
      }
    }
    if (xml !== '') await this.sheet.write(this.encoder.encode(xml));
  }

  /** Close the sheet and assemble the archive. */
  async finish(): Promise<XlsxResult> {
    if (this.closed) throw new Error('workbook already finished');
    await this.start();
    this.closed = true;
    await this.sheet.write(this.encoder.encode('</sheetData></worksheet>'));

    const sheetName = xmlEscape(safeSheetName(this.opts.sheetName));
    const zip = new ZipWriter();
    await zip.add(
      '[Content_Types].xml',
      XML_HEADER +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    );
    await zip.add(
      '_rels/.rels',
      XML_HEADER +
        `<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    );
    await zip.add(
      'xl/workbook.xml',
      XML_HEADER +
        `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
        '<bookViews><workbookView/></bookViews>' +
        `<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    );
    await zip.add(
      'xl/_rels/workbook.xml.rels',
      XML_HEADER +
        `<Relationships xmlns="${NS_PKG_REL}">` +
        `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
        '</Relationships>',
    );
    await zip.add(
      'xl/styles.xml',
      XML_HEADER +
        `<styleSheet xmlns="${NS_MAIN}">` +
        '<fonts count="2">' +
        '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '</fonts>' +
        '<fills count="2">' +
        '<fill><patternFill patternType="none"/></fill>' +
        '<fill><patternFill patternType="gray125"/></fill>' +
        '</fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    );
    await zip.addStream(this.sheet);
    const { chunks, size } = zip.finish();
    return { chunks, size, rows: this.rows, truncatedCells: this.truncated };
  }
}

/** Convenience for small workbooks (and tests): header + rows → bytes. */
export async function buildXlsx(
  opts: XlsxOptions,
  rows: ReadonlyArray<ReadonlyArray<Cell | boolean | undefined>>,
): Promise<Uint8Array> {
  const writer = new XlsxWriter(opts);
  await writer.addRows(rows);
  const { chunks, size } = await writer.finish();
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
