import { describe, expect, it } from 'vitest';
import {
  createPickSession,
  formatCoordinates,
  InvalidCoordinatesError,
  normalizePoint,
} from './pick';

describe('pick session (v2 parity 1.8)', () => {
  it('cannot confirm before a point was chosen', () => {
    const session = createPickSession(null);
    expect(session.canConfirm()).toBe(false);
    expect(session.selected()).toBeNull();
    expect(() => session.confirm()).toThrow();
    expect(session.settled).toBe(false);
  });

  it('tap → confirm returns the rounded point with source "map"', () => {
    const session = createPickSession(null);
    expect(session.choose({ lon: 39.7291234567, lat: -5.0551234567 })).toEqual({
      lon: 39.729123,
      lat: -5.055123,
    });
    expect(session.canConfirm()).toBe(true);
    expect(session.confirm()).toEqual({ lon: 39.729123, lat: -5.055123, source: 'map' });
    expect(session.settled).toBe(true);
  });

  it('the last tap wins', () => {
    const session = createPickSession(null);
    session.choose({ lon: 39.1, lat: -5.1 });
    session.choose({ lon: 39.2, lat: -5.2 });
    expect(session.confirm()).toEqual({ lon: 39.2, lat: -5.2, source: 'map' });
  });

  it('"return without change" gives null even after a tap', () => {
    const session = createPickSession({ lon: 39.0, lat: -5.0 });
    session.choose({ lon: 39.5, lat: -5.5 });
    expect(session.cancel()).toBeNull();
    expect(session.settled).toBe(true);
  });

  it('keeps the original point apart from the chosen one and reports a change', () => {
    const session = createPickSession({ lon: 39.0000001, lat: -5.0000004 });
    expect(session.original).toEqual({ lon: 39, lat: -5 });
    expect(session.changed()).toBe(false);
    session.choose({ lon: 39, lat: -5 });
    expect(session.changed()).toBe(false); // same place tapped again
    session.choose({ lon: 39.0001, lat: -5 });
    expect(session.changed()).toBe(true);
  });

  it('an invalid initial point is ignored; an invalid tap is refused', () => {
    const session = createPickSession({ lon: 999, lat: 0 });
    expect(session.original).toBeNull();
    expect(() => session.choose({ lon: Number.NaN, lat: 0 })).toThrow(InvalidCoordinatesError);
    expect(session.canConfirm()).toBe(false);
  });

  it('a tap without a previous location counts as a change', () => {
    const session = createPickSession(null);
    session.choose({ lon: 39, lat: -5 });
    expect(session.changed()).toBe(true);
  });
});

describe('normalizePoint', () => {
  it('validates ranges and rounds to six decimals', () => {
    expect(normalizePoint({ lon: '39.12345678', lat: '-5.98765432' })).toEqual({
      lon: 39.123457,
      lat: -5.987654,
    });
    expect(normalizePoint({ lon: -0.0000001, lat: 0 })).toEqual({ lon: 0, lat: 0 });
    expect(Object.is(normalizePoint({ lon: -0.0000001, lat: 0 }).lon, -0)).toBe(false);
    for (const bad of [
      { lon: 181, lat: 0 },
      { lon: 0, lat: -91 },
      { lon: '', lat: 1 },
      { lon: null, lat: 1 },
      { lon: 'abc', lat: 1 },
      { lon: Number.POSITIVE_INFINITY, lat: 1 },
    ]) {
      expect(() => normalizePoint(bad)).toThrow(InvalidCoordinatesError);
    }
  });

  it('formats latitude first with six decimals', () => {
    expect(formatCoordinates({ lon: 39.729, lat: -5.055 })).toBe('-5.055000, 39.729000');
  });
});
