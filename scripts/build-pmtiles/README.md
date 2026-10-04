# `scripts/build-pmtiles` — basemap and offline map packs

Brief §1 (PMTiles on our own storage, never `tile.openstreetmap.org`) and §4.7 (offline map
packs per region). Everything here reads **local files** by default: nothing is downloaded
unless you pass a remote source together with `--allow-remote`.

| File                                                                        | Purpose                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `index.ts`                                                                  | `npm run pmtiles:build` — one pack per administrative area: extract → upload → `map_packs` row |
| `upload-dev.ts`                                                             | publishes the development basemap to `tiles/basemap/east-africa.pmtiles`                       |
| `dev-basemap.ts`                                                            | builds a stand-in basemap from `admin_areas` when no Protomaps extract is available            |
| `cli.ts`, `region.ts`, `pmtiles.ts`, `storage.ts`, `header.ts`, `writer.ts` | parts (unit-tested in `build-pmtiles.test.ts`)                                                 |

Requirements: the go-pmtiles CLI at `.local/pmtiles/pmtiles.exe` (or `--tool`), `DATABASE_URL`,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment or `.env.local` (the service
key never leaves the scripts; the app only ever sees the anon key).

## 1. Basemap

The app reads `{VITE_TILES_URL}/basemap/east-africa.pmtiles` (bucket `tiles`, public, HTTP Range).

```bash
# the Protomaps extract on this machine (default .local/tiles/east-africa.pmtiles)
npx tsx scripts/build-pmtiles/upload-dev.ts
# too big for the storage object limit (local gateway: 50 MiB)? publish a lower max zoom
npx tsx scripts/build-pmtiles/upload-dev.ts --fit
# no usable extract and no network: a basemap made from the boundaries in the database
npx tsx scripts/build-pmtiles/dev-basemap.ts            # → .local/tiles/dev-basemap.pmtiles (z0–9)
npx tsx scripts/build-pmtiles/upload-dev.ts --file .local/tiles/dev-basemap.pmtiles
```

`upload-dev.ts` checks the PMTiles header and section layout first: an interrupted
`pmtiles extract` leaves a file of the expected size that is mostly zeros, and that file is
refused with an explanation instead of being published. After the upload it reads the first
bytes back through the **public** URL with a Range request (what the browser does).

The development basemap has the Protomaps layer names the app's style expects — `earth`
(land of the seven countries), `boundaries` (country and level-1 lines), `places` (country,
region and district labels in Arabic, English and Swahili) — but no roads, water or
buildings. It is for development and tests only.

Production: extract East Africa from a Protomaps daily build once
(`pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles east-africa.pmtiles
--bbox=28,-27,60,26.5 --maxzoom=15`, ≈ 1–2 GB at z15), upload it to the `tiles` bucket of
the project (Supabase needs a plan whose object size limit allows it), and keep the build
date for `--tiles-version`.

## 2. Offline map packs

```bash
npm run pmtiles:build -- list --country TZ --level 1            # areas and default pack codes
npm run pmtiles:build -- --country TZ --area "North Pemba"      # build + upload + map_packs row
npm run pmtiles:build -- --country TZ --area Tanga --maxzoom 13 --dry-run
npm run pmtiles:build -- --country KE --area Mombasa --source /data/east-africa.pmtiles \
  --tiles-version 20261003
```

What happens:

1. the area (level 1 or 2) is looked up in `admin_areas` by id, code, short code or name
   (ar / en / sw); ambiguous names are refused with the candidates;
2. its outline — `ST_AsGeoJSON(geom_simple, 5)`, the same simplified shape that
   `admin_area_shapes` serves — is written to `<out-dir>/<code>.region.geojson`;
3. `pmtiles extract <source> <out> --region=<that file> --maxzoom=N` (default z14) writes
   `<out-dir>/<code>.pmtiles` (default `.local/packs/`), whose header is validated;
4. the file is uploaded with the service key to `tiles/packs/<ISO2>/<code>.pmtiles` and read
   back through the public URL;
5. `map_packs` is upserted by `code`: names in three languages (Arabic falls back to English
   because `name_ar` is NOT NULL), `country_id`, `admin_area_id`, `storage_path`, `bytes`,
   `min_zoom`/`max_zoom` (from the archive), the area's bbox (5 decimals), `tiles_version`
   (`--tiles-version`, or the 8-digit date in the source file name), `sha256`, `active`.
   A soft-deleted pack with the same code is revived.

Devices receive the row through `sync_pull` and list it under Settings → offline map packs
with its size; the download is checked against `bytes`, the PMTiles header and `sha256`.

Default pack codes: `<ISO2>-<short code>` for a level-1 area (`TZ-PN`), and
`<ISO2>-<parent short code>-<NAME>` for a district; `--code` overrides it.

Sizes were not yet measured on a real Protomaps extract (the development extract was
unusable when these scripts were written); expect tens of MB per region at z14. Every extra zoom level roughly doubles the size:
check with `--dry-run` and choose the smallest zoom that still shows village roads.

**Remote sources are opt-in.** `--source https://build.protomaps.com/<date>.pmtiles` reads the
build with HTTP Range requests (only the tiles of the area are transferred) and therefore
needs `--allow-remote`. Never run it from CI or on a metered connection.

## 3. Removing a pack

Set `active = false` (or soft-delete the row) from the admin screens or SQL; devices stop
offering it after their next sync. The object can stay in the bucket for devices that already
have it, or be removed with the service key.

## 4. Tests

```bash
npx vitest run scripts/build-pmtiles
```

The writer is checked by round-tripping archives through the `pmtiles` decoder (including
leaf directories), the header parser rejects zero-filled and truncated files, and the option
parser refuses remote sources without `--allow-remote`.
