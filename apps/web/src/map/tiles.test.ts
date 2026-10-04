import { describe, expect, it, vi } from 'vitest';
import { functionsUrl } from './config';
import {
  createTransformRequest,
  isProjectTileUrl,
  projectTilesUrl,
  tileFilters,
  type TransformedRequest,
} from './tiles';

const FN = 'http://127.0.0.1:54321/functions/v1';

describe('tileFilters', () => {
  it('keeps only what the tile function understands', () => {
    expect(
      tileFilters(
        {
          q: 'نور',
          countryId: 'c-1',
          branchId: 'b-1',
          adminAreaId: 'a-1',
          type: 'mosque',
          status: 'maintenance',
          recordState: 'approved',
          mine: true,
          incomplete: true,
          openMaintenance: true,
        },
        false,
      ),
    ).toEqual({
      layers: ['clusters', 'points'],
      country_id: 'c-1',
      branch_id: 'b-1',
      type: 'mosque',
      status: 'maintenance',
      record_state: 'approved',
    });
  });

  it('asks for the needs layer only while a heat map is shown', () => {
    expect(tileFilters({}, true).layers).toEqual(['clusters', 'points', 'needs']);
    expect(tileFilters({}, false).layers).toEqual(['clusters', 'points']);
  });

  it('drops values the server would reject with 422', () => {
    expect(tileFilters({ type: 'mosque; drop', status: '' }, false)).toEqual({
      layers: ['clusters', 'points'],
    });
  });
});

describe('projectTilesUrl', () => {
  it('builds the Edge Function template with URI-encoded filters and the scope epoch', () => {
    const url = projectTilesUrl(`${FN}/`, tileFilters({ type: 'school' }, false), 'e:1');
    expect(url.startsWith(`${FN}/tiles/{z}/{x}/{y}?f=`)).toBe(true);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(JSON.parse(query.get('f') ?? '')).toEqual({
      layers: ['clusters', 'points'],
      type: 'school',
    });
    expect(query.get('e')).toBe('e:1');
    // Only MapLibre's own placeholders contain braces.
    expect(url.replace('{z}/{x}/{y}', '')).not.toMatch(/[{}]/);
  });

  it('a changed scope epoch changes the URL (cache invalidation)', () => {
    const f = tileFilters({}, false);
    expect(projectTilesUrl(FN, f, 'a')).not.toBe(projectTilesUrl(FN, f, 'b'));
    expect(projectTilesUrl(FN, f, null)).toContain('&e=0');
  });
});

describe('createTransformRequest', () => {
  const deps = {
    functionsBase: functionsUrl('http://127.0.0.1:54321/'),
    anonKey: 'anon-key',
    deviceId: () => 'device-1',
    token: vi.fn(async () => 'jwt-token'),
  };

  it('adds Authorization, apikey and x-device-id to project tile requests', async () => {
    const transform = createTransformRequest(deps);
    const result = await transform(`${FN}/tiles/5/19/16?f=%7B%7D&e=x`, 'Tile');
    expect(result).toEqual({
      url: `${FN}/tiles/5/19/16?f=%7B%7D&e=x`,
      headers: {
        Authorization: 'Bearer jwt-token',
        apikey: 'anon-key',
        'x-device-id': 'device-1',
      },
    });
  });

  it('asks for the token on every tile (supabase-js refreshes it when needed)', async () => {
    deps.token.mockClear();
    const transform = createTransformRequest(deps);
    await transform(`${FN}/tiles/1/0/0`, 'Tile');
    await transform(`${FN}/tiles/1/1/0`, 'Tile');
    expect(deps.token).toHaveBeenCalledTimes(2);
  });

  it('leaves every other URL untouched and synchronous (glyphs, sprites, basemap)', () => {
    const transform = createTransformRequest(deps);
    for (const url of [
      'http://127.0.0.1:4173/map/fonts/Noto%20Sans%20Regular/0-255.pbf',
      'http://127.0.0.1:4173/map/sprites/light.json',
      'istiqama-basemap://tilejson/1',
      `${FN}/sync_pull`,
    ]) {
      const result = transform(url, 'Glyphs') as TransformedRequest;
      expect(result).toEqual({ url });
      expect(result).not.toBeInstanceOf(Promise);
    }
  });

  it('sends no Authorization header when signed out', async () => {
    const transform = createTransformRequest({ ...deps, token: async () => null });
    const result = await transform(`${FN}/tiles/0/0/0`, 'Tile');
    expect(result.headers).toEqual({ apikey: 'anon-key', 'x-device-id': 'device-1' });
  });

  it('recognises the tile endpoint only under the configured functions URL', () => {
    expect(isProjectTileUrl(`${FN}/tiles/1/2/3`, FN)).toBe(true);
    expect(isProjectTileUrl(`${FN}/tilesx/1/2/3`, FN)).toBe(false);
    expect(isProjectTileUrl('https://evil.example/functions/v1/tiles/1/2/3', FN)).toBe(false);
  });
});
