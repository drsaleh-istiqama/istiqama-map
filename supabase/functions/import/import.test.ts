import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, jsonResponse, nextUserId, pgError, userToken } from '../_shared/fake-api.ts';
import { XLSX_MIME, buildXlsx } from '../_shared/xlsx.ts';
import { handler } from './index.ts';

const BOM = String.fromCharCode(0xfeff);
const COUNTRY = '0198a8b0-0000-7000-8000-0000000000aa';

let api: FakeApi;
let userId = '';
let token = '';

const SUMMARY = {
  batch_id: '0198a8b2-0000-7000-8000-000000000001',
  state: 'validated',
  source_kind: 'csv',
  row_count: 2,
  counts: { total: 2, valid: 1, invalid: 1, duplicate: 0 },
  ignored_columns: [],
  first_errors: [],
};

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://api.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  api = new FakeApi();
  vi.stubGlobal('fetch', api.fetch);
  userId = nextUserId('0198a8b0-0000-7000-9000');
  token = userToken(userId);
  api.on('POST', '/rest/v1/rpc/import_stage', jsonResponse(SUMMARY));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function send(body: BodyInit, headers: Record<string, string> = {}, query = ''): Promise<Response> {
  return handler(
    new Request(`http://fn.test/import${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    }),
  );
}

interface StageArgs {
  p_meta: Record<string, unknown>;
  p_rows: Array<Record<string, unknown>>;
}
function staged(): StageArgs {
  const calls = api.rpcCalls('import_stage');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.bearer()).toBe(token); // the caller's token: write scope decided by the database
  return calls[0]!.json<StageArgs>();
}

const CSV =
  BOM +
  'الاسم بالعربية,النوع,خط العرض,خط الطول,الطاقة الاستيعابية\r\n' +
  '"مسجد النور، الجديد",مسجد,-5.05,39.75,١٢٠\r\n' +
  ',school,999,39.7,\r\n';

describe('import — files parsed on the server', () => {
  it('multipart CSV (file + lang + options) is parsed and staged with the caller token', async () => {
    const form = new FormData();
    form.append('file', new Blob([CSV], { type: 'text/csv' }), 'C:\\Users\\x\\مشاريع.csv');
    form.append('lang', 'ar');
    form.append('options', JSON.stringify({ country_id: COUNTRY, unknown_option: 1 }));
    const res = await send(form);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ...SUMMARY,
      file: {
        kind: 'csv',
        encoding: 'utf-8',
        delimiter: ',',
        header_row: 1,
        rows: 2,
        headers: ['الاسم بالعربية', 'النوع', 'خط العرض', 'خط الطول', 'الطاقة الاستيعابية'],
      },
    });

    const args = staged();
    expect(args.p_meta).toEqual({
      source_kind: 'csv',
      file_name: 'مشاريع.csv',
      country_id: COUNTRY,
      lang: 'ar',
    });
    expect(args.p_rows).toEqual([
      {
        'الاسم بالعربية': 'مسجد النور، الجديد',
        النوع: 'مسجد',
        'خط العرض': '-5.05',
        'خط الطول': '39.75',
        'الطاقة الاستيعابية': '١٢٠',
      },
      { النوع: 'school', 'خط العرض': '999', 'خط الطول': '39.7' },
    ]);
  });

  it('a raw XLSX body (options in the query string): cell values, never formulas', async () => {
    const workbook = await buildXlsx(
      {
        sheetName: 'Projects',
        rtl: false,
        columns: [{ header: 'name_ar' }, { header: 'capacity' }, { header: 'note' }],
      },
      [
        ['مسجد التقوى', 150, '=1+1'],
        ['مدرسة', null, 'ok'],
      ],
    );
    const res = await send(
      workbook as BodyInit,
      { 'content-type': XLSX_MIME },
      '?file_name=book.xlsx&branch_id=0198a8b0-0000-7000-8000-0000000000bb',
    );
    expect(res.status).toBe(200);
    const args = staged();
    expect(args.p_meta).toEqual({
      source_kind: 'xlsx',
      file_name: 'book.xlsx',
      branch_id: '0198a8b0-0000-7000-8000-0000000000bb',
    });
    // our own export guard (apostrophe) is removed again on import; the text stays text
    expect(args.p_rows).toEqual([
      { name_ar: 'مسجد التقوى', capacity: 150, note: '=1+1' },
      { name_ar: 'مدرسة', note: 'ok' },
    ]);
  });

  it('JSON rows parsed on the device (v2 migration) are forwarded as they are', async () => {
    const rows = [{ name_ar: 'مسجد', type: 'mosque', lat: -5, lon: 39 }];
    const res = await send(
      JSON.stringify({ rows, meta: { source_kind: 'v2_json', file_name: 'v2-backup.json' } }),
      { 'content-type': 'application/json' },
    );
    expect(res.status).toBe(200);
    const args = staged();
    expect(args.p_rows).toEqual(rows);
    expect(args.p_meta).toEqual({ source_kind: 'v2_json', file_name: 'v2-backup.json' });
    expect((await res.json()) as object).toMatchObject({ file: null });
  });

  it('storage_path: the uploaded file is read from bucket "imports" with the caller token', async () => {
    const path = `${userId}/big.csv`;
    api.on('GET', `/storage/v1/object/imports/${path}`, (req) => {
      expect(req.bearer()).toBe(token);
      return new Response(CSV, { headers: { 'content-type': 'text/csv' } });
    });
    const res = await send(JSON.stringify({ storage_path: path }), {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(staged().p_meta).toEqual({
      source_kind: 'csv',
      file_name: 'big.csv',
      storage_path: path,
    });
  });

  it('passes the database refusal through (viewer → 403)', async () => {
    api.on(
      'POST',
      '/rest/v1/rpc/import_stage',
      pgError(403, 'PT403', 'only users with write access may import'),
    );
    const res = await send(CSV, { 'content-type': 'text/csv' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PT403' });
  });
});

describe('import — refused before anything is staged', () => {
  it('more than 5,000 data rows', async () => {
    const lines = ['name_ar,type'];
    for (let i = 0; i < 5001; i++) lines.push(`m${i},mosque`);
    const res = await send(lines.join('\n'), { 'content-type': 'text/csv' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toBe('too_many_rows');

    const json = await send(
      JSON.stringify({ rows: Array.from({ length: 5001 }, () => ({ a: 1 })) }),
      {
        'content-type': 'application/json',
      },
    );
    expect(json.status).toBe(422);
    expect(api.rpcCalls('import_stage')).toHaveLength(0);
  });

  it('empty files, header-only files, legacy .xls and malformed requests', async () => {
    const cases: Array<[BodyInit, Record<string, string>, number, string]> = [
      ['', { 'content-type': 'text/csv' }, 422, 'empty_file'],
      [`${BOM}name_ar,type\r\n`, { 'content-type': 'text/csv' }, 422, 'empty_file'],
      [
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
        { 'content-type': 'application/vnd.ms-excel' },
        415,
        'unsupported_file_type',
      ],
      [
        JSON.stringify({ rows: [1, 2] }),
        { 'content-type': 'application/json' },
        422,
        'invalid_rows',
      ],
      [JSON.stringify({ meta: {} }), { 'content-type': 'application/json' }, 422, 'rows_required'],
      ['{oops', { 'content-type': 'application/json' }, 400, 'invalid_json'],
      [
        JSON.stringify({ rows: [{}], options: { country_id: 'tz' } }),
        { 'content-type': 'application/json' },
        422,
        'invalid_options',
      ],
    ];
    for (const [body, headers, status, message] of cases) {
      const res = await send(body, headers);
      expect(res.status, message).toBe(status);
      expect(((await res.json()) as { message: string }).message).toBe(message);
    }
    const noFile = new FormData();
    noFile.append('lang', 'ar');
    const res = await send(noFile);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toBe('file_required');
    expect(api.rpcCalls('import_stage')).toHaveLength(0);
  });

  it('requires a signed-in user', async () => {
    const res = await handler(new Request('http://fn.test/import', { method: 'POST', body: CSV }));
    expect(res.status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });
});
