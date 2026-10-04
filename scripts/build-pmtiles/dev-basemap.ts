/**
 * Development basemap made from the boundaries already in the local database — for machines
 * where the Protomaps East Africa extract is missing or broken and nothing may be downloaded.
 *
 *   npx tsx scripts/build-pmtiles/dev-basemap.ts                 → .local/tiles/dev-basemap.pmtiles
 *   npx tsx scripts/build-pmtiles/dev-basemap.ts --maxzoom 10 --out <file>
 *
 * Layers follow the Protomaps basemap schema so the app's style renders them unchanged:
 * `earth` (land of the countries in `admin_areas`), `boundaries` (country and level-1 lines)
 * and `places` (country, region and district labels in ar / en / sw). No roads, water or
 * buildings: it is a stand-in for development and tests, never for production.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import pg from 'pg';
import { ROOT, UsageError } from './cli.ts';
import { buildArchive, COMPRESSION, type WriterTile } from './writer.ts';

interface Options {
  out: string;
  maxZoom: number;
  bbox: [number, number, number, number];
}

function parse(argv: string[]): Options {
  const opts: Options = {
    out: path.join(ROOT, '.local', 'tiles', 'dev-basemap.pmtiles'),
    maxZoom: 9,
    bbox: [28, -27, 60, 26.5],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out' && value) opts.out = path.resolve(value);
    else if (flag === '--maxzoom' && value) opts.maxZoom = Number(value);
    else if (flag === '--bbox' && value) opts.bbox = value.split(',').map(Number) as Options['bbox'];
    else throw new UsageError(`unknown option ${flag}`);
    i++;
  }
  if (!Number.isInteger(opts.maxZoom) || opts.maxZoom < 0 || opts.maxZoom > 12)
    throw new UsageError('--maxzoom must be 0..12');
  if (opts.bbox.length !== 4 || opts.bbox.some((n) => !Number.isFinite(n)))
    throw new UsageError('--bbox must be minLon,minLat,maxLon,maxLat');
  return opts;
}

/** Tiles of zoom z covering a lon/lat box. */
export function tilesInBbox(z: number, bbox: [number, number, number, number]): Array<[number, number]> {
  const n = 2 ** z;
  const x = (lon: number): number => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const y = (lat: number): number => {
    const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const out: Array<[number, number]> = [];
  for (let tx = x(bbox[0]); tx <= x(bbox[2]); tx++)
    for (let ty = y(bbox[3]); ty <= y(bbox[1]); ty++) out.push([tx, ty]);
  return out;
}

const PREPARE = `
create temp table dev_land as
  select c.id as country_id, c.name_ar, c.name_en, c.name_sw,
         st_transform(st_multi(st_union(coalesce(a.geom_simple, a.geom))), 3857) as g
    from public.admin_areas a join public.countries c on c.id = a.country_id
   where a.level = 1 and a.deleted_at is null and c.deleted_at is null
   group by c.id, c.name_ar, c.name_en, c.name_sw;
create index on dev_land using gist (g);

create temp table dev_lines as
  select 2 as kind_detail, 0 as min_zoom, st_boundary(g) as g from dev_land
  union all
  select 4, 4, st_transform(st_boundary(coalesce(a.geom_simple, a.geom)), 3857)
    from public.admin_areas a where a.level = 1 and a.deleted_at is null;
create index on dev_lines using gist (g);

create temp table dev_places as
  select 'country'::text as kind, 2 as min_zoom, 12 as population_rank, 1 as sort_key,
         name_en as name, name_ar, name_en, name_sw, null::text as ref,
         st_pointonsurface(g) as g
    from dev_land
  union all
  select 'region', 5, 8, 2, coalesce(a.name_en, a.name_ar), a.name_ar, a.name_en, a.name_sw,
         a.short_code, st_transform(st_pointonsurface(coalesce(a.geom_simple, a.geom)), 3857)
    from public.admin_areas a where a.level = 1 and a.deleted_at is null
  union all
  select 'locality', 8, 4, 3, coalesce(a.name_en, a.name_ar), a.name_ar, a.name_en, a.name_sw,
         null, st_transform(st_pointonsurface(coalesce(a.geom_simple, a.geom)), 3857)
    from public.admin_areas a where a.level = 2 and a.deleted_at is null;
create index on dev_places using gist (g);
`;

const TILE = `
with env as (select st_tileenvelope($1, $2, $3) as e),
earth as (
  select 'earth'::text as kind, st_asmvtgeom(l.g, env.e, 4096, 64, true) as geom
    from dev_land l, env where l.g && env.e),
lines as (
  select b.kind_detail, st_asmvtgeom(b.g, env.e, 4096, 64, true) as geom
    from dev_lines b, env where b.g && env.e and b.min_zoom <= $1),
places as (
  select p.kind, p.min_zoom, p.population_rank, p.sort_key, p.name, p.name_ar as "name:ar",
         p.name_en as "name:en", p.name_sw as "name:sw", p.ref,
         st_asmvtgeom(p.g, env.e, 4096, 64, true) as geom
    from dev_places p, env where p.g && env.e and p.min_zoom <= $1)
select coalesce((select st_asmvt(earth.*, 'earth', 4096, 'geom') from earth where geom is not null), ''::bytea)
    || coalesce((select st_asmvt(lines.*, 'boundaries', 4096, 'geom') from lines where geom is not null), ''::bytea)
    || coalesce((select st_asmvt(places.*, 'places', 4096, 'geom') from places where geom is not null), ''::bytea)
    as mvt`;

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  dotenv.config({ path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')], quiet: true });
  if (!process.env.DATABASE_URL) throw new UsageError('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const tiles: WriterTile[] = [];
  try {
    await client.query(PREPARE);
    for (let z = 0; z <= opts.maxZoom; z++) {
      let count = 0;
      for (const [x, y] of tilesInBbox(z, opts.bbox)) {
        const { rows } = await client.query<{ mvt: Buffer }>(TILE, [z, x, y]);
        const mvt = rows[0]?.mvt;
        if (!mvt || mvt.length === 0) continue;
        tiles.push({ z, x, y, data: new Uint8Array(gzipSync(mvt)) });
        count++;
      }
      console.log(`z${z}: ${count} tiles`);
    }
  } finally {
    await client.end();
  }
  const archive = buildArchive(tiles, {
    tileCompression: COMPRESSION.gzip,
    bounds: opts.bbox,
    metadata: {
      name: 'Istiqama development basemap',
      description: 'Generated from admin_areas for development only (no roads, no water).',
      attribution: '© geoBoundaries',
      vector_layers: [
        { id: 'earth', fields: { kind: 'String' } },
        { id: 'boundaries', fields: { kind_detail: 'Number' } },
        { id: 'places', fields: { kind: 'String', name: 'String' } },
      ],
    },
  });
  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, archive);
  console.log(`wrote ${opts.out}: ${tiles.length} tiles, ${(archive.length / 1024 / 1024).toFixed(1)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(`dev-basemap.ts`)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}
