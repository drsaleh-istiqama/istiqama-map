/**
 * Import wizard flows against a mocked server layer (`setImportApi`): template download,
 * device-side file checks, upload → review page by page with translated errors and duplicate
 * candidates, row actions, refused and successful commit, history with rollback.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => {
  const { computed, signal } = await import('@preact/signals');
  const role = signal('field_collector');
  return {
    __role: role,
    session: signal({ user: { id: 'u1' } }),
    me: signal({ user_id: 'u1' }),
    can: {
      write: computed(() => role.value !== 'viewer'),
      review: computed(() => false),
      seePeople: computed(() => true),
      seeRestricted: computed(() => false),
      admin: computed(() => false),
    },
    supabase: {},
  };
});
vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: async () => undefined,
    transport: { rpc: async () => null },
    isSyncError: () => false,
    errorKey: () => 'sync.error_unknown',
  };
});

import * as auth from '../auth';
import { freshDb } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { ImportApiError, setImportApi, type ImportApi } from './api';
import ImportPage from './ImportPage';
import {
  BATCH_ID,
  DUP_TARGET,
  LIVE_ROWS,
  LIVE_TEMPLATE,
  LIVE_TEMPLATE_EN,
  LIVE_UPLOAD,
} from './testing/fixtures';
import {
  parseCommit,
  parsePreview,
  parseRollback,
  parseRow,
  parseTemplate,
  parseUpload,
  type BatchRow,
  type PreviewFilter,
} from './types';

const role = (auth as unknown as { __role: { value: string } }).__role;

function fakeApi() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let rows = structuredClone(LIVE_ROWS) as Array<Record<string, unknown>>;
  let counts = { ...LIVE_UPLOAD.counts };
  let commitAnswer: unknown = {
    ...LIVE_UPLOAD,
    state: 'committed',
    committed: true,
    counts: { ...counts, applied_created: 1 },
  };
  let batches: BatchRow[] = [];
  const api: ImportApi = {
    async template(lang) {
      calls.push({ fn: 'template', args: [lang] });
      return parseTemplate(lang === 'en' ? LIVE_TEMPLATE_EN : LIVE_TEMPLATE);
    },
    async upload(file, options) {
      calls.push({ fn: 'upload', args: [file, options] });
      return parseUpload(LIVE_UPLOAD);
    },
    async preview(batchId, after, limit, only) {
      calls.push({ fn: 'preview', args: [batchId, after, limit, only] });
      const filtered = rows.filter((r) => filterRow(r, only));
      const page = filtered.filter((r) => (r.row_no as number) > after).slice(0, 2);
      const last = page[page.length - 1];
      const more = last && filtered.some((r) => (r.row_no as number) > (last.row_no as number));
      return parsePreview({ ...LIVE_UPLOAD, counts, rows: page, next: more ? last!.row_no : null });
    },
    async setAction(batchId, rowNo, action, targetId) {
      calls.push({ fn: 'setAction', args: [batchId, rowNo, action, targetId] });
      rows = rows.map((r) =>
        r.row_no === rowNo ? { ...r, action, target_id: targetId ?? r.target_id } : r,
      );
      counts = {
        ...counts,
        skip: counts.skip - 1,
        [action]: (counts as Record<string, number>)[action]! + 1,
      };
      return parseRow(rows.find((r) => r.row_no === rowNo))!;
    },
    async commit(batchId) {
      calls.push({ fn: 'commit', args: [batchId] });
      return parseCommit(commitAnswer);
    },
    async rollback(batchId) {
      calls.push({ fn: 'rollback', args: [batchId] });
      batches = batches.map((b) => (b.id === batchId ? { ...b, state: 'rolled_back' } : b));
      return parseRollback({
        state: 'rolled_back',
        rolled_back: true,
        reverted: 2,
        kept: 1,
        no_access: 1,
        conflicting_fields: 3,
      });
    },
    async batches(limit) {
      calls.push({ fn: 'batches', args: [limit] });
      return batches;
    },
  };
  return {
    api,
    calls,
    of: (fn: string) => calls.filter((c) => c.fn === fn),
    setCommitAnswer: (v: unknown) => {
      commitAnswer = v;
    },
    setBatches: (b: BatchRow[]) => {
      batches = b;
    },
  };
}

function filterRow(r: Record<string, unknown>, only: PreviewFilter | null): boolean {
  switch (only) {
    case null:
      return true;
    case 'invalid':
    case 'duplicate':
    case 'valid':
      return r.state === only;
    case 'warnings':
      return (r.warnings as unknown[]).length > 0;
    default:
      return r.action === only;
  }
}

function pick(input: HTMLElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const csv = (name = 'projects.csv', size?: number): File => {
  const f = new File(['name_ar,type\nمسجد,mosque\n'], name, { type: 'text/csv' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
};

let api: ReturnType<typeof fakeApi>;

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  role.value = 'field_collector';
  api = fakeApi();
  setImportApi(api.api);
});

afterEach(() => {
  setImportApi(null);
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function uploadSample(): Promise<HTMLElement> {
  render(<ImportPage />);
  pick(screen.getByTestId('import-file'), csv());
  await screen.findByTestId('import-file-chosen');
  fireEvent.click(screen.getByTestId('import-upload-submit'));
  return screen.findByTestId('import-preview');
}

describe('import wizard', () => {
  it('needs write access', () => {
    role.value = 'viewer';
    render(<ImportPage />);
    expect(screen.getByTestId('import-no-access')).toBeTruthy();
    expect(screen.queryByTestId('import-file')).toBeNull();
  });

  it('downloads the official template as CSV with a BOM, headers in the chosen language', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob);
      return 'blob:template';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(<ImportPage />);
    fireEvent.change(screen.getByTestId('import-template-lang'), { target: { value: 'ar' } });
    fireEvent.click(screen.getByTestId('import-template-csv'));
    await waitFor(() => expect(created).toHaveLength(1));
    const bytes = new Uint8Array(await created[0]!.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain('اسم المشروع (عربي),النوع');
    expect(api.of('template').map((c) => c.args[0])).toContain('ar');

    fireEvent.click(screen.getByTestId('import-template-guide'));
    const table = await screen.findByTestId('import-guide-table');
    expect(table.textContent).toContain('مدرسة قرآن (school)');
  });

  it('checks size and type on the device before sending anything', async () => {
    render(<ImportPage />);
    pick(screen.getByTestId('import-file'), csv('big.csv', 11 * 1024 * 1024));
    expect((await screen.findByTestId('import-file-error')).textContent).toMatch(/larger than/i);
    pick(screen.getByTestId('import-file'), csv('old.xls'));
    await waitFor(() =>
      expect(screen.getByTestId('import-file-error').textContent).toMatch(/\.csv or \.xlsx/),
    );
    expect((screen.getByTestId('import-upload-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(api.of('upload')).toHaveLength(0);
  });

  it('shows a refused upload in the user’s language (5,000 rows limit)', async () => {
    api.api.upload = async () => {
      throw new ImportApiError('PT422', 'too_many_rows', 422, '6000 rows');
    };
    render(<ImportPage />);
    pick(screen.getByTestId('import-file'), csv());
    fireEvent.click(await screen.findByTestId('import-upload-submit'));
    expect((await screen.findByTestId('import-file-error')).textContent).toMatch(
      /more than 5,000 rows/,
    );
  });

  it('upload → review: counts, translated errors per cell, duplicate with the matched project', async () => {
    const preview = await uploadSample();
    const [file, options] = api.of('upload')[0]!.args as [File, { lang: string }];
    expect(file.name).toBe('projects.csv');
    expect(options.lang).toBe('en');
    expect(preview.getAttribute('data-batch')).toBe(BATCH_ID);
    expect(within(preview).getByTestId('import-count-invalid').textContent).toBe('1');
    expect(within(preview).getByTestId('import-ignored').textContent).toContain('ملاحظات');

    const rows = await within(preview).findAllByTestId('import-row');
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(['1', '2']);
    const invalid = rows[1]!;
    const errors = within(invalid).getAllByTestId('import-error');
    expect(errors.map((e) => e.getAttribute('data-code'))).toEqual([
      'invalid_value',
      'invalid_number',
      'required',
    ]);
    // Field label = template header in the interface language; text translated by code.
    expect(errors[0]!.textContent).toBe('Type: Value not accepted.');
    expect(errors[2]!.textContent).toContain('Required cell is empty.');
    expect(within(invalid).queryByTestId('import-row-action')).toBeNull();

    // Page 2 (keyset: p_after = last row number of page 1).
    fireEvent.click(screen.getByTestId('import-page-next'));
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row').map((r) => r.getAttribute('data-row'))).toEqual([
        '3',
      ]),
    );
    expect(api.of('preview').at(-1)!.args).toEqual([BATCH_ID, 2, 50, null]);
    const dup = screen.getAllByTestId('import-row')[0]!;
    expect(dup.getAttribute('data-state')).toBe('duplicate');
    const candidate = within(dup).getByTestId('import-candidate');
    expect(candidate.textContent).toContain('TZ-PN-000001');
    expect(candidate.querySelector('a')!.getAttribute('href')).toBe(`/projects/${DUP_TARGET}`);

    // "It is the same one" → update of the matched project.
    fireEvent.change(within(dup).getByTestId('import-row-action'), { target: { value: 'update' } });
    await waitFor(() => expect(api.of('setAction')).toHaveLength(1));
    expect(api.of('setAction')[0]!.args).toEqual([BATCH_ID, 3, 'update', DUP_TARGET]);
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row')[0]!.getAttribute('data-action')).toBe('update'),
    );

    fireEvent.click(screen.getByTestId('import-page-prev'));
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row')[0]!.getAttribute('data-row')).toBe('1'),
    );
  });

  it('a duplicate with several candidates can be merged into ANY of them, and names the target', async () => {
    const OTHER = '0b9f3c2e-5a61-4d7e-9c11-2f4e8a6b7c90';
    const plainPreview = api.api.preview;
    api.api.preview = async (...args) => {
      const page = await plainPreview(...args);
      for (const row of page.rows)
        for (const w of row.warnings)
          if (w.candidates?.length)
            w.candidates = [
              ...w.candidates,
              {
                ...w.candidates[0]!,
                id: OTHER,
                code: 'TZ-PN-000002',
                name_ar: 'مسجد النور الجديد',
                distance_m: 120,
              },
            ];
      return page;
    };
    await uploadSample();
    fireEvent.click(screen.getByTestId('import-filter-duplicate'));
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row').map((r) => r.getAttribute('data-row'))).toEqual([
        '3',
      ]),
    );
    let dup = screen.getAllByTestId('import-row')[0]!;
    expect(within(dup).getAllByTestId('import-candidate')).toHaveLength(2);
    const buttons = within(dup).getAllByTestId('import-candidate-merge');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.getAttribute('aria-label')).toContain('TZ-PN-000002');
    expect(within(dup).queryByTestId('import-row-target')).toBeNull();

    // "It is THIS one" on the second candidate → update with that target, not duplicate_of.
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(api.of('setAction')).toHaveLength(1));
    expect(api.of('setAction')[0]!.args).toEqual([BATCH_ID, 3, 'update', OTHER]);
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row')[0]!.getAttribute('data-action')).toBe('update'),
    );
    dup = screen.getAllByTestId('import-row')[0]!;
    const target = within(dup).getByTestId('import-row-target');
    expect(target.getAttribute('data-target')).toBe(OTHER);
    expect(target.textContent).toContain('TZ-PN-000002');
    // the chosen candidate is marked; the other one can still be picked instead
    const items = within(dup).getAllByTestId('import-candidate');
    expect(within(items[1]!).getByTestId('import-candidate-chosen')).toBeTruthy();
    expect(within(items[0]!).getByTestId('import-candidate-merge')).toBeTruthy();
    fireEvent.click(within(items[0]!).getByTestId('import-candidate-merge'));
    await waitFor(() => expect(api.of('setAction')).toHaveLength(2));
    expect(api.of('setAction')[1]!.args).toEqual([BATCH_ID, 3, 'update', DUP_TARGET]);
  });

  it('filters rows by state through import_preview(p_only)', async () => {
    await uploadSample();
    await screen.findAllByTestId('import-row');
    fireEvent.click(screen.getByTestId('import-filter-invalid'));
    await waitFor(() =>
      expect(api.of('preview').at(-1)!.args).toEqual([BATCH_ID, 0, 50, 'invalid']),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('import-row').map((r) => r.getAttribute('data-row'))).toEqual([
        '2',
      ]),
    );
  });

  it('a row refused at commit time is shown and nothing is reported as imported', async () => {
    api.setCommitAnswer({
      ...LIVE_UPLOAD,
      committed: false,
      failed_row: 3,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    await uploadSample();
    await screen.findAllByTestId('import-row');
    fireEvent.click(screen.getByTestId('import-commit'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    const refused = await screen.findByTestId('import-commit-refused');
    expect(refused.textContent).toContain('row 3');
    expect(refused.textContent).toContain('23505');
    expect(screen.queryByTestId('import-done')).toBeNull();
    // The refused row is shown first.
    await waitFor(() => expect(api.of('preview').at(-1)!.args).toEqual([BATCH_ID, 2, 50, null]));
  });

  it('cancelling the confirmation commits nothing', async () => {
    await uploadSample();
    await screen.findAllByTestId('import-row');
    fireEvent.click(screen.getByTestId('import-commit'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(api.of('commit')).toHaveLength(0);
  });

  it('commit → done with the applied counts; the history reloads', async () => {
    await uploadSample();
    await screen.findAllByTestId('import-row');
    const before = api.of('batches').length;
    fireEvent.click(screen.getByTestId('import-commit'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    const done = await screen.findByTestId('import-done');
    expect(within(done).getByTestId('import-done-counts').textContent).toBe(
      '1 created, 0 updated, 0 skipped.',
    );
    expect(api.of('commit')[0]!.args).toEqual([BATCH_ID]);
    await waitFor(() => expect(api.of('batches').length).toBeGreaterThan(before));
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(screen.getByTestId('import-upload')).toBeTruthy();
  });

  it('history: roll back a committed batch, continue a validated one', async () => {
    api.setBatches([
      {
        id: 'b-committed',
        state: 'committed',
        sourceKind: 'xlsx',
        fileName: 'tanga.xlsx',
        rowCount: 3,
        counts: { ...LIVE_UPLOAD.counts, applied_created: 2, applied_updated: 1 },
        createdAt: '2026-10-04T08:00:00Z',
        committedAt: '2026-10-04T08:05:00Z',
        rolledBackAt: null,
      },
      {
        id: BATCH_ID,
        state: 'validated',
        sourceKind: 'csv',
        fileName: 'probe.csv',
        rowCount: 3,
        counts: LIVE_UPLOAD.counts,
        createdAt: '2026-10-04T09:00:00Z',
        committedAt: null,
        rolledBackAt: null,
      },
    ]);
    render(<ImportPage />);
    const items = await screen.findAllByTestId('import-batch');
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['committed', 'validated']);
    expect(items[0]!.textContent).toContain('2 created, 1 updated');

    fireEvent.click(within(items[0]!).getByTestId('import-batch-rollback'));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('tanga.xlsx');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    const result = await screen.findByTestId('import-rollback-result');
    expect(result.textContent).toContain(
      '2 rolled back, 1 left as they are, 3 fields not restored',
    );
    expect(result.textContent).toMatch(/ask an administrator/);
    expect(api.of('rollback')[0]!.args).toEqual(['b-committed']);

    fireEvent.click(
      within(screen.getAllByTestId('import-batch')[1]!).getByTestId('import-batch-open'),
    );
    expect((await screen.findByTestId('import-preview')).getAttribute('data-batch')).toBe(BATCH_ID);
  });

  it('offline: nothing is requested and the user is told why', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      render(<ImportPage />);
      expect(screen.getByTestId('import-offline')).toBeTruthy();
      expect((screen.getByTestId('import-template-csv') as HTMLButtonElement).disabled).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(api.calls).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    }
  });

  it('the v2 migration panel is on the page (file input, no local data)', () => {
    render(<ImportPage />);
    const v2 = screen.getByTestId('import-v2');
    expect(within(v2).getByTestId('v2-import-file')).toBeTruthy();
    expect(within(v2).getByTestId('v2-local-none')).toBeTruthy();
  });
});
