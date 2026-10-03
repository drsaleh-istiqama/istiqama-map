/**
 * Reads a boundary GeoJSON file (geoBoundaries, or an OCHA COD-AB export passed with --file)
 * into the flat records the loader sends to PostGIS.
 */
import fs from 'node:fs';

export interface BoundaryFeature {
  /** geoBoundaries shapeID or COD-AB p-code: unique per country and level. */
  code: string;
  nameEn: string;
  /** Present in some COD-AB files only. */
  nameAr: string | null;
  nameSw: string | null;
  /** ISO 3166-2 code when the source has one (geoBoundaries: level 1 only), e.g. "TZ-06". */
  iso: string | null;
  /** GeoJSON geometry (Polygon or MultiPolygon) as text. */
  geometry: string;
}

export interface BoundaryFile {
  features: BoundaryFeature[];
  warnings: string[];
}

interface RawFeature {
  type?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

interface RawCollection {
  type?: unknown;
  crs?: { properties?: { name?: unknown } } | null;
  features?: unknown;
}

const WGS84_CRS = /(CRS84|EPSG:+4326)$/i;

function clean(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** First non-empty property among the candidates (exact name, then case-insensitive). */
function pick(props: Record<string, unknown>, candidates: string[]): string | null {
  for (const name of candidates) {
    const value = clean(props[name]);
    if (value !== null) return value;
  }
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const name of candidates) {
    const key = lower.get(name.toLowerCase());
    if (key !== undefined) {
      const value = clean(props[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

export function readBoundaryFile(file: string, level: number): BoundaryFile {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RawCollection;
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`${file}: not a GeoJSON FeatureCollection`);
  }
  const crs = clean(parsed.crs?.properties?.name);
  if (crs !== null && !WGS84_CRS.test(crs)) {
    throw new Error(`${file}: unsupported CRS "${crs}" (WGS 84 longitude/latitude is required)`);
  }

  const codeProps = ['shapeID', `ADM${level}_PCODE`, 'pcode', 'code', 'id'];
  const nameProps = ['shapeName', `ADM${level}_EN`, 'name_en', 'name'];
  const arProps = [`ADM${level}_AR`, 'name_ar'];
  const swProps = [`ADM${level}_SW`, 'name_sw'];
  const isoProps = ['shapeISO', 'iso_3166_2', 'iso'];

  const features: BoundaryFeature[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let skippedGeometry = 0;
  let unnamed = 0;

  (parsed.features as RawFeature[]).forEach((feature, index) => {
    const props = feature.properties ?? {};
    const geometryType = feature.geometry?.type;
    if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
      skippedGeometry++;
      return;
    }
    const code = pick(props, codeProps);
    if (code === null) {
      warnings.push(`feature #${index + 1} has no shapeID / p-code and was skipped`);
      return;
    }
    if (seen.has(code)) {
      warnings.push(`duplicate code ${code}: only the first feature was kept`);
      return;
    }
    seen.add(code);

    let nameEn = pick(props, nameProps);
    if (nameEn === null) {
      unnamed++;
      nameEn = code;
    }
    const iso = pick(props, isoProps);
    features.push({
      code,
      nameEn,
      nameAr: pick(props, arProps),
      nameSw: pick(props, swProps),
      // geoBoundaries repeats the ISO3 country code where it has no subdivision code.
      iso: iso !== null && /^[A-Z]{2}-[A-Z0-9]{1,3}$/i.test(iso) ? iso.toUpperCase() : null,
      geometry: JSON.stringify(feature.geometry),
    });
  });

  if (skippedGeometry > 0)
    warnings.push(`${skippedGeometry} feature(s) without a polygon were skipped`);
  if (unnamed > 0) warnings.push(`${unnamed} feature(s) without a name use their code as name`);
  return { features, warnings };
}
