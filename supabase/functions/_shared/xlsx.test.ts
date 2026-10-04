import { describe, expect, it } from 'vitest';
import * as XLSXNS from 'xlsx';
import { readXlsx } from './xlsx-read.ts';
import {
  XLSX_MAX_CELL_CHARS,
  XlsxWriter,
  buildXlsx,
  columnName,
  safeSheetName,
  xmlEscape,
} from './xlsx.ts';
import { readZipDirectory, readZipEntry } from './zip.ts';

const XLSX: typeof XLSXNS = (XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS;

async function sheetXml(bytes: Uint8Array): Promise<string> {
  const entry = readZipDirectory(bytes).find((e) => e.name === 'xl/worksheets/sheet1.xml')!;
  return new TextDecoder().decode(await readZipEntry(bytes, entry, 50_000_000));
}

const COLUMNS = [
  { header: 'رمز المشروع' },
  { header: 'النوع' },
  { header: 'السعة' },
  { header: 'ملاحظة' },
];

describe('helpers', () => {
  it('columnName', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'XFD',
    ]);
  });

  it('safeSheetName', () => {
    expect(safeSheetName('المشاريع')).toBe('المشاريع');
    expect(safeSheetName('a/b:c*d?e[f]g\\h')).toBe('a b c d e f g h');
    expect(safeSheetName("'quoted'")).toBe('quoted');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(safeSheetName('  ')).toBe('Sheet1');
  });

  it('xmlEscape escapes markup and drops characters XML cannot carry', () => {
    expect(xmlEscape('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
    expect(
      xmlEscape(
        `a${String.fromCharCode(0)}b${String.fromCharCode(8)}c${String.fromCharCode(0x1f)}d`,
      ),
    ).toBe('abcd');
    expect(xmlEscape(`line1\r\nline2\rline3`)).toBe('line1\nline2\nline3');
    expect(xmlEscape(`ok ${String.fromCodePoint(0x1f54c)}`)).toBe(
      `ok ${String.fromCodePoint(0x1f54c)}`,
    );
    expect(xmlEscape(`lone ${String.fromCharCode(0xd83d)} surrogate`)).toBe(
      `lone ${String.fromCharCode(0xfffd)} surrogate`,
    );
    expect(xmlEscape('مسجد النور')).toBe('مسجد النور');
  });
});

describe('XlsxWriter', () => {
  it('produces a workbook that SheetJS reads: Arabic header, typed numbers, RTL view', async () => {
    const bytes = await buildXlsx({ sheetName: 'المشاريع', rtl: true, columns: COLUMNS }, [
      ['TZ-PN-000001', 'مسجد', 150, 'يعمل'],
      ['TZ-PN-000002', 'مدرسة قرآن', -5.05, null],
    ]);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['المشاريع']);
    expect(wb.Workbook?.Views?.[0]?.RTL).toBe(true);
    const ws = wb.Sheets['المشاريع']!;
    expect(XLSX.utils.sheet_to_json(ws, { header: 1 })).toEqual([
      ['رمز المشروع', 'النوع', 'السعة', 'ملاحظة'],
      ['TZ-PN-000001', 'مسجد', 150, 'يعمل'],
      ['TZ-PN-000002', 'مدرسة قرآن', -5.05],
    ]);
    expect((ws.C2 as XLSXNS.CellObject).t).toBe('n');
    expect((ws.A2 as XLSXNS.CellObject).t).toBe('s');
  });

  it('freezes the header row and marks the sheet right-to-left only for RTL languages', async () => {
    const rtl = await sheetXml(
      await buildXlsx({ sheetName: 'x', rtl: true, columns: COLUMNS }, []),
    );
    expect(rtl).toContain('rightToLeft="1"');
    expect(rtl).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    const ltr = await sheetXml(
      await buildXlsx({ sheetName: 'x', rtl: false, columns: COLUMNS }, []),
    );
    expect(ltr).not.toContain('rightToLeft');
    expect(ltr).toContain('state="frozen"');
    // header cells use the bold style
    expect(ltr).toMatch(/<c r="A1" s="1" t="inlineStr">/);
  });

  it('never writes a formula; formula-looking text stays verbatim with a quotePrefix style', async () => {
    const bytes = await buildXlsx({ sheetName: 'x', rtl: false, columns: COLUMNS }, [
      ['=1+1', '+255700000001', -7, '@SUM(A1:A9)'],
      ['-خطر', '\t=cmd', 3, '=HYPERLINK("http://evil","x")'],
      ['مسجد', 'plain', 1, 'a=b'],
    ]);
    const xml = await sheetXml(bytes);
    expect(xml).not.toContain('<f>');
    // inline strings are never evaluated: no apostrophe is added to the value (phones stay E.164)
    const rows = XLSX.utils.sheet_to_json(XLSX.read(bytes, { type: 'array' }).Sheets.x!, {
      header: 1,
    });
    expect(rows[1]).toEqual(['=1+1', '+255700000001', -7, '@SUM(A1:A9)']);
    expect(rows[2]).toEqual(['-خطر', '\t=cmd', 3, '=HYPERLINK("http://evil","x")']);
    expect(rows[3]).toEqual(['مسجد', 'plain', 1, 'a=b']);
    const mine = await readXlsx(bytes, { maxRows: 10 });
    expect(mine.rows[1]).toEqual(['=1+1', '+255700000001', -7, '@SUM(A1:A9)']);
    // formula-looking cells carry the text style with quotePrefix="1"; ordinary text does not
    expect(xml).toMatch(/<c r="A2" s="2" t="inlineStr">/);
    expect(xml).toMatch(/<c r="B2" s="2" t="inlineStr">/);
    expect(xml).toMatch(/<c r="B3" s="2" t="inlineStr">/);
    expect(xml).toMatch(/<c r="A4" t="inlineStr">/);
    expect(xml).toMatch(/<c r="D4" t="inlineStr">/);
    const entry = readZipDirectory(bytes).find((e) => e.name === 'xl/styles.xml')!;
    const styles = new TextDecoder().decode(await readZipEntry(bytes, entry, 1_000_000));
    const xfs = /<cellXfs count="(\d+)">(.*?)<\/cellXfs>/.exec(styles)!;
    const list = xfs[2]!.match(/<xf [^>]*\/>/g)!;
    expect(Number(xfs[1])).toBe(list.length);
    expect(list[2]).toContain('quotePrefix="1"');
  });

  it('keeps markup, quotes and line breaks of cell text intact', async () => {
    const tricky = 'سطر أول\nسطر ثانٍ & <b>bold</b> "quoted" \'single\'';
    const bytes = await buildXlsx({ sheetName: 'x', rtl: true, columns: COLUMNS }, [
      [tricky, ' padded ', 1, ''],
    ]);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(bytes, { type: 'array' }).Sheets.x!, {
      header: 1,
      raw: true,
    });
    expect(rows[1]).toEqual([tricky, ' padded ', 1]);
    const mine = await readXlsx(bytes, { maxRows: 10 });
    expect(mine.rows[1]).toEqual([tricky, ' padded ', 1]);
  });

  it('skips empty cells and non-finite numbers, writes booleans as text', async () => {
    const bytes = await buildXlsx({ sheetName: 'x', rtl: false, columns: COLUMNS }, [
      [null, undefined, Number.NaN, ''],
      [true, false, Number.POSITIVE_INFINITY, 0],
    ]);
    const mine = await readXlsx(bytes, { maxRows: 10 });
    expect(mine.rows).toEqual([
      ['رمز المشروع', 'النوع', 'السعة', 'ملاحظة'],
      ['true', 'false', null, 0],
    ]);
    expect(mine.rowNumbers).toEqual([1, 3]); // row 2 had no value at all
  });

  it('cuts cells at the Excel limit and counts them', async () => {
    const writer = new XlsxWriter({ sheetName: 'x', rtl: false, columns: [{ header: 'h' }] });
    await writer.addRows([['x'.repeat(XLSX_MAX_CELL_CHARS + 10)], ['short']]);
    const result = await writer.finish();
    expect(result.truncatedCells).toBe(1);
    expect(result.rows).toBe(2);
    const bytes = new Uint8Array(result.size);
    let o = 0;
    for (const c of result.chunks) {
      bytes.set(c, o);
      o += c.byteLength;
    }
    const mine = await readXlsx(bytes, { maxRows: 10 });
    expect((mine.rows[1]![0] as string).length).toBe(XLSX_MAX_CELL_CHARS);
  });

  it('ignores cells beyond the declared columns and counts data rows', async () => {
    const writer = new XlsxWriter({
      sheetName: 'x',
      rtl: false,
      columns: [{ header: 'a' }, { header: 'b' }],
    });
    await writer.addRows([[1, 2, 3, 4]]);
    await writer.addRows([[5, 6]]);
    expect(writer.rows).toBe(2);
    const { chunks, size } = await writer.finish();
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.byteLength;
    }
    expect((await readXlsx(bytes, { maxRows: 10 })).rows).toEqual([
      ['a', 'b'],
      [1, 2],
      [5, 6],
    ]);
    await expect(writer.addRows([[1, 2]])).rejects.toThrow(/finished/);
  });

  it('writes many rows in bounded pieces and reads them back', async () => {
    const columns = Array.from({ length: 30 }, (_v, i) => ({ header: `عمود ${i + 1}` }));
    const writer = new XlsxWriter({ sheetName: 'كبير', rtl: true, columns });
    const row = columns.map((_c, i) => (i % 2 === 0 ? `قيمة ${i}` : i));
    for (let page = 0; page < 5; page++)
      await writer.addRows(Array.from({ length: 1000 }, () => row));
    const { chunks, size, rows } = await writer.finish();
    expect(rows).toBe(5000);
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.byteLength;
    }
    const back = await readXlsx(bytes, { maxRows: 6000 });
    expect(back.rows).toHaveLength(5001);
    expect(back.rows[5000]).toEqual(row);
    expect(back.truncated).toBe(false);
  });
});

function joined(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  return bytes;
}

async function entryText(bytes: Uint8Array, name: string): Promise<string> {
  const entry = readZipDirectory(bytes).find((e) => e.name === name);
  if (!entry) throw new Error(`no entry ${name}`);
  return new TextDecoder().decode(await readZipEntry(bytes, entry, 50_000_000));
}

describe('XlsxWriter — several sheets', () => {
  it('writes sheets in order, each with its own header, frozen row and direction', async () => {
    const writer = new XlsxWriter({ sheetName: 'المشاريع', rtl: true, columns: COLUMNS });
    await writer.addRows([['TZ-1', 'مسجد', 120, 'x']]);
    const staff = writer.addSheet({
      sheetName: 'الكادر',
      rtl: true,
      columns: [{ header: 'الاسم' }, { header: 'الدور' }, { header: 'الراتب' }],
    });
    await staff.addRows([
      ['سالم', 'إمام', 250000],
      ['خديجة', 'معلم', null],
    ]);
    const third = writer.addSheet({ sheetName: 'Notes', rtl: false, columns: [{ header: 'n' }] });
    await third.addRows([['=1+1']]);
    const result = await writer.finish();
    expect(result.rows).toBe(1);
    expect(result.sheets).toEqual([
      { name: 'المشاريع', rows: 1 },
      { name: 'الكادر', rows: 2 },
      { name: 'Notes', rows: 1 },
    ]);
    const bytes = joined(result.chunks, result.size);

    // SheetJS reads all three
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['المشاريع', 'الكادر', 'Notes']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets['الكادر']!, { header: 1, defval: null })).toEqual([
      ['الاسم', 'الدور', 'الراتب'],
      ['سالم', 'إمام', 250000],
      ['خديجة', 'معلم', null],
    ]);
    // our own reader still sees the first sheet only
    expect((await readXlsx(bytes, { maxRows: 10 })).rows).toEqual([
      ['رمز المشروع', 'النوع', 'السعة', 'ملاحظة'],
      ['TZ-1', 'مسجد', 120, 'x'],
    ]);

    // parts, relationships and content types for every sheet; styles keep their own id
    const types = await entryText(bytes, '[Content_Types].xml');
    for (const n of [1, 2, 3]) expect(types).toContain(`/xl/worksheets/sheet${n}.xml`);
    const rels = await entryText(bytes, 'xl/_rels/workbook.xml.rels');
    expect(rels).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"',
    );
    expect(rels).toContain(
      'Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    const s2 = await entryText(bytes, 'xl/worksheets/sheet2.xml');
    expect(s2).toMatch(/<sheetView[^>]*rightToLeft="1"/);
    expect(s2).toContain('state="frozen"');
    const s3 = await entryText(bytes, 'xl/worksheets/sheet3.xml');
    expect(s3).not.toContain('rightToLeft');
    expect(s3).not.toContain('<f>'); // formula-looking text is never a formula
    expect(s3).toContain(' s="2" t="inlineStr"');
  });

  it('makes sheet names unique (case-insensitive) and Excel-safe', async () => {
    const writer = new XlsxWriter({ sheetName: 'Staff', rtl: false, columns: [{ header: 'a' }] });
    const b = writer.addSheet({ sheetName: 'staff', rtl: false, columns: [{ header: 'a' }] });
    const c = writer.addSheet({
      sheetName: 'x'.repeat(40),
      rtl: false,
      columns: [{ header: 'a' }],
    });
    const d = writer.addSheet({
      sheetName: 'x'.repeat(40),
      rtl: false,
      columns: [{ header: 'a' }],
    });
    const e = writer.addSheet({ sheetName: 'a/b:c', rtl: false, columns: [{ header: 'a' }] });
    expect([b.name, c.name, d.name, e.name]).toEqual([
      'staff (2)',
      'x'.repeat(31),
      'x'.repeat(27) + ' (2)',
      'a b c',
    ]);
    const { chunks, size, sheets } = await writer.finish();
    expect(sheets.map((s) => s.name)).toEqual([
      'Staff',
      'staff (2)',
      'x'.repeat(31),
      'x'.repeat(27) + ' (2)',
      'a b c',
    ]);
    expect(XLSX.read(joined(chunks, size), { type: 'array' }).SheetNames).toHaveLength(5);
  });

  it('counts truncated cells over all sheets; no sheet can be added after finish', async () => {
    const writer = new XlsxWriter({ sheetName: 'a', rtl: false, columns: [{ header: 'h' }] });
    await writer.addRows([['x'.repeat(XLSX_MAX_CELL_CHARS + 1)]]);
    const second = writer.addSheet({ sheetName: 'b', rtl: false, columns: [{ header: 'h' }] });
    await second.addRows([['y'.repeat(XLSX_MAX_CELL_CHARS + 1)], ['z']]);
    expect(() => writer.addSheet({ sheetName: 'c', rtl: false, columns: [] })).toThrow(RangeError);
    const result = await writer.finish();
    expect(result.truncatedCells).toBe(2);
    expect(result.sheets.map((s) => s.rows)).toEqual([1, 2]);
    expect(() =>
      writer.addSheet({ sheetName: 'd', rtl: false, columns: [{ header: 'h' }] }),
    ).toThrow(/finished/);
    await expect(second.addRows([['late']])).rejects.toThrow(/finished/);
  });

  it('an empty extra sheet still has its header row', async () => {
    const writer = new XlsxWriter({ sheetName: 'a', rtl: false, columns: [{ header: 'h' }] });
    writer.addSheet({ sheetName: 'b', rtl: true, columns: [{ header: 'الاسم' }] });
    const { chunks, size } = await writer.finish();
    const wb = XLSX.read(joined(chunks, size), { type: 'array' });
    expect(XLSX.utils.sheet_to_json(wb.Sheets.b!, { header: 1 })).toEqual([['الاسم']]);
  });
});
