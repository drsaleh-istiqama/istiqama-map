import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth', () => ({ supabase: {}, can: {} }));
vi.mock('../sync', () => ({
  transport: { rpc: async () => null },
  isSyncError: () => false,
  errorKey: () => 'sync.error_unknown',
}));

import { actionsFor, rowName, stateTone } from './PreviewPanel';
import { guideRows, headerRow, templateCsv, templateFileName } from './template';
import { DUP_TARGET, LIVE_ROWS, LIVE_TEMPLATE, LIVE_UPLOAD } from './testing/fixtures';
import {
  parseBatch,
  parseCommit,
  parsePreview,
  parseRollback,
  parseTemplate,
  parseUpload,
} from './types';
import { checkFile } from './UploadCard';

const LABELS = {
  sheetData: 'P',
  sheetGuide: 'G',
  column: 'C',
  key: 'K',
  required: 'R',
  kind: 'T',
  allowed: 'A',
  example: 'E',
  yes: 'Y',
  no: 'N',
  range: (min: number | null, max: number | null) => `${min}..${max}`,
};

describe('parsers of the import responses (live shapes)', () => {
  it('upload summary + file info', () => {
    const r = parseUpload(LIVE_UPLOAD);
    expect(r.batchId).toBe(LIVE_UPLOAD.batch_id);
    expect(r.counts.create).toBe(1);
    expect(r.counts.invalid).toBe(1);
    expect(r.ignoredColumns).toEqual(['ملاحظات']);
    expect(r.firstErrors[0]!.rowNo).toBe(2);
    expect(r.firstErrors[0]!.errors[0]!.code).toBe('invalid_value');
    expect(r.file?.headers).toEqual(['name_ar', 'type']);
  });

  it('preview rows: errors, warnings with candidates, actions', () => {
    const p = parsePreview({ ...LIVE_UPLOAD, rows: LIVE_ROWS, next: null });
    expect(p.rows).toHaveLength(3);
    expect(p.next).toBeNull();
    const [valid, invalid, dup] = p.rows;
    expect(valid!.action).toBe('create');
    expect(invalid!.action).toBeNull();
    expect(invalid!.errors.map((e) => e.field)).toEqual(['type', 'lat', 'name_ar']);
    expect(dup!.warnings[0]!.candidates![0]!.code).toBe('TZ-PN-000001');
    expect(dup!.duplicateOf).toBe(DUP_TARGET);
    expect(rowName(dup!)).toBe('مسجد النور');
    expect(rowName(invalid!)).toBeNull();
    expect(actionsFor(valid!)).toEqual(['skip', 'create']);
    expect(actionsFor(invalid!)).toEqual([]);
    expect(actionsFor(dup!)).toEqual(['skip', 'create', 'update']);
    expect(stateTone('invalid')).toBe('danger');
    expect(stateTone('duplicate')).toBe('warning');
  });

  it('garbage never throws and gives safe defaults', () => {
    for (const v of [
      null,
      undefined,
      42,
      'x',
      [],
      { rows: 'x', counts: 'y', first_errors: [1, { row_no: 'a' }] },
    ]) {
      const p = parsePreview(v);
      expect(p.rows).toEqual([]);
      expect(p.counts.total).toBe(0);
      expect(p.firstErrors).toEqual([]);
    }
    expect(
      parsePreview({ rows: [{ row_no: 1, errors: [{ nope: 1 }, { code: 'required' }] }] }).rows[0]!
        .errors,
    ).toEqual([{ field: null, code: 'required', message: '' }]);
    expect(parseBatch({})).toBeNull();
  });

  it('commit (refused) and rollback results', () => {
    const refused = parseCommit({
      ...LIVE_UPLOAD,
      committed: false,
      failed_row: 17,
      error: { code: '23505', message: 'duplicate key' },
    });
    expect(refused.committed).toBe(false);
    expect(refused.failedRow).toBe(17);
    expect(refused.error).toEqual({ code: '23505', message: 'duplicate key' });
    expect(parseCommit({ committed: true }).committed).toBe(true);
    const rb = parseRollback({
      state: 'rolled_back',
      rolled_back: true,
      reverted: 3,
      kept: 2,
      no_access: 1,
      conflicting_fields: 4,
    });
    expect(rb).toMatchObject({
      rolledBack: true,
      reverted: 3,
      kept: 2,
      noAccess: 1,
      conflictingFields: 4,
    });
  });

  it('batch rows of the history (import_batches)', () => {
    const b = parseBatch({
      id: 'b1',
      state: 'committed',
      source_kind: 'xlsx',
      file_name: 'a.xlsx',
      row_count: 4,
      stats: { applied_created: 3 },
      created_at: '2026-10-04T10:00:00Z',
      committed_at: '2026-10-04T10:01:00Z',
      rolled_back_at: null,
    });
    expect(b).toMatchObject({ id: 'b1', state: 'committed', sourceKind: 'xlsx', rowCount: 4 });
    expect(b!.counts.applied_created).toBe(3);
  });
});

describe('the official template', () => {
  it('builds a CSV with BOM and the headers of the chosen language', async () => {
    const tpl = parseTemplate(LIVE_TEMPLATE);
    expect(tpl.dir).toBe('rtl');
    expect(tpl.maxRows).toBe(5000);
    expect(tpl.columns.find((c) => c.key === 'type')!.allowed).toHaveLength(2);
    expect(headerRow(tpl)).toEqual([
      'المعرّف الخارجي',
      'اسم المشروع (عربي)',
      'النوع',
      'السعة',
      'خط العرض',
    ]);
    const bytes = new Uint8Array(await templateCsv(tpl).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(text.slice(1)).toBe('المعرّف الخارجي,اسم المشروع (عربي),النوع,السعة,خط العرض');
    expect(templateFileName(tpl, 'xlsx')).toBe('istiqama-import-template-ar-v1.xlsx');
  });

  it('guide rows list required columns, allowed values and ranges', () => {
    const rows = guideRows(parseTemplate(LIVE_TEMPLATE), LABELS);
    expect(rows[0]).toEqual(['C', 'K', 'R', 'T', 'A', 'E']);
    expect(rows[2]).toEqual(['اسم المشروع (عربي)', 'name_ar', 'Y', 'text', '', 'مسجد النور']);
    expect(rows[3]![4]).toBe('مسجد (mosque) | مدرسة قرآن (school)');
    expect(rows[4]![4]).toBe('0..10000000');
  });

  it('builds an XLSX whose FIRST sheet is the header row (read back by SheetJS)', async () => {
    const { templateXlsx } = await import('./template');
    const XLSX = await import('xlsx');
    const tpl = parseTemplate(LIVE_TEMPLATE);
    const blob = await templateXlsx(tpl, { ...LABELS, sheetData: 'المشاريع', sheetGuide: 'شرح' });
    const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
    expect(wb.SheetNames).toEqual(['المشاريع', 'شرح']);
    const first = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['المشاريع']!, { header: 1 });
    expect(first).toEqual([headerRow(tpl)]);
  });

  it('files are checked on the device before upload', () => {
    expect(checkFile({ name: 'a.csv', size: 10 })).toBe('ok');
    expect(checkFile({ name: 'a.XLSX', size: 10 })).toBe('ok');
    expect(checkFile({ name: 'a.xls', size: 10 })).toBe('unsupported');
    expect(checkFile({ name: 'a.json', size: 10 })).toBe('unsupported');
    expect(checkFile({ name: 'a.csv', size: 0 })).toBe('empty');
    expect(checkFile({ name: 'a.csv', size: 11 * 1024 * 1024 })).toBe('too_large');
  });
});
