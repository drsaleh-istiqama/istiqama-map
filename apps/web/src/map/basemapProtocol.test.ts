import { PMTiles } from 'pmtiles';
import { describe, expect, it, vi } from 'vitest';
import { createBasemapProvider, tileBounds, type ArchiveLike } from './basemapProtocol';
import { LocalPackSource } from './localSource';
import type { PackFile } from './packStore';
import { buildPmtiles, bytesOf } from './testing/pmtilesFixture';

function memoryFile(bytes: Uint8Array): PackFile & { reads: number } {
  const file = {
    reads: 0,
    size: async () => bytes.length,
    read: async (offset: number, length: number) => {
      file.reads++;
      return bytes.slice(offset, offset + length).buffer;
    },
  };
  return file;
}

/** Pemba pack: z0 world tile + two z10 tiles around Wete. */
const PEMBA = buildPmtiles(
  [
    { z: 0, x: 0, y: 0, data: bytesOf(100, 1) },
    { z: 10, x: 625, y: 526, data: bytesOf(300, 2) },
    { z: 10, x: 625, y: 527, data: bytesOf(300, 3) },
  ],
  { bounds: [39.5, -5.5, 40, -4.8] },
);

function packArchive(code = 'TZ-PN', bytes = PEMBA, file = memoryFile(bytes)) {
  return {
    code,
    archive: new PMTiles(new LocalPackSource(`pack:${code}`, file)),
    bbox: [39.5, -5.5, 40, -4.8] as [number, number, number, number],
    minZoom: 0,
    maxZoom: 10,
    file,
  };
}

function fakeRemote(maxZoom = 15): ArchiveLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getHeader: vi.fn(async () => ({
      minZoom: 0,
      maxZoom,
      minLon: 28,
      minLat: -27,
      maxLon: 60,
      maxLat: 26.5,
    })),
    getZxy: vi.fn(async (z: number, x: number, y: number) => {
      calls.push(`${z}/${x}/${y}`);
      if (z === 5 && x === 0) return undefined; // open sea
      return { data: bytesOf(50, z * 1000 + x).buffer };
    }),
  };
}

const tileUrl = (z: number, x: number, y: number) => `istiqama-basemap://tiles/${z}/${x}/${y}`;

describe('basemap protocol: pack first, online archive second', () => {
  it('serves a tile from an installed pack without touching the network', async () => {
    const remote = fakeRemote();
    const provider = createBasemapProvider({ online: () => true });
    provider.setRemote(remote);
    provider.setPacks([packArchive()]);
    const { data } = await provider.handle({ url: tileUrl(10, 625, 526) });
    expect(data).toEqual(bytesOf(300, 2));
    expect(remote.calls).toEqual([]);
    expect(provider.status.value).toMatchObject({ state: 'pack', fromPacks: 1 });
  });

  it('falls back to the online archive outside the pack', async () => {
    const remote = fakeRemote();
    const provider = createBasemapProvider({ online: () => true });
    provider.setRemote(remote);
    provider.setPacks([packArchive()]);
    const { data } = await provider.handle({ url: tileUrl(10, 600, 500) });
    expect(data).toEqual(bytesOf(50, 10 * 1000 + 600));
    expect(remote.calls).toEqual(['10/600/500']);
    expect(provider.status.value.state).toBe('online');
  });

  it('a tile absent from the online archive is an empty tile, not a failure', async () => {
    const provider = createBasemapProvider({ online: () => true });
    provider.setRemote(fakeRemote());
    const { data } = await provider.handle({ url: tileUrl(5, 0, 3) });
    expect(data).toEqual(new Uint8Array(0));
    expect(provider.status.value.missing).toBe(0);
  });

  it('offline: never asks the online archive; reports unavailable where no pack covers', async () => {
    const remote = fakeRemote();
    const provider = createBasemapProvider({ online: () => false });
    provider.setRemote(remote);
    provider.setPacks([packArchive()]);
    expect((await provider.handle({ url: tileUrl(10, 625, 527) })).data).toEqual(bytesOf(300, 3));
    expect(provider.status.value.state).toBe('pack');
    expect((await provider.handle({ url: tileUrl(10, 100, 100) })).data).toEqual(new Uint8Array(0));
    expect(remote.getZxy).not.toHaveBeenCalled();
    expect(remote.getHeader).not.toHaveBeenCalled();
    expect(provider.status.value).toMatchObject({ state: 'unavailable', remote: 'offline' });
  });

  it('a failing online archive is not retried on every tile', async () => {
    let t = 0;
    const remote = fakeRemote();
    (remote.getZxy as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));
    const provider = createBasemapProvider({ online: () => true, now: () => t });
    provider.setRemote(remote);
    await provider.handle({ url: tileUrl(3, 4, 4) });
    await provider.handle({ url: tileUrl(3, 5, 4) });
    expect(remote.getZxy).toHaveBeenCalledTimes(1);
    expect(provider.status.value).toMatchObject({
      state: 'unavailable',
      remote: 'error',
      missing: 2,
    });
    t += 61_000;
    await provider.handle({ url: tileUrl(3, 5, 4) });
    expect(remote.getZxy).toHaveBeenCalledTimes(2);
  });

  it('skips packs that cannot contain the tile (zoom or area) without reading them', async () => {
    const pack = packArchive();
    const provider = createBasemapProvider({ online: () => false });
    provider.setPacks([pack]);
    await provider.handle({ url: tileUrl(12, 2500, 2100) }); // deeper than the pack
    await provider.handle({ url: tileUrl(10, 10, 10) }); // far away
    expect(pack.file.reads).toBe(0);
  });

  it("TileJSON: online → deepest archive zoom; offline → the packs' maximum (over-zoom)", async () => {
    const online = { value: true };
    const provider = createBasemapProvider({ online: () => online.value });
    provider.setRemote(fakeRemote(15));
    provider.setPacks([packArchive()]);
    const a = (await provider.handle({ url: 'istiqama-basemap://tilejson/1' })).data;
    expect(a).toMatchObject({
      tiles: ['istiqama-basemap://tiles/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: 15,
    });
    online.value = false;
    provider.reset();
    const b = (await provider.handle({ url: 'istiqama-basemap://tilejson/2' })).data;
    expect(b).toMatchObject({ maxzoom: 10 });
  });

  it('a broken online archive (bad header) leaves the packs working', async () => {
    const broken: ArchiveLike = {
      getHeader: async () => {
        throw new Error('Wrong magic number for PMTiles archive');
      },
      getZxy: async () => {
        throw new Error('Wrong magic number for PMTiles archive');
      },
    };
    const provider = createBasemapProvider({ online: () => true });
    provider.setRemote(broken);
    provider.setPacks([packArchive()]);
    const tj = (await provider.handle({ url: 'istiqama-basemap://tilejson/1' })).data;
    expect(tj).toMatchObject({ maxzoom: 10 });
    expect((await provider.handle({ url: tileUrl(0, 0, 0) })).data).toEqual(bytesOf(100, 1));
    expect(provider.status.value.remote).toBe('error');
  });

  it('rejects unknown URLs', async () => {
    const provider = createBasemapProvider({ online: () => true });
    await expect(provider.handle({ url: 'istiqama-basemap://other' })).rejects.toThrow();
  });
});

describe('tileBounds', () => {
  it('returns the degree box of a tile', () => {
    expect(tileBounds(0, 0, 0)[0]).toBe(-180);
    const [w, s, e, n] = tileBounds(10, 625, 526);
    expect(w).toBeLessThan(39.8);
    expect(e).toBeGreaterThan(39.7);
    expect(s).toBeLessThan(n);
    expect(n).toBeLessThan(-4.5);
  });
});
