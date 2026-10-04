/**
 * When the map page fits the map to the projects (v2 parity 1.5; v2 called `fitFiltered` at map
 * start and on every filter change, reset included).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { requestCamera, resetMapController, takePendingCamera } from './controller';
import { endStartFit, fitDecision, resetStartFit, startFitWaiting } from './MapPage';

afterEach(() => {
  resetStartFit();
  resetMapController();
});

describe('fitDecision', () => {
  it('the first map of an app session tries the start fit (fresh device or not)', () => {
    expect(fitDecision(true)).toBe('start');
    expect(startFitWaiting()).toBe(true);
  });

  it('the start fit stays wanted until it found projects (a fresh device before its first sync)', () => {
    expect(fitDecision(true)).toBe('start');
    // No project on the device yet: the page tries again on the next visit / after the sync.
    expect(fitDecision(true)).toBe('start');
    endStartFit(); // projects were found and the map was fitted
    expect(fitDecision(true)).toBe('keep');
    expect(startFitWaiting()).toBe(false);
  });

  it('later visits in the same session keep the camera the user left', () => {
    expect(fitDecision(true)).toBe('start');
    endStartFit();
    expect(fitDecision(true)).toBe('keep');
    expect(fitDecision(true)).toBe('keep');
  });

  it('every filter change fits, clearing the filters included, and ends the start fit', () => {
    expect(fitDecision(true)).toBe('start');
    expect(fitDecision(false)).toBe('fit');
    expect(startFitWaiting()).toBe(false);
    expect(fitDecision(false)).toBe('fit');
    expect(fitDecision(true)).toBe('keep');
  });

  it('a "show on map" request waiting for the map wins over the start fit', () => {
    requestCamera({ kind: 'fly', point: { lon: 39.7, lat: -5.05 }, zoom: 16 });
    expect(fitDecision(true)).toBe('keep');
    expect(takePendingCamera()).toEqual({
      kind: 'fly',
      point: { lon: 39.7, lat: -5.05 },
      zoom: 16,
    });
    // …and the start fit is not made up for on the next visit of the session.
    expect(fitDecision(true)).toBe('keep');
  });

  it('a new app session fits again', () => {
    expect(fitDecision(true)).toBe('start');
    endStartFit();
    resetStartFit();
    expect(fitDecision(true)).toBe('start');
  });
});
