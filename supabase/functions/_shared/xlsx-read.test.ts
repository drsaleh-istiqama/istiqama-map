import { describe, expect, it } from 'vitest';
import * as XLSXNS from 'xlsx';
import {
  XlsxReadError,
  decodeXml,
  excelSerialToIso,
  isDateFormatCode,
  parseDateStyles,
  parseSharedStrings,
  readXlsx,
} from './xlsx-read.ts';
import { ZipEntryStream, ZipWriter } from './zip.ts';

const XLSX: typeof XLSXNS = (XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS;

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface Parts {
  sheet: string;
  sharedStrings?: string;
  styles?: string;
  workbook?: string;
  rels?: string;
  extra?: Record<string, string>;
}

/** A hand-made workbook: full control over the XML the reader has to cope with. */
async function makeXlsx(parts: Parts): Promise<Uint8Array> {
  const zip = new ZipWriter();
  await zip.add(
    'xl/workbook.xml',
    parts.workbook ??
      `<workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  await zip.add(
    'xl/_rels/workbook.xml.rels',
    parts.rels ??
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>` +
        `</Relationships>`,
  );
  if (parts.sharedStrings !== undefined) await zip.add('xl/sharedStrings.xml', parts.sharedStrings);
  if (parts.styles !== undefined) await zip.add('xl/styles.xml', parts.styles);
  await zip.add('xl/worksheets/sheet1.xml', parts.sheet);
  for (const [name, content] of Object.entries(parts.extra ?? {})) await zip.add(name, content);
  return join(zip.finish().chunks);
}

const sheet = (rows: string): string => `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;

function sheetJsBytes(wb: XLSXNS.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('small parsers', () => {
  it('decodeXml handles named and numeric entities', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#1605;&#x633;')).toBe(`a & b <c> "d" 'e' مس`);
    expect(decodeXml('no entities')).toBe('no entities');
    expect(decodeXml('&unknown; stays')).toBe('&unknown; stays');
  });

  it('parseSharedStrings: plain, rich text, phonetic runs, empty items', () => {
    const xml =
      '<sst><si><t>مسجد</t></si>' +
      '<si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text </t></r><r><t>مع عربي</t></r></si>' +
      '<si/>' +
      '<si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si>' +
      '<si><t>a &amp; b_x000D_c</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(['مسجد', 'Rich text مع عربي', '', '漢字', 'a & b\rc']);
  });

  it('isDateFormatCode', () => {
    for (const code of ['yyyy-mm-dd', 'dd/mm/yyyy', 'd-mmm-yy', 'h:mm:ss', '[$-409]mmmm d, yyyy', '[h]:mm'])
      expect(isDateFormatCode(code), code).toBe(true);
    for (const code of ['General', '0.00', '#,##0', '0%', '0.00E+00', '@', '#,##0 "days"', '0.0 "m"', '[Red]0.00'])
      expect(isDateFormatCode(code), code).toBe(false);
  });

  it('parseDateStyles maps cell styles to "is a date"', () => {
    const styles =
      '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
      '<numFmt numFmtId="165" formatCode="#,##0.00 &quot;TZS&quot;"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"><alignment/></xf>' +
      '<xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>';
    expect(parseDateStyles(styles)).toEqual([false, true, true, false]);
  });

  it('excelSerialToIso', () => {
    expect(excelSerialToIso(45000)).toBe('2023-03-15');
    expect(excelSerialToIso(25569)).toBe('1970-01-01');
    expect(excelSerialToIso(1)).toBe('1900-01-01');
    expect(excelSerialToIso(59)).toBe('1900-02-28');
    expect(excelSerialToIso(61)).toBe('1900-03-01');
    expect(excelSerialToIso(45000.5)).toBe('2023-03-15T12:00:00');
    expect(excelSerialToIso(0.75)).toBe('18:00:00');
    expect(excelSerialToIso(43538, true)).toBe('2023-03-15'); // 1904 date system
    expect(excelSerialToIso(-1)).toBeNull();
    expect(excelSerialToIso(Number.NaN)).toBeNull();
  });
});

describe('readXlsx — workbooks written by SheetJS', () => {
  it('reads strings (shared), numbers, booleans and Arabic text', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name_ar', 'type', 'capacity', 'expandable', 'lat'],
      ['مسجد النور', 'mosque', 150, true, -5.05],
      ['مدرسة الهداية', 'مدرسة قرآن', null, false, -4.953],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'القالب');
    const result = await readXlsx(sheetJsBytes(wb), { maxRows: 100 });
    expect(result.name).toBe('القالب');
    expect(result.rows).toEqual([
      ['name_ar', 'type', 'capacity', 'expandable', 'lat'],
      ['مسجد النور', 'mosque', 150, true, -5.05],
      ['مدرسة الهداية', 'مدرسة قرآن', null, false, -4.953],
    ]);
    expect(result.rowNumbers).toEqual([1, 2, 3]);
    expect(result.formulaCells).toBe(0);
    expect(result.hasMacros).toBe(false);
  });

  it('turns date cells into ISO dates', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['build_date', 'when', 'plain']]);
    // serial numbers with date formats, exactly what Excel stores for date cells
    ws.A2 = { t: 'n', v: 42175, z: 'yyyy-mm-dd' };
    ws.B2 = { t: 'n', v: 46298 + 14.5 / 24, z: 'yyyy-mm-dd hh:mm:ss' };
    ws.C2 = { t: 'n', v: 42175 };
    ws['!ref'] = 'A1:C2';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await readXlsx(sheetJsBytes(wb), { maxRows: 10 });
    expect(result.rows[1]).toEqual(['2015-06-20', '2026-10-03T14:30:00', 42175]);
  });

  it('uses the cached value of formula cells and counts them — nothing is evaluated', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b', 'total'], [2, 3, 5]]);
    ws.C2 = { t: 'n', v: 5, f: 'A2+B2' };
    ws.D2 = { t: 's', v: 'cached text', f: 'HYPERLINK("http://evil.example","click")' };
    ws['!ref'] = 'A1:D2';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await readXlsx(sheetJsBytes(wb), { maxRows: 10 });
    expect(result.rows[1]).toEqual([2, 3, 5, 'cached text']);
    expect(result.formulaCells).toBe(2);
  });

  it('reads the first visible sheet, or the one asked for', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['hidden']]), 'Hidden');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['first visible']]), 'Data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['third']]), 'More');
    wb.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }, { Hidden: 0 }] };
    const bytes = sheetJsBytes(wb);
    const auto = await readXlsx(bytes, { maxRows: 10 });
    expect(auto.name).toBe('Data');
    expect(auto.sheetNames).toEqual(['Hidden', 'Data', 'More']);
    expect((await readXlsx(bytes, { maxRows: 10, sheet: 'More' })).rows).toEqual([['third']]);
    expect((await readXlsx(bytes, { maxRows: 10, sheet: 0 })).rows).toEqual([['hidden']]);
    await expect(readXlsx(bytes, { maxRows: 10, sheet: 'Nope' })).rejects.toMatchObject({ code: 'no_sheet' });
  });

  it('stops at the row limit and says so', async () => {
    const rows = [['n'], ...Array.from({ length: 300 }, (_v, i) => [i + 1])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    const limited = await readXlsx(sheetJsBytes(wb), { maxRows: 101 });
    expect(limited.rows).toHaveLength(101);
    expect(limited.truncated).toBe(true);
    expect(limited.rows[100]).toEqual([100]);
    const all = await readXlsx(sheetJsBytes(wb), { maxRows: 301 });
    expect(all.truncated).toBe(false);
    expect(all.rows).toHaveLength(301);
  });
});

describe('readXlsx — hand-made XML', () => {
  it('reads inline strings, shared strings, formula strings, booleans and skips errors', async () => {
    const bytes = await makeXlsx({
      sharedStrings: '<sst><si><t>shared مشترك</t></si></sst>',
      sheet: sheet(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>inline &amp; text</t></is></c>' +
          '<c r="B1" t="s"><v>0</v></c><c r="C1" t="str"><f>A1&amp;B1</f><v>computed</v></c>' +
          '<c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#N/A</v></c><c r="F1"><v>12.5</v></c></row>',
      ),
    });
    const result = await readXlsx(bytes, { maxRows: 10 });
    expect(result.rows).toEqual([['inline & text', 'shared مشترك', 'computed', true, null, 12.5]]);
    expect(result.formulaCells).toBe(1);
  });

  it('copes with cells without references, gaps, empty rows and self-closing tags', async () => {
    const bytes = await makeXlsx({
      sheet: sheet(
        '<row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row>' +
          '<row r="2"/>' +
          '<row r="3" spans="1:4"><c r="A3" s="1"/><c r="D3"><v>4</v></c></row>' +
          '<row r="7"><c r="B7"><v>7</v></c><c><v>8</v></c></row>',
      ),
    });
    const result = await readXlsx(bytes, { maxRows: 10 });
    expect(result.rows).toEqual([['a', 'b'], [null, null, null, 4], [null, 7, 8]]);
    expect(result.rowNumbers).toEqual([1, 3, 7]);
  });

  it('accepts namespace prefixes on every element', async () => {
    const bytes = await makeXlsx({
      workbook:
        '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<x:sheets><x:sheet name="Prefixed" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      sharedStrings: '<x:sst><x:si><x:t>نص</x:t></x:si></x:sst>',
      sheet:
        '<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    });
    const result = await readXlsx(bytes, { maxRows: 10 });
    expect(result.name).toBe('Prefixed');
    expect(result.rows).toEqual([['نص', 2]]);
  });

  it('converts numbers with a date style, honours the 1904 date system', async () => {
    const styles =
      '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const cells = sheet('<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="0"><v>45000</v></c><c r="C1" t="d"><v>2024-02-29T00:00:00Z</v></c></row>');
    expect((await readXlsx(await makeXlsx({ styles, sheet: cells }), { maxRows: 5 })).rows).toEqual([
      ['2023-03-15', 45000, '2024-02-29'],
    ]);
    const wb1904 = `<workbook ${NS}><workbookPr date1904="1"/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    expect(
      (await readXlsx(await makeXlsx({ styles, workbook: wb1904, sheet: sheet('<row r="1"><c r="A1" s="1"><v>43538</v></c></row>') }), { maxRows: 5 })).rows,
    ).toEqual([['2023-03-15']]);
  });

  it('ignores cells beyond the column limit and reports it', async () => {
    const bytes = await makeXlsx({ sheet: sheet('<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>') });
    const result = await readXlsx(bytes, { maxRows: 5, maxColumns: 100 });
    expect(result.rows).toEqual([[1]]);
    expect(result.columnsTruncated).toBe(true);
  });

  it('reports macros without opening them', async () => {
    const bytes = await makeXlsx({
      sheet: sheet('<row r="1"><c r="A1"><v>1</v></c></row>'),
      extra: { 'xl/vbaProject.bin': 'not really a macro' },
    });
    expect((await readXlsx(bytes, { maxRows: 5 })).hasMacros).toBe(true);
  });

  it('handles rows that arrive split across inflate chunks (large sheet)', async () => {
    const zip = new ZipWriter();
    await zip.add('xl/workbook.xml', `<workbook ${NS}><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    await zip.add(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
    );
    const entry = new ZipEntryStream('xl/worksheets/sheet1.xml');
    const enc = new TextEncoder();
    await entry.write(enc.encode(`<worksheet ${NS}><sheetData>`));
    const filler = 'حشو '.repeat(40);
    for (let r = 1; r <= 3000; r++)
      await entry.write(
        enc.encode(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}" t="inlineStr"><is><t>${filler}${r}</t></is></c></row>`),
      );
    await entry.write(enc.encode('</sheetData></worksheet>'));
    await zip.addStream(entry);
    const result = await readXlsx(join(zip.finish().chunks), { maxRows: 5000 });
    expect(result.rows).toHaveLength(3000);
    expect(result.rows[2999]).toEqual([3000, `${filler}3000`]);
    expect(result.rows.every((row, i) => row[0] === i + 1)).toBe(true);
  });
});

describe('readXlsx — refusals', () => {
  it('refuses legacy .xls / encrypted containers', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(readXlsx(cfb, { maxRows: 5 })).rejects.toMatchObject({ code: 'encrypted_or_legacy' });
  });

  it('refuses files that are not ZIP archives or not workbooks', async () => {
    await expect(readXlsx(new TextEncoder().encode('a,b\n1,2'), { maxRows: 5 })).rejects.toMatchObject({
      code: 'not_xlsx',
    });
    const zip = new ZipWriter();
    await zip.add('word/document.xml', '<w:document/>');
    await expect(readXlsx(join(zip.finish().chunks), { maxRows: 5 })).rejects.toMatchObject({ code: 'not_xlsx' });
  });

  it('refuses a sheet that inflates beyond the limit (zip bomb)', async () => {
    const zip = new ZipWriter();
    await zip.add('xl/workbook.xml', `<workbook ${NS}><sheets><sheet name="B" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    await zip.add(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    const entry = new ZipEntryStream('xl/worksheets/sheet1.xml');
    const spaces = new Uint8Array(1_000_000).fill(0x20);
    for (let i = 0; i < 8; i++) await entry.write(spaces);
    await zip.addStream(entry);
    const bytes = join(zip.finish().chunks);
    expect(bytes.byteLength).toBeLessThan(50_000);
    const error = await readXlsx(bytes, { maxRows: 5, maxSheetBytes: 2_000_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XlsxReadError);
    expect((error as XlsxReadError).code).toBe('too_large');
  });

  it('a crafted "__proto__" sheet or header cannot pollute Object.prototype', async () => {
    const bytes = await makeXlsx({
      workbook: `<workbook ${NS}><sheets><sheet name="__proto__" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      sheet: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>__proto__</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>polluted</t></is></c></row>'),
    });
    const result = await readXlsx(bytes, { maxRows: 5 });
    expect(result.name).toBe('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});
