import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv } from '../_shared/csv.ts';
import {
  FakeApi,
  jsonResponse,
  nextUserId,
  pgError,
  userToken,
  type RecordedRequest,
} from '../_shared/fake-api.ts';
import type { ExportColumns } from '../_shared/labels.ts';
import { readXlsx } from '../_shared/xlsx-read.ts';
import { isZip } from '../_shared/zip.ts';

const SERVICE_KEY = 'service-role-key-for-tests';
const BOM = String.fromCharCode(0xfeff);

const COLUMNS: ExportColumns = {
  lang: 'ar',
  dir: 'rtl',
  list_separator: ' | ',
  capabilities: { people: false, restricted: false },
  columns: [
    { key: 'code', header: 'رمز المشروع', kind: 'text' },
    { key: 'name_ar', header: 'الاسم', kind: 'text' },
    { key: 'type', header: 'النوع', kind: 'enum', enum: 'project_type' },
    { key: 'status', header: 'الحالة', kind: 'enum', enum: 'project_status' },
    { key: 'capacity', header: 'السعة', kind: 'integer' },
    { key: 'land_expandable', header: 'قابلية التوسع', kind: 'boolean', enum: 'boolean' },
  ],
  enums: {
    project_type: { mosque: 'مسجد', school: 'مدرسة قرآن', combined: 'مسجد ومدرسة' },
    project_status: { active: 'يعمل', maintenance: 'يحتاج صيانة' },
    boolean: { true: 'نعم', false: 'لا' },
  },
};

const ROWS = [
  {
    code: 'TZ-PN-000001',
    name_ar: 'مسجد النور',
    type: 'mosque',
    status: 'active',
    capacity: 120,
    land_expandable: true,
  },
  {
    code: 'TZ-PN-000002',
    name_ar: '=HYPERLINK("x")',
    type: 'school',
    status: 'maintenance',
    capacity: null,
    land_expandable: false,
  },
  {
    code: 'TZ-PN-000003',
    name_ar: 'مدرسة الفرقان، القديمة',
    type: 'combined',
    status: 'active',
    capacity: 80,
    land_expandable: null,
  },
];

let api: FakeApi;
let userId = '';
let token = '';

type Handler = (req: Request) => Promise<Response>;

/** Import the function fresh (its limits are read from the environment at load time). */
async function loadHandler(extraEnv: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(extraEnv)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import('./index.ts')).handler;
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://api.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  api = new FakeApi();
  vi.stubGlobal('fetch', api.fetch);
  userId = nextUserId('0198a8b0-0000-7000-8000');
  token = userToken(userId);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:
      over.id ??
      `0198a8b1-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    user_id: userId,
    format: 'csv',
    lang: 'ar',
    filters: {},
    state: 'queued',
    storage_path: null,
    file_name: null,
    bytes: null,
    row_count: null,
    stats: {},
    error: null,
    attempts: 0,
    started_at: null,
    finished_at: null,
    expires_at: null,
    created_at: '2026-10-04T08:00:00Z',
    updated_at: new Date().toISOString(),
    ...over,
  };
}

/** The database side of a whole export: finish(running|done|failed), columns, two pages of rows. */
function serveExport(theJob: Record<string, unknown>, rows = ROWS, pageSize = 2): void {
  api
    .on('POST', '/rest/v1/rpc/export_finish', (req) => {
      const args = req.json<{ p_state: string }>();
      return jsonResponse({ ...theJob, state: args.p_state, attempts: 1 });
    })
    .on('POST', '/rest/v1/rpc/export_columns', jsonResponse(COLUMNS))
    .on('POST', '/rest/v1/rpc/export_rows', (req) => {
      const after = req.json<{ p_after: { id: string } | null }>().p_after;
      const start = after === null ? 0 : Number(after.id);
      const slice = rows.slice(start, start + pageSize);
      const end = start + slice.length;
      const done = end >= rows.length;
      return jsonResponse({
        job_id: theJob.id,
        count: slice.length,
        done,
        next: done ? null : { id: String(end) },
        rows: slice,
      });
    })
    .on('POST', /^\/storage\/v1\/object\/exports\//, (req) =>
      jsonResponse({ Id: 'obj-1', Key: req.path.replace('/storage/v1/object/', '') }),
    )
    .on('PATCH', '/rest/v1/export_jobs', jsonResponse([]))
    .on('DELETE', '/storage/v1/object/exports', jsonResponse([]));
}

function post(handler: Handler, body: unknown): Promise<Response> {
  return handler(
    new Request('http://fn.test/export', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-device-id': 'dev-1',
      },
      body: JSON.stringify(body),
    }),
  );
}

function get(handler: Handler, query: string): Promise<Response> {
  return handler(
    new Request(`http://fn.test/export${query}`, { headers: { authorization: `Bearer ${token}` } }),
  );
}

function finishCalls(state: string): RecordedRequest[] {
  return api
    .rpcCalls('export_finish')
    .filter((c) => c.json<{ p_state: string }>().p_state === state);
}

async function waitForFinish(state: 'done' | 'failed'): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(finishCalls(state)).toHaveLength(1), { timeout: 3000 });
  return finishCalls(state)[0]!.json();
}

async function uploadedBytes(req: RecordedRequest): Promise<Uint8Array> {
  if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await req.form();
    const file = form.get('');
    if (!(file instanceof Blob)) throw new Error('no file part');
    return new Uint8Array(await file.arrayBuffer());
  }
  return req.bytes;
}

describe('export — POST { format, lang, filters }', () => {
  it('creates the job with the caller token, answers 202 at once and builds the CSV in the background', async () => {
    const handler = await loadHandler();
    const theJob = job();
    api.on('POST', '/rest/v1/rpc/export_request', jsonResponse(theJob));
    serveExport(theJob);

    const res = await post(handler, { format: 'csv', lang: 'ar', filters: { type: 'mosque' } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      job: { id: theJob.id, state: 'queued' },
      status: `?job=${theJob.id}`,
    });
    expect(api.rpcCalls('export_request')[0]!.json()).toEqual({
      p_format: 'csv',
      p_lang: 'ar',
      p_filters: { type: 'mosque' },
    });

    const done = await waitForFinish('done');
    const path = `${userId}/${theJob.id}.csv`;
    const upload = api.callsTo('POST', `/storage/v1/object/exports/${path}`)[0]!;
    const bytes = await uploadedBytes(upload);
    expect(done).toMatchObject({
      p_job_id: theJob.id,
      p_state: 'done',
      p_storage_path: path,
      p_row_count: 3,
      p_bytes: bytes.byteLength,
    });
    expect(String(done.p_file_name)).toMatch(/^istiqama-projects-\d{8}-[0-9a-f]{8}\.csv$/);

    // the file: BOM, CRLF, Arabic header, translated values, guarded formula, quoted comma
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text).toContain('\r\n');
    const table = parseCsv(text).rows;
    expect(table[0]).toEqual(['رمز المشروع', 'الاسم', 'النوع', 'الحالة', 'السعة', 'قابلية التوسع']);
    expect(table[1]).toEqual(['TZ-PN-000001', 'مسجد النور', 'مسجد', 'يعمل', '120', 'نعم']);
    expect(table[2]).toEqual([
      'TZ-PN-000002',
      `'=HYPERLINK("x")`,
      'مدرسة قرآن',
      'يحتاج صيانة',
      '',
      'لا',
    ]);
    expect(table[3]).toEqual([
      'TZ-PN-000003',
      'مدرسة الفرقان، القديمة',
      'مسجد ومدرسة',
      'يعمل',
      '80',
      '',
    ]);

    // who did what: data with the caller's token, upload and bookkeeping with the service key
    for (const fn of ['export_request', 'export_columns', 'export_rows'])
      for (const c of api.rpcCalls(fn)) expect(c.bearer(), fn).toBe(token);
    for (const c of api.rpcCalls('export_finish')) expect(c.bearer()).toBe(SERVICE_KEY);
    expect(upload.bearer()).toBe(SERVICE_KEY);
    expect(api.rpcCalls('export_columns')[0]!.json()).toEqual({ p_lang: 'ar' });
    expect(api.rpcCalls('export_rows').map((c) => c.json())).toEqual([
      { p_job_id: theJob.id, p_after: null, p_limit: 1000 },
      { p_job_id: theJob.id, p_after: { id: '2' }, p_limit: 1000 },
    ]);
    // running is reported before the first page is read
    expect(api.calls.findIndex((c) => c.path.endsWith('/export_finish'))).toBeLessThan(
      api.calls.findIndex((c) => c.path.endsWith('/export_rows')),
    );
  });

  it('builds an XLSX workbook (RTL, header row) and uploads it as .xlsx', async () => {
    const handler = await loadHandler();
    const theJob = job({ format: 'xlsx' });
    api.on('POST', '/rest/v1/rpc/export_request', jsonResponse(theJob));
    serveExport(theJob);

    expect((await post(handler, { format: 'xlsx', lang: 'ar' })).status).toBe(202);
    const done = await waitForFinish('done');
    const path = `${userId}/${theJob.id}.xlsx`;
    expect(done).toMatchObject({ p_storage_path: path, p_row_count: 3 });
    const bytes = await uploadedBytes(
      api.callsTo('POST', `/storage/v1/object/exports/${path}`)[0]!,
    );
    expect(isZip(bytes)).toBe(true);
    expect(done.p_bytes).toBe(bytes.byteLength);
    const sheet = await readXlsx(bytes, { maxRows: 100 });
    expect(sheet.name).toBe('المشاريع');
    expect(sheet.rows[0]).toEqual([
      'رمز المشروع',
      'الاسم',
      'النوع',
      'الحالة',
      'السعة',
      'قابلية التوسع',
    ]);
    expect(sheet.rows[1]).toEqual(['TZ-PN-000001', 'مسجد النور', 'مسجد', 'يعمل', 120, 'نعم']);
    // verbatim text in an inline string (never evaluated), no apostrophe added to the value
    expect(sheet.rows[2]?.[1]).toBe(`=HYPERLINK("x")`);
    expect(sheet.formulaCells).toBe(0);
  });

  it('beyond the XLSX row limit the job is delivered as CSV and says why', async () => {
    const handler = await loadHandler({ EXPORT_XLSX_MAX_ROWS: '2' });
    const theJob = job({ format: 'xlsx' });
    api.on('POST', '/rest/v1/rpc/export_request', jsonResponse(theJob));
    serveExport(theJob);

    expect((await post(handler, { format: 'xlsx', lang: 'ar' })).status).toBe(202);
    const done = await waitForFinish('done');
    expect(done).toMatchObject({ p_storage_path: `${userId}/${theJob.id}.csv`, p_row_count: 3 });
    expect(String(done.p_file_name)).toMatch(/\.csv$/);
    expect(api.callsTo('POST', /\.xlsx$/)).toHaveLength(0);
    const stats = api
      .callsTo('PATCH', '/rest/v1/export_jobs')[0]!
      .json<{ stats: Record<string, unknown> }>();
    expect(stats.stats).toMatchObject({
      format_delivered: 'csv',
      fallback: { from: 'xlsx', to: 'csv', reason: 'row_limit', limit: 2 },
    });
  });

  it('a failing page fails the job: export_finish(failed) with the cause, partial file removed', async () => {
    const handler = await loadHandler();
    const theJob = job();
    api.on('POST', '/rest/v1/rpc/export_request', jsonResponse(theJob));
    serveExport(theJob);
    // the owner cancelled the job while the first page was being read
    api.on('POST', '/rest/v1/rpc/export_rows', pgError(409, 'PT409', 'export job is cancelled'));

    expect((await post(handler, { format: 'csv' })).status).toBe(202);
    const failed = await waitForFinish('failed');
    expect(failed).toMatchObject({ p_job_id: theJob.id, p_state: 'failed' });
    expect(String(failed.p_error)).toContain('PT409');
    expect(String(failed.p_error)).toContain('cancelled');
    expect(finishCalls('done')).toHaveLength(0);
    const removal = api.callsTo('DELETE', '/storage/v1/object/exports')[0]!;
    expect(removal.json()).toEqual({ prefixes: [`${userId}/${theJob.id}.csv`] });
    expect(removal.bearer()).toBe(SERVICE_KEY);
  });

  it('validates the request before creating a job', async () => {
    const handler = await loadHandler();
    const cases: Array<[unknown, string]> = [
      [{ format: 'pdf' }, 'invalid_format'],
      [{}, 'invalid_format'],
      [{ format: 'csv', lang: 'fr' }, 'invalid_lang'],
      [{ format: 'csv', filters: ['x'] }, 'invalid_filters'],
      [{ job_id: 'nope' }, 'invalid_job_id'],
      [[1, 2], 'invalid_body'],
    ];
    for (const [body, message] of cases) {
      const res = await post(handler, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { message: string }).message).toBe(message);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('passes the database refusal of export_request through (rate limit with Retry-After)', async () => {
    const handler = await loadHandler();
    api.on(
      'POST',
      '/rest/v1/rpc/export_request',
      jsonResponse(
        {
          code: 'PT429',
          message: 'rate_limited',
          details: '20 exports per hour',
          hint: 'Retry in 600 seconds.',
        },
        429,
      ),
    );
    const res = await post(handler, { format: 'csv' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(await res.json()).toMatchObject({ code: 'PT429', message: 'rate_limited' });
    expect(api.rpcCalls('export_request')).toHaveLength(1); // never retried: it would create a second job
  });
});

describe('export — POST { job_id } (job created by the client)', () => {
  it('loads the job with the caller token (RLS: own jobs only) and processes it', async () => {
    const handler = await loadHandler();
    const theJob = job();
    api.on('GET', '/rest/v1/export_jobs', (req) => {
      expect(req.bearer()).toBe(token);
      expect(req.url.searchParams.get('id')).toBe(`eq.${String(theJob.id)}`);
      return jsonResponse([theJob]);
    });
    serveExport(theJob);
    const res = await post(handler, { job_id: theJob.id });
    expect(res.status).toBe(202);
    await waitForFinish('done');
    expect(api.rpcCalls('export_request')).toHaveLength(0);
  });

  it("somebody else's (or an unknown) job is a 404", async () => {
    const handler = await loadHandler();
    api.on('GET', '/rest/v1/export_jobs', jsonResponse([]));
    const res = await post(handler, { job_id: '0198a8b1-0000-7000-8000-000000000999' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe('export_job_not_found');
    expect(api.rpcCalls('export_finish')).toHaveLength(0);
  });

  it('a job that is running elsewhere is not processed a second time; finished jobs are refused', async () => {
    const handler = await loadHandler();
    const running = job({ state: 'running', updated_at: new Date().toISOString() });
    const failed = job({ state: 'failed' });
    api.on('GET', '/rest/v1/export_jobs', (req) =>
      jsonResponse([
        req.url.searchParams.get('id') === `eq.${String(running.id)}` ? running : failed,
      ]),
    );
    const res = await post(handler, { job_id: running.id });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.rpcCalls('export_finish')).toHaveLength(0);

    const again = await post(handler, { job_id: failed.id });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { message: string }).message).toBe('export_not_active');
  });
});

describe('export — GET ?job=<id>', () => {
  it('a done job comes with a short-lived signed URL, signed by the function after the CALLER read the job', async () => {
    const handler = await loadHandler();
    const path = `${userId}/job-done.csv`;
    const done = job({
      state: 'done',
      storage_path: path,
      file_name: 'istiqama-projects.csv',
      bytes: 10,
      row_count: 1,
    });
    api
      .on('GET', '/rest/v1/export_jobs', (req) => {
        // the job is read with the caller's token and soft-deleted jobs are excluded
        expect(req.bearer()).toBe(token);
        expect(req.url.searchParams.get('deleted_at')).toBe('is.null');
        return jsonResponse([done]);
      })
      .on('POST', `/storage/v1/object/sign/exports/${path}`, (req) => {
        // fixed lifetime, service role: clients never sign export files themselves
        expect(req.bearer()).toBe(SERVICE_KEY);
        expect(req.json()).toEqual({ expiresIn: 300 });
        return jsonResponse({ signedURL: `/object/sign/exports/${path}?token=signed-token` });
      });
    const res = await get(handler, `?job=${String(done.id)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      job: { state: string };
      download: Record<string, unknown>;
    };
    expect(body.job.state).toBe('done');
    expect(body.download).toMatchObject({
      expires_in: 300,
      bucket: 'exports',
      storage_path: path,
      file_name: 'istiqama-projects.csv',
      row_count: 1,
    });
    expect(String(body.download.url)).toContain('token=signed-token');
    expect(String(body.download.url)).toContain('download=istiqama-projects.csv');
    expect(String(body.download.path)).toMatch(/^\/storage\/v1\/object\/sign\/exports\//);
  });

  it('never signs a deleted / foreign job, a path outside the owner folder, or a longer lifetime', async () => {
    // EXPORT_SIGNED_URL_SECONDS cannot raise the lifetime above 300 s
    const handler = await loadHandler({ EXPORT_SIGNED_URL_SECONDS: '315360000' });
    // soft-deleted (or somebody else's) job: the caller's read returns nothing → 404, no signing
    api.on('GET', '/rest/v1/export_jobs', jsonResponse([]));
    const gone = await get(handler, `?job=${String(job().id)}`);
    expect(gone.status).toBe(404);
    expect(api.calls.some((c) => c.path.startsWith('/storage/'))).toBe(false);

    // a path outside the owner's folder is never signed
    const odd = job({ state: 'done', storage_path: `${nextUserId()}/x.csv`, file_name: 'x.csv' });
    api.on('GET', '/rest/v1/export_jobs', jsonResponse([odd]));
    const res = await get(handler, `?job=${String(odd.id)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { download: unknown }).download).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith('/storage/'))).toBe(false);

    // the lifetime stays capped
    const path = `${userId}/capped.csv`;
    const done = job({ state: 'done', storage_path: path, file_name: 'capped.csv' });
    api
      .on('GET', '/rest/v1/export_jobs', jsonResponse([done]))
      .on('POST', `/storage/v1/object/sign/exports/${path}`, (req) => {
        expect(req.json<{ expiresIn: number }>().expiresIn).toBeLessThanOrEqual(300);
        return jsonResponse({ signedURL: `/object/sign/exports/${path}?token=t` });
      });
    const ok = await get(handler, `?job=${String(done.id)}`);
    const body = (await ok.json()) as { download: { expires_in: number } };
    expect(body.download.expires_in).toBeLessThanOrEqual(300);
  });

  it('a queued job has no download; a bad id is a 422', async () => {
    const handler = await loadHandler();
    const queued = job();
    api.on('GET', '/rest/v1/export_jobs', jsonResponse([queued]));
    const res = await get(handler, `?job=${String(queued.id)}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).not.toHaveProperty('download');
    expect((await get(handler, '?job=123')).status).toBe(422);
    expect((await get(handler, '')).status).toBe(422);
  });
});
