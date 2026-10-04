import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  GRID_COLUMNS,
  bboxAround,
  bboxContains,
  bboxIntersects,
  bboxOfGeometry,
  gridCell,
  gridColumn,
  gridRangesForBBox,
  gridRow,
  haversineMeters,
  isValidLonLat,
  pointInPolygon,
  type BBox,
} from './geo';

const PEMBA = { lon: 39.75, lat: -5.05 };

describe('haversineMeters', () => {
  it('is zero for the same point and symmetric', () => {
    expect(haversineMeters(PEMBA, PEMBA)).toBe(0);
    const other = { lon: 39.2, lat: -6.16 };
    expect(haversineMeters(PEMBA, other)).toBeCloseTo(haversineMeters(other, PEMBA), 6);
  });

  it('one degree of latitude is about 111.2 km', () => {
    const d = haversineMeters({ lon: 39, lat: -5 }, { lon: 39, lat: -6 });
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });

  it('one degree of longitude shrinks with the cosine of the latitude', () => {
    const equator = haversineMeters({ lon: 39, lat: 0 }, { lon: 40, lat: 0 });
    const north = haversineMeters({ lon: 39, lat: 60 }, { lon: 40, lat: 60 });
    expect(north / equator).toBeCloseTo(0.5, 2);
  });

  it('agrees with PostGIS geography distance within 0.5 % at duplicate-check distances', () => {
    // select st_distance('SRID=4326;POINT(39.75 -5.05)'::geography, 'SRID=4326;POINT(39.751 -5.0508)'::geography)
    //   -> 141.855 m (spheroid, measured on the local stack)
    const d = haversineMeters(PEMBA, { lon: 39.751, lat: -5.0508 });
    expect(Math.abs(d - 141.855) / 141.855).toBeLessThan(0.005);
  });

  it('known city pair: Zanzibar Stone Town to Dar es Salaam is about 73 km', () => {
    const d = haversineMeters({ lon: 39.1925, lat: -6.1622 }, { lon: 39.2803, lat: -6.8161 });
    expect(d).toBeGreaterThan(72_000);
    expect(d).toBeLessThan(74_500);
  });

  it('handles antipodes without NaN', () => {
    const d = haversineMeters({ lon: 0, lat: 0 }, { lon: 180, lat: 0 });
    expect(d).toBeCloseTo(Math.PI * 6371008.8, 0);
  });
});

describe('isValidLonLat', () => {
  it('accepts numbers in range only', () => {
    expect(isValidLonLat({ lon: 39.7, lat: -5 })).toBe(true);
    expect(isValidLonLat({ lon: 180, lat: 90 })).toBe(true);
    expect(isValidLonLat({ lon: 180.1, lat: 0 })).toBe(false);
    expect(isValidLonLat({ lon: 0, lat: -90.5 })).toBe(false);
    expect(isValidLonLat({ lon: null, lat: null })).toBe(false);
    expect(isValidLonLat({ lon: '39', lat: -5 })).toBe(false);
    expect(isValidLonLat({ lon: Number.NaN, lat: 0 })).toBe(false);
    expect(isValidLonLat(null)).toBe(false);
    expect(isValidLonLat(undefined)).toBe(false);
  });
});

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

const squareWithHole: Polygon = {
  type: 'Polygon',
  coordinates: [
    square.coordinates[0]!,
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ],
};

const twoIslands: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    squareWithHole.coordinates,
    [
      [
        [20, 20],
        [22, 20],
        [21, 23],
        [20, 20],
      ],
    ],
  ],
};

describe('pointInPolygon', () => {
  it('Polygon: inside and outside', () => {
    expect(pointInPolygon({ lon: 5, lat: 5 }, square)).toBe(true);
    expect(pointInPolygon({ lon: 0.001, lat: 9.999 }, square)).toBe(true);
    expect(pointInPolygon({ lon: -1, lat: 5 }, square)).toBe(false);
    expect(pointInPolygon({ lon: 5, lat: 11 }, square)).toBe(false);
    expect(pointInPolygon({ lon: 15, lat: 5 }, square)).toBe(false);
  });

  it('Polygon: a point in a hole is outside', () => {
    expect(pointInPolygon({ lon: 5, lat: 5 }, squareWithHole)).toBe(false);
    expect(pointInPolygon({ lon: 3, lat: 5 }, squareWithHole)).toBe(true);
    expect(pointInPolygon({ lon: 7, lat: 7 }, squareWithHole)).toBe(true);
  });

  it('MultiPolygon: any part counts, holes are respected per part', () => {
    expect(pointInPolygon({ lon: 21, lat: 21 }, twoIslands)).toBe(true);
    expect(pointInPolygon({ lon: 3, lat: 3 }, twoIslands)).toBe(true);
    expect(pointInPolygon({ lon: 5, lat: 5 }, twoIslands)).toBe(false);
    expect(pointInPolygon({ lon: 15, lat: 15 }, twoIslands)).toBe(false);
    expect(pointInPolygon({ lon: 21.9, lat: 22.9 }, twoIslands)).toBe(false);
  });

  it('concave polygon', () => {
    const concave: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [5, 3],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    expect(pointInPolygon({ lon: 5, lat: 1 }, concave)).toBe(true);
    expect(pointInPolygon({ lon: 5, lat: 6 }, concave)).toBe(false);
    expect(pointInPolygon({ lon: 1, lat: 7 }, concave)).toBe(true);
  });

  it('degenerate geometry never matches', () => {
    expect(pointInPolygon({ lon: 0, lat: 0 }, { type: 'Polygon', coordinates: [] })).toBe(false);
    expect(pointInPolygon({ lon: 0, lat: 0 }, { type: 'MultiPolygon', coordinates: [] })).toBe(false);
  });
});

describe('bounding boxes', () => {
  it('bboxOfGeometry covers every part', () => {
    expect(bboxOfGeometry(square)).toEqual([0, 0, 10, 10]);
    expect(bboxOfGeometry(twoIslands)).toEqual([0, 0, 22, 23]);
    expect(bboxOfGeometry({ type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('bboxContains is inclusive', () => {
    const box: BBox = [39, -6, 40, -5];
    expect(bboxContains(box, PEMBA)).toBe(true);
    expect(bboxContains(box, { lon: 39, lat: -6 })).toBe(true);
    expect(bboxContains(box, { lon: 40.0001, lat: -5.5 })).toBe(false);
  });

  it('bboxIntersects', () => {
    expect(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(bboxIntersects([0, 0, 2, 2], [2, 2, 3, 3])).toBe(true);
    expect(bboxIntersects([0, 0, 2, 2], [2.1, 0, 3, 2])).toBe(false);
  });

  it('bboxAround contains the whole circle and little more', () => {
    const radius = 150;
    const box = bboxAround(PEMBA, radius);
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const rad = (bearing * Math.PI) / 180;
      const p = {
        lon: PEMBA.lon + ((radius * Math.sin(rad)) / (111320 * Math.cos((PEMBA.lat * Math.PI) / 180))) * 0.999,
        lat: PEMBA.lat + ((radius * Math.cos(rad)) / 111320) * 0.999,
      };
      expect(bboxContains(box, p)).toBe(true);
    }
    expect(haversineMeters({ lon: box[0], lat: PEMBA.lat }, { lon: box[2], lat: PEMBA.lat })).toBeLessThan(2 * radius * 1.02);
    expect(haversineMeters({ lon: PEMBA.lon, lat: box[1] }, { lon: PEMBA.lon, lat: box[3] })).toBeLessThan(2 * radius * 1.02);
  });

  it('bboxAround is clamped at the poles and the date line', () => {
    const box = bboxAround({ lon: 179.9999, lat: 89.9999 }, 5000);
    expect(box[2]).toBeLessThanOrEqual(180);
    expect(box[3]).toBeLessThanOrEqual(90);
  });
});

describe('grid for the local spatial index', () => {
  it('a cell is 0.01 degrees; cells are numbered row by row', () => {
    expect(gridColumn(-180)).toBe(0);
    expect(gridRow(-90)).toBe(0);
    expect(gridColumn(39.75)).toBe(21975);
    expect(gridRow(-5.05)).toBe(8495);
    expect(gridCell(PEMBA)).toBe(8495 * GRID_COLUMNS + 21975);
    // neighbours east and north
    expect(gridCell({ lon: 39.76, lat: -5.05 })).toBe(gridCell(PEMBA) + 1);
    expect(gridCell({ lon: 39.75, lat: -5.04 })).toBe(gridCell(PEMBA) + GRID_COLUMNS);
  });

  it('is stable against floating point noise at cell borders', () => {
    for (let i = 0; i < 2000; i++) {
      const lon = Math.round((-180 + i * 0.18) * 100) / 100;
      expect(gridColumn(lon)).toBe(Math.round((lon + 180) * 100));
    }
    for (let i = 0; i < 1800; i++) {
      const lat = Math.round((-90 + i * 0.1) * 100) / 100;
      expect(gridRow(lat)).toBe(Math.round((lat + 90) * 100));
    }
  });

  it('clamps to the valid range', () => {
    expect(gridColumn(180)).toBe(GRID_COLUMNS - 1);
    expect(gridColumn(500)).toBe(GRID_COLUMNS - 1);
    expect(gridColumn(-500)).toBe(0);
    expect(gridRow(90)).toBe(17999);
    expect(gridRow(-200)).toBe(0);
  });

  it('gridRangesForBBox: one inclusive key range per grid row, covering every point of the box', () => {
    const box: BBox = [39.741, -5.062, 39.768, -5.038];
    const ranges = gridRangesForBBox(box)!;
    expect(ranges).toHaveLength(4); // rows of -5.07..-5.06 up to -5.04..-5.03
    for (const [lo, hi] of ranges) expect(hi - lo).toBe(2); // 3 columns
    const inRanges = (cell: number): boolean => ranges.some(([lo, hi]) => cell >= lo && cell <= hi);
    for (let lon = box[0]; lon <= box[2]; lon += 0.0031) {
      for (let lat = box[1]; lat <= box[3]; lat += 0.0029) {
        expect(inRanges(gridCell({ lon, lat }))).toBe(true);
      }
    }
    // points outside the box by more than one cell are not covered
    expect(inRanges(gridCell({ lon: 39.80, lat: -5.05 }))).toBe(false);
    expect(inRanges(gridCell({ lon: 39.75, lat: -5.10 }))).toBe(false);
  });

  it('gridRangesForBBox accepts corners in any order and refuses huge boxes', () => {
    expect(gridRangesForBBox([39.768, -5.038, 39.741, -5.062])).toEqual(gridRangesForBBox([39.741, -5.062, 39.768, -5.038]));
    expect(gridRangesForBBox([30, -12, 42, 5])).toBeNull();
    expect(gridRangesForBBox([30, -12, 42, 5], 2000)).toHaveLength(1701);
  });
});
