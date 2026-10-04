import { describe, expect, it, vi } from 'vitest';
import { haversineMeters, type LonLat } from '../lib/geo';
import {
  circlePolygon,
  LocateController,
  locateFeatures,
  zoomForAccuracy,
  type GeolocationLike,
  type LocateAdapter,
} from './locate';

interface FakeMarker {
  id: number;
  p: LonLat;
  accuracy: number;
}

function fakeAdapter() {
  let ids = 0;
  const markers: FakeMarker[] = [];
  const adapter: LocateAdapter<FakeMarker> = {
    createMarker: vi.fn((p: LonLat, accuracy: number) => {
      const marker = { id: ++ids, p, accuracy };
      markers.push(marker);
      return marker;
    }),
    updateMarker: vi.fn((marker: FakeMarker, p: LonLat, accuracy: number) => {
      marker.p = p;
      marker.accuracy = accuracy;
    }),
    removeMarker: vi.fn((marker: FakeMarker) => {
      markers.splice(markers.indexOf(marker), 1);
    }),
    focus: vi.fn(),
  };
  return { adapter, markers };
}

function fakeGeolocation(fixes: Array<{ lon: number; lat: number; accuracy: number } | number>) {
  const calls: number[] = [];
  const geo: GeolocationLike = {
    getCurrentPosition(success, error) {
      calls.push(1);
      const next = fixes.shift();
      if (typeof next === 'number') error?.({ code: next });
      else if (next)
        success({
          coords: { latitude: next.lat, longitude: next.lon, accuracy: next.accuracy },
        });
    },
  };
  return { geo, calls };
}

describe('LocateController — one marker updated in place (brief §12)', () => {
  it('creates the marker on the first fix and moves it on every later press', async () => {
    const { adapter, markers } = fakeAdapter();
    const { geo } = fakeGeolocation([
      { lon: 39.7, lat: -5.0, accuracy: 12 },
      { lon: 39.71, lat: -5.01, accuracy: 8 },
      { lon: 39.72, lat: -5.02, accuracy: 30 },
    ]);
    const controller = new LocateController(adapter, geo);
    for (let i = 0; i < 3; i++) expect((await controller.locate()).ok).toBe(true);
    expect(adapter.createMarker).toHaveBeenCalledTimes(1);
    expect(adapter.updateMarker).toHaveBeenCalledTimes(2);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ p: { lon: 39.72, lat: -5.02 }, accuracy: 30 });
    expect(adapter.focus).toHaveBeenCalledTimes(3);
  });

  it('a second press while waiting for the GPS shares the same request', async () => {
    const { adapter } = fakeAdapter();
    let deliver: (() => void) | null = null;
    const geo: GeolocationLike = {
      getCurrentPosition: vi.fn((success) => {
        deliver = () => success({ coords: { latitude: -5, longitude: 39, accuracy: 5 } });
      }),
    };
    const controller = new LocateController(adapter, geo);
    const a = controller.locate();
    const b = controller.locate();
    expect(a).toBe(b);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    deliver!();
    await a;
    expect(adapter.createMarker).toHaveBeenCalledTimes(1);
  });

  it('reports denied / unavailable / timeout / unsupported without touching the marker', async () => {
    const { adapter } = fakeAdapter();
    const { geo } = fakeGeolocation([1, 2, 3]);
    const controller = new LocateController(adapter, geo);
    expect(await controller.locate()).toEqual({ ok: false, error: 'denied' });
    expect(await controller.locate()).toEqual({ ok: false, error: 'unavailable' });
    expect(await controller.locate()).toEqual({ ok: false, error: 'timeout' });
    expect(await new LocateController(adapter, null).locate()).toEqual({
      ok: false,
      error: 'unsupported',
    });
    expect(adapter.createMarker).not.toHaveBeenCalled();
  });

  it('after a style rebuild the last fix is drawn again with ONE new marker', async () => {
    const { adapter } = fakeAdapter();
    const { geo } = fakeGeolocation([{ lon: 39, lat: -5, accuracy: 10 }]);
    const controller = new LocateController(adapter, geo);
    await controller.locate();
    controller.reattach();
    expect(adapter.createMarker).toHaveBeenCalledTimes(2);
    controller.show({ lon: 39.1, lat: -5 }, 10);
    expect(adapter.createMarker).toHaveBeenCalledTimes(2);
    expect(adapter.updateMarker).toHaveBeenCalledTimes(1);
  });

  it('clear() removes the marker; the next fix creates it again', async () => {
    const { adapter, markers } = fakeAdapter();
    const { geo } = fakeGeolocation([
      { lon: 39, lat: -5, accuracy: 10 },
      { lon: 39, lat: -5, accuracy: 10 },
    ]);
    const controller = new LocateController(adapter, geo);
    await controller.locate();
    controller.clear();
    expect(markers).toHaveLength(0);
    expect(controller.hasMarker).toBe(false);
    await controller.locate();
    expect(markers).toHaveLength(1);
  });
});

describe('accuracy circle', () => {
  it('is a closed ring at the given radius', () => {
    const center = { lon: 39.75, lat: -5.05 };
    const polygon = circlePolygon(center, 250, 32);
    const ring = polygon.coordinates[0]!;
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    for (const [lon, lat] of ring) {
      expect(haversineMeters(center, { lon: lon!, lat: lat! })).toBeCloseTo(250, 0);
    }
  });

  it('marker features: accuracy polygon + dot, dot only without accuracy', () => {
    const p = { lon: 39, lat: -5 };
    expect(locateFeatures(p, 20).features.map((f) => f.geometry.type)).toEqual([
      'Polygon',
      'Point',
    ]);
    expect(locateFeatures(p, 0).features.map((f) => f.geometry.type)).toEqual(['Point']);
  });

  it('zooms closer for a better fix', () => {
    expect(zoomForAccuracy(10)).toBeGreaterThan(zoomForAccuracy(500));
    expect(zoomForAccuracy(5000)).toBe(11);
  });
});
