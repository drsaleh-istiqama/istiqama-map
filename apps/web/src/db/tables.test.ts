/**
 * `SYNC_TABLES` must not drift from the server registry. This test parses the binding
 * contract (docs/contracts/sync.md §1 table, §4.2 rule 2; schema.md §1 pull order); the live
 * comparison with `private.sync_tables` and the column lists is
 * tests/integration/registry.live.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_INSERT_COLUMNS,
  COMPLETENESS_CHILD_TABLES,
  PROJECT_CHILD_TABLES,
  RESTRICTED_TABLES,
  STD_COLUMNS,
  STD_SERVER_COLUMNS,
  SYNC_TABLES,
  TABLE_NAMES,
  canPush,
  isRestrictedTable,
  isTableName,
  tableDef,
  wireColumns,
  writableColumns,
  type PushClass,
} from './tables';
import type { TableName } from './types';

const docs = path.resolve(__dirname, '../../../../docs');
const syncMd = fs.readFileSync(path.join(docs, 'contracts/sync.md'), 'utf8');
const schemaMd = fs.readFileSync(path.join(docs, 'contracts/schema.md'), 'utf8');

interface DocRow {
  order: number;
  table: string;
  scope: string;
  audience: string;
  push: [PushClass, PushClass, PushClass];
  notes: string;
}

/** The rows of the table in sync.md §1 ("| # | Table | Scope of a row | Audience | …"). */
function registryFromDoc(): DocRow[] {
  const start = syncMd.indexOf('## 1. Table registry');
  const end = syncMd.indexOf('**Scope kinds.**', start);
  const lines = syncMd.slice(start, end).split('\n');
  const rows: DocRow[] = [];
  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim());
    // ['', '#', 'Table', 'Scope', 'Audience', 'insert', 'update', 'delete', 'Notes', '']
    if (cells.length < 9 || !/^\d+$/.test(cells[1] ?? '')) continue;
    const cls = (c: string): PushClass => (c === '–' || c === '-' ? 'none' : (c as PushClass));
    rows.push({
      order: Number(cells[1]),
      table: (cells[2] ?? '').replace(/`/g, ''),
      scope: (cells[3] ?? '').split(/[\s(]/)[0]!,
      audience: (cells[4] ?? '').replace(/\*/g, ''),
      push: [cls(cells[5] ?? ''), cls(cells[6] ?? ''), cls(cells[7] ?? '')],
      notes: cells[8] ?? '',
    });
  }
  return rows;
}

describe('SYNC_TABLES mirrors docs/contracts/sync.md §1', () => {
  const doc = registryFromDoc();

  it('parses the contract table (22 tables)', () => {
    expect(doc).toHaveLength(22);
  });

  it('same tables in the same order with the same pull_order numbers', () => {
    expect(SYNC_TABLES.map((t) => [t.order, t.name])).toEqual(doc.map((d) => [d.order, d.table]));
    expect(TABLE_NAMES).toEqual(doc.map((d) => d.table));
  });

  it('scope kind of every table', () => {
    for (const d of doc)
      expect([d.table, tableDef(d.table as TableName).scope]).toEqual([d.table, d.scope]);
  });

  it('audience and restricted flag', () => {
    for (const d of doc) {
      const t = tableDef(d.table as TableName);
      // "own rows" (notifications) is audience `all` on the server, filtered by the own scope
      const audience = d.audience === 'own rows' ? 'all' : d.audience;
      expect([d.table, t.audience, t.restricted]).toEqual([
        d.table,
        audience,
        audience === 'restricted',
      ]);
    }
  });

  it('push classes for insert / update / delete', () => {
    for (const d of doc) {
      const t = tableDef(d.table as TableName);
      expect([d.table, t.push.insert, t.push.update, t.push.delete]).toEqual([d.table, ...d.push]);
    }
  });

  it('natural keys named in the notes', () => {
    for (const d of doc) {
      const m = /natural key `\(?([^`)]+)\)?`/.exec(d.notes);
      const want = m ? m[1]!.split(',').map((s) => s.trim()) : null;
      expect([d.table, tableDef(d.table as TableName).naturalKey]).toEqual([d.table, want]);
    }
  });

  it('point tables (`lon`/`lat` in the notes)', () => {
    for (const d of doc) {
      expect([d.table, tableDef(d.table as TableName).geomPoint]).toEqual([
        d.table,
        d.notes.includes('`lon`/`lat`'),
      ]);
    }
  });

  it('pull order equals the list of syncable tables in schema.md §1', () => {
    const m = /in pull order:\s*`([\s\S]*?)`\s*\(\* restricted\)/.exec(schemaMd);
    expect(m).not.toBeNull();
    const list = m![1]!
      .replace(/[`*\s]/g, '')
      .split(',')
      .filter(Boolean);
    expect(TABLE_NAMES).toEqual(list);
  });
});

describe('server-managed columns (sync.md §4.2 rule 2)', () => {
  const start = syncMd.indexOf('**Server-managed columns are ignored silently**');
  const text = syncMd
    .slice(start, syncMd.indexOf('`review_note` is ignored', start))
    .replace(/\s+/g, ' ');

  it('standard columns', () => {
    const std = text.slice(0, text.indexOf('geometry columns'));
    const names = [...std.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect([...STD_SERVER_COLUMNS].sort()).toEqual([...new Set(names)].sort());
  });

  it('per-table protected columns', () => {
    const perTable = text.slice(text.indexOf('per table:') + 'per table:'.length);
    const alias: Record<string, TableName> = {
      projects: 'projects',
      localities: 'localities',
      donors: 'donors',
      persons: 'persons',
      photos: 'project_photos',
      merge: 'person_merge_requests',
    };
    const seen = new Set<TableName>();
    for (const part of perTable.split(';')) {
      const word = part.trim().split(' ')[0]!;
      const table = alias[word];
      expect(table, `unknown table "${word}" in sync.md`).toBeDefined();
      const cols = [...part.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      expect([table, [...tableDef(table!).protectedCols].sort()]).toEqual([table, cols.sort()]);
      seen.add(table!);
    }
    for (const t of SYNC_TABLES)
      if (!seen.has(t.name)) expect([t.name, t.protectedCols]).toEqual([t.name, []]);
  });

  it('protected and standard columns are never writable; created_at only on insert', () => {
    for (const t of SYNC_TABLES) {
      const w = writableColumns(t.name);
      for (const c of [
        ...STD_SERVER_COLUMNS,
        ...t.protectedCols,
        'geom',
        'geom_simple',
        'sync_xid',
      ]) {
        expect(w.has(c), `${t.name}.${c}`).toBe(false);
      }
    }
    expect(CLIENT_INSERT_COLUMNS).toEqual(['created_at']);
  });
});

describe('registry helpers', () => {
  it('column lists: standard columns first, no geometry, lon/lat on point tables', () => {
    expect(wireColumns('projects').slice(0, STD_COLUMNS.length)).toEqual([...STD_COLUMNS]);
    for (const t of SYNC_TABLES) {
      const cols = wireColumns(t.name);
      expect(cols).not.toContain('geom');
      expect(cols).not.toContain('sync_xid');
      expect(cols.includes('lon') && cols.includes('lat')).toBe(t.geomPoint);
      expect(new Set(cols).size).toBe(cols.length);
    }
  });

  it('writable columns', () => {
    expect([...writableColumns('notifications')]).toEqual(['read_at']);
    expect(writableColumns('countries').size).toBe(0);
    expect(writableColumns('sync_conflicts').size).toBe(0);
    expect(writableColumns('projects').has('lon')).toBe(true);
    expect(writableColumns('projects').has('record_state')).toBe(true);
    expect(writableColumns('projects').has('review_note')).toBe(true);
    expect(writableColumns('project_photos').has('purged_at')).toBe(false);
  });

  it('canPush / restricted / name guards / derived lists', () => {
    expect(canPush('notifications', 'update')).toBe(true);
    expect(canPush('notifications', 'insert')).toBe(false);
    expect(canPush('map_packs', 'delete')).toBe(false);
    expect(RESTRICTED_TABLES.every((t) => isRestrictedTable(t))).toBe(true);
    expect(SYNC_TABLES.filter((t) => t.restricted).map((t) => t.name)).toEqual([
      ...RESTRICTED_TABLES,
    ]);
    expect(isTableName('projects')).toBe(true);
    expect(isTableName('profiles')).toBe(false);
    expect(() => tableDef('nope' as TableName)).toThrow();
    expect(PROJECT_CHILD_TABLES).toEqual([
      'project_land',
      'project_facilities',
      'project_maintenance',
      'project_photos',
      'project_donors',
      'project_staff',
      'community_profiles',
      'community_sensitive',
    ]);
    for (const t of COMPLETENESS_CHILD_TABLES) expect(PROJECT_CHILD_TABLES).toContain(t);
  });

  it('parents precede children: every ref points to an earlier table', () => {
    for (const t of SYNC_TABLES) {
      for (const parent of Object.values(t.refs)) {
        expect(tableDef(parent).order, `${t.name} -> ${parent}`).toBeLessThan(t.order);
      }
    }
  });
});
