import { describe, expect, it } from 'vitest';
import * as XLSXNS from 'xlsx';
import { parseCsv } from '../_shared/csv.ts';
import type { ExportColumns } from '../_shared/labels.ts';
import { readZipDirectory, readZipEntry } from '../_shared/zip.ts';
import {
  buildXlsxExport,
  cellPages,
  csvChunks,
  csvStream,
  exportFileName,
  type ExportPage,
  type PageFetcher,
  type Progress,
} from './build.ts';

const XLSX: typeof XLSXNS = (XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS;

const COLUMNS_AR: ExportColumns = {
  lang: 'ar',
  dir: 'rtl',
  list_separator: ' | ',
  capabilities: { people: true, restricted: false },
  columns: [
    { key: 'code', header: 'رمز المشروع', kind: 'text' },
    { key: 'type', header: 'النوع', kind: 'enum', enum: 'project_type' },
    { key: 'status', header: 'الحالة', kind: 'enum', enum: 'project_status' },
    { key: 'capacity', header: 'السعة', kind: 'integer' },
    { key: 'land_expandable', header: 'قابلية التوسع', kind: 'boolean', enum: 'boolean' },
    { key: 'review_note', header: 'ملاحظة المراجعة', kind: 'text' },
  ],
  enums: {
    project_type: { mosque: 'مسجد', school: 'مدرسة قرآن', combined: 'مسجد ومدرسة' },
    project_status: { active: 'يعمل', maintenance: 'يحتاج صيانة' },
    boolean: { true: 'نعم', false: 'لا' },
  },
};

const COLUMNS_EN: ExportColumns = {
  ...COLUMNS_AR,
  lang: 'en',
  dir: 'ltr',
  columns: COLUMNS_AR.columns.map((c, i) => ({ ...c, header: ['Code', 'Type', 'Status', 'Capacity', 'Expandable', 'Review note'][i]! })),
  enums: { project_type: { mosque: 'Mosque', school: "Qur'an school" }, project_status: { active: 'Active' }, boolean: { true: 'Yes', false: 'No' } },
};

function row(i: number): Record<string, unknown> {
  return {
    code: `TZ-PN-${String(i).padStart(6, '0')}`,
    type: i % 2 ? 'mosque' : 'school',
    status: 'active',
    capacity: 100 + i,
    land_expandable: i % 3 === 0,
    review_note: i === 1 ? '=HYPERLINK("http://evil","x")' : null,
  };
}

/** A fake `export_rows`: `total` rows in pages of `size`, recording the cursors it was given. */
function fakePages(total: number, size: number): { fetch: PageFetcher; cursors: unknown[] } {
  const cursors: unknown[] = [];
  const fetch: PageFetcher = async (after) => {
    cursors.push(after);
    const start = after === null ? 0 : (after as { n: number }).n;
    const rows = Array.from({ length: Math.min(size, total - start) }, (_v, k) => row(start + k + 1));
    const end = start + rows.length;
    const page: ExportPage = { rows, done: end >= total, next: end >= total ? null : { n: end } };
    return page;
  };
  return { fetch, cursors };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const fresh = (): Progress => ({ rows: 0, bytes: 0, pages: 0 });

describe('cellPages', () => {
  it('follows the cursor until done and translates every page', async () => {
    const { fetch, cursors } = fakePages(5, 2);
    const pages: unknown[][][] = [];
    for await (const page of cellPages(COLUMNS_AR, fetch)) pages.push(page);
    expect(cursors).toEqual([null, { n: 2 }, { n: 4 }]);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages[0]![0]).toEqual(['TZ-PN-000001', 'مسجد', 'يعمل', 101, 'لا', '=HYPERLINK("http://evil","x")']);
    expect(pages[0]![1]).toEqual(['TZ-PN-000002', 'مدرسة قرآن', 'يعمل', 102, 'لا', null]);
    expect(pages[1]![0]![4]).toBe('نعم');
  });

  it('an empty result yields no page', async () => {
    const pages: unknown[] = [];
    for await (const page of cellPages(COLUMNS_AR, fakePages(0, 10).fetch)) pages.push(page);
    expect(pages).toEqual([]);
  });

  it('stops when next is null even if done is missing', async () => {
    let calls = 0;
    const fetch: PageFetcher = async () => {
      calls++;
      return { rows: [row(1)], done: false, next: null };
    };
    const pages: unknown[] = [];
    for await (const page of cellPages(COLUMNS_AR, fetch)) pages.push(page);
    expect(calls).toBe(1);
    expect(pages).toHaveLength(1);
  });
});

describe('CSV export', () => {
  it('streams BOM + Arabic header + translated rows with the injection guard', async () => {
    const progress = fresh();
    const bytes = await collect(csvStream(COLUMNS_AR, cellPages(COLUMNS_AR, fakePages(3, 2).fetch), progress));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('رمز المشروع,النوع,الحالة,السعة,قابلية التوسع,ملاحظة المراجعة');
    expect(lines[1]).toBe(`TZ-PN-000001,مسجد,يعمل,101,لا,"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(lines[2]).toBe('TZ-PN-000002,مدرسة قرآن,يعمل,102,لا,');
    expect(lines[3]).toBe('TZ-PN-000003,مسجد,يعمل,103,نعم,');
    expect(lines[4]).toBe('');
    expect(progress).toEqual({ rows: 3, pages: 2, bytes: bytes.byteLength });
    // and it parses back
    expect(parseCsv(text).rows).toHaveLength(4);
  });

  it('writes other languages the same way', async () => {
    const bytes = await collect(csvStream(COLUMNS_EN, cellPages(COLUMNS_EN, fakePages(2, 10).fetch), fresh()));
    const lines = new TextDecoder().decode(bytes).split('\r\n');
    expect(lines[0]!.replace(String.fromCharCode(0xfeff), '')).toBe('Code,Type,Status,Capacity,Expandable,Review note');
    expect(lines[2]).toBe("TZ-PN-000002,Qur'an school,Active,102,No,");
  });

  it('an export without rows still has the header', async () => {
    const progress = fresh();
    const bytes = await collect(csvStream(COLUMNS_AR, cellPages(COLUMNS_AR, fakePages(0, 10).fetch), progress));
    expect(new TextDecoder().decode(bytes).split('\r\n')).toHaveLength(2);
    expect(progress.rows).toBe(0);
  });

  it('a failing page errors the stream and reports the cause', async () => {
    let calls = 0;
    const fetch: PageFetcher = async () => {
      if (++calls === 2) throw new Error('PT409 export job is cancelled');
      return { rows: [row(1)], done: false, next: { n: 1 } };
    };
    let reported: unknown = null;
    const stream = csvStream(COLUMNS_AR, cellPages(COLUMNS_AR, fetch), fresh(), (e) => {
      reported = e;
    });
    await expect(collect(stream)).rejects.toThrow(/cancelled/);
    expect((reported as Error).message).toMatch(/cancelled/);
  });

  it('csvChunks produces the same bytes as the stream', async () => {
    const a = await collect(csvStream(COLUMNS_AR, cellPages(COLUMNS_AR, fakePages(25, 10).fetch), fresh()));
    const progress = fresh();
    const chunks = await csvChunks(COLUMNS_AR, cellPages(COLUMNS_AR, fakePages(25, 10).fetch), progress);
    expect(chunks).toHaveLength(4); // header + 3 pages: memory is bounded by the page size
    expect(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer())).toEqual(a);
    expect(progress.rows).toBe(25);
  });
});

describe('XLSX export', () => {
  async function build(columns: ExportColumns, total: number, maxRows = 1000): Promise<{ bytes: Uint8Array; progress: Progress }> {
    const progress = fresh();
    const outcome = await buildXlsxExport(columns, cellPages(columns, fakePages(total, 7).fetch), progress, maxRows);
    if (outcome.overflow) throw new Error('unexpected overflow');
    const bytes = new Uint8Array(await new Blob(outcome.chunks as BlobPart[]).arrayBuffer());
    expect(bytes.byteLength).toBe(outcome.size);
    return { bytes, progress };
  }

  it('Arabic: translated cells, RTL sheet, frozen header, guarded text', async () => {
    const { bytes, progress } = await build(COLUMNS_AR, 20);
    expect(progress.rows).toBe(20);
    expect(progress.bytes).toBe(bytes.byteLength);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['المشاريع']);
    expect(wb.Workbook?.Views?.[0]?.RTL).toBe(true);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['المشاريع']!, { header: 1 });
    expect(rows).toHaveLength(21);
    expect(rows[0]).toEqual(['رمز المشروع', 'النوع', 'الحالة', 'السعة', 'قابلية التوسع', 'ملاحظة المراجعة']);
    expect(rows[1]).toEqual(['TZ-PN-000001', 'مسجد', 'يعمل', 101, 'لا', `'=HYPERLINK("http://evil","x")`]);
    expect(rows[3]).toEqual(['TZ-PN-000003', 'مسجد', 'يعمل', 103, 'نعم']);
    const entry = readZipDirectory(bytes).find((e) => e.name === 'xl/worksheets/sheet1.xml')!;
    const xml = new TextDecoder().decode(await readZipEntry(bytes, entry, 10_000_000));
    expect(xml).toContain('rightToLeft="1"');
    expect(xml).toContain('state="frozen"');
    expect(xml).not.toContain('<f>');
  });

  it('other languages get a left-to-right sheet named in that language', async () => {
    const { bytes } = await build(COLUMNS_EN, 2);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Projects']);
    expect(wb.Workbook?.Views?.[0]?.RTL ?? false).toBe(false);
  });

  it('reports overflow beyond the row limit so that the caller can fall back to CSV', async () => {
    const progress = fresh();
    const { fetch, cursors } = fakePages(100, 10);
    const outcome = await buildXlsxExport(COLUMNS_AR, cellPages(COLUMNS_AR, fetch), progress, 25);
    expect(outcome.overflow).toBe(true);
    // it stopped paging as soon as the limit was crossed (3 pages of 10 → 30 > 25)
    expect(cursors).toHaveLength(3);
    // exactly at the limit is fine
    const exact = await buildXlsxExport(COLUMNS_AR, cellPages(COLUMNS_AR, fakePages(25, 10).fetch), fresh(), 25);
    expect(exact.overflow).toBe(false);
  });
});

describe('exportFileName', () => {
  it('is ASCII, dated and tied to the job', () => {
    const name = exportFileName('01a1027f-fc21-7a83-8e7f-64628ffed1be', 'csv', new Date('2026-10-03T16:01:44Z'));
    expect(name).toBe('istiqama-projects-20261003-8ffed1be.csv');
    expect(name).toMatch(/^[\x20-\x7e]+$/);
  });
});
