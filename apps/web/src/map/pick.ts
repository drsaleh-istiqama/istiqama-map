/**
 * Pick-mode session (docs/V2_PARITY.md 1.8): tap the map to choose a point, then "confirm and
 * return" (the chosen point) or "return without change" (null). Pure state, no DOM — the
 * dialog (PickerDialog.tsx) drives it and the unit tests cover it.
 *
 * Same rules as v2's `createMapPickSession`: coordinates are validated and rounded to six
 * decimals (~0.1 m); nothing can be confirmed before a point was chosen.
 */
import type { LonLat } from '../lib/geo';

export type PickResult = LonLat & { source: 'map' };

export class InvalidCoordinatesError extends Error {
  constructor() {
    super('invalid coordinates');
    this.name = 'InvalidCoordinatesError';
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Validated, rounded copy of a point; throws `InvalidCoordinatesError` for anything else. */
export function normalizePoint(point: { lon: unknown; lat: unknown }): LonLat {
  const lon = typeof point.lon === 'number' ? point.lon : Number(point.lon);
  const lat = typeof point.lat === 'number' ? point.lat : Number(point.lat);
  if (
    point.lon === null ||
    point.lat === null ||
    point.lon === '' ||
    point.lat === '' ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new InvalidCoordinatesError();
  }
  // `+ 0` turns a rounded -0 into 0.
  return { lon: round6(lon) + 0, lat: round6(lat) + 0 };
}

/** `-5.055000, 39.729000` — latitude first, as GPS apps and v2 show it. */
export function formatCoordinates(p: LonLat): string {
  return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
}

export interface PickSession {
  /** The point the form had when pick mode opened (shown, but not "chosen"). */
  readonly original: LonLat | null;
  /** Tap on the map. Returns the stored (rounded) point. */
  choose(point: LonLat): LonLat;
  selected(): LonLat | null;
  canConfirm(): boolean;
  /** A point was chosen and it differs from the original one. */
  changed(): boolean;
  /** "Confirm and return". Throws when nothing was chosen. */
  confirm(): PickResult;
  /** "Return without change". */
  cancel(): null;
  /** True once confirm() or cancel() ran (state only: the dialog keeps its own "done" flag). */
  readonly settled: boolean;
}

export function createPickSession(initial: LonLat | null): PickSession {
  let original: LonLat | null = null;
  if (initial) {
    try {
      original = normalizePoint(initial);
    } catch {
      original = null;
    }
  }
  let selected: LonLat | null = null;
  let settled = false;
  return {
    original,
    choose(point) {
      selected = normalizePoint(point);
      return { ...selected };
    },
    selected: () => (selected ? { ...selected } : null),
    canConfirm: () => selected !== null,
    changed: () =>
      selected !== null &&
      (original === null || selected.lon !== original.lon || selected.lat !== original.lat),
    confirm() {
      if (!selected) throw new Error('choose a point on the map first');
      settled = true;
      return { lon: selected.lon, lat: selected.lat, source: 'map' };
    },
    cancel() {
      settled = true;
      return null;
    },
    get settled() {
      return settled;
    },
  };
}
