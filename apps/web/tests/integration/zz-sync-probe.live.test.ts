// TEMPORARY probe (deleted after diagnosis): how many rows make src/db applyPage fail?
import { expect, it } from 'vitest';
import * as realDb from '../../src/db';

function area(i: number): Record<string, unknown> {
  const hex = i.toString(16).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${hex}`,
    code: `X${i}`,
    level: 3,
    name_ar: null,
    name_en: `Area ${i}`,
    name_sw: null,
    version: 1,
    parent_id: null,
    country_id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-10-03T15:30:57.358943+00:00',
    created_by: null,
    deleted_at: null,
    short_code: null,
    updated_at: '2026-10-03T15:30:57.358943+00:00',
    updated_by: null,
  };
}

it('probe: rows per page', async () => {
  const outcome: Record<number, string> = {};
  for (const n of [20, 40, 60, 80, 100, 120, 200, 500]) {
    await realDb.wipeAllLocalData();
    try {
      await realDb.applyPage({
        changes: [{ table: 'admin_areas', rows: Array.from({ length: n }, (_, i) => area(i)) }],
        meta: [{ key: 'probe', value: n }],
      });
      outcome[n] = `ok (${await realDb.db.admin_areas.count()} rows stored)`;
    } catch (e) {
      outcome[n] = `FAILED ${(e as Error).name}`;
    }
  }
  expect(outcome).toEqual({});
}, 120_000);
