/**
 * Static location snapshot for printed reports (brief §9.4): the project point inside the
 * outline of its administrative area, drawn as inline SVG from `admin_area_shapes` — no map
 * tiles, no external request, prints crisply at any size.
 *
 * The district (level 2) is used when the project has one, else the region (level 1); level 3
 * carries no geometry (geo-search-tiles.md §2).
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { useEffect, useState } from 'preact/hooks';
import { pickName, t } from '../i18n';
import { isOnline, reportsApi } from './api';
import { isObj, type AdminAreaRef } from './types';

type Shape = Polygon | MultiPolygon;

const shapeCache = new Map<string, Promise<Map<string, Shape>>>();

async function shapesOf(countryId: string, level: number): Promise<Map<string, Shape>> {
  const key = `${countryId}:${level}`;
  let pending = shapeCache.get(key);
  if (!pending) {
    pending = reportsApi()
      .adminAreaShapes(countryId, level)
      .then((payload) => {
        const map = new Map<string, Shape>();
        const features = isObj(payload) && Array.isArray(payload.features) ? payload.features : [];
        for (const f of features) {
          if (!isObj(f) || !isObj(f.geometry)) continue;
          const props = isObj(f.properties) ? f.properties : {};
          const id =
            typeof props.id === 'string' ? props.id : typeof f.id === 'string' ? f.id : null;
          const g = f.geometry as unknown as Shape;
          if (id && (g.type === 'Polygon' || g.type === 'MultiPolygon')) map.set(id, g);
        }
        return map;
      });
    // A failure is not remembered: the next print view may try again.
    pending.catch(() => shapeCache.delete(key));
    shapeCache.set(key, pending);
  }
  return pending;
}

/** Test hook. */
export function clearShapeCache(): void {
  shapeCache.clear();
}

function rings(shape: Shape): Position[][] {
  return shape.type === 'Polygon' ? shape.coordinates : shape.coordinates.flat();
}

export interface Projection {
  x(lon: number): number;
  y(lat: number): number;
}

/** Equirectangular projection of `bbox` into a `w × h` box with `pad` (aspect kept, centred). */
export function fitProjection(
  bbox: [number, number, number, number],
  w: number,
  h: number,
  pad: number,
): Projection {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const dx = Math.max((maxLon - minLon) * k, 1e-6);
  const dy = Math.max(maxLat - minLat, 1e-6);
  const s = Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy);
  const ox = (w - dx * s) / 2;
  const oy = (h - dy * s) / 2;
  return {
    x: (lon) => ox + (lon - minLon) * k * s,
    y: (lat) => oy + (maxLat - lat) * s,
  };
}

export function bboxOf(
  shape: Shape | null,
  point: { lon: number; lat: number } | null,
): [number, number, number, number] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const add = (lon: number, lat: number): void => {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  };
  if (shape)
    for (const ring of rings(shape)) for (const p of ring) add(p[0] as number, p[1] as number);
  if (point) add(point.lon, point.lat);
  if (!Number.isFinite(minLon)) return null;
  if (!shape) {
    // A point alone: a ~5 km frame around it.
    const d = 0.025;
    return [minLon - d, minLat - d, maxLon + d, maxLat + d];
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function pathOf(shape: Shape, proj: Projection): string {
  return rings(shape)
    .map(
      (ring) =>
        ring
          .map(
            (p, i) =>
              `${i === 0 ? 'M' : 'L'}${proj.x(p[0] as number).toFixed(1)} ${proj.y(p[1] as number).toFixed(1)}`,
          )
          .join('') + 'Z',
    )
    .join('');
}

export interface AreaMapProps {
  countryId: string | null;
  areas: AdminAreaRef[];
  lon: number | null;
  lat: number | null;
}

const W = 320;
const H = 220;

export function AreaMap({ countryId, areas, lon, lat }: AreaMapProps) {
  const area = areas.find((a) => a.level === 2) ?? areas.find((a) => a.level === 1) ?? null;
  const [shape, setShape] = useState<Shape | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none'>(
    area && countryId ? 'loading' : 'none',
  );

  useEffect(() => {
    if (!area || !countryId || !isOnline()) {
      setState('none');
      return;
    }
    let alive = true;
    shapesOf(countryId, area.level)
      .then((map) => {
        if (!alive) return;
        const found = map.get(area.id) ?? null;
        setShape(found);
        setState(found ? 'ready' : 'none');
      })
      .catch(() => alive && setState('none'));
    return () => {
      alive = false;
    };
  }, [countryId, area?.id]);

  const point = lon !== null && lat !== null ? { lon, lat } : null;
  const bbox = bboxOf(shape, point);
  if (state === 'loading') {
    return (
      <div
        class="pmap pmap--loading"
        aria-busy="true"
        data-testid="print-map"
        data-state="loading"
      />
    );
  }
  if (!bbox) {
    return (
      <div class="pmap pmap--empty" data-testid="print-map" data-state="empty">
        <p class="muted">{t('reports.mapNoLocation')}</p>
      </div>
    );
  }
  const proj = fitProjection(bbox, W, H, 14);
  const label = area ? pickName(area) : '';
  return (
    <figure class="pmap" data-testid="print-map" data-state={shape ? 'shape' : 'point'}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('reports.mapLabel', { area: label || t('reports.unassigned') })}
        class="pmap__svg"
      >
        <rect x="0" y="0" width={W} height={H} class="pmap__bg" />
        {shape && (
          <path
            d={pathOf(shape, proj)}
            class="pmap__area"
            fill-rule="evenodd"
            data-testid="print-map-area"
          />
        )}
        {point && (
          <g data-testid="print-map-point">
            <circle cx={proj.x(point.lon)} cy={proj.y(point.lat)} r="9" class="pmap__halo" />
            <circle cx={proj.x(point.lon)} cy={proj.y(point.lat)} r="5" class="pmap__dot" />
          </g>
        )}
      </svg>
      <figcaption class="pmap__caption">
        {label && <bdi>{label}</bdi>}
        {point && (
          <span class="ltr mono" dir="ltr">
            {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
