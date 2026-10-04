/** The real server layer of the wizard against mocked supabase-js / transport. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../auth', () => ({ supabase: { functions: { invoke: m.invoke }, from: m.from } }));
vi.mock('../sync', () => ({
  transport: { rpc: m.rpc },
  isSyncError: () => false,
  errorKey: () => 'sync.error_unknown',
}));

import { ImportApiError, supabaseImportApi as api, uploadPath } from './api';
import { importErrorText } from './labels';
import { setLocale } from '../i18n';
import { BATCH_ID, LIVE_ROWS, LIVE_TEMPLATE, LIVE_UPLOAD } from './testing/fixtures';

beforeEach(async () => {
  m.invoke.mockReset();
  m.rpc.mockReset();
  m.from.mockReset();
  await setLocale('en');
});

describe('import api', () => {
  it('uploads the raw file with name and language in the query string', async () => {
    m.invoke.mockResolvedValue({ data: LIVE_UPLOAD, error: null });
    const file = new File(['a,b\n1,2\n'], 'مشاريع بيمبا.csv', { type: 'text/csv' });
    const result = await api.upload(file, { lang: 'sw' });
    expect(result.batchId).toBe(BATCH_ID);
    const [path, init] = m.invoke.mock.calls[0]!;
    expect(path).toBe(uploadPath(file, { lang: 'sw' }));
    const query = new URLSearchParams(String(path).split('?')[1]);
    expect(String(path).startsWith('import?')).toBe(true);
    expect(query.get('lang')).toBe('sw');
    expect(query.get('file_name')).toBe('مشاريع بيمبا.csv');
    expect(init).toMatchObject({
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  it('turns a refused upload into ImportApiError with the reason of the body', async () => {
    const context = new Response(
      JSON.stringify({ code: 'PT422', message: 'too_many_rows', details: '6000 rows' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
    m.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('x'), { name: 'FunctionsHttpError', context }),
    });
    const error = await api
      .upload(new File(['x'], 'a.csv'), { lang: 'en' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportApiError);
    expect(error).toMatchObject({
      code: 'PT422',
      message: 'too_many_rows',
      status: 422,
      details: '6000 rows',
    });
    expect(importErrorText(error)).toMatch(/more than 5,000 rows/);

    m.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('x'), { name: 'FunctionsFetchError', context: {} }),
    });
    const offline = await api
      .upload(new File(['x'], 'a.csv'), { lang: 'en' })
      .catch((e: unknown) => e);
    expect(offline).toMatchObject({ code: 'network' });
    expect(importErrorText(offline)).toMatch(/cannot be reached/);
    expect(importErrorText(new ImportApiError('PT415', 'whatever', 415))).toMatch(/not supported/);
    expect(importErrorText(new ImportApiError('PT429', 'rate_limited', 429))).toMatch(
      /Too many attempts/,
    );
  });

  it('calls the RPCs with the contract argument names', async () => {
    m.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'import_template') return LIVE_TEMPLATE;
      if (fn === 'import_preview') return { ...LIVE_UPLOAD, rows: LIVE_ROWS, next: 3 };
      if (fn === 'import_set_action') return LIVE_ROWS[2];
      if (fn === 'import_commit') return { ...LIVE_UPLOAD, committed: true };
      if (fn === 'import_rollback') return { ...LIVE_UPLOAD, rolled_back: true, reverted: 1 };
      return null;
    });
    expect((await api.template('ar')).columns).toHaveLength(5);
    expect((await api.preview(BATCH_ID, 0, 50, 'invalid')).next).toBe(3);
    await api.setAction(BATCH_ID, 3, 'update', 'target-1');
    await api.setAction(BATCH_ID, 1, 'skip');
    expect((await api.commit(BATCH_ID)).committed).toBe(true);
    expect((await api.rollback(BATCH_ID)).reverted).toBe(1);
    expect(m.rpc.mock.calls).toEqual([
      ['import_template', { p_lang: 'ar' }],
      ['import_preview', { p_batch_id: BATCH_ID, p_after: 0, p_limit: 50, p_only: 'invalid' }],
      [
        'import_set_action',
        { p_batch_id: BATCH_ID, p_row_no: 3, p_action: 'update', p_target_id: 'target-1' },
      ],
      ['import_set_action', { p_batch_id: BATCH_ID, p_row_no: 1, p_action: 'skip' }],
      ['import_commit', { p_batch_id: BATCH_ID }],
      ['import_rollback', { p_batch_id: BATCH_ID }],
    ]);
  });

  it('reads the own batches, newest first, live only', async () => {
    const calls: string[] = [];
    const chain = {
      select: (cols: string) => (calls.push(`select:${cols}`), chain),
      is: (c: string, v: unknown) => (calls.push(`is:${c}=${String(v)}`), chain),
      order: (c: string, o: { ascending: boolean }) => (
        calls.push(`order:${c}:${o.ascending}`),
        chain
      ),
      limit: async (n: number) => {
        calls.push(`limit:${n}`);
        return {
          data: [
            { id: 'b1', state: 'committed', stats: {}, created_at: '2026-10-04T00:00:00Z' },
            { nope: 1 },
          ],
          error: null,
        };
      },
    };
    m.from.mockReturnValue(chain);
    const rows = await api.batches(20);
    expect(m.from).toHaveBeenCalledWith('import_batches');
    expect(rows.map((r) => r.id)).toEqual(['b1']);
    expect(calls).toContain('is:deleted_at=null');
    expect(calls).toContain('order:created_at:false');
    expect(calls).toContain('limit:20');
  });
});
