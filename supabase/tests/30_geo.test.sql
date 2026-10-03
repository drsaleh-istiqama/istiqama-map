-- =============================================================================
-- 30  locate_point + admin_area_shapes (migration 0031)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(32);

select tests.fixture_extra();

-- Extra geography (rolled back with the transaction):
--   level 2 "Wete" inside the Pemba North square, level 3 "Ward 1" inside Wete,
--   one approved locality 300 m from p_pemba_1, one locality ~15 km away and
--   one Kenyan locality.
insert into public.admin_areas (id, country_id, parent_id, level, code, name_ar, name_en, name_sw, geom)
values
  ('00000000-0000-4000-8000-00000000a002', tests.id('tz'), tests.id('tz_pemba_north'), 2,
   'TEST-TZ-PN-WETE', 'ويتي', 'Wete (test)', 'Wete',
   st_multi(st_makeenvelope(39.70, -5.10, 39.80, -5.00, 4326)));
insert into public.admin_areas (id, country_id, parent_id, level, code, name_ar, name_en, name_sw, geom)
values
  ('00000000-0000-4000-8000-00000000a003', tests.id('tz'), '00000000-0000-4000-8000-00000000a002', 3,
   'TEST-TZ-PN-WETE-W1', 'الحي الأول', 'Ward 1 (test)', 'Kata 1',
   st_multi(st_makeenvelope(39.74, -5.06, 39.76, -5.04, 4326)));

insert into public.localities (id, country_id, name_ar, name_latin, geom, status)
values
  ('00000000-0000-4000-8000-00000000b001', tests.id('tz'), 'قرية قريبة', 'Near village',
   st_setsrid(st_makepoint(39.75, -5.0527), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000b002', tests.id('tz'), 'قرية بعيدة', 'Far village',
   st_setsrid(st_makepoint(39.75, -4.915), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000b003', tests.id('ke'), 'قرية كينية', 'Kenyan village',
   st_setsrid(st_makepoint(39.661, -4.051), 4326), 'approved');

-- ----------------------------------------------------------------------------
-- Catalogue and privileges
-- ----------------------------------------------------------------------------
select has_function('public', 'locate_point', array['double precision', 'double precision'],
  'locate_point(lon, lat) exists');
select has_function('public', 'admin_area_shapes', array['uuid', 'integer'],
  'admin_area_shapes(country, level) exists');
select function_privs_are('public', 'locate_point', array['double precision', 'double precision'],
  'anon', array[]::text[], 'anon cannot execute locate_point');
select function_privs_are('public', 'admin_area_shapes', array['uuid', 'integer'],
  'anon', array[]::text[], 'anon cannot execute admin_area_shapes');
select function_privs_are('public', 'locate_point', array['double precision', 'double precision'],
  'authenticated', array['EXECUTE'], 'authenticated can execute locate_point');

-- ----------------------------------------------------------------------------
-- locate_point: inside the nested polygons
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(
  public.locate_point(39.75, -5.05) -> 'country' ->> 'iso2', 'TZ',
  'point inside Pemba: country is Tanzania');
select is(
  (select jsonb_agg(a -> 'level' order by (a ->> 'level')::int)
   from jsonb_array_elements(public.locate_point(39.75, -5.05) -> 'areas') a),
  '[1, 2, 3]'::jsonb,
  'point inside the ward: chain has levels 1, 2 and 3 in order');
select is(
  public.locate_point(39.75, -5.05) ->> 'admin_area_id',
  '00000000-0000-4000-8000-00000000a003',
  'admin_area_id is the deepest area containing the point');
select is(
  public.locate_point(39.75, -5.05) -> 'areas' -> 0 ->> 'id',
  tests.id('tz_pemba_north')::text,
  'level 1 of the chain is the Pemba North fixture area');
select is(
  public.locate_point(39.75, -5.05) -> 'areas' -> 2 ->> 'name_sw', 'Kata 1',
  'area entries carry the names in ar/en/sw');

-- Inside level 1 only.
select is(
  public.locate_point(39.65, -4.85) -> 'areas',
  (select jsonb_build_array(jsonb_build_object(
            'id', a.id, 'level', a.level, 'code', a.code, 'parent_id', a.parent_id,
            'name_ar', a.name_ar, 'name_en', a.name_en, 'name_sw', a.name_sw))
   from public.admin_areas a where a.id = tests.id('tz_pemba_north')),
  'point inside the region only: exactly the level-1 area is returned');
select is(
  public.locate_point(39.65, -4.85) ->> 'admin_area_id', tests.id('tz_pemba_north')::text,
  'deepest area falls back to level 1');

-- ----------------------------------------------------------------------------
-- locate_point: outside every polygon
-- ----------------------------------------------------------------------------
select is(
  public.locate_point(39.95, -5.05) -> 'country', 'null'::jsonb,
  'point outside all polygons: country is null');
select is(
  public.locate_point(39.95, -5.05) -> 'areas', '[]'::jsonb,
  'point outside all polygons: no areas');
select is(
  public.locate_point(39.95, -5.05) -> 'admin_area_id', 'null'::jsonb,
  'point outside all polygons: admin_area_id is null');

-- ----------------------------------------------------------------------------
-- locate_point: nearest localities within 10 km, ordered by distance
-- ----------------------------------------------------------------------------
select is(
  (select jsonb_agg(l -> 'id' order by o)
   from jsonb_array_elements(public.locate_point(39.75, -5.05) -> 'localities') with ordinality as e(l, o)
   where l ->> 'id' in ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b002',
                        tests.id('loc:tz_pemba_north')::text)),
  jsonb_build_array('00000000-0000-4000-8000-00000000b001', tests.id('loc:tz_pemba_north')),
  'nearby localities: nearest first, the one 15 km away is left out');
select ok(
  (public.locate_point(39.75, -5.05) -> 'localities' -> 0 ->> 'distance_m')::numeric between 290 and 310,
  'distance_m is geodesic metres (about 300 m)');
select is(
  public.locate_point(39.75, -5.05) -> 'localities' -> 0 ->> 'status', 'approved',
  'localities carry their status');

-- ----------------------------------------------------------------------------
-- Scope: reference geography is shared, localities are not
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');

select is(
  public.locate_point(39.75, -5.05) -> 'country' ->> 'iso2', 'TZ',
  'a Kenyan collector still learns that the point lies in Tanzania');
select is(
  public.locate_point(39.75, -5.05) -> 'localities', '[]'::jsonb,
  'a Kenyan collector gets no Tanzanian localities');
select is(
  (select count(*)::int
   from jsonb_array_elements(public.locate_point(39.66, -4.05) -> 'localities') l
   where l ->> 'id' in ('00000000-0000-4000-8000-00000000b003', tests.id('loc:ke_mombasa')::text)),
  2, 'a Kenyan collector gets the Kenyan localities around a Kenyan point');

-- ----------------------------------------------------------------------------
-- Validation and session checks
-- ----------------------------------------------------------------------------
select throws_ok('select public.locate_point(200, 0)', 'PT422', null,
  'longitude out of range is rejected');
select throws_ok('select public.locate_point(39.7, null)', 'PT422', null,
  'missing latitude is rejected');
select throws_ok(
  format('select public.admin_area_shapes(%L, 4)', tests.id('tz')), 'PT422', null,
  'level outside 1..3 is rejected');

-- ----------------------------------------------------------------------------
-- admin_area_shapes
-- ----------------------------------------------------------------------------
select is(
  public.admin_area_shapes(tests.id('tz'), 1) ->> 'type', 'FeatureCollection',
  'shapes are a GeoJSON FeatureCollection');
select ok(
  (select bool_and(f -> 'geometry' ->> 'type' = 'MultiPolygon' and (f -> 'properties' ->> 'level')::int = 1)
          and count(*) filter (where f ->> 'id' in (tests.id('tz_pemba_north')::text, tests.id('tz_tanga')::text)) = 2
          and count(*) filter (where f ->> 'id' = tests.id('ke_mombasa')::text) = 0
   from jsonb_array_elements(public.admin_area_shapes(tests.id('tz'), 1) -> 'features') f),
  'level 1: every feature has a geometry, both Tanzanian fixture areas are present, Kenya is not');
select is(
  (select f -> 'properties'
   from jsonb_array_elements(public.admin_area_shapes(tests.id('tz'), 2) -> 'features') f
   where f ->> 'id' = '00000000-0000-4000-8000-00000000a002'),
  jsonb_build_object(
    'id', '00000000-0000-4000-8000-00000000a002', 'parent_id', tests.id('tz_pemba_north'),
    'level', 2, 'code', 'TEST-TZ-PN-WETE', 'short_code', null,
    'name_ar', 'ويتي', 'name_en', 'Wete (test)', 'name_sw', 'Wete'),
  'level 2: properties carry ids, code and names');
select ok(
  (select bool_and(f -> 'geometry' = 'null'::jsonb) and count(*) >= 1
   from jsonb_array_elements(public.admin_area_shapes(tests.id('tz'), 3) -> 'features') f),
  'level 3: names only, geometry is null');
select ok(
  public.admin_area_shapes(tests.id('tz'), 1)::text !~ '\d\.\d{6,}',
  'coordinates are rounded to at most 5 decimals');

-- A deactivated account gets nothing, not even reference geography.
select tests.logout();
update public.profiles set active = false where id = tests.id('u_col_pemba2');
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select throws_ok('select public.locate_point(39.75, -5.05)', 'PT403', null,
  'locate_point refuses an inactive account');
select throws_ok(
  format('select public.admin_area_shapes(%L, 1)', tests.id('tz')), 'PT403', null,
  'admin_area_shapes refuses an inactive account');

-- anon has no EXECUTE at all.
select tests.login_anon();
select throws_ok('select public.locate_point(39.75, -5.05)', '42501', null,
  'anon cannot call locate_point');

select tests.logout();
select * from finish();
rollback;
