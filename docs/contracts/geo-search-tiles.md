# Contract — geography, duplicates, search, paging and map tiles

Migrations `0030`–`0036`, tests `supabase/tests/30_*` … `34_*`. Brief §5, §7.1–7.3; ARCHITECTURE §2.4, §5.

All functions are `SECURITY DEFINER`, pin their `search_path`, are **not executable by `anon`**
(`authenticated` and `service_role` only) and filter every row by the caller's scope triples
(`private.read_*`, `private.people_*`). A caller without a usable role (no role, revoked session,
inactive profile, manager/HQ without MFA) gets empty results, not an error — except the two
reference-geography functions, which raise `PT403`.

| RPC | Volatility / verb | Rate limit | Typical latency¹ |
|---|---|---|---|
| `locate_point(p_lon, p_lat)` → jsonb | STABLE (GET or POST) | — | ~1 ms |
| `admin_area_shapes(p_country_id, p_level)` → jsonb | STABLE (GET or POST) | — | payload-bound |
| `project_duplicates(p_type, p_lon, p_lat, p_name, p_locality_id, p_exclude_id default null)` → jsonb | STABLE (GET or POST) | — | ~2 ms |
| `search(p_q, p_limit default 20, p_kinds default null)` → jsonb | VOLATILE (**POST only**) | 300 / minute / caller | 10–60 ms; 100–250 ms for the typo fallback |
| `projects_page(p_filters, p_after, p_limit default 50)` → jsonb | VOLATILE (**POST only**) | 300 / minute / caller | 3–20 ms |
| `tile_projects(z, x, y, p_filters default '{}')` → MVT bytes (`bytea` domain) | STABLE (**GET**) | in the `tiles` Edge Function | 1–15 ms |

¹ Measured on the development machine (8 cores, shared) with 100,000 projects / 500,000 persons /
500,000 staff links, single connection, warm cache. With 8 connections firing without think time:
tiles 396/s (p95 36 ms), `projects_page` 247/s (p95 51 ms), `search` 76/s (p50 63 ms, p95 253 ms);
with 60 connections and 1 s mean think time: search p95 151 ms, tiles p95 27 ms.
The limits are per caller (`private.rate_limit`); exceeding one raises `PT429`. Load tests that
share a few accounts can switch the limiter off with `alter database … set app.rate_limit = 'off'`.

Errors: `PT403` invalid session (geography functions), `PT422` invalid argument, `PT429` rate limit,
`42501` for `anon`.

---

## 1. `locate_point(p_lon float8, p_lat float8)`

Country and administrative chain of a WGS84 point, plus nearby localities (form geofill, §7.1–7.2).

```jsonc
{
  "country": { "id": "…", "iso2": "TZ", "name_ar": "تنزانيا", "name_en": "Tanzania", "name_sw": "Tanzania", "active": true },   // null when no polygon contains the point
  "admin_area_id": "…",          // deepest area containing the point (what the projects trigger will store), or null
  "areas": [                     // ascending level, at most one per level 1..3
    { "id": "…", "level": 1, "code": "TZ-…", "parent_id": null, "name_ar": "…", "name_en": "…", "name_sw": "…" }
  ],
  "localities": [                // <= 10 nearest within 10 km, nearest first, approved and proposed
    { "id": "…", "name_ar": "…", "name_latin": "…", "status": "approved", "admin_area_id": "…",
      "country_id": "…", "lon": 39.75, "lat": -5.0527, "distance_m": 298.6 }
  ]
}
```

- The deepest polygon containing the point wins (`ST_Contains`, same rule and tie-break as the
  projects trigger); its ancestors come from `parent_id`, so the chain is consistent. A level
  without a parent link falls back to the polygon containing the point at that level.
- **Reference geography is not scope-filtered**: a Kenyan collector standing in Tanzania gets the
  Tanzanian country and areas, so the form can warn "outside your country/area" (§7.2).
  **Localities are scope-filtered** to the countries the caller can read (a branch role reads the
  country of its branch).
- Outside every polygon: `country: null`, `areas: []`, `admin_area_id: null` (localities may still
  be returned).
- `PT422` for null or out-of-range coordinates; `PT403` for an invalid session.

## 2. `admin_area_shapes(p_country_id uuid, p_level int)`

GeoJSON for offline geofill on the device (point-in-polygon in `src/lib/geo.ts`).

```jsonc
{ "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "id": "<admin_area id>",
      "geometry": { "type": "MultiPolygon", "coordinates": [...] },   // null for level 3
      "properties": { "id": "…", "parent_id": "…", "level": 1, "code": "…", "short_code": "PN",
                      "name_ar": "…", "name_en": "…", "name_sw": "…" } } ] }
```

- Levels 1 and 2 carry `geom_simple` with 5 decimals (~1 m). Level 3 returns names only
  (`"geometry": null`) — ward polygons are too heavy for 3G; use `locate_point` online for level 3.
- Features are ordered by name. `p_level` outside 1..3 → `PT422`.
- Not scope-filtered (official boundaries). Cache it on the device per `(country, level)`; the
  `admin_areas` rows (without shapes) arrive through `sync_pull`.

## 3. `project_duplicates(p_type, p_lon, p_lat, p_name, p_locality_id, p_exclude_id default null)`

Duplicate detection before saving (§7.3). Returns a jsonb array (max 20, best first):

```jsonc
[ { "id": "…", "code": "TZ-PN-000123", "name_ar": "…", "name_latin": "…",
    "type": "mosque", "status": "active", "record_state": "approved",
    "lon": 39.75, "lat": -5.05, "locality_id": null, "admin_area_id": "…",
    "created_by_me": false,
    "distance_m": 99.9,        // null when no coordinates were given
    "similarity": 0.812,       // 0..1 on the normalised names; null when no name was given
    "reason": "nearby" } ]     // "nearby" | "similar_name" | "both"
```

- **nearby**: a project of the same type within **150 m** (geodesic). `combined` overlaps with both
  `mosque` and `school` (a mosque re-entered as "mosque + school" is still caught).
- **similar_name**: trigram similarity ≥ **0.6** between `private.norm(p_name)` and the normalised
  Arabic or Latin name of a project in the **same locality** (`p_locality_id`); when no locality is
  given, in the **level-3 area** (village) that contains the point.
- Only projects inside the caller's read scope are reported. `p_exclude_id` = the record being edited.
- Any argument may be null: without coordinates only the name rule runs, without a name only the
  distance rule. `PT422` for an unknown type or bad coordinates.
- No rate limit on purpose: `import_preview` calls it once per candidate row.

## 4. `search(p_q text, p_limit int default 20, p_kinds text[] default null)`

Global search (§5). Returns one flat jsonb array, best hits first (on equal score: projects,
localities, staff, donors), at most `p_limit` (capped at **50**) in total. `p_kinds` ⊆
`{project, locality, staff, donor}` (default: all).

```jsonc
[
  { "kind": "project", "id": "<project id>", "score": 0.93, "name_ar": "…", "name_latin": "…", "code": "TZ-PN-000123",
    "type": "mosque", "status": "active", "record_state": "approved", "lon": 39.75, "lat": -5.05,
    "country_id": "…", "admin_area_id": "…", "locality_id": null },
  { "kind": "locality", "id": "<locality id>", "score": 0.93, "name_ar": "…", "name_latin": "…", "status": "approved",
    "lon": 39.74, "lat": -5.0, "country_id": "…", "admin_area_id": "…" },
  { "kind": "staff", "id": "<person id>", "score": 0.93, "name_ar": "…", "name_latin": "…",
    "projects_count": 2,
    "projects": [ { "id": "…", "code": "…", "name_ar": "…", "name_latin": "…", "type": "mosque", "status": "active",
                    "lon": 39.75, "lat": -5.05, "role": "imam" } ] },          // <= 5, current assignments first
  { "kind": "donor", "id": "<donor id>", "score": 0.93, "name_ar": "…", "name_latin": "…",
    "projects_count": 14,
    "projects": [ { "id": "…", "code": "…", "name_ar": "…", "name_latin": "…", "type": "school", "status": "active",
                    "lon": 39.1, "lat": -5.07 } ] }                            // <= 5; list the rest with projects_page({donor_id})
]
```

Matching

- The query is normalised with `private.norm` (tashkeel/tatweel removed, `أإآ→ا`, `ى→ي`, `ة→ه`,
  Latin accents stripped, lower case) — the same function that fills `projects.search_norm`
  (Arabic name + Latin name + code + locality names), `localities.name_norm`,
  `persons.name_normalized` and `donors.name_norm`.
- Every word must occur (substring, any order). When all words are shorter than three characters
  the first one must start a word. Queries shorter than **2** characters, and punctuation-only
  queries, return `[]`.
- Only when nothing at all matches, a typo-tolerant pass runs (`word_similarity ≥ 0.6` on the
  words of three or more characters): first projects, localities and donors; staff only if those
  found nothing.
- `score` ∈ [0, 1]: 1 for an exact match or an exact project code, otherwise
  `0.9 · word_similarity(query, text) + 0.1 · similarity(query, text)`.
- At most 400 candidates per kind are ranked: a single very common word ("محمد") returns 20 good
  matches, not necessarily the 20 best of 100,000 — the user refines the query.

Authorisation

- `project`: read scope. `locality`: countries the caller can read.
- `staff`: people scope on the person **and** read scope on the project — a `viewer` never gets a
  staff hit. Persons merged into another person are skipped. No phone numbers are returned.
- `donor`: only donors linked to at least one readable project; `projects` / `projects_count` count
  readable projects only.

Client notes: debounce 250 ms (the limit of 300 calls/minute assumes it); the result is a snapshot,
do not page it — narrow the query or use `projects_page({ q })` for a full project list.

## 5. `projects_page(p_filters jsonb, p_after jsonb, p_limit int default 50)`

Keyset-paged project list (§5). Never `OFFSET`.

```jsonc
// first page:  projects_page({ "sort": "name", "type": ["mosque","combined"] }, null, 50)
{ "rows": [ { … } ], "next": { "s": "name", "k": "مسجد النور", "id": "…" }, "total": 1234 }
// next page:   projects_page(<same filters>, <"next" of the previous page>, 50)
{ "rows": [ { … } ], "next": null }
```

- `next` is opaque: pass it back unchanged together with the **same filters**. `next: null` = last
  page. `total` (rows matching the filters) is only computed on the first page (`p_after = null`).
- `p_limit` is clamped to 1..200.

`p_filters` (all optional)

| Key | Value | Meaning |
|---|---|---|
| `sort` | `"name"` (default) \| `"updated"` | `(name_ar, id)` ascending in code-point order (`COLLATE "C"`, identical to a plain JS string comparison) \| `(updated_at desc, id desc)` |
| `country_id`, `branch_id` | uuid | intersected with the caller's scope |
| `admin_area_id` | uuid of any level | the area and all its descendants |
| `locality_id`, `donor_id` | uuid | |
| `type`, `status`, `record_state` | string or array of strings | |
| `q` | text | every word must occur in the project's search text (names + code + locality names) |
| `incomplete` | `true` | `completeness < 100` ("incomplete records" list, §7.5) |
| `created_by_me` | `true` | rows created by the caller |
| `has_open_maintenance` | `true` | at least one `open` / `in_progress` maintenance entry |

Row (light list item)

```jsonc
{ "id": "…", "code": "TZ-PN-000123", "name_ar": "…", "name_latin": "…", "type": "mosque", "status": "active",
  "record_state": "approved", "completeness": 80, "capacity": 100, "lon": 39.75, "lat": -5.05,
  "country_id": "…", "branch_id": "…", "admin_area_id": "…", "locality_id": null,
  "area_level": 1, "area_name_ar": "…", "area_name_en": "…", "area_name_sw": "…",   // the project's (deepest) admin area
  "locality_name_ar": null, "locality_name_latin": null,
  "cover_thumb": "projects/TZ/<project>/<photo>_thumb.webp",   // storage path in bucket "photos" (cover, else first uploaded photo), or null
  "updated_at": "2026-10-03T10:00:00.123456+00:00", "version": 3 }
```

`PT422`: unknown `sort`, or a cursor that belongs to the other sort order.
The export functions (`export_request`, `export_rows`) accept the same filter keys.

## 6. `tile_projects(z int, x int, y int, p_filters jsonb default '{}')` → MVT

Vector tiles (extent 4096, XYZ scheme, Web Mercator). Three layers; a tile with nothing visible is
a zero-length body.

**HTTP:** the function returns the domain `public."application/vnd.mapbox-vector-tile"` (a `bytea`
for SQL callers). PostgREST (≥ 12, i.e. Supabase) serves it as raw bytes **only** when the request
carries `Accept: application/vnd.mapbox-vector-tile`:

```
GET /rest/v1/rpc/tile_projects?z=5&x=19&y=16&p_filters=%7B%22type%22%3A%22school%22%7D
Accept: application/vnd.mapbox-vector-tile          → 200, Content-Type: application/vnd.mapbox-vector-tile
```

`Accept: */*` (the `fetch` default) yields a JSON string with the hex dump, and
`application/octet-stream` yields `406` — always send the explicit media type (verified against
the local PostgREST). `PT422` → HTTP 422, missing/`anon` token → 401.

| Layer | Zoom | One feature per | Attributes |
|---|---|---|---|
| `clusters` | 0–13 | grid cell with ≥ 1 visible project (8 × 8 cells per tile, i.e. 64 px on a 512 px tile), placed at the **mean position** of its projects | `count`, `capacity` (sum), `mosque`, `school`, `combined`, `st_active`, `st_maintenance`, `st_building`, `st_inactive` (all integers); for single-project cells also `id` (uuid string), `type`, `status` |
| `points` | ≥ 14 | project | `id` (uuid string), `code`, `name_ar`, `name_latin`, `type`, `status`, `record_state`, `capacity` |
| `needs` | all | cell (z < 14) or project (z ≥ 14) with at least one non-zero weight | `maintenance` (open + in-progress entries), `quran_need` (copies), `housing` (teacher housing missing + imam housing missing), `transport` (projects needing student transport); `id` on z ≥ 14 |

- `clusters` and cluster-level `needs` features carry a numeric feature id that is stable per cell
  and zoom (`(cell_y << (z + 3)) | cell_x`) — usable with `feature-state`.
- Null attributes are omitted (e.g. `name_latin`, `capacity` on points; `id`/`type`/`status` on
  multi-project clusters).
- No buffer: every project / cell is in exactly one tile, so nothing is drawn twice (MapLibre does
  not clip circles, symbols or heat maps at tile edges).

`p_filters` (all optional): `country_id`, `branch_id`, `type`, `status`, `record_state` — each a
string or an array of strings — and `layers` (subset of `["clusters","points","needs"]`, default
all; ask for `["clusters"]`/`["points"]` only when no heat map is shown). The admin-area filter is
not available on tiles: fit the map to the area instead.

Scope: the caller's read scope is applied to every pyramid row and project
(`country_id`/`branch_id`); filters can only narrow it. `PT422` for coordinates outside the zoom.

Data freshness

- z < 14 comes from the cluster pyramid `private.mv_project_clusters`, refreshed by
  `private.refresh_clusters()` — called by `refresh_reports()` every 15 minutes. New or changed
  projects therefore show up in clusters within 15 minutes; z ≥ 14 is live.
- **After any bulk load (seed, load data, import of boundaries) call
  `select private.refresh_clusters();`** (or `select public.refresh_reports();`), otherwise the map
  is empty below zoom 14.

### MapLibre usage

```ts
map.addSource('projects', {
  type: 'vector',
  tiles: [`${FUNCTIONS_URL}/tiles/{z}/{x}/{y}?f=${encodeURIComponent(JSON.stringify(filters))}&e=${scopeEpoch}`],
  minzoom: 0,
  maxzoom: 14,          // z > 14 over-zooms the z14 tile ("points" layer)
});
// clusters: source-layer "clusters" — circle radius by ["get","count"], label when count > 1,
//           colour by ["get","type"] / ["get","status"] when count = 1; click → open ["get","id"]
//           or easeTo(zoom + 2) for count > 1.
// heat maps: source-layer "needs", heatmap-weight from "maintenance" | "quran_need" | "housing".
// zoom >= 14: individual points come from the local database (ARCHITECTURE §5); the "points"
//           layer is the fallback for areas that are not on the device (e.g. viewers).
```

### Cache headers for the `tiles` Edge Function

The function forwards the caller's `Authorization` and `x-device-id` headers to
`GET /rest/v1/rpc/tile_projects?z=…&x=…&y=…&p_filters=…` with
`Accept: application/vnd.mapbox-vector-tile` and answers with:

| Header | Value |
|---|---|
| `Content-Type` | `application/vnd.mapbox-vector-tile` |
| `Cache-Control` | z < 14: `private, max-age=300, stale-while-revalidate=600` · z ≥ 14: `private, max-age=30` · errors: `no-store` |
| `Vary` | `Authorization` |
| `ETag` | strong hash of the body; answer `304` to a matching `If-None-Match` |
| status | `200` with the body, `204` for a zero-length tile (same cache headers) |

- Tiles depend on the caller's scope: **never `public`**, never a shared/CDN cache keyed by URL only.
- The `e=<scope_epoch>` query parameter (from `my_context()`) is ignored by the server; it changes
  when the caller's roles change and so invalidates browser/Workbox caches. Workbox: a
  `StaleWhileRevalidate` runtime route for `/functions/v1/tiles/` with `maxEntries` ≈ 500 and
  `maxAgeSeconds` 3600, purged on logout.
- `tile_projects` is STABLE and cannot call the DB rate limiter; limit in the function
  (a map move requests ~12–40 tiles; e.g. 1,200 tiles/minute/user).

## 7. Private objects (not part of the API)

| Object | Purpose |
|---|---|
| `private.mv_project_clusters` | cluster pyramid: one row per `(zoom 0..13, tile tx/ty, cell cx/cy, country_id, branch_id, type, status, record_state)` with `n`, `capacity`, `sum_mx`, `sum_my` (EPSG:3857 metres, centroid = sum / n), `maint_open`, `maint_projects`, `quran_need`, `housing_gaps`, `transport_needs`, `single_id`. Missing country/branch = nil UUID. Unique index `mv_project_clusters_key` (also the tile lookup index). No grants to API roles. |
| `private.refresh_clusters()` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` (readers never block). ~660,000 rows / ~190 MB for 100,000 projects; 10–15 s plain, 30–40 s concurrent on the development machine. |
| `private.search_candidates(kind, fuzzy, q, tokens, all, countries, branches, cap)` | step 1 of `search`: candidate ids from the trigram index, bitmap plans only. |
| domain `public."application/vnd.mapbox-vector-tile"` | PostgREST media type handler for `tile_projects`. |
| `private.like_escape(text)`, `private.jsonb_text_array(jsonb)` | LIKE escaping; `"x"` or `["x","y"]` → `text[]`. |
| indexes `projects_page_name_idx (name_ar COLLATE "C", id)`, `projects_page_updated_idx (updated_at, id)` | keyset orders of `projects_page` (partial: live rows). |

## 8. Operational requirements

- **`LC_CTYPE` must not be `C`.** With `LC_CTYPE = C` pg_trgm sees no letters in Arabic text:
  `search` returns nothing for Arabic queries, the typo fallback and the "similar name" duplicate
  rule never match. Supabase (en_US.UTF-8 / C.UTF-8) is fine; a local database must be created
  with e.g. `create database … lc_collate 'C' lc_ctype 'en_US.UTF-8' template template0`.
  `32_search.test.sql` test 1 checks this explicitly.
- Statistics: run `analyze` after bulk loads (the candidate queries are planned per call).
- `search` and `projects_page` write to the rate-limit table → call them with POST (`supabase.rpc()` default).
