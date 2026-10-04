import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { checkPoint, fromLocatePayload, locateOnDevice, locatePoint } from './geo';
import {
  cachedCountryIds,
  ensureShapes,
  getCachedShapes,
  putCachedShapes,
  resetShapeMemory,
  shapesContaining,
  toCachedShapes,
} from './geoCache';

// Two square level-1 regions side by side in country TZ, one level-2 district inside the first.
const sq = (x0: number, y0: number, x1: number, y1: number) => ({
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  ],
});
const L1 = {
  features: [
    { id: 'r1', geometry: sq(39, -6, 40, -5), properties: { id: 'r1', parent_id: null, level: 1 } },
    { id: 'r2', geometry: sq(40, -6, 41, -5), properties: { id: 'r2', parent_id: null, level: 1 } },
  ],
};
const L2 = {
  features: [
    {
      id: 'd1',
      geometry: sq(39, -6, 39.5, -5.5),
      properties: { id: 'd1', parent_id: 'r1', level: 2 },
    },
    { id: 'd2', geometry: null, properties: { id: 'd2', parent_id: 'r1', level: 2 } },
  ],
};

async function cacheTz(): Promise<void> {
  await putCachedShapes(toCachedShapes('TZ', 1, L1, 1000));
  await putCachedShapes(toCachedShapes('TZ', 2, L2, 1000));
}

beforeEach(async () => {
  resetShapeMemory();
  await db.meta.clear();
});

describe('geoCache', () => {
  it('converts the RPC payload with bounding boxes and skips features without geometry', () => {
    const c = toCachedShapes('TZ', 2, L2, 5);
    expect(c.shapes.map((s) => s.id)).toEqual(['d1']);
    expect(c.shapes[0]!.bbox).toEqual([39, -6, 39.5, -5.5]);
  });

  it('stores shapes in IndexedDB (meta) and reads them back after a restart', async () => {
    await cacheTz();
    resetShapeMemory(); // simulates a new session
    expect((await getCachedShapes('TZ', 1))?.shapes).toHaveLength(2);
    expect(await cachedCountryIds()).toEqual(['TZ']);
    expect(
      shapesContaining(await getCachedShapes('TZ', 1), { lon: 40.5, lat: -5.5 }).map((s) => s.id),
    ).toEqual(['r2']);
  });

  it('downloads levels 1 and 2 once and refreshes only stale entries', async () => {
    const rpc = vi.fn(async (_fn: string, args?: Record<string, unknown>) =>
      (args?.p_level as number) === 1 ? L1 : L2,
    ) as never;
    expect(await ensureShapes(['TZ'], rpc, { online: true, now: 10 })).toEqual(['TZ']);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('admin_area_shapes', { p_country_id: 'TZ', p_level: 1 });
    await ensureShapes(['TZ'], rpc, { online: true, now: 20 });
    expect(rpc).toHaveBeenCalledTimes(2); // fresh: nothing fetched
    await ensureShapes(['TZ'], rpc, { online: false, now: 10 ** 12 });
    expect(rpc).toHaveBeenCalledTimes(2); // offline: never a request
  });

  it('a failed download keeps the cache and never throws', async () => {
    await cacheTz();
    const rpc = vi.fn(async () => {
      throw new Error('network');
    }) as never;
    await expect(ensureShapes(['TZ'], rpc, { online: true, now: 10 ** 12 })).resolves.toEqual([]);
    expect((await getCachedShapes('TZ', 1))?.shapes).toHaveLength(2);
  });
});

describe('geofill', () => {
  it('offline: fills country, region and district from the cached shapes', async () => {
    await cacheTz();
    const r = await locateOnDevice({ lon: 39.2, lat: -5.8 });
    expect(r).toMatchObject({
      countryId: 'TZ',
      areaPath: ['r1', 'd1', null],
      adminAreaId: 'd1',
      source: 'device',
    });
    const r2 = await locateOnDevice({ lon: 40.2, lat: -5.2 });
    expect(r2).toMatchObject({ countryId: 'TZ', areaPath: ['r2', null, null], adminAreaId: 'r2' });
    expect((await locateOnDevice({ lon: 10, lat: 10 })).source).toBe('none');
  });

  it('online: uses locate_point (server truth, level 3 included)', async () => {
    const rpc = vi.fn(async () => ({
      country: { id: 'TZ' },
      admin_area_id: 'w1',
      areas: [
        { id: 'r1', level: 1 },
        { id: 'd1', level: 2 },
        { id: 'w1', level: 3 },
      ],
      localities: [
        {
          id: 'L1',
          name_ar: 'ويتي',
          name_latin: 'Wete',
          status: 'approved',
          admin_area_id: 'w1',
          distance_m: 298.6,
        },
      ],
    })) as never;
    const r = await locatePoint({ lon: 39.2, lat: -5.8 }, { rpc, online: true });
    expect(rpc).toHaveBeenCalledWith('locate_point', { p_lon: 39.2, p_lat: -5.8 });
    expect(r).toMatchObject({
      countryId: 'TZ',
      areaPath: ['r1', 'd1', 'w1'],
      adminAreaId: 'w1',
      source: 'server',
    });
    expect(r.localities[0]).toMatchObject({ id: 'L1', distance_m: 299 });
  });

  it('falls back to the device when the server fails, and never calls it offline', async () => {
    await cacheTz();
    const failing = vi.fn(async () => {
      throw new Error('502');
    }) as never;
    expect(
      (await locatePoint({ lon: 39.2, lat: -5.8 }, { rpc: failing, online: true })).source,
    ).toBe('device');
    const never = vi.fn() as never;
    expect(
      (await locatePoint({ lon: 39.2, lat: -5.8 }, { rpc: never, online: false })).source,
    ).toBe('device');
    expect(never).not.toHaveBeenCalled();
  });

  it('reads an empty server answer as "outside every polygon"', () => {
    expect(fromLocatePayload({ country: null, admin_area_id: null, areas: [] })).toMatchObject({
      countryId: null,
      adminAreaId: null,
      areaPath: [null, null, null],
    });
  });
});

describe('geo-validation (brief §7.2)', () => {
  it('offline: warns when the point is outside the chosen country or area', async () => {
    await cacheTz();
    const p = { lon: 39.2, lat: -5.8 };
    expect(await checkPoint(p, { countryId: 'TZ', areaPath: ['r1', 'd1', null] }, null)).toEqual({
      country: 'inside',
      area: 'inside',
    });
    expect(await checkPoint(p, { countryId: 'TZ', areaPath: ['r2', null, null] }, null)).toEqual({
      country: 'inside',
      area: 'outside',
    });
    expect(
      await checkPoint(
        { lon: 30, lat: 0 },
        { countryId: 'TZ', areaPath: ['r1', null, null] },
        null,
      ),
    ).toEqual({ country: 'outside', area: 'outside' });
    // No shapes for that country: nothing can be said, no false warning.
    expect(await checkPoint(p, { countryId: 'KE', areaPath: [null, null, null] }, null)).toEqual({
      country: 'unknown',
      area: 'unknown',
    });
  });

  it('uses the geofill result for the same point when available (also level 3)', async () => {
    const located = {
      countryId: 'TZ',
      areaPath: ['r1', 'd1', 'w1'] as [string, string, string],
      adminAreaId: 'w1',
      localities: [],
      source: 'server' as const,
    };
    const p = { lon: 39.2, lat: -5.8 };
    expect(await checkPoint(p, { countryId: 'TZ', areaPath: ['r1', 'd1', 'w2'] }, located)).toEqual(
      { country: 'inside', area: 'outside' },
    );
    expect(
      await checkPoint(p, { countryId: 'KE', areaPath: [null, null, null] }, located),
    ).toMatchObject({ country: 'outside' });
  });
});
