import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasActiveMap,
  hasPendingCamera,
  registerMap,
  requestCamera,
  resetMapController,
  takePendingCamera,
} from './controller';

afterEach(resetMapController);

const target = () => ({ flyTo: vi.fn(), fitBounds: vi.fn() });

describe('map controller registry', () => {
  it('moves the active map at once', () => {
    const map = target();
    registerMap(map);
    expect(requestCamera({ kind: 'fly', point: { lon: 39, lat: -5 }, zoom: 16 })).toBe(true);
    expect(map.flyTo).toHaveBeenCalledWith({ lon: 39, lat: -5 }, 16);
    requestCamera({ kind: 'fit', bounds: [39, -6, 40, -5], maxZoom: 11 });
    expect(map.fitBounds).toHaveBeenCalledWith([39, -6, 40, -5], 11);
  });

  it('keeps a request made without a map and applies it when the next map mounts', () => {
    expect(hasActiveMap()).toBe(false);
    expect(requestCamera({ kind: 'fly', point: { lon: 39, lat: -5 } })).toBe(false);
    const map = target();
    registerMap(map);
    expect(map.flyTo).toHaveBeenCalledWith({ lon: 39, lat: -5 }, undefined);
    expect(takePendingCamera()).toBeNull();
  });

  it('reports a request waiting for a map until a map takes it', () => {
    expect(hasPendingCamera()).toBe(false);
    requestCamera({ kind: 'fly', point: { lon: 39, lat: -5 } });
    expect(hasPendingCamera()).toBe(true);
    registerMap(target());
    expect(hasPendingCamera()).toBe(false);
    requestCamera({ kind: 'fly', point: { lon: 39, lat: -5 } });
    expect(hasPendingCamera()).toBe(false); // applied to the active map at once
  });

  it('only the latest pending request survives', () => {
    requestCamera({ kind: 'fly', point: { lon: 1, lat: 1 } });
    requestCamera({ kind: 'fit', bounds: [0, 0, 1, 1] });
    expect(takePendingCamera()).toEqual({ kind: 'fit', bounds: [0, 0, 1, 1] });
  });

  it('unregistering an older map does not drop a newer one', () => {
    const first = target();
    const second = target();
    const offFirst = registerMap(first);
    const offSecond = registerMap(second);
    offFirst();
    expect(hasActiveMap()).toBe(true);
    offSecond();
    expect(hasActiveMap()).toBe(false);
  });
});
