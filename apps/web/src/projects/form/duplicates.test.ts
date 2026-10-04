import { describe, expect, it, vi } from 'vitest';
import { db, newRow, type DuplicateHit, type Row } from '../../db';
import { gridCell } from '../../lib/geo';
import { findDuplicates, mergeDuplicates } from './duplicates';

const hit = (
  id: string,
  reason: DuplicateHit['reason'],
  distance: number | null = null,
): DuplicateHit => ({
  id,
  code: null,
  name_ar: id,
  name_latin: null,
  type: 'mosque',
  status: 'active',
  record_state: 'approved',
  lon: 39,
  lat: -5,
  locality_id: null,
  admin_area_id: null,
  created_by_me: false,
  distance_m: distance,
  similarity: null,
  reason,
});

const q = {
  type: 'mosque',
  lon: 39.75,
  lat: -5.05,
  name: 'مسجد النور',
  localityId: null,
  excludeId: 'self',
};

describe('duplicate check (brief §7.3)', () => {
  it('merges device and server hits by id, best first, never the record itself', () => {
    const out = mergeDuplicates(
      [hit('a', 'nearby', 90), hit('self', 'both', 0)],
      [hit('a', 'similar_name'), hit('b', 'nearby', 40)],
      'self',
    );
    expect(out.map((h) => [h.id, h.reason])).toEqual([
      ['a', 'both'],
      ['b', 'nearby'],
    ]);
  });

  it('online: asks the server too (150 m / similar name rules live there)', async () => {
    const local = vi.fn(async () => [hit('a', 'nearby', 100)]);
    const rpc = vi.fn(async () => [hit('srv', 'similar_name')]) as never;
    const out = await findDuplicates(q, { rpc, online: true, local });
    expect(rpc).toHaveBeenCalledWith('project_duplicates', {
      p_type: 'mosque',
      p_lon: 39.75,
      p_lat: -5.05,
      p_name: 'مسجد النور',
      p_locality_id: null,
      p_exclude_id: 'self',
    });
    expect(out.map((h) => h.id).sort()).toEqual(['a', 'srv']);
  });

  it('offline: the device index only; a failing server is ignored', async () => {
    const local = vi.fn(async () => [hit('a', 'nearby', 100)]);
    const rpc = vi.fn() as never;
    expect((await findDuplicates(q, { rpc, online: false, local })).map((h) => h.id)).toEqual([
      'a',
    ]);
    expect(rpc).not.toHaveBeenCalled();
    const failing = vi.fn(async () => {
      throw new Error('timeout');
    }) as never;
    expect(
      (await findDuplicates(q, { rpc: failing, online: true, local })).map((h) => h.id),
    ).toEqual(['a']);
  });

  describe('the device "same village" radius once the server answered (no locality)', () => {
    const named = (id: string, reason: DuplicateHit['reason'], m: number): DuplicateHit => ({
      ...hit(id, reason, m),
      code: `TZ-PN-${id}`,
      similarity: 0.9,
    });
    const knownToServer = async () => new Set<string>();

    it('drops radius-only name hits of projects the server knows (its level-3 rule decided)', async () => {
      const local = vi.fn(async () => [named('far', 'similar_name', 1200.9)]);
      const rpc = vi.fn(async () => []) as never;
      expect(
        await findDuplicates(q, { rpc, online: true, local, localOnly: knownToServer }),
      ).toEqual([]);
    });

    it('a "both" hit keeps its 150 m part; nearby hits stay as they are', async () => {
      const local = vi.fn(async () => [named('b', 'both', 80), named('n', 'nearby', 120)]);
      const rpc = vi.fn(async () => []) as never;
      const out = await findDuplicates(q, { rpc, online: true, local, localOnly: knownToServer });
      expect(out.map((h) => [h.id, h.reason])).toEqual([
        ['b', 'nearby'],
        ['n', 'nearby'],
      ]);
    });

    it('keeps them for projects that never reached the server, offline, or when the server fails', async () => {
      const local = vi.fn(async () => [named('mine', 'similar_name', 1200.9)]);
      const ok = vi.fn(async () => []) as never;
      const localOnly = vi.fn(async (ids: readonly string[]) => new Set(ids));
      expect(
        (await findDuplicates(q, { rpc: ok, online: true, local, localOnly })).map((h) => h.id),
      ).toEqual(['mine']);
      expect(localOnly).toHaveBeenCalledWith(['mine']);
      expect(
        (await findDuplicates(q, { rpc: ok, online: false, local, localOnly: knownToServer })).map(
          (h) => h.id,
        ),
      ).toEqual(['mine']);
      const failing = vi.fn(async () => {
        throw new Error('timeout');
      }) as never;
      expect(
        (
          await findDuplicates(q, { rpc: failing, online: true, local, localOnly: knownToServer })
        ).map((h) => h.id),
      ).toEqual(['mine']);
    });

    it('with a chosen locality the device rule equals the server rule and stays', async () => {
      const local = vi.fn(async () => [named('same', 'similar_name', 1200.9)]);
      const rpc = vi.fn(async () => []) as never;
      const out = await findDuplicates(
        { ...q, localityId: '01900000-0000-7000-8000-00000000f001' },
        { rpc, online: true, local, localOnly: knownToServer },
      );
      expect(out.map((h) => h.id)).toEqual(['same']);
    });

    it('regression (device index + server): a similarly named project 1.2 km away in another village', async () => {
      const make = (values: Partial<Row<'projects'>>) => {
        const p = {
          ...newRow('projects', {
            name_ar: 'مسجد النور',
            type: 'school',
            status: 'active',
            record_state: 'approved',
            lon: 39.75 + 0.0108, // ≈ 1.2 km east
            lat: -5.05,
            ...values,
          } as Partial<Row<'projects'>>),
        } as Row<'projects'> & { _cell?: number };
        p._cell = gridCell({ lon: p.lon as number, lat: p.lat as number });
        return p;
      };
      await db.projects.clear();
      const synced = make({ code: 'TZ-PN-000777', version: 3 });
      await db.projects.put(synced);
      const rpc = vi.fn(async () => []) as never;
      const query = { ...q, type: 'mosque', localityId: null };
      // Offline the device still warns (its radius is the only village it knows) …
      const offline = await findDuplicates(query, { rpc, online: false });
      expect(offline.map((h) => [h.id, h.reason])).toEqual([[synced.id, 'similar_name']]);
      // … online the server's level-3 rule found nothing: no false positive.
      expect(await findDuplicates(query, { rpc, online: true })).toEqual([]);
      // A project entered on this device and not uploaded yet is unknown to the server: kept.
      await db.projects.clear();
      const pending = make({ code: null, version: 0 });
      await db.projects.put(pending);
      expect((await findDuplicates(query, { rpc, online: true })).map((h) => h.id)).toEqual([
        pending.id,
      ]);
      await db.projects.clear();
    });
  });

  it('nothing to compare without a type or without both point and name', async () => {
    const local = vi.fn(async () => [hit('a', 'nearby')]);
    expect(
      await findDuplicates({ ...q, type: '' }, { rpc: vi.fn() as never, online: false, local }),
    ).toEqual([]);
    expect(
      await findDuplicates(
        { ...q, lon: null, lat: null, name: ' ' },
        { rpc: vi.fn() as never, online: false, local },
      ),
    ).toEqual([]);
  });
});
