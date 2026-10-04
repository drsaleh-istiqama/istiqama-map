-- =============================================================================
-- 34  Cluster pyramid + tile_projects (migrations 0035, 0036; brief §5)
--
-- The tiles are decoded with a small protobuf/MVT reader written in plpgsql
-- (schema tests_tiles, rolled back with the transaction), so the assertions look
-- at real layer names, feature counts and attributes, not just at byte lengths.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(48);

select tests.fixture_extra();

-- ----------------------------------------------------------------------------
-- Test helpers
-- ----------------------------------------------------------------------------
create schema tests_tiles;
grant usage on schema tests_tiles to public;

-- Top-level fields of one protobuf message, in order.
create function tests_tiles.pb_fields(p bytea)
returns table (field integer, wire integer, vint bigint, body bytea)
language plpgsql
immutable
as $$
declare
  v_pos integer := 0;
  v_len integer := coalesce(length(p), 0);
  v_val bigint;
  v_shift integer;
  v_b integer;
begin
  while v_pos < v_len loop
    v_val := 0; v_shift := 0;
    loop
      v_b := get_byte(p, v_pos); v_pos := v_pos + 1;
      v_val := v_val | ((v_b & 127)::bigint << v_shift);
      exit when v_b < 128;
      v_shift := v_shift + 7;
    end loop;
    field := (v_val >> 3)::integer;
    wire := (v_val & 7)::integer;
    vint := null;
    body := null;
    if wire = 0 or wire = 2 then
      v_val := 0; v_shift := 0;
      loop
        v_b := get_byte(p, v_pos); v_pos := v_pos + 1;
        v_val := v_val | ((v_b & 127)::bigint << v_shift);
        exit when v_b < 128;
        v_shift := v_shift + 7;
      end loop;
      if wire = 0 then
        vint := v_val;
      else
        body := substring(p from v_pos + 1 for v_val::integer);
        v_pos := v_pos + v_val::integer;
      end if;
    elsif wire = 1 then
      body := substring(p from v_pos + 1 for 8);
      v_pos := v_pos + 8;
    elsif wire = 5 then
      body := substring(p from v_pos + 1 for 4);
      v_pos := v_pos + 4;
    else
      raise exception 'unsupported protobuf wire type %', wire;
    end if;
    return next;
  end loop;
end;
$$;

-- Packed repeated varints.
create function tests_tiles.pb_packed(p bytea)
returns bigint[]
language plpgsql
immutable
as $$
declare
  v_pos integer := 0;
  v_len integer := coalesce(length(p), 0);
  v_val bigint;
  v_shift integer;
  v_b integer;
  v_out bigint[] := '{}';
begin
  while v_pos < v_len loop
    v_val := 0; v_shift := 0;
    loop
      v_b := get_byte(p, v_pos); v_pos := v_pos + 1;
      v_val := v_val | ((v_b & 127)::bigint << v_shift);
      exit when v_b < 128;
      v_shift := v_shift + 7;
    end loop;
    v_out := v_out || v_val;
  end loop;
  return v_out;
end;
$$;

-- One row per feature of a vector tile: layer name, feature id, attributes and
-- (for point features) the tile-local coordinates.
create function tests_tiles.features(p_tile bytea)
returns table (layer text, fid bigint, props jsonb, px integer, py integer)
language plpgsql
immutable
as $$
declare
  r_layer record;
  r_feat record;
  v_keys text[];
  v_vals jsonb[];
  v_tags bigint[];
  v_geom bigint[];
  i integer;
begin
  for r_layer in
    select f.body from tests_tiles.pb_fields(p_tile) f where f.field = 3
  loop
    select convert_from(f.body, 'UTF8') into layer
    from tests_tiles.pb_fields(r_layer.body) f where f.field = 1;

    select coalesce(array_agg(convert_from(f.body, 'UTF8') order by f.ord), '{}')
    into v_keys
    from tests_tiles.pb_fields(r_layer.body) with ordinality as f(field, wire, vint, body, ord)
    where f.field = 3;

    select coalesce(array_agg(
             (select case v.field
                       when 1 then to_jsonb(convert_from(v.body, 'UTF8'))
                       when 4 then to_jsonb(v.vint)
                       when 5 then to_jsonb(v.vint)
                       when 6 then to_jsonb((v.vint >> 1) # (-(v.vint & 1)))
                       when 7 then to_jsonb(v.vint <> 0)
                       else to_jsonb('<float>'::text)
                     end
              from tests_tiles.pb_fields(f.body) v
              limit 1)
             order by f.ord), '{}')
    into v_vals
    from tests_tiles.pb_fields(r_layer.body) with ordinality as f(field, wire, vint, body, ord)
    where f.field = 4;

    for r_feat in
      select f.body from tests_tiles.pb_fields(r_layer.body) f where f.field = 2
    loop
      select f.vint into fid
      from tests_tiles.pb_fields(r_feat.body) f where f.field = 1;
      select tests_tiles.pb_packed(f.body) into v_tags
      from tests_tiles.pb_fields(r_feat.body) f where f.field = 2;
      select tests_tiles.pb_packed(f.body) into v_geom
      from tests_tiles.pb_fields(r_feat.body) f where f.field = 4;

      props := '{}'::jsonb;
      i := 1;
      while i < coalesce(array_length(v_tags, 1), 0) loop
        props := props || jsonb_build_object(v_keys[v_tags[i] + 1], v_vals[v_tags[i + 1] + 1]);
        i := i + 2;
      end loop;

      -- Point geometry: [MoveTo(1) = 9, zigzag(dx), zigzag(dy)].
      px := null; py := null;
      if coalesce(array_length(v_geom, 1), 0) = 3 and v_geom[1] = 9 then
        px := ((v_geom[2] >> 1) # (-(v_geom[2] & 1)))::integer;
        py := ((v_geom[3] >> 1) # (-(v_geom[3] & 1)))::integer;
      end if;
      return next;
    end loop;
  end loop;
end;
$$;

-- XYZ tile containing a WGS84 point.
create function tests_tiles.tile_x(p_lon double precision, p_z integer)
returns integer language sql immutable as $$
  select floor((p_lon + 180.0) / 360.0 * (1 << p_z))::integer;
$$;
create function tests_tiles.tile_y(p_lat double precision, p_z integer)
returns integer language sql immutable as $$
  select floor((1.0 - ln(tan(radians(p_lat)) + 1.0 / cos(radians(p_lat))) / pi()) / 2.0 * (1 << p_z))::integer;
$$;

-- ----------------------------------------------------------------------------
-- Extra data: two Pemba projects ~15 m apart (one cell on every zoom) with
-- facilities, and a user without any role.
-- ----------------------------------------------------------------------------
insert into public.projects
  (id, created_by, name_ar, name_latin, type, status, capacity, geom, country_id, branch_id, record_state)
values
  ('00000000-0000-4000-8000-00000000aa01', tests.id('u_col_pemba'), 'مسجد التجميع', 'Cluster mosque',
   'mosque', 'maintenance', 200, st_setsrid(st_makepoint(39.70010, -5.10010), 4326),
   tests.id('tz'), tests.id('br_pemba'), 'approved'),
  ('00000000-0000-4000-8000-00000000aa02', tests.id('u_col_pemba'), 'مدرسة التجميع', 'Cluster school',
   'school', 'active', 80, st_setsrid(st_makepoint(39.70020, -5.10020), 4326),
   tests.id('tz'), tests.id('br_pemba'), 'submitted');

insert into public.project_facilities
  (id, created_by, project_id, teacher_housing, imam_housing, quran_need, student_transport)
values
  ('00000000-0000-4000-8000-00000000aa11', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000aa01',
   false, false, 15, 'available');

select tests.create_user('u_norole_tiles@example.org', null, null, null) as u_norole \gset

select tests_tiles.tile_x(39.75, 13) as x13_p1, tests_tiles.tile_y(-5.05, 13) as y13_p1,
       tests_tiles.tile_x(39.66, 13) as x13_ke, tests_tiles.tile_y(-4.05, 13) as y13_ke,
       tests_tiles.tile_x(39.7001, 13) as x13_cl, tests_tiles.tile_y(-5.1001, 13) as y13_cl,
       tests_tiles.tile_x(39.75, 14) as x14_p1, tests_tiles.tile_y(-5.05, 14) as y14_p1 \gset

-- ----------------------------------------------------------------------------
-- Catalogue
-- ----------------------------------------------------------------------------
select has_function('public', 'tile_projects', array['integer', 'integer', 'integer', 'jsonb'],
  'tile_projects(z, x, y, filters) exists');
select volatility_is('public', 'tile_projects', array['integer', 'integer', 'integer', 'jsonb'], 'stable',
  'tile_projects is STABLE (PostgREST serves it over GET)');
select domain_type_is('public', 'application/vnd.mapbox-vector-tile', 'pg_catalog', 'bytea',
  'the PostgREST media type handler domain is a bytea');
select is(
  (select t.typname::text
   from pg_catalog.pg_proc p
   join pg_catalog.pg_type t on t.oid = p.prorettype
   where p.oid = 'public.tile_projects(integer, integer, integer, jsonb)'::regprocedure),
  'application/vnd.mapbox-vector-tile',
  'tile_projects returns the media type domain (raw bytes over PostgREST)');
select function_privs_are('public', 'tile_projects', array['integer', 'integer', 'integer', 'jsonb'],
  'anon', array[]::text[], 'anon cannot execute tile_projects');
select has_materialized_view('private', 'mv_project_clusters', 'the cluster pyramid exists');
select index_is_unique('private', 'mv_project_clusters', 'mv_project_clusters_key',
  'the pyramid has a unique index (needed for REFRESH ... CONCURRENTLY)');
select table_privs_are('private', 'mv_project_clusters', 'authenticated', array[]::text[],
  'authenticated cannot read the pyramid directly');
select function_privs_are('private', 'refresh_clusters', array[]::text[], 'authenticated', array[]::text[],
  'authenticated cannot refresh the pyramid');

select lives_ok('select private.refresh_clusters()', 'refresh_clusters() runs');
select lives_ok('select private.refresh_clusters()', 'refresh_clusters() runs again (concurrent refresh path)');
select is(
  (select array_agg(distinct m.zoom order by m.zoom)::int[] from private.mv_project_clusters m),
  array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  'the pyramid covers zoom 0..13');
select is(
  (select count(distinct m.zoom)::int
   from private.mv_project_clusters m
   where m.branch_id = tests.id('br_pemba')
   group by m.branch_id
   having bool_and(m.tx = m.cx >> 3 and m.ty = m.cy >> 3)),
  14, 'every cell lies inside its tile (tx = cx >> 3, ty = cy >> 3)');

-- ----------------------------------------------------------------------------
-- Clusters (z < 14), scope filtering
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(
  (select jsonb_agg(f.props order by f.fid)
   from tests_tiles.features(public.tile_projects(13, :x13_p1, :y13_p1)) f
   where f.layer = 'clusters'),
  jsonb_build_array(jsonb_build_object(
    'count', 1, 'capacity', 100, 'mosque', 1, 'school', 0, 'combined', 0,
    'st_active', 1, 'st_maintenance', 0, 'st_building', 0, 'st_inactive', 0,
    'id', tests.id('p_pemba_1'), 'type', 'mosque', 'status', 'active')),
  'z13: a lone project is a cluster of one carrying its id, type and status');
select is(
  (select jsonb_build_array(f.px, f.py)
   from tests_tiles.features(public.tile_projects(13, :x13_p1, :y13_p1)) f
   where f.layer = 'clusters'),
  (select jsonb_build_array(st_x(g.g)::int, st_y(g.g)::int)
   from (select st_asmvtgeom(st_transform(st_setsrid(st_makepoint(39.75, -5.05), 4326), 3857),
                             st_tileenvelope(13, :x13_p1, :y13_p1), 4096, 0, false) as g) g),
  'z13: the cluster sits at the project position inside the tile');
select is(
  (select jsonb_agg(f.props - 'capacity' order by f.fid)
   from tests_tiles.features(public.tile_projects(13, :x13_cl, :y13_cl)) f
   where f.layer = 'clusters'),
  jsonb_build_array(jsonb_build_object(
    'count', 2, 'mosque', 1, 'school', 1, 'combined', 0,
    'st_active', 1, 'st_maintenance', 1, 'st_building', 0, 'st_inactive', 0)),
  'z13: two projects in one cell are merged (count 2, per-type and per-status counts, no id)');
select is(
  (select jsonb_agg(jsonb_build_array(f.props -> 'count', f.props -> 'capacity'))
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f
   where f.layer = 'clusters'),
  '[[4, 480]]'::jsonb,
  'z0: a branch collector sees one cluster with exactly the four projects of the branch');

select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(length(public.tile_projects(13, :x13_p1, :y13_p1)), 0,
  'z13: the Tanzanian tile is empty for a Kenyan collector');
select is(
  (select jsonb_agg(f.props -> 'id')
   from tests_tiles.features(public.tile_projects(13, :x13_ke, :y13_ke)) f
   where f.layer = 'clusters'),
  jsonb_build_array(tests.id('p_ke_1')),
  'z13: the Kenyan collector sees the Kenyan project');
select is(
  (select jsonb_agg(jsonb_build_array(f.props -> 'count', f.props -> 'id'))
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f
   where f.layer = 'clusters'),
  jsonb_build_array(jsonb_build_array(1, tests.id('p_ke_1'))),
  'z0: the world tile of a Kenyan collector contains only the Kenyan project');
select ok(
  position(convert_to(tests.id('p_pemba_1')::text, 'UTF8') in public.tile_projects(0, 0, 0)) = 0
  and position(convert_to(tests.id('p_tanga_1')::text, 'UTF8') in public.tile_projects(14, :x14_p1, :y14_p1)) = 0,
  'no Tanzanian id appears in any byte of the Kenyan collector''s tiles');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(length(public.tile_projects(13, :x13_ke, :y13_ke)), 0,
  'z13: the Kenyan tile is empty for a Pemba collector');

select tests.login_as(tests.id('u_hq'), 'aal2');
select ok(
  (select sum((f.props ->> 'count')::int) >= 6
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f
   where f.layer = 'clusters'),
  'z0: HQ sees the projects of every country');

select tests.login_as(tests.id('u_mgr_ke'), 'aal1');
select is(length(public.tile_projects(0, 0, 0)), 0,
  'a country manager without MFA (aal1) gets an empty tile');

select tests.login_as(:'u_norole'::uuid, 'aal1');
select is(length(public.tile_projects(0, 0, 0)), 0, 'a user without any role gets an empty tile');

-- ----------------------------------------------------------------------------
-- Filters
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(
  (select jsonb_agg(f.props -> 'count')
   from tests_tiles.features(public.tile_projects(0, 0, 0, '{"type": "school"}')) f
   where f.layer = 'clusters'),
  '[2]'::jsonb, 'filter type: only the two schools of the branch are counted');
select is(
  (select jsonb_agg(f.props -> 'count')
   from tests_tiles.features(public.tile_projects(0, 0, 0, '{"status": ["maintenance", "inactive"]}')) f
   where f.layer = 'clusters'),
  '[1]'::jsonb, 'filter status (array)');
select is(
  (select jsonb_agg(f.props -> 'id')
   from tests_tiles.features(public.tile_projects(0, 0, 0, '{"record_state": "draft"}')) f
   where f.layer = 'clusters'),
  jsonb_build_array(tests.id('p_pemba_2')), 'filter record_state');
select is(
  length(public.tile_projects(0, 0, 0, jsonb_build_object('country_id', tests.id('ke')))), 0,
  'filter country_id outside the caller''s scope: empty tile');
select is(
  (select jsonb_agg(f.props -> 'count')
   from tests_tiles.features(public.tile_projects(0, 0, 0, jsonb_build_object('branch_id', tests.id('br_pemba')))) f
   where f.layer = 'clusters'),
  '[4]'::jsonb, 'filter branch_id inside the scope');
select is(
  (select jsonb_agg(distinct f.layer)
   from tests_tiles.features(public.tile_projects(0, 0, 0, '{"layers": ["needs"]}')) f),
  '["needs"]'::jsonb, 'filter layers: only the requested layer is produced');
select is(
  (select jsonb_agg(distinct f.layer order by f.layer)
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f),
  '["clusters", "needs"]'::jsonb, 'z < 14 carries the layers "clusters" and "needs"');

-- ----------------------------------------------------------------------------
-- Needs layer (heat-map weights)
-- ----------------------------------------------------------------------------
select is(
  (select jsonb_agg(f.props)
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f
   where f.layer = 'needs'),
  '[{"maintenance": 2, "quran_need": 135, "housing": 2, "transport": 2}]'::jsonb,
  'z0 needs: open maintenance entries, Quran copies, housing gaps and transport needs are summed');
select is(
  (select jsonb_agg(f.props)
   from tests_tiles.features(public.tile_projects(13, :x13_cl, :y13_cl)) f
   where f.layer = 'needs'),
  '[{"maintenance": 0, "quran_need": 15, "housing": 2, "transport": 0}]'::jsonb,
  'z13 needs: weights of the merged cell');
select is(
  (select count(*)::int
   from tests_tiles.features(public.tile_projects(0, 0, 0, '{"type": "combined"}')) f),
  0, 'no project after filtering: neither clusters nor needs');

-- ----------------------------------------------------------------------------
-- Points (z >= 14) straight from the projects table
-- ----------------------------------------------------------------------------
select is(
  (select jsonb_agg(f.props)
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1)) f
   where f.layer = 'points'),
  (select jsonb_build_array(jsonb_build_object(
            'id', p.id, 'code', p.code, 'name_ar', p.name_ar, 'name_latin', p.name_latin,
            'type', p.type, 'status', p.status, 'record_state', p.record_state, 'capacity', p.capacity))
   from public.projects p where p.id = tests.id('p_pemba_1')),
  'z14: one point per project with id, code, names, type, status, record_state, capacity');
select is(
  (select jsonb_agg(f.props)
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1)) f
   where f.layer = 'needs'),
  jsonb_build_array(jsonb_build_object(
    'id', tests.id('p_pemba_1'), 'maintenance', 1, 'quran_need', 60, 'housing', 0, 'transport', 1)),
  'z14 needs: per-project weights');
select is(
  (select jsonb_agg(distinct f.layer order by f.layer)
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1)) f),
  '["needs", "points"]'::jsonb, 'z >= 14 carries the layers "points" and "needs"');
select is(
  (select count(*)::int
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1, '{"type": "school"}')) f),
  0, 'z14: filters apply to points and needs as well');

-- Points are live; clusters are as fresh as the last refresh.
select tests.logout();
insert into public.projects
  (id, created_by, name_ar, type, status, geom, country_id, branch_id, record_state)
values
  ('00000000-0000-4000-8000-00000000aa03', tests.id('u_col_pemba'), 'مسجد جديد', 'mosque', 'active',
   st_setsrid(st_makepoint(39.7501, -5.0501), 4326), tests.id('tz'), tests.id('br_pemba'), 'draft');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(
  (select count(*)::int
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1)) f
   where f.layer = 'points'),
  2, 'z14: a project inserted after the last refresh is visible immediately');

select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(length(public.tile_projects(14, :x14_p1, :y14_p1)), 0,
  'z14: the Tanzanian tile is empty for a Kenyan collector');

-- ----------------------------------------------------------------------------
-- Viewers: approved projects only (owner decision ح, migration 0013), in the
-- pyramid groups (record_state) and in the live points. aa02 is submitted,
-- p_pemba_2 and aa03 are drafts.
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(
  (select jsonb_agg(jsonb_build_array(f.props -> 'count', f.props -> 'id'))
   from tests_tiles.features(public.tile_projects(13, :x13_cl, :y13_cl)) f
   where f.layer = 'clusters'),
  jsonb_build_array(jsonb_build_array(1, '00000000-0000-4000-8000-00000000aa01'::uuid)),
  'viewer z13: the cell of an approved and a submitted project counts the approved one only');
select is(
  (select sum((f.props ->> 'count')::int)::int
   from tests_tiles.features(public.tile_projects(0, 0, 0)) f
   where f.layer = 'clusters'),
  3, 'viewer z0: the three approved Tanzanian projects only (no draft, no submitted)');
select is(
  (select jsonb_agg(f.props -> 'id')
   from tests_tiles.features(public.tile_projects(14, :x14_p1, :y14_p1)) f
   where f.layer = 'points'),
  jsonb_build_array(tests.id('p_pemba_1')),
  'viewer z14: points of approved projects only (the draft next to it is left out)');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select ok(
  position(convert_to(tests.id('p_pemba_2')::text, 'UTF8') in public.tile_projects(0, 0, 0)) = 0
  and (select sum((f.props ->> 'count')::int)::int
       from tests_tiles.features(public.tile_projects(0, 0, 0)) f where f.layer = 'clusters') = 4,
  'global viewer z0: the four approved projects of both countries, no draft id in any byte');

-- ----------------------------------------------------------------------------
-- Validation
-- ----------------------------------------------------------------------------
select throws_ok('select public.tile_projects(3, 8, 0)', 'PT422', null, 'x outside the zoom range is rejected');
select throws_ok('select public.tile_projects(-1, 0, 0)', 'PT422', null, 'negative zoom is rejected');
select tests.login_anon();
select throws_ok('select public.tile_projects(0, 0, 0)', '42501', null, 'anon cannot call tile_projects');

select tests.logout();
select * from finish();
rollback;
