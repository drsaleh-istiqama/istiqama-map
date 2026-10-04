import { describe, expect, it } from 'vitest';
import * as XLSXNS from 'xlsx';
import { HttpError } from '../_shared/http.ts';
import { buildXlsx } from '../_shared/xlsx.ts';
import { parseImportFile } from './parse.ts';

const XLSX: typeof XLSXNS = (XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS;

const BOM = String.fromCharCode(0xfeff);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function failure(run: Promise<unknown>): Promise<HttpError> {
  try {
    await run;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error('expected a failure');
}

function workbookBytes(rows: unknown[][], sheetName = 'Sheet1'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('parseImportFile — CSV', () => {
  it('parses the official template shape with Arabic headers and values', async () => {
    const csv =
      `${BOM}المعرّف الخارجي,اسم المشروع (عربي),النوع,خط العرض,خط الطول,الدولة\r\n` +
      `EXT-1,مسجد النور,مسجد,-5.05,39.75,TZ\r\n` +
      `EXT-2,"مدرسة ""الهداية"", الجديدة",مدرسة قرآن,-4.953,39.752,تنزانيا\r\n`;
    const { rows, info } = await parseImportFile(enc(csv), { maxRows: 5000 });
    expect(info).toMatchObject({
      kind: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      header_row: 1,
      rows: 2,
      skipped_blank_rows: 0,
      warnings: [],
    });
    expect(info.headers).toEqual([
      'المعرّف الخارجي',
      'اسم المشروع (عربي)',
      'النوع',
      'خط العرض',
      'خط الطول',
      'الدولة',
    ]);
    expect(info.source_rows).toBeUndefined();
    expect(rows).toEqual([
      {
        'المعرّف الخارجي': 'EXT-1',
        'اسم المشروع (عربي)': 'مسجد النور',
        النوع: 'مسجد',
        'خط العرض': '-5.05',
        'خط الطول': '39.75',
        الدولة: 'TZ',
      },
      {
        'المعرّف الخارجي': 'EXT-2',
        'اسم المشروع (عربي)': 'مدرسة "الهداية", الجديدة',
        النوع: 'مدرسة قرآن',
        'خط العرض': '-4.953',
        'خط الطول': '39.752',
        الدولة: 'تنزانيا',
      },
    ]);
  });

  it('copes with semicolons, blank lines, leading empty lines and reports source lines', async () => {
    const csv = `\n\nname_ar;type;lat;lon\nA;mosque;-5,05;39,75\n\n;;;\nB;school;-4.9;39.7\n`;
    const { rows, info } = await parseImportFile(enc(csv), { maxRows: 5000 });
    expect(info.delimiter).toBe(';');
    expect(info.header_row).toBe(3);
    expect(rows).toEqual([
      { name_ar: 'A', type: 'mosque', lat: '-5,05', lon: '39,75' },
      { name_ar: 'B', type: 'school', lat: '-4.9', lon: '39.7' },
    ]);
    expect(info.source_rows).toEqual([4, 7]);
    expect(info.skipped_blank_rows).toBe(1);
    expect(info.warnings).toEqual(['blank_rows_skipped']);
  });

  it('keeps formula-looking cells as text and removes the export guard', async () => {
    const csv = `name_ar,review_note,builder\n=1+1,'=HYPERLINK("x"),'+255700000001\n`;
    const { rows } = await parseImportFile(enc(csv), { maxRows: 10 });
    expect(rows).toEqual([
      { name_ar: '=1+1', review_note: '=HYPERLINK("x")', builder: '+255700000001' },
    ]);
  });

  it('decodes windows-1256 files and says so', async () => {
    // "النوع,type\nمسجد,x\n" in windows-1256
    const bytes = new Uint8Array([
      0xc7, 0xe1, 0xe4, 0xe6, 0xda, 0x2c, 0x74, 0x79, 0x70, 0x65, 0x0a, 0xe3, 0xd3, 0xcc, 0xcf,
      0x2c, 0x78, 0x0a,
    ]);
    const { rows, info } = await parseImportFile(bytes, { maxRows: 10 });
    expect(rows).toEqual([{ النوع: 'مسجد', type: 'x' }]);
    expect(info.encoding).toBe('windows-1256');
    expect(info.warnings).toContain('encoding_windows_1256');
  });

  it('reports duplicate and unnamed columns', async () => {
    const { rows, info } = await parseImportFile(enc('name,name,,type\na,b,c,d\n'), {
      maxRows: 10,
    });
    expect(rows).toEqual([{ name: 'a', type: 'd' }]);
    expect(info.warnings).toEqual(['duplicate_headers', 'unnamed_columns']);
  });

  it('enforces the row limit', async () => {
    const lines = ['name'];
    for (let i = 0; i < 12; i++) lines.push(`row ${i}`);
    const e = await failure(parseImportFile(enc(lines.join('\n')), { maxRows: 10 }));
    expect(e.status).toBe(422);
    expect(e.message).toBe('too_many_rows');
    expect(e.details).toContain('12');
    const ok = await parseImportFile(enc(lines.slice(0, 11).join('\n')), { maxRows: 10 });
    expect(ok.rows).toHaveLength(10);
  });

  it('rejects empty files, header-only files and binary data', async () => {
    expect((await failure(parseImportFile(new Uint8Array(0), { maxRows: 10 }))).message).toBe(
      'empty_file',
    );
    expect((await failure(parseImportFile(enc('\n\n  \n'), { maxRows: 10 }))).message).toBe(
      'empty_file',
    );
    expect((await failure(parseImportFile(enc('a,b,c\n'), { maxRows: 10 }))).message).toBe(
      'empty_file',
    );
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3]);
    const e = await failure(parseImportFile(binary, { maxRows: 10 }));
    expect(e.status).toBe(415);
    expect(e.message).toBe('unsupported_file_type');
  });
});

describe('parseImportFile — XLSX', () => {
  it('reads the first sheet of a workbook written by Excel-compatible software', async () => {
    const bytes = workbookBytes(
      [
        ['external_id', 'name_ar', 'type', 'capacity', 'lat', 'lon', 'land_expandable'],
        ['EXT-1', 'مسجد النور', 'مسجد', 150, -5.05, 39.75, true],
        [1002, 'مدرسة الهداية', 'school', null, -4.953, 39.752, 'نعم'],
      ],
      'القالب',
    );
    const { rows, info } = await parseImportFile(bytes, { maxRows: 5000 });
    expect(info).toMatchObject({
      kind: 'xlsx',
      sheet: 'القالب',
      sheets: ['القالب'],
      header_row: 1,
      rows: 2,
      warnings: [],
    });
    expect(rows).toEqual([
      {
        external_id: 'EXT-1',
        name_ar: 'مسجد النور',
        type: 'مسجد',
        capacity: 150,
        lat: -5.05,
        lon: 39.75,
        land_expandable: true,
      },
      {
        external_id: 1002,
        name_ar: 'مدرسة الهداية',
        type: 'school',
        lat: -4.953,
        lon: 39.752,
        land_expandable: 'نعم',
      },
    ]);
  });

  it('re-imports a file produced by our own export writer (guard removed, numbers kept)', async () => {
    const bytes = await buildXlsx(
      {
        sheetName: 'المشاريع',
        rtl: true,
        columns: [{ header: 'رمز المشروع' }, { header: 'هاتف المسؤول' }, { header: 'خط العرض' }],
      },
      [['TZ-PN-000001', '+255700000001', -5.05]],
    );
    const { rows, info } = await parseImportFile(bytes, { maxRows: 10 });
    expect(info.sheet).toBe('المشاريع');
    expect(rows).toEqual([
      { 'رمز المشروع': 'TZ-PN-000001', 'هاتف المسؤول': '+255700000001', 'خط العرض': -5.05 },
    ]);
  });

  it('uses cached values of formulas and reports them; nothing is evaluated', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name_ar', 'capacity'],
      ['x', 1],
    ]);
    ws.B2 = { t: 'n', v: 42, f: '6*7' };
    ws.A2 = { t: 's', v: 'cached', f: 'WEBSERVICE("http://evil.example")' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    const { rows, info } = await parseImportFile(bytes, { maxRows: 10 });
    expect(rows).toEqual([{ name_ar: 'cached', capacity: 42 }]);
    expect(info.warnings).toEqual(['formulas_ignored']);
  });

  it('skips blank spreadsheet rows and maps row_no to spreadsheet rows', async () => {
    const bytes = workbookBytes([[], ['name_ar'], ['a'], [], [null], ['b']]);
    const { rows, info } = await parseImportFile(bytes, { maxRows: 10 });
    expect(rows).toEqual([{ name_ar: 'a' }, { name_ar: 'b' }]);
    expect(info.header_row).toBe(2);
    expect(info.source_rows).toEqual([3, 6]);
  });

  it('selects a sheet by name', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['h'], ['first']]), 'One');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['h'], ['second']]), 'Two');
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expect((await parseImportFile(bytes, { maxRows: 10 })).rows).toEqual([{ h: 'first' }]);
    expect((await parseImportFile(bytes, { maxRows: 10, sheet: 'Two' })).rows).toEqual([
      { h: 'second' },
    ]);
    expect((await failure(parseImportFile(bytes, { maxRows: 10, sheet: 'Three' }))).message).toBe(
      'no_sheet',
    );
  });

  it('enforces the row limit without reading the whole sheet', async () => {
    const rows: unknown[][] = [['n']];
    for (let i = 0; i < 2000; i++) rows.push([i]);
    const e = await failure(parseImportFile(workbookBytes(rows), { maxRows: 100 }));
    expect(e.status).toBe(422);
    expect(e.message).toBe('too_many_rows');
  });

  it('rejects legacy .xls, encrypted workbooks, other archives and damaged files', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4]);
    const legacy = await failure(parseImportFile(cfb, { maxRows: 10 }));
    expect(legacy.status).toBe(415);
    expect(legacy.message).toBe('unsupported_file_type');

    const good = workbookBytes([['a'], ['b']]);
    const damaged = await failure(
      parseImportFile(good.subarray(0, good.byteLength - 40), { maxRows: 10 }),
    );
    expect(damaged.status).toBe(422);
    expect(damaged.message).toBe('invalid_file');
  });

  it('an empty sheet is an empty file', async () => {
    expect((await failure(parseImportFile(workbookBytes([]), { maxRows: 10 }))).message).toBe(
      'empty_file',
    );
    expect(
      (await failure(parseImportFile(workbookBytes([['only', 'header']]), { maxRows: 10 })))
        .message,
    ).toBe('empty_file');
  });
});
