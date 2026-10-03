# import-boundaries

Loads the administrative boundaries **ADM1–ADM3** of every active country from
[geoBoundaries](https://www.geoboundaries.org) (release `gbOpen`) into `public.admin_areas`
(brief §2.1), imports the towns and villages of the v2 location tree as approved
`localities`, and gives projects and localities their administrative area.

```bash
npm run boundaries:import                                    # every active country, levels 1-3
npm run boundaries:import -- --country TZA --levels 1,2      # one country, two levels
npm run boundaries:import -- --offline                       # cached files only, no network
npm run boundaries:import -- --country OMN --levels 1 --file ./oman-governorates.geojson
npm run boundaries:import -- --dry-run                       # run everything, then roll back
npm run boundaries:import -- --relocate all                  # also re-derive the area of every project
```

The script reads `DATABASE_URL` from the environment or from `.env.local` / `.env` in the
repository root (or `--database-url`). It must connect as the database owner (`postgres`):
the tables have forced RLS and the API roles cannot write boundaries in bulk. It uses only
`pg`, `dotenv` and Node built-ins (Node ≥ 22, global `fetch`).

It is safe to run again at any time: a second run with unchanged data writes nothing (no new
row versions, so devices do not re-sync 10,000 boundaries).

## Options

| Option                 | Default                          | Meaning                                                                                                                                |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--country <ISO3[,…]>` | every active country             | ISO3 or ISO2 codes of rows in `public.countries`                                                                                       |
| `--levels <1,2,3>`     | `1,2,3`                          | administrative levels to load                                                                                                          |
| `--offline`            | off                              | never touch the network; levels missing from the cache are skipped                                                                     |
| `--file <path>`        | –                                | load this GeoJSON instead of downloading (exactly one country and one level)                                                           |
| `--cache-dir <dir>`    | `scripts/import-boundaries/data` | download cache (git-ignored)                                                                                                           |
| `--full`               | off                              | full-resolution geometry instead of the simplified one                                                                                 |
| `--refresh`            | off                              | download again even when the cache holds a completed file                                                                              |
| `--release <name>`     | `gbOpen`                         | `gbOpen`, `gbHumanitarian` or `gbAuthoritative`                                                                                        |
| `--relocate <mode>`    | `missing`                        | `missing`: give an area to located projects/localities that have none · `all`: re-derive every located project/locality · `none`: skip |
| `--skip-localities`    | off                              | do not import `localities.v2.json`                                                                                                     |
| `--overwrite-names`    | off                              | let `names.json` replace `name_ar` / `name_sw` / `short_code` of existing rows                                                         |
| `--allow-shrink`       | off                              | accept a file with fewer than half as many shapes as the areas it would retire (see "What is written")                                 |
| `--retries <n>`        | `5`                              | download attempts per file (exponential back-off)                                                                                      |
| `--dry-run`            | off                              | everything runs in one transaction that is rolled back                                                                                 |
| `--database-url <url>` | `DATABASE_URL`                   | target database                                                                                                                        |

Exit code: `0` success, `1` at least one country failed or was not found, `2` usage error.

Environment: `GEOBOUNDARIES_API_BASE` points the importer at a mirror of the API
(default `https://www.geoboundaries.org/api/current`). Besides the mirror, only the
geoBoundaries and GitHub hosts are ever contacted.

## Download and cache

API call per country and level:
`https://www.geoboundaries.org/api/current/gbOpen/<ISO3>/ADM<level>/` → JSON metadata with
`simplifiedGeometryGeoJSON` (preferred) and `gjDownloadURL` (full geometry, used when the
simplified file is unavailable or with `--full`). A level that geoBoundaries does not have
(HTTP 404, e.g. Oman ADM3) is reported and skipped.

```
data/<ISO3>-ADM<level>.meta.json                  API metadata (source, licence, build date)
data/<ISO3>-ADM<level>.simplified.geojson         or .full.geojson
data/<ISO3>-ADM<level>.<variant>.geojson.done     the download completed and parsed
data/<ISO3>-ADM<level>.<variant>.geojson.part     partial download
```

- A file with a `.done` marker is never downloaded again (unless `--refresh`).
- An interrupted transfer keeps its `.part` file; the next attempt continues it with an HTTP
  `Range` request. A transfer that delivers no byte for two minutes is aborted and retried.
- Files fetched by other means can be dropped into the cache under these names (create the
  empty `.done` marker next to them), then run with `--offline`.

## What is written

**`admin_areas`** — upsert by `(country_id, level, code)`:

| Column               | Value                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `private.ref_uuid('admin_area:<ISO3>:<level>:<code>')` — the same in every environment                                           |
| `code`               | geoBoundaries `shapeID` (or the p-code of a COD-AB file given with `--file`)                                                     |
| `name_en`            | `shapeName` (always follows the source; `names.json` may correct a poor spelling)                                                |
| `name_ar`, `name_sw` | from `names.json`; filled only where empty, so edits made in the admin screens survive (`--overwrite-names` forces them)         |
| `short_code`         | level 1 only, see below; never changed once set                                                                                  |
| `geom`               | `ST_Multi(ST_CollectionExtract(ST_MakeValid(…), 3))`, MultiPolygon, SRID 4326                                                    |
| `geom_simple`        | `ST_SimplifyPreserveTopology(geom, 0.005° / 0.002° / 0.0005°)` for level 1 / 2 / 3 (the tolerances of the `admin_areas` trigger) |
| `parent_id`          | the area one level up that contains `ST_PointOnSurface(geom)`; when none contains it, the nearest one                            |

A `(country, level)` set is **replaced as a whole**: live rows of that country and level that
are not in the loaded file are soft-deleted (`deleted_at`). This retires the fallback squares
of the staging seed and the shapes of an older geoBoundaries release (shape ids change between
releases). `--file` never retires anything, because a custom file may be partial.
As a guard against truncated or wrong files, a country is left untouched (and reported as
failed) when a file holds fewer than half as many shapes as the areas it would retire;
`--allow-shrink` overrides that.

Each country is loaded in one transaction: either all of its requested levels are applied or
none.

**Short codes** (used in project codes such as `TZ-PN-000123`), unique per country:

1. the code already stored for the area;
2. `short_code` from `names.json`;
3. the subdivision part of the ISO 3166-2 code (`BI-GI` → `GI`) when it has 2–3 characters;
4. derived from the name: initials of the first two words, first two letters, first letter +
   a later consonant, three letters, letter + digit.

**References to retired areas** are moved to the live area of the same country and level with
the same English name, else the one containing the retired shape's interior point:
`branches.admin_area_ids`, `persons.home_admin_area_id`, `map_packs.admin_area_id`.

**Projects and localities** (one `UPDATE` each, the same rule as the triggers — the deepest
live area containing the point, decision D5):

- always: rows that point at a retired area;
- `--relocate missing` (default): located rows whose `admin_area_id` is null;
- `--relocate all`: every located row — use it after loading deeper levels for a country
  that already has projects. Every changed project gets a new version and is re-synced.

A row whose point lies in no polygon keeps its manually chosen area. Project codes never
change.

**`localities`** — the 97 towns and villages of v2 (`localities.v2.json`), `status =
'approved'`, `id = private.ref_uuid('locality:v2:<ISO2>:<region key>:<locality key>')`.
Existing rows are never overwritten. A locality with coordinates is attached to the deepest
area containing the point; otherwise to the area its v2 region maps to.

**`app_settings` key `boundaries.sources`** (public) —
`{ "<ISO3>": { "ADM1": { release, variant, boundary_id, source, license, license_source,
source_url, build_date, year_represented, features, imported_at }, … } }`.
The web app shows it as map attribution.

## names.json

Arabic and Swahili names and short codes of well-known areas, keyed by ISO2:

```json
{
  "countries": {
    "TZ": [
      {
        "iso": "TZ-06",
        "match": ["North Pemba", "Pemba North", "Kaskazini Pemba"],
        "name_ar": "بيمبا الشمالية",
        "name_sw": "Kaskazini Pemba",
        "short_code": "PN"
      }
    ]
  }
}
```

`level` defaults to 1. An area is recognised by its ISO 3166-2 code (`iso`) or by any
spelling in `match` (case, accents, punctuation and spaces are ignored). `name_en` replaces
a poor source spelling. Covered: all 31 regions of Tanzania, the 47 counties of Kenya, the 4
regions of Uganda plus the six districts used in v2, the 5 provinces of Rwanda, the 18
provinces of Burundi, the 11 provinces of Mozambique and the governorates of Oman (current
and pre-2011 names). Areas that are not listed keep `name_en` only; the app falls back to the
name that exists (brief §8).

## localities.v2.json

```json
{
  "countries": {
    "TZ": [
      {
        "key": "north-pemba",
        "region_ar": "بيمبا الشمالية",
        "match": [{ "level": 1, "name": "North Pemba" }],
        "localities": [
          { "key": "wete", "name_ar": "ويتي", "name_latin": "Wete", "lon": 39.728, "lat": -5.057 }
        ]
      }
    ]
  }
}
```

`name_ar` is the v2 spelling, `name_latin` the usual Latin spelling. `lon`/`lat` are
approximate town centres (± 2 km) and `null` where not known reliably (Wingwi, Wambaa); they
can be corrected in the admin screens. **Never change the keys**: they are part of the row id.

## Data sources and licences

geoBoundaries — Runfola, D. et al. (2020), _geoBoundaries: A global database of political
administrative boundaries_, PLoS ONE 15(4): e0231866, <https://www.geoboundaries.org>.
The database is published under **CC BY 4.0**; every boundary file additionally carries the
licence of its original source, which the importer stores in `boundaries.sources`:

| Country    | ADM1                          | ADM2                           | ADM3                          |
| ---------- | ----------------------------- | ------------------------------ | ----------------------------- |
| Tanzania   | OpenStreetMap — ODbL 1.0      | NBS / UN OCHA — CC BY 3.0 IGO  | OpenStreetMap — ODbL 1.0      |
| Kenya      | RCMRD — public domain         | IEBC / UN OCHA — CC BY 3.0 IGO | CC BY 4.0                     |
| Uganda     | OpenStreetMap — ODbL 1.0      | Wikimedia — public domain      | Wikimedia — CC0               |
| Rwanda     | Rwanda Geo Portal — CC BY 4.0 | Open Data Rwanda — CC BY 4.0   | Open Data Rwanda — CC BY 4.0  |
| Burundi    | Wikimedia — CC0               | public domain                  | RCMRD — public domain         |
| Mozambique | OpenStreetMap — ODbL 1.0      | INE / UN OCHA — CC BY 3.0 IGO  | INE / UN OCHA — CC BY 3.0 IGO |
| Oman       | OpenStreetMap — ODbL 1.0      | "Other – Direct Permission"    | not available                 |

(as of the gbOpen build of December 2023; the table is informative, `boundaries.sources`
holds what was actually imported).

Obligations:

- **Attribution** in the app ("about" / map attribution): geoBoundaries, and
  "© OpenStreetMap contributors" for the ODbL layers.
- **ODbL share-alike**: using the shapes inside our own system is unrestricted; if the
  association ever _publishes_ a database derived from the OSM-based layers, that database
  must be offered under ODbL as well.
- **Oman ADM2** is distributed by geoBoundaries under "Other – Direct Permission". Confirm
  that this covers the association's use before production, or load an official file with
  `--file`.

The downloaded files are not committed (`scripts/import-boundaries/data/` is git-ignored).

## Known limitations of the gbOpen data

- **Oman**: ADM1 is the pre-2011 layout with seven regions (no separate Musandam and Al
  Buraimi, Al Batinah and Ash Sharqiyah not split) and there is no ADM3. The v2 localities
  of these governorates are attached through their coordinates (wilayat level).
- **Uganda**: ADM1 = 4 regions, ADM2 = counties, ADM3 = districts (the "regions" of v2 —
  Kampala, Wakiso, … — are districts, i.e. level 3 here).
- **Tanzania**: ADM1 represents 2015 (30 regions, Songwe is still part of Mbeya).
- The simplified shapes cut corners along coasts: a point on a beach or pier can fall
  outside every polygon. Such a project keeps the area chosen in the form (decision D5).
  Use `--full` when that matters more than size.

## Tests and the staging seed

- The pgTAP fixtures use small squares around Pemba, Tanga and Mombasa. Run pgTAP on a
  database **without imported boundaries**: real wards are deeper than the fixture squares
  and win the "deepest area" rule, which breaks assertions of the sync, list, report and
  import tests.
- `supabase/seed.staging.sql` creates fallback squares only for countries without
  boundaries; importing afterwards retires them and moves the demo data to the real shapes.
  Either order (seed → import or import → seed) gives the same project codes.
