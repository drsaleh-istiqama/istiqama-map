/**
 * The Dexie schema: one store per syncable table keyed by id, the indexes the queries rely
 * on, the local-only stores, and the versioned upgrade path.
 */
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_NAME, IstiqamaDexie, SCHEMA, SCHEMA_VERSION, db, type SchemaStep } from './dexie';
import { SYNC_TABLES } from './tables';

const opened: IstiqamaDexie[] = [];
afterEach(async () => {
  for (const d of opened.splice(0)) {
    d.close();
    await Dexie.delete(d.name);
  }
});

function indexNames(name: string): string[] {
  return db.table(name).schema.indexes.map((i) => i.name);
}

describe('schema', () => {
  it('is the database "istiqama-map" with ascending schema versions', () => {
    expect(DB_NAME).toBe('istiqama-map');
    expect(db.name).toBe('istiqama-map');
    const versions = SCHEMA.map((s) => s.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(SCHEMA_VERSION).toBe(versions[versions.length - 1]);
  });

  it('one store per syncable table, keyed by id, with the sparse state-flag indexes', () => {
    for (const t of SYNC_TABLES) {
      const schema = db.table(t.name).schema;
      expect(schema.primKey.keyPath, t.name).toBe('id');
      expect(indexNames(t.name), t.name).toEqual(expect.arrayContaining(['_dirty', '_conflict']));
    }
  });

  it('children are found by project_id, staff by person, compensation by staff', () => {
    for (const t of SYNC_TABLES.filter((x) => x.scopeCol === 'project_id')) {
      expect(indexNames(t.name), t.name).toContain('project_id');
    }
    expect(indexNames('project_staff')).toContain('person_id');
    expect(indexNames('project_donors')).toContain('donor_id');
    expect(indexNames('staff_compensation')).toContain('project_staff_id');
  });

  it('projects: name / updated facet indexes, grid cell, multiEntry search tokens', () => {
    const idx = db.projects.schema.indexes;
    const byName = (n: string) => idx.find((i) => i.name === n);
    expect(byName('_fn')?.multi).toBe(true);
    expect(byName('_fu')?.multi).toBe(true);
    expect(byName('_tokens')?.multi).toBe(true);
    expect(byName('_cell')).toBeDefined();
    expect(byName('locality_id')).toBeDefined();
    for (const t of ['localities', 'persons', 'donors']) {
      expect(db.table(t).schema.indexes.find((i) => i.name === '_tokens')?.multi, t).toBe(true);
    }
    expect(indexNames('localities')).toContain('_cell');
    expect(indexNames('persons')).toEqual(expect.arrayContaining(['phone_e164', '[_name+id]']));
  });

  it('local-only stores', () => {
    expect(db.outbox.schema.primKey).toMatchObject({ keyPath: 'seq', auto: true });
    expect(db.outbox.schema.indexes.find((i) => i.name === 'op_id')?.unique).toBe(true);
    expect(indexNames('outbox')).toEqual(
      expect.arrayContaining(['[table+row_id]', 'state', 'project_id']),
    );
    expect(db.failed_ops.schema.primKey).toMatchObject({ keyPath: 'id', auto: true });
    expect(db.photo_blobs.schema.primKey.keyPath).toBe('id');
    expect(db.drafts.schema.primKey.keyPath).toBe('key');
    expect(db.meta.schema.primKey.keyPath).toBe('key');
    expect(indexNames('restricted_local')).toEqual(
      expect.arrayContaining(['[table+parent_id]', 'project_id']),
    );
    expect(db.packs.schema.primKey.keyPath).toBe('code');
  });
});

describe('upgrade path', () => {
  it('a later schema step keeps the stored rows and rewrites them in its upgrade function', async () => {
    const name = 'istiqama-map-upgrade-test';
    const v1 = new IstiqamaDexie(name, SCHEMA);
    opened.push(v1);
    await v1.open();
    await v1.table('donors').put({ id: 'd1', name_ar: 'متبرع', _tokens: ['متبرع'] });
    await v1
      .table('outbox')
      .add({ op_id: 'op-1', table: 'donors', row_id: 'd1', state: 'pending' });
    v1.close();

    const next: SchemaStep = {
      version: SCHEMA_VERSION + 1,
      stores: { donors: 'id, *_tokens, _dirty, _conflict, _initial', packs: null },
      upgrade: (tx) =>
        tx
          .table('donors')
          .toCollection()
          .modify((row: { name_ar?: string; _initial?: string }) => {
            row._initial = (row.name_ar ?? '').slice(0, 1);
          }),
    };
    const v2 = new IstiqamaDexie(name, [...SCHEMA, next]);
    opened.push(v2);
    await v2.open();
    expect(v2.verno).toBe(SCHEMA_VERSION + 1);
    expect(await v2.table('donors').where('_initial').equals('م').count()).toBe(1);
    expect(await v2.table('outbox').count()).toBe(1);
    expect(v2.tables.map((t) => t.name)).not.toContain('packs');
  });

  it('an open connection steps aside when a newer app version upgrades the schema', async () => {
    const name = 'istiqama-map-versionchange-test';
    const old = new IstiqamaDexie(name, SCHEMA);
    opened.push(old);
    await old.open();
    const newer = new IstiqamaDexie(name, [
      ...SCHEMA,
      { version: SCHEMA_VERSION + 1, stores: { packs: 'code, kind' } },
    ]);
    opened.push(newer);
    await newer.open();
    expect(old.outdated).toBe(true);
    expect(old.isOpen()).toBe(false);
  });
});
