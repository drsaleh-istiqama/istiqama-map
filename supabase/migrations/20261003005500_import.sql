-- Bulk import with preview, duplicate detection, merge by external_id and whole-batch rollback
-- (brief §10). Shapes: docs/contracts/reports-import-export.md.
--
--   import_template(lang)                         official template columns
--   import_stage(meta, rows)                      stage + validate (max 5,000 rows) -> summary
--   import_preview(batch, after, limit, only)     page through rows with errors / duplicates
--   import_set_action(batch, row_no, action, id)  skip, force-create or merge a row
--   import_commit(batch)                          all-or-nothing merge; new projects are drafts
--   import_rollback(batch)                        undo the whole batch
--
-- Rules:
--   * only writers may import, and every row is checked against the caller's write scope;
--   * a row whose external_id already exists UPDATES that project: only the cells that are
--     filled in the file are written, nothing else is touched (never a wholesale replace);
--   * every updated row keeps a field-level pre-image (before / after) in import_rows.pre_image;
--   * staff, salaries and sensitive community data are NOT importable (people are never merged
--     automatically, brief §2.4; restricted data never travels in spreadsheets).

-- ---------------------------------------------------------------------------------------------
-- Template definition
-- ---------------------------------------------------------------------------------------------

create table if not exists private.import_column_defs (
  position smallint primary key,
  key text not null unique,
  section text not null check (section in ('meta', 'project', 'geo', 'land', 'facilities',
                                           'community', 'donor', 'maintenance')),
  col text not null,
  kind text not null check (kind in ('text', 'integer', 'number', 'date', 'boolean', 'enum', 'list')),
  enum_key text,
  required boolean not null default false,
  min_value numeric,
  max_value numeric,
  example text,
  -- headers: NULL = same as the export column with the same key
  ar text,
  sw text,
  en text
);
alter table private.import_column_defs enable row level security;
revoke all on private.import_column_defs from public, anon, authenticated;

insert into private.import_column_defs
  (position, key, section, col, kind, enum_key, required, min_value, max_value, example, ar, sw, en)
values
  (10, 'external_id', 'meta', 'external_id', 'text', null, false, null, null, 'IST-TZ-0001', null, null, null),
  (20, 'name_ar', 'project', 'name_ar', 'text', null, true, null, null, 'مسجد النور', null, null, null),
  (30, 'name_latin', 'project', 'name_latin', 'text', null, false, null, null, 'Masjid An-Nur', null, null, null),
  (40, 'type', 'project', 'type', 'enum', 'project_type', true, null, null, 'mosque', null, null, null),
  (50, 'status', 'project', 'status', 'enum', 'project_status', false, null, null, 'active', null, null, null),
  (60, 'capacity', 'project', 'capacity', 'integer', null, false, 0, 10000000, '250', null, null, null),
  (70, 'lat', 'geo', 'lat', 'number', null, true, -90, 90, '-5.0712', null, null, null),
  (80, 'lon', 'geo', 'lon', 'number', null, true, -180, 180, '39.7754', null, null, null),
  (90, 'gps_accuracy_m', 'project', 'gps_accuracy_m', 'number', null, false, 0, 100000, '12', null, null, null),
  (100, 'country', 'geo', 'country', 'text', null, true, null, null, 'TZ', null, null, null),
  (110, 'area', 'geo', 'area', 'text', null, false, null, null, 'Kaskazini Pemba',
        'المنطقة الإدارية (الرمز أو الاسم)', 'Eneo la utawala (msimbo au jina)', 'Admin area (code or name)'),
  (120, 'locality', 'geo', 'locality', 'text', null, false, null, null, 'Wete', null, null, null),
  (130, 'branch', 'geo', 'branch', 'text', null, false, null, null, 'PEMBA', null, null, null),
  (140, 'builder', 'project', 'builder', 'text', null, false, null, null, 'الاستقامة', null, null, null),
  (150, 'build_year', 'project', 'build_year', 'integer', null, false, 1800, 2200, '2015', null, null, null),
  (160, 'build_date', 'project', 'build_date', 'date', null, false, null, null, '2015-03-20', null, null, null),

  (200, 'land_ownership', 'land', 'ownership', 'enum', 'land_ownership', false, null, null, 'waqf', null, null, null),
  (210, 'land_owner_name', 'land', 'owner_name', 'text', null, false, null, null, null, null, null, null),
  (220, 'land_area_m2', 'land', 'area_m2', 'number', null, false, 0, 100000000000, '1200', null, null, null),
  (230, 'land_utilization_pct', 'land', 'utilization_pct', 'number', null, false, 0, 100, '60', null, null, null),
  (240, 'land_expandable', 'land', 'expandable', 'boolean', 'boolean', false, null, null, 'true', null, null, null),
  (250, 'land_notes', 'land', 'notes', 'text', null, false, null, null, null, null, null, null),

  (300, 'teacher_housing', 'facilities', 'teacher_housing', 'boolean', 'boolean', false, null, null, 'false', null, null, null),
  (310, 'imam_housing', 'facilities', 'imam_housing', 'boolean', 'boolean', false, null, null, 'true', null, null, null),
  (320, 'guest_housing', 'facilities', 'guest_housing', 'boolean', 'boolean', false, null, null, 'false', null, null, null),
  (330, 'library', 'facilities', 'library', 'boolean', 'boolean', false, null, null, 'true', null, null, null),
  (340, 'quran_count', 'facilities', 'quran_count', 'integer', null, false, 0, 10000000, '40', null, null, null),
  (350, 'quran_need', 'facilities', 'quran_need', 'integer', null, false, 0, 10000000, '60', null, null, null),
  (360, 'hall', 'facilities', 'hall', 'boolean', 'boolean', false, null, null, 'false', null, null, null),
  (370, 'hall_capacity', 'facilities', 'hall_capacity', 'integer', null, false, 0, 10000000, '100', null, null, null),
  (380, 'student_transport', 'facilities', 'student_transport', 'enum', 'student_transport', false, null, null, 'needed', null, null, null),
  (390, 'students_origin', 'facilities', 'students_origin', 'enum', 'students_origin', false, null, null, 'nearby', null, null, null),

  (400, 'community_branch_name', 'community', 'branch_name', 'text', null, false, null, null, null, null, null, null),
  (410, 'population', 'community', 'population', 'integer', null, false, 0, 2000000000, '3500', null, null, null),
  (420, 'muslim_pct', 'community', 'muslim_pct', 'number', null, false, 0, 100, '95', null, null, null),
  (430, 'daawa_activities', 'community', 'daawa_activities', 'list', null, false, null, null, null, null, null, null),
  (440, 'social_features', 'community', 'social_features', 'list', null, false, null, null, null, null, null, null),
  (450, 'livelihoods', 'community', 'livelihoods', 'list', null, false, null, null, null, null, null, null),
  (460, 'religious_issues', 'community', 'religious_issues', 'list', null, false, null, null, null, null, null, null),
  (470, 'religious_challenges', 'community', 'religious_challenges', 'list', null, false, null, null, null, null, null, null),
  (480, 'social_challenges', 'community', 'social_challenges', 'list', null, false, null, null, null, null, null, null),
  (490, 'proposed_activities', 'community', 'proposed_activities', 'list', null, false, null, null, null, null, null, null),

  (500, 'donor', 'donor', 'name', 'text', null, false, null, null, null, 'المتبرع', 'Mfadhili', 'Donor'),
  (510, 'donor_amount', 'donor', 'amount', 'number', null, false, 0, 1000000000000, '5000',
        'مبلغ التبرع', 'Kiasi cha mchango', 'Donation amount'),
  (520, 'donor_currency', 'donor', 'currency', 'text', null, false, null, null, 'USD',
        'عملة التبرع', 'Sarafu ya mchango', 'Donation currency'),
  (530, 'donor_year', 'donor', 'year', 'integer', null, false, 1800, 2200, '2015',
        'سنة التبرع', 'Mwaka wa mchango', 'Donation year'),

  (600, 'maintenance_note', 'maintenance', 'description', 'text', null, false, null, null, null,
        'ملاحظات الصيانة', 'Maelezo ya matengenezo', 'Maintenance note'),
  (610, 'maintenance_priority', 'maintenance', 'priority', 'enum', 'maintenance_priority', false, null, null, 'medium',
        'أولوية الصيانة', 'Kipaumbele cha matengenezo', 'Maintenance priority')
on conflict (position) do update
  set key = excluded.key, section = excluded.section, col = excluded.col, kind = excluded.kind,
      enum_key = excluded.enum_key, required = excluded.required, min_value = excluded.min_value,
      max_value = excluded.max_value, example = excluded.example,
      ar = excluded.ar, sw = excluded.sw, en = excluded.en;

-- Exact-name look-ups made for every committed row ("does this locality / donor exist already?").
create index if not exists localities_country_name_norm_idx on public.localities (country_id, name_norm);
create index if not exists donors_name_norm_idx on public.donors (name_norm);

-- Import columns with their three headers resolved (own header, else the export header).
create or replace view private.import_columns as
select i.position, i.key, i.section, i.col, i.kind, i.enum_key, i.required, i.min_value,
       i.max_value, i.example,
       coalesce(i.ar, e.ar, i.key) as ar,
       coalesce(i.sw, e.sw, i.key) as sw,
       coalesce(i.en, e.en, i.key) as en
from private.import_column_defs i
left join private.export_column_defs e on e.key = i.key;

revoke all on private.import_columns from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Cell parsers (pure). Invalid input is reported through a sentinel, never an exception, so
-- that validating 5,000 rows needs no sub-transactions.
-- ---------------------------------------------------------------------------------------------

-- NULL for blank, NaN for "not a number". Accepts Arabic-Indic digits and thousands separators.
create or replace function private.import_number(p_text text)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  t text;
begin
  if p_text is null then
    return null;
  end if;
  t := translate(p_text,
    U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\066B',
    '01234567890123456789.');
  t := regexp_replace(t, '[\s' || chr(1644) || chr(160) || chr(8239) || ']', '', 'g');
  if t = '' then
    return null;
  end if;
  if t ~ '^[+-]?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$' then
    t := replace(t, ',', '');
  end if;
  if length(t) <= 40 and t ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' then
    return t::numeric;
  end if;
  return 'NaN'::numeric;
end;
$$;

-- 'true' | 'false' | 'invalid' | NULL (blank). p_norm must already be private.norm()-alised.
create or replace function private.import_bool(p_norm text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_norm is null or p_norm = '' then null
    when p_norm in ('true', 't', 'yes', 'y', '1', 'x', 'ndiyo', 'ndio', 'available',
                    'نعم', 'صح', 'متوفر', 'متوفره', 'موجود', 'موجوده', 'يوجد') then 'true'
    when p_norm in ('false', 'f', 'no', 'n', '0', 'hapana', 'hakuna', 'not available',
                    'لا', 'خطا', 'غير متوفر', 'غير متوفره', 'غير موجود', 'غير موجوده', 'لا يوجد') then 'false'
    else 'invalid'
  end
$$;

-- NULL for blank, 'infinity' for "not a date". Accepts YYYY-MM-DD (optionally followed by a
-- time) and DD/MM/YYYY or DD.MM.YYYY (day first).
create or replace function private.import_date(p_text text)
returns date
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  t text;
  m text[];
  y integer;
  mo integer;
  d integer;
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  t := btrim(translate(p_text,
    U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
    '01234567890123456789'));
  m := regexp_match(t, '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})([T ].*)?$');
  if m is not null then
    y := m[1]::integer; mo := m[2]::integer; d := m[3]::integer;
  else
    m := regexp_match(t, '^([0-9]{1,2})[/.]([0-9]{1,2})[/.]([0-9]{4})$');
    if m is null then
      return 'infinity'::date;
    end if;
    d := m[1]::integer; mo := m[2]::integer; y := m[3]::integer;
  end if;
  if y < 1000 or y > 2200 or mo < 1 or mo > 12 or d < 1 then
    return 'infinity'::date;
  end if;
  if d > extract(day from (make_date(y, mo, 1) + interval '1 month' - interval '1 day'))::integer then
    return 'infinity'::date;
  end if;
  return make_date(y, mo, d);
end;
$$;

create or replace function private.import_issue(p_field text, p_code text, p_message text)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select jsonb_build_object('field', p_field, 'code', p_code, 'message', p_message) $$;

-- Columns the import may write, per table (anything else in a payload is ignored).
create or replace function private.import_cols(p_table text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_table
    when 'projects' then array['external_id', 'name_ar', 'name_latin', 'type', 'status', 'capacity',
                               'gps_accuracy_m', 'country_id', 'admin_area_id', 'locality_id',
                               'branch_id', 'builder', 'build_year', 'build_date']
    when 'project_land' then array['ownership', 'owner_name', 'area_m2', 'utilization_pct',
                                   'expandable', 'notes']
    when 'project_facilities' then array['teacher_housing', 'imam_housing', 'guest_housing', 'library',
                                         'hall', 'quran_count', 'quran_need', 'hall_capacity',
                                         'student_transport', 'students_origin']
    when 'community_profiles' then array['branch_name', 'population', 'muslim_pct',
                                         'daawa_activities', 'daawa_activities_other',
                                         'social_features', 'social_features_other',
                                         'livelihoods', 'livelihoods_other',
                                         'religious_issues', 'religious_issues_other',
                                         'religious_challenges', 'religious_challenges_other',
                                         'social_challenges', 'social_challenges_other',
                                         'proposed_activities', 'proposed_activities_other']
  end
$$;

revoke execute on function private.import_number(text) from public, anon, authenticated;
revoke execute on function private.import_bool(text) from public, anon, authenticated;
revoke execute on function private.import_date(text) from public, anon, authenticated;
revoke execute on function private.import_issue(text, text, text) from public, anon, authenticated;
revoke execute on function private.import_cols(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row writers used by commit / rollback (no authorisation inside; never granted to API roles)
-- ---------------------------------------------------------------------------------------------

-- Inserts a 1:1 child row of a project from a JSON payload. Returns the new id.
create or replace function private.import_insert_child(p_table text, p_project uuid, p_values jsonb)
returns uuid
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_allowed text[] := private.import_cols(p_table);
  v_cols text;
  v_xcols text;
  v_id uuid := private.uuid_v7();
begin
  if v_allowed is null or p_table = 'projects' then
    raise exception 'import: table % is not an importable child table', p_table;
  end if;
  select string_agg(quote_ident(e.key), ', ' order by e.key),
         string_agg('x.' || quote_ident(e.key), ', ' order by e.key)
    into v_cols, v_xcols
  from jsonb_each(p_values) e
  where e.key = any (v_allowed) and jsonb_typeof(e.value) <> 'null';
  if v_cols is null then
    return null;
  end if;
  execute format(
    'insert into public.%I (id, project_id, %s) select $1, $2, %s from jsonb_populate_record(null::public.%I, $3) x',
    p_table, v_cols, v_xcols, p_table)
    using v_id, p_project, p_values;
  return v_id;
end;
$$;

-- Writes the given values into one row and returns {id, before, after} holding exactly the
-- columns whose value changed (including columns changed by triggers); NULL when nothing changed.
-- For projects, "lon"/"lat" in p_values move the point.
create or replace function private.import_apply(p_table text, p_id uuid, p_values jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_skip constant text[] := array['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version',
                                  'sync_xid', 'search_norm', 'completeness', 'geom', 'deleted_at', 'code'];
  v_allowed text[] := private.import_cols(p_table);
  v_before jsonb;
  v_after jsonb;
  v_cols text;
  v_xcols text;
  v_lon0 double precision;
  v_lat0 double precision;
  v_lon1 double precision;
  v_lat1 double precision;
  v_move boolean := false;
  v_b jsonb;
  v_a jsonb;
begin
  if v_allowed is null then
    raise exception 'import: table % is not importable', p_table;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.deleted_at is null for update', p_table)
    into v_before using p_id;
  if v_before is null then
    return null;
  end if;

  select string_agg(quote_ident(e.key), ', ' order by e.key),
         string_agg('x.' || quote_ident(e.key), ', ' order by e.key)
    into v_cols, v_xcols
  from jsonb_each(p_values) e
  where e.key = any (v_allowed) and (v_before -> e.key) is distinct from e.value;

  if p_table = 'projects' and p_values ? 'lon' and p_values ? 'lat' then
    select st_x(p.geom), st_y(p.geom) into v_lon0, v_lat0 from public.projects p where p.id = p_id;
    v_lon1 := (p_values ->> 'lon')::double precision;
    v_lat1 := (p_values ->> 'lat')::double precision;
    v_move := v_lon0 is null or abs(v_lon0 - v_lon1) > 1e-7 or abs(v_lat0 - v_lat1) > 1e-7;
  end if;

  if v_cols is null and not v_move then
    return null;
  end if;

  if v_move then
    execute format(
      'update public.projects t set (%s) = (select %s from jsonb_populate_record(t, $1) x) where t.id = $2',
      concat_ws(', ', v_cols, 'geom'),
      concat_ws(', ', v_xcols, 'st_setsrid(st_makepoint($3, $4), 4326)'))
      using p_values, p_id, v_lon1, v_lat1;
  else
    execute format(
      'update public.%I t set (%s) = (select %s from jsonb_populate_record(t, $1) x) where t.id = $2',
      p_table, v_cols, v_xcols)
      using p_values, p_id;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table)
    into v_after using p_id;

  select coalesce(jsonb_object_agg(e.key, v_before -> e.key), '{}'::jsonb),
         coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    into v_b, v_a
  from jsonb_each(v_after) e
  where e.key <> all (c_skip) and e.value is distinct from (v_before -> e.key);

  if v_move then
    v_b := v_b || jsonb_build_object('lon', v_lon0, 'lat', v_lat0);
    v_a := v_a || jsonb_build_object('lon', v_lon1, 'lat', v_lat1);
  end if;

  return jsonb_build_object('id', p_id, 'before', v_b, 'after', v_a);
end;
$$;

-- Undoes one import_apply image. A column is restored only when it still holds the value the
-- import wrote (somebody else's later edit is kept). Returns the number of columns kept.
create or replace function private.import_restore(p_table text, p_image jsonb)
returns integer
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_id uuid := (p_image ->> 'id')::uuid;
  v_before jsonb := coalesce(p_image -> 'before', '{}'::jsonb);
  v_after jsonb := coalesce(p_image -> 'after', '{}'::jsonb);
  v_cur jsonb;
  v_cols text;
  v_xcols text;
  v_kept integer := 0;
  v_move boolean := false;
  v_lon double precision;
  v_lat double precision;
begin
  if private.import_cols(p_table) is null then
    raise exception 'import: table % is not importable', p_table;
  end if;
  if v_id is null then
    return 0;
  end if;

  if coalesce((p_image ->> 'created')::boolean, false) then
    execute format('update public.%I t set deleted_at = now() where t.id = $1 and t.deleted_at is null', p_table)
      using v_id;
    return 0;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_table)
    into v_cur using v_id;
  if v_cur is null then
    return 0;
  end if;

  select string_agg(quote_ident(e.key), ', ' order by e.key),
         string_agg('x.' || quote_ident(e.key), ', ' order by e.key),
         count(*) filter (where (v_cur -> e.key) is distinct from (v_after -> e.key))
    into v_cols, v_xcols, v_kept
  from jsonb_each(v_before) e
  where e.key not in ('lon', 'lat') and v_cur ? e.key;

  -- keep only the columns that still hold the imported value
  select string_agg(quote_ident(e.key), ', ' order by e.key),
         string_agg('x.' || quote_ident(e.key), ', ' order by e.key)
    into v_cols, v_xcols
  from jsonb_each(v_before) e
  where e.key not in ('lon', 'lat') and v_cur ? e.key
    and (v_cur -> e.key) is not distinct from (v_after -> e.key);

  if p_table = 'projects' and v_before ? 'lon' then
    select st_x(p.geom), st_y(p.geom) into v_lon, v_lat from public.projects p where p.id = v_id;
    if v_lon is not null
       and abs(v_lon - (v_after ->> 'lon')::double precision) <= 1e-7
       and abs(v_lat - (v_after ->> 'lat')::double precision) <= 1e-7 then
      v_move := true;
    else
      v_kept := coalesce(v_kept, 0) + 1;
    end if;
  end if;

  if v_cols is null and not v_move then
    return coalesce(v_kept, 0);
  end if;

  if v_move then
    execute format(
      'update public.projects t set (%s) = (select %s from jsonb_populate_record(t, $1) x) where t.id = $2',
      concat_ws(', ', v_cols, 'geom'),
      concat_ws(', ', v_xcols,
        'case when $3 is null then null else st_setsrid(st_makepoint($3, $4), 4326) end'))
      using v_before, v_id,
            (v_before ->> 'lon')::double precision, (v_before ->> 'lat')::double precision;
  else
    execute format(
      'update public.%I t set (%s) = (select %s from jsonb_populate_record(t, $1) x) where t.id = $2',
      p_table, v_cols, v_xcols)
      using v_before, v_id;
  end if;

  return coalesce(v_kept, 0);
end;
$$;

revoke execute on function private.import_insert_child(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.import_apply(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.import_restore(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Batch bookkeeping
-- ---------------------------------------------------------------------------------------------

create or replace function private.import_refresh_stats(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_stats jsonb;
begin
  select jsonb_build_object(
           'total', count(*),
           'valid', count(*) filter (where r.state = 'valid'),
           'invalid', count(*) filter (where r.state = 'invalid'),
           'duplicate', count(*) filter (where r.state = 'duplicate'),
           'with_warnings', count(*) filter (where jsonb_array_length(r.warnings) > 0),
           'create', count(*) filter (where r.action = 'create' and r.state in ('valid', 'duplicate')),
           'update', count(*) filter (where r.action = 'update' and r.state in ('valid', 'duplicate')),
           'skip', count(*) filter (where r.action = 'skip' and r.state in ('valid', 'duplicate')),
           'applied_created', count(*) filter (where r.state = 'applied' and r.action = 'create'),
           'applied_updated', count(*) filter (where r.state = 'applied' and r.action = 'update'),
           'skipped', count(*) filter (where r.state = 'skipped'),
           'reverted', count(*) filter (where r.state = 'reverted'))
    into v_stats
  from public.import_rows r
  where r.batch_id = p_batch_id and r.deleted_at is null;

  update public.import_batches b
  set stats = b.stats || v_stats
  where b.id = p_batch_id;
  return v_stats;
end;
$$;

create or replace function private.import_summary(p_batch_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select jsonb_build_object(
    'batch_id', b.id,
    'state', b.state,
    'source_kind', b.source_kind,
    'file_name', b.file_name,
    'row_count', b.row_count,
    'counts', b.stats - 'created' - 'rollback',
    -- file columns that match no template column (ignored, reported for information)
    'ignored_columns', coalesce((
      select jsonb_agg(e.value ->> 'column' order by e.value ->> 'column')
      from jsonb_array_elements(b.errors) e
      where e.value ->> 'code' = 'unknown_column'), '[]'::jsonb),
    'first_errors', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', x.row_no, 'errors', x.errors) order by x.row_no)
      from (
        select r.row_no, r.errors
        from public.import_rows r
        where r.batch_id = b.id and r.deleted_at is null and r.state = 'invalid'
        order by r.row_no
        limit 20
      ) x), '[]'::jsonb),
    'committed_at', b.committed_at,
    'rolled_back_at', b.rolled_back_at)
  from public.import_batches b
  where b.id = p_batch_id
$$;

revoke execute on function private.import_refresh_stats(uuid) from public, anon, authenticated;
revoke execute on function private.import_summary(uuid) from public, anon, authenticated;

-- May the CALLER merge an import row into this existing project?
--   reviewers of its scope: always; writers: only their own records that are not approved yet.
create or replace function private.import_can_update(p_project uuid)
returns boolean
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce((
    select private.can_review(p.country_id, p.branch_id)
           or (private.can_write_project(p.country_id, p.branch_id)
               and p.created_by = auth.uid()
               and p.record_state <> 'approved')
    from public.projects p
    where p.id = p_project and p.deleted_at is null), false)
$$;

revoke execute on function private.import_can_update(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Validation of a staged batch (called by import_stage; runs with the caller's JWT so the
-- authorisation helpers describe the importing user)
-- ---------------------------------------------------------------------------------------------

create or replace function private.import_validate_batch(p_batch_id uuid)
returns void
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_batch public.import_batches%rowtype;
  v_defs private.import_columns[];
  d private.import_columns;
  r record;
  -- caller scope
  v_w_all boolean := private.write_all();
  v_w_countries uuid[] := private.write_countries();
  v_w_branches uuid[] := private.write_branches();
  v_default_country uuid;
  -- lookup maps (built once per batch)
  v_keymap jsonb;
  v_unknown jsonb;
  v_enum jsonb;
  v_opt jsonb;
  v_country_map jsonb;
  v_area_map jsonb := '{}'::jsonb;
  -- Results of repeated look-ups, keyed by the cell text. Appending to a jsonb value copies it,
  -- so the cache is capped: files with thousands of distinct values simply query every time.
  c_cache_max constant integer := 2000;
  v_cache jsonb := '{}'::jsonb;
  v_cache_n integer := 0;
  v_ext_first jsonb;
  -- per row
  v_in jsonb;
  v_err jsonb;
  v_warn jsonb;
  v_prj jsonb;
  v_land jsonb;
  v_fac jsonb;
  v_com jsonb;
  v_don jsonb;
  v_mnt jsonb;
  v_geo jsonb;
  v_parsed jsonb;
  v_txt text;
  v_n text;
  v_ck text;
  v_val jsonb;
  v_num numeric;
  v_date date;
  v_hit jsonb;
  v_ext text;
  v_t_id uuid;
  v_t_country uuid;
  v_t_branch uuid;
  v_t_deleted timestamptz;
  v_is_update boolean;
  v_lat double precision;
  v_lon double precision;
  v_pt geometry(Point, 4326);
  v_loc_id uuid;
  v_loc_country uuid;
  v_loc_level smallint;
  v_has_loc boolean;
  v_dx double precision;
  v_dy double precision;
  v_check_dup boolean;
  v_country uuid;
  v_country_given uuid;
  v_area uuid;
  v_area_given uuid;
  v_cands jsonb;
  v_branch uuid;
  v_locality uuid;
  v_dups jsonb;
  v_state text;
  v_action text;
  v_dup_of uuid;
  v_name text;
begin
  select * into v_batch from public.import_batches b where b.id = p_batch_id;

  select array_agg(c order by c.position) into v_defs from private.import_columns c;

  -- header -> template key: explicit meta.column_map first, then key / ar / sw / en headers
  -- (normalised), plus two aliases that make an exported file re-importable.
  with headers as (
    select private.norm(h.label) as n, min(h.key) as key
    from (
      select c.key, c.key as label from private.import_columns c
      union all select c.key, c.ar from private.import_columns c
      union all select c.key, c.sw from private.import_columns c
      union all select c.key, c.en from private.import_columns c
      union all select 'country', 'country_iso2'
      union all select 'area', 'admin_area_code'
      union all select 'country', e.ar from private.export_column_defs e where e.key = 'country_iso2'
      union all select 'country', e.sw from private.export_column_defs e where e.key = 'country_iso2'
      union all select 'country', e.en from private.export_column_defs e where e.key = 'country_iso2'
      union all select 'area', e.ar from private.export_column_defs e where e.key = 'admin_area_code'
      union all select 'area', e.sw from private.export_column_defs e where e.key = 'admin_area_code'
      union all select 'area', e.en from private.export_column_defs e where e.key = 'admin_area_code'
    ) h
    group by 1
    having count(distinct h.key) = 1
  ),
  raw_keys as (
    select distinct k.key as raw_key
    from public.import_rows ir, jsonb_object_keys(ir.raw) k(key)
    where ir.batch_id = p_batch_id
  ),
  mapped as (
    select rk.raw_key,
           coalesce(
             (select c.key from private.import_columns c
              where c.key = nullif(v_batch.meta -> 'column_map' ->> rk.raw_key, '')),
             (select hd.key from headers hd where hd.n = private.norm(rk.raw_key))) as key
    from raw_keys rk
  )
  select coalesce(jsonb_object_agg(m.raw_key, m.key) filter (where m.key is not null), '{}'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('code', 'unknown_column', 'column', m.raw_key)
                            order by m.raw_key) filter (where m.key is null), '[]'::jsonb)
    into v_keymap, v_unknown
  from mapped m;

  -- enum labels: {enum_key: {norm(code | ar | sw | en): code}}
  select jsonb_object_agg(x.enum_key, x.m) into v_enum
  from (
    select l.enum_key, jsonb_object_agg(private.norm(v.label), l.code) as m
    from private.enum_labels l
    cross join lateral (values (l.code), (l.ar), (l.sw), (l.en)) v(label)
    group by l.enum_key
  ) x;

  -- option lists: {list_key: {norm(code | name_ar | name_en | name_sw): id}}
  select coalesce(jsonb_object_agg(x.list_key, x.m), '{}'::jsonb) into v_opt
  from (
    select o.list_key, jsonb_object_agg(private.norm(v.label), o.id) as m
    from public.option_values o
    cross join lateral (values (o.code), (o.name_ar), (o.name_en), (o.name_sw)) v(label)
    where o.deleted_at is null and v.label is not null and private.norm(v.label) <> ''
    group by o.list_key
  ) x;

  -- countries: {norm(iso2 | iso3 | name_ar | name_en | name_sw): id}
  select coalesce(jsonb_object_agg(private.norm(v.label), c.id), '{}'::jsonb) into v_country_map
  from public.countries c
  cross join lateral (values (c.iso2::text), (c.iso3::text), (c.name_ar), (c.name_en), (c.name_sw)) v(label)
  where c.deleted_at is null and c.active and v.label is not null and private.norm(v.label) <> '';

  -- default country: the batch's, else the only country the caller can write to
  v_default_country := v_batch.country_id;
  if v_default_country is null and not v_w_all then
    select case when count(*) = 1 then min(x.id::text)::uuid end into v_default_country
    from (
      select unnest(v_w_countries) as id
      union
      select b.country_id from public.branches b where b.id = any (v_w_branches)
    ) x;
  end if;

  -- external ids that occur more than once in the file: {external_id: first row_no}
  select coalesce(jsonb_object_agg(x.ext, x.first_no), '{}'::jsonb) into v_ext_first
  from (
    select s.ext, min(s.row_no) as first_no
    from (
      select ir.row_no,
             nullif(btrim(ir.raw ->> (select k.key from jsonb_each_text(v_keymap) k
                                      where k.value = 'external_id' and ir.raw ? k.key limit 1)), '') as ext
      from public.import_rows ir
      where ir.batch_id = p_batch_id
    ) s
    where s.ext is not null
    group by s.ext
    having count(*) > 1
  ) x;

  for r in
    select ir.id, ir.row_no, ir.raw
    from public.import_rows ir
    where ir.batch_id = p_batch_id
    order by ir.row_no
  loop
    v_err := '[]'::jsonb;
    v_warn := '[]'::jsonb;
    v_prj := '{}'::jsonb;
    v_land := '{}'::jsonb;
    v_fac := '{}'::jsonb;
    v_com := '{}'::jsonb;
    v_don := '{}'::jsonb;
    v_mnt := '{}'::jsonb;
    v_geo := '{}'::jsonb;
    v_parsed := '{}'::jsonb;
    v_t_id := null;
    v_t_country := null;
    v_t_branch := null;
    v_t_deleted := null;
    v_is_update := false;
    v_lat := null;
    v_lon := null;
    v_pt := null;
    v_loc_id := null;
    v_loc_country := null;
    v_loc_level := null;
    v_has_loc := false;
    v_check_dup := false;
    v_country := null;
    v_country_given := null;
    v_area := null;
    v_area_given := null;
    v_branch := null;
    v_locality := null;
    v_dup_of := null;

    -- canonical keys, trimmed text values, blanks dropped
    select coalesce(jsonb_object_agg(v_keymap ->> e.key, nullif(btrim(e.value #>> '{}'), ''))
                    filter (where v_keymap ? e.key and nullif(btrim(e.value #>> '{}'), '') is not null),
                    '{}'::jsonb)
      into v_in
    from jsonb_each(r.raw) e;

    -- 1. external id: decides between create and update ------------------------------------------
    v_ext := v_in ->> 'external_id';
    if v_ext is not null then
      if length(v_ext) > 200 then
        v_err := v_err || private.import_issue('external_id', 'too_long', 'external_id is longer than 200 characters');
      elsif v_ext_first ? v_ext and (v_ext_first ->> v_ext)::integer <> r.row_no then
        v_err := v_err || private.import_issue('external_id', 'duplicate_external_id_in_file',
          format('external_id is already used by row %s of this file', v_ext_first ->> v_ext));
      else
        select p.id, p.country_id, p.branch_id, p.deleted_at
          into v_t_id, v_t_country, v_t_branch, v_t_deleted
        from public.projects p where p.external_id = v_ext;
        if found then
          if v_t_deleted is not null then
            v_err := v_err || private.import_issue('external_id', 'external_id_deleted',
              'a deleted record already uses this external_id');
          elsif not private.import_can_update(v_t_id) then
            v_err := v_err || private.import_issue('external_id', 'no_write_access',
              'a record with this external_id exists and you may not update it');
          else
            v_is_update := true;
          end if;
        end if;
      end if;
    end if;

    -- 2. generic cells -----------------------------------------------------------------------------
    foreach d in array v_defs loop
      v_txt := v_in ->> d.key;
      if v_txt is null then
        if d.required and not v_is_update and d.key not in ('name_ar', 'country') then
          v_err := v_err || private.import_issue(d.key, 'required', format('%s is required', d.key));
        end if;
        continue;
      end if;
      v_val := null;

      if d.kind = 'text' then
        v_val := to_jsonb(v_txt);

      elsif d.kind in ('integer', 'number') then
        v_num := private.import_number(v_txt);
        if v_num = 'NaN'::numeric then
          v_err := v_err || private.import_issue(d.key, 'invalid_number', format('"%s" is not a number', left(v_txt, 40)));
          continue;
        elsif d.kind = 'integer' and v_num <> trunc(v_num) then
          v_err := v_err || private.import_issue(d.key, 'invalid_integer', format('"%s" is not a whole number', left(v_txt, 40)));
          continue;
        elsif (d.min_value is not null and v_num < d.min_value)
           or (d.max_value is not null and v_num > d.max_value) then
          v_err := v_err || private.import_issue(d.key, 'out_of_range',
            format('%s must be between %s and %s', d.key, coalesce(d.min_value::text, '-inf'), coalesce(d.max_value::text, 'inf')));
          continue;
        end if;
        v_val := to_jsonb(v_num);

      elsif d.kind = 'date' then
        v_date := private.import_date(v_txt);
        if v_date = 'infinity'::date then
          v_err := v_err || private.import_issue(d.key, 'invalid_date', format('"%s" is not a date (use YYYY-MM-DD)', left(v_txt, 40)));
          continue;
        end if;
        v_val := to_jsonb(v_date);

      else
        -- boolean / enum / list: resolved through a per-batch cache keyed by the cell text
        v_ck := d.key || '|' || v_txt;
        v_hit := v_cache -> v_ck;
        if v_hit is null then
          if d.kind = 'boolean' then
            v_n := private.import_bool(private.norm(v_txt));
            v_hit := case v_n when 'true' then jsonb_build_object('v', true)
                              when 'false' then jsonb_build_object('v', false)
                              else jsonb_build_object('bad', true) end;
          elsif d.kind = 'enum' then
            v_n := v_enum -> d.enum_key ->> private.norm(v_txt);
            v_hit := case when v_n is null then jsonb_build_object('bad', true)
                          else jsonb_build_object('v', v_n) end;
          else
            select jsonb_build_object(
                     'v', coalesce(jsonb_agg(distinct o.id) filter (where o.id is not null), '[]'::jsonb),
                     'other', string_agg(distinct btrim(i.item), '، ') filter (where o.id is null))
              into v_hit
            from regexp_split_to_table(v_txt, '[،,;|\n]+') i(item)
            left join lateral (select v_opt -> d.key ->> private.norm(i.item) as id) o on true
            where btrim(i.item) <> '';
          end if;
          if v_cache_n < c_cache_max then v_cache := v_cache || jsonb_build_object(v_ck, v_hit); v_cache_n := v_cache_n + 1; end if;
        end if;

        if v_hit ? 'bad' then
          v_err := v_err || private.import_issue(d.key,
            case when d.kind = 'boolean' then 'invalid_boolean' else 'invalid_value' end,
            format('"%s" is not an allowed value for %s', left(v_txt, 40), d.key));
          continue;
        end if;

        if d.kind = 'list' then
          v_com := v_com || jsonb_build_object(d.col, v_hit -> 'v', d.col || '_other', v_hit -> 'other');
          if v_hit ->> 'other' is not null then
            v_warn := v_warn || private.import_issue(d.key, 'unknown_option',
              format('not in the official list, kept as free text: %s', left(v_hit ->> 'other', 200)));
          end if;
          continue;
        end if;
        v_val := v_hit -> 'v';
      end if;

      case d.section
        when 'project' then v_prj := v_prj || jsonb_build_object(d.col, v_val);
        when 'land' then v_land := v_land || jsonb_build_object(d.col, v_val);
        when 'facilities' then v_fac := v_fac || jsonb_build_object(d.col, v_val);
        when 'community' then v_com := v_com || jsonb_build_object(d.col, v_val);
        when 'donor' then v_don := v_don || jsonb_build_object(d.col, v_val);
        when 'maintenance' then v_mnt := v_mnt || jsonb_build_object(d.col, v_val);
        when 'geo' then v_geo := v_geo || jsonb_build_object(d.col, v_val);
        else null;
      end case;
    end loop;

    -- 3. names ----------------------------------------------------------------------------------
    if not (v_prj ? 'name_ar') and v_prj ? 'name_latin' and not v_is_update then
      -- projects.name_ar is mandatory; a Latin-only name is accepted and flagged.
      v_prj := v_prj || jsonb_build_object('name_ar', v_prj -> 'name_latin');
      v_warn := v_warn || private.import_issue('name_ar', 'name_ar_copied_from_latin',
        'name_ar is empty: the Latin name is used for both');
    elsif not (v_prj ? 'name_ar') and not v_is_update then
      v_err := v_err || private.import_issue('name_ar', 'required', 'name_ar is required');
    end if;
    if not (v_prj ? 'status') and not v_is_update then
      v_prj := v_prj || jsonb_build_object('status', 'active');
    end if;

    -- 4. location -------------------------------------------------------------------------------
    if v_is_update and (v_in ? 'lat') <> (v_in ? 'lon') then
      -- (new rows already report the missing coordinate as "required")
      v_err := v_err || private.import_issue('lat', 'incomplete_coordinates', 'lat and lon must be given together');
    elsif v_geo ? 'lat' and v_geo ? 'lon' then
      v_lat := (v_geo ->> 'lat')::double precision;
      v_lon := (v_geo ->> 'lon')::double precision;
      v_pt := st_setsrid(st_makepoint(v_lon, v_lat), 4326);
      v_prj := v_prj || jsonb_build_object('lon', v_lon, 'lat', v_lat);
      select dd.id, dd.country_id, dd.level into v_loc_id, v_loc_country, v_loc_level
      from private.deepest_admin_area(v_pt) dd;
      v_has_loc := found;
    end if;

    if v_geo ? 'country' then
      v_country_given := (v_country_map ->> private.norm(v_geo ->> 'country'))::uuid;
      if v_country_given is null then
        v_err := v_err || private.import_issue('country', 'country_not_found',
          format('unknown country "%s" (use the ISO code or the name)', left(v_geo ->> 'country', 40)));
      end if;
    end if;

    if v_has_loc then
      v_country := v_loc_country;
      v_area := v_loc_id;
      if v_country_given is not null and v_country_given <> v_country then
        v_warn := v_warn || private.import_issue('country', 'point_outside_country',
          'the coordinates fall inside another country; the country of the coordinates is used');
      end if;
    elsif v_is_update then
      v_country := coalesce(v_country_given, v_t_country);
    else
      v_country := coalesce(v_country_given, v_default_country);
    end if;

    if v_country is null and not v_is_update then
      if not (v_geo ? 'country') then
        v_err := v_err || private.import_issue('country', 'required', 'country is required');
      end if;
    end if;

    -- admin area given by code or name (fallback when no boundary contains the point)
    if v_geo ? 'area' and v_country is not null then
      if not (v_area_map ? v_country::text) then
        select v_area_map || jsonb_build_object(v_country::text, coalesce(jsonb_object_agg(x.n, x.ids), '{}'::jsonb))
          into v_area_map
        from (
          select y.n, jsonb_agg(jsonb_build_object('id', y.id, 'level', y.level) order by y.level, y.id) as ids
          from (
            select distinct private.norm(v.label) as n, a.id, a.level
            from public.admin_areas a
            cross join lateral (values (a.code), (a.name_ar), (a.name_en), (a.name_sw)) v(label)
            where a.country_id = v_country and a.deleted_at is null and v.label is not null
          ) y
          where y.n <> ''
          group by y.n
        ) x;
      end if;
      v_cands := v_area_map -> v_country::text -> private.norm(v_geo ->> 'area');
      if v_cands is null then
        if v_has_loc then
          v_warn := v_warn || private.import_issue('area', 'area_not_found',
            'unknown admin area; the area of the coordinates is used');
        else
          v_err := v_err || private.import_issue('area', 'area_not_found',
            format('unknown admin area "%s" in this country', left(v_geo ->> 'area', 60)));
        end if;
      elsif jsonb_array_length(v_cands) > 1
            and (v_cands -> 0 ->> 'level') = (v_cands -> 1 ->> 'level') then
        if not v_has_loc then
          v_err := v_err || private.import_issue('area', 'area_ambiguous',
            'several admin areas share this name; use the area code');
        end if;
      else
        v_area_given := (v_cands -> 0 ->> 'id')::uuid;
        if v_has_loc then
          -- brief §7.2: warn when the point lies outside the chosen area
          if not exists (
            with recursive up as (
              select a.id, a.parent_id, 1 as depth from public.admin_areas a where a.id = v_loc_id
              union all
              select a.id, a.parent_id, u.depth + 1 from public.admin_areas a join up u on a.id = u.parent_id
              where u.depth < 4
            )
            select 1 from up where up.id = v_area_given
          ) then
            v_warn := v_warn || private.import_issue('area', 'point_outside_area',
              'the coordinates fall outside the given admin area; the area of the coordinates is used');
          end if;
        else
          v_area := v_area_given;
        end if;
      end if;
    end if;

    -- branch: given by code or name, else batch default, else the caller's only branch there,
    -- else the only branch covering the area
    if v_geo ? 'branch' and v_country is not null then
      v_ck := 'branch|' || v_country::text || '|' || (v_geo ->> 'branch');
      v_hit := v_cache -> v_ck;
      if v_hit is null then
        v_n := private.norm(v_geo ->> 'branch');
        select jsonb_build_object('id', (
          select b.id from public.branches b
          where b.country_id = v_country and b.deleted_at is null
            and (private.norm(b.code) = v_n or private.norm(b.name_ar) = v_n
                 or private.norm(b.name_en) = v_n or private.norm(b.name_sw) = v_n)
          order by b.active desc, b.created_at
          limit 1)) into v_hit;
        if v_cache_n < c_cache_max then v_cache := v_cache || jsonb_build_object(v_ck, v_hit); v_cache_n := v_cache_n + 1; end if;
      end if;
      v_branch := (v_hit ->> 'id')::uuid;
      if v_branch is null then
        v_err := v_err || private.import_issue('branch', 'branch_not_found',
          format('unknown branch "%s" in this country', left(v_geo ->> 'branch', 60)));
      end if;
    elsif not v_is_update and v_country is not null then
      v_ck := 'defbranch|' || v_country::text || '|' || coalesce(v_area::text, '');
      v_hit := v_cache -> v_ck;
      if v_hit is null then
        select jsonb_build_object('id', coalesce(
          (select b.id from public.branches b
           where b.id = v_batch.branch_id and b.country_id = v_country and b.deleted_at is null),
          (select case when count(*) = 1 then min(b.id::text)::uuid end
           from public.branches b
           where b.id = any (v_w_branches) and b.country_id = v_country and b.deleted_at is null
             and not v_w_all and not (v_country = any (v_w_countries))),
          (select case when count(*) = 1 then min(b.id::text)::uuid end
           from public.branches b
           where b.country_id = v_country and b.deleted_at is null and b.active
             and v_area is not null
             and b.admin_area_ids && (
               with recursive up as (
                 select a.id, a.parent_id, 1 as depth from public.admin_areas a where a.id = v_area
                 union all
                 select a.id, a.parent_id, u.depth + 1 from public.admin_areas a join up u on a.id = u.parent_id
                 where u.depth < 4
               )
               select array_agg(up.id) from up))))
          into v_hit;
        if v_cache_n < c_cache_max then v_cache := v_cache || jsonb_build_object(v_ck, v_hit); v_cache_n := v_cache_n + 1; end if;
      end if;
      v_branch := (v_hit ->> 'id')::uuid;
    end if;

    -- write scope of the row
    if not v_is_update and v_country is not null then
      if not (v_w_all or v_country = any (v_w_countries) or coalesce(v_branch = any (v_w_branches), false)) then
        v_err := v_err || private.import_issue(null, 'out_of_scope',
          'this row is outside the countries / branches you may write to');
      end if;
    elsif v_is_update and (v_country is distinct from v_t_country
                           or (v_branch is not null and v_branch is distinct from v_t_branch)) then
      -- the row moves the project: the destination must be writable too
      if not (v_w_all or v_country = any (v_w_countries)
              or coalesce(coalesce(v_branch, v_t_branch) = any (v_w_branches), false)) then
        v_err := v_err || private.import_issue(null, 'out_of_scope',
          'this row would move the record outside the countries / branches you may write to');
      end if;
    end if;

    -- locality by name inside the country; unknown names become proposed localities on commit
    if v_geo ? 'locality' and v_country is not null then
      v_n := private.norm(v_geo ->> 'locality');
      -- candidates with that name in the country (cached per name) ...
      v_ck := 'loc|' || v_country::text || '|' || v_n;
      v_hit := v_cache -> v_ck;
      if v_hit is null then
        select jsonb_build_object('c', coalesce(jsonb_agg(
                 jsonb_build_object('id', x.id, 'area', x.admin_area_id) order by x.approved desc, x.created_at, x.id),
                 '[]'::jsonb))
          into v_hit
        from (
          select l.id, l.admin_area_id, (l.status = 'approved') as approved, l.created_at
          from public.localities l
          where l.country_id = v_country and l.deleted_at is null
            and l.name_norm like '%' || private.like_escape(v_n) || '%'
            and (l.name_norm = v_n or private.norm(l.name_ar) = v_n or private.norm(l.name_latin) = v_n)
          order by (l.status = 'approved') desc, l.created_at, l.id
          limit 50
        ) x;
        if v_cache_n < c_cache_max then v_cache := v_cache || jsonb_build_object(v_ck, v_hit); v_cache_n := v_cache_n + 1; end if;
      end if;
      -- ... preferring the one in the row's own admin area
      select (c.value ->> 'id')::uuid into v_locality
      from jsonb_array_elements(v_hit -> 'c') with ordinality c(value, ord)
      order by ((c.value ->> 'area') is not distinct from v_area::text) desc, c.ord
      limit 1;
      if v_locality is null then
        v_parsed := v_parsed || jsonb_build_object('locality_new', jsonb_strip_nulls(jsonb_build_object(
          'name_ar', case when (v_geo ->> 'locality') ~ U&'[\0600-\06FF]' then v_geo ->> 'locality' end,
          'name_latin', case when (v_geo ->> 'locality') !~ U&'[\0600-\06FF]' then v_geo ->> 'locality' end,
          'country_id', v_country,
          'admin_area_id', v_area)));
        v_warn := v_warn || private.import_issue('locality', 'locality_new',
          'unknown locality: it will be created as "proposed" for a supervisor to approve');
      end if;
    end if;

    -- resolved references go into the project payload (updates only carry what the file gave)
    if not v_is_update then
      v_prj := v_prj || jsonb_strip_nulls(jsonb_build_object(
        'country_id', v_country, 'admin_area_id', v_area, 'branch_id', v_branch, 'locality_id', v_locality));
    else
      if v_geo ? 'lat' or v_geo ? 'country' or v_geo ? 'area' then
        v_prj := v_prj || jsonb_strip_nulls(jsonb_build_object('country_id', v_country, 'admin_area_id', v_area));
      end if;
      v_prj := v_prj || jsonb_strip_nulls(jsonb_build_object('branch_id', v_branch, 'locality_id', v_locality));
    end if;
    if v_ext is not null then
      v_prj := v_prj || jsonb_build_object('external_id', v_ext);
    end if;

    -- 5. donor and maintenance --------------------------------------------------------------------
    if v_don ? 'name' then
      v_n := private.norm(v_don ->> 'name');
      v_ck := 'donor|' || v_n;
      v_hit := v_cache -> v_ck;
      if v_hit is null then
        select jsonb_build_object('id', (
          select dn.id from public.donors dn
          where dn.deleted_at is null
            and dn.name_norm like '%' || private.like_escape(v_n) || '%'
            and (dn.name_norm = v_n or private.norm(dn.name_ar) = v_n or private.norm(dn.name_latin) = v_n)
          order by dn.created_at, dn.id
          limit 1)) into v_hit;
        if v_cache_n < c_cache_max then v_cache := v_cache || jsonb_build_object(v_ck, v_hit); v_cache_n := v_cache_n + 1; end if;
      end if;
      v_don := v_don || jsonb_build_object('donor_id', v_hit -> 'id');
      if v_don ? 'currency' then
        if upper(v_don ->> 'currency') !~ '^[A-Z]{3}$' then
          v_err := v_err || private.import_issue('donor_currency', 'invalid_value', 'currency must be a 3-letter code');
        else
          v_don := v_don || jsonb_build_object('currency', upper(v_don ->> 'currency'));
        end if;
      end if;
      v_parsed := v_parsed || jsonb_build_object('donor', v_don);
    elsif v_don <> '{}'::jsonb then
      v_warn := v_warn || private.import_issue('donor', 'donor_details_without_name',
        'donation details are ignored because the donor name is empty');
    end if;

    if v_mnt ? 'description' then
      v_parsed := v_parsed || jsonb_build_object('maintenance',
        jsonb_build_object('priority', 'medium') || v_mnt);
    end if;

    -- 6. assemble ----------------------------------------------------------------------------------
    v_parsed := v_parsed || jsonb_build_object('project', v_prj);
    -- "same place" key of the similar-name rule: the locality, else the level-3 area of the point
    v_txt := coalesce(
      v_locality::text,
      'new:' || nullif(private.norm(coalesce(v_parsed -> 'locality_new' ->> 'name_ar',
                                             v_parsed -> 'locality_new' ->> 'name_latin')), ''),
      case when v_has_loc and v_loc_level = 3 then 'area:' || v_loc_id::text end);
    if v_txt is not null then
      v_parsed := v_parsed || jsonb_build_object('dup_place', v_txt);
    end if;
    -- template keys that really had a cell in the file (a merge writes nothing else)
    v_parsed := v_parsed || jsonb_build_object('given',
      coalesce((select jsonb_agg(k.key order by k.key) from jsonb_object_keys(v_in) k(key)), '[]'::jsonb));
    if v_land <> '{}'::jsonb then v_parsed := v_parsed || jsonb_build_object('land', v_land); end if;
    if v_fac <> '{}'::jsonb then v_parsed := v_parsed || jsonb_build_object('facilities', v_fac); end if;
    if v_com <> '{}'::jsonb then v_parsed := v_parsed || jsonb_build_object('community', v_com); end if;

    -- 7. duplicates (brief §7.3), only for clean new rows --------------------------------------------
    v_state := 'valid';
    v_action := case when v_is_update then 'update' else 'create' end;
    if jsonb_array_length(v_err) > 0 then
      v_state := 'invalid';
      v_action := null;
    elsif not v_is_update then
      v_name := coalesce(v_prj ->> 'name_ar', v_prj ->> 'name_latin');
      -- The rule itself lives in project_duplicates(). It is only called when a candidate can
      -- exist at all: some project inside a box wider than the 150 m radius, or some project
      -- in the same locality / level-3 area (two index probes instead of the full check).
      v_dy := 170.0 / 111320.0;
      v_dx := v_dy / greatest(cos(radians(v_lat)), 0.01);
      select exists (
        select 1 from public.projects p
        where p.deleted_at is null and p.geom && st_expand(v_pt, v_dx, v_dy)) into v_check_dup;
      if not v_check_dup and v_locality is not null then
        select exists (
          select 1 from public.projects p
          where p.locality_id = v_locality and p.deleted_at is null) into v_check_dup;
      elsif not v_check_dup and v_has_loc and v_loc_level = 3 then
        select exists (
          select 1 from public.projects p
          where p.admin_area_id = v_loc_id and p.deleted_at is null) into v_check_dup;
      end if;
      if v_check_dup then
        v_dups := public.project_duplicates(v_prj ->> 'type', v_lon, v_lat, v_name, v_locality, null);
      else
        v_dups := '[]'::jsonb;
      end if;
      if jsonb_array_length(v_dups) > 0 then
        v_state := 'duplicate';
        v_action := 'skip';
        v_dup_of := (v_dups -> 0 ->> 'id')::uuid;
        v_warn := v_warn || (private.import_issue(null, 'possible_duplicate',
            'a similar project already exists; the row is skipped unless you force it or merge it')
          || jsonb_build_object('candidates', (
               select jsonb_agg(c.value order by c.ord)
               from jsonb_array_elements(v_dups) with ordinality c(value, ord)
               where c.ord <= 5)));
      end if;
    end if;

    update public.import_rows ir
    set external_id = v_ext,
        parsed = v_parsed,
        state = v_state,
        action = v_action,
        errors = v_err,
        warnings = v_warn,
        duplicate_of = v_dup_of,
        target_id = case when v_is_update and v_state <> 'invalid' then v_t_id end,
        pre_image = null,
        applied_at = null
    where ir.id = r.id;
  end loop;

  -- 8. duplicates inside the file itself: a later row within 150 m of an earlier row of a
  --    compatible type, or with the same name in the same locality / level-3 area.
  --    Points are bucketed in a 0.002-degree grid (> 150 m per cell in the tropics) so that the
  --    distance test is an equi-join on the cell and its 8 neighbours, not a 5,000 x 5,000 loop.
  with cand as materialized (
    select ir.row_no,
           ir.parsed -> 'project' ->> 'type' as type,
           (ir.parsed -> 'project' ->> 'lon')::double precision as lon,
           (ir.parsed -> 'project' ->> 'lat')::double precision as lat,
           floor((ir.parsed -> 'project' ->> 'lon')::double precision / 0.002)::bigint as cx,
           floor((ir.parsed -> 'project' ->> 'lat')::double precision / 0.002)::bigint as cy,
           private.norm(coalesce(ir.parsed -> 'project' ->> 'name_ar', ir.parsed -> 'project' ->> 'name_latin')) as name_n,
           ir.parsed ->> 'dup_place' as place
    from public.import_rows ir
    where ir.batch_id = p_batch_id and ir.action = 'create' and ir.state = 'valid'
  ),
  probe as materialized (
    select b.row_no, b.type, b.lon, b.lat, b.cx + gx as cx, b.cy + gy as cy
    from cand b
    cross join generate_series(-1, 1) gx
    cross join generate_series(-1, 1) gy
  ),
  near as (
    select b.row_no, min(a.row_no) as first_no
    from probe b
    join cand a on a.cx = b.cx and a.cy = b.cy
    where a.row_no < b.row_no
      and (a.type = b.type or a.type = 'combined' or b.type = 'combined')
      and st_distancesphere(st_makepoint(a.lon, a.lat), st_makepoint(b.lon, b.lat)) <= 150
    group by b.row_no
  ),
  named as (
    select b.row_no, min(a.row_no) as first_no
    from cand b
    join cand a on a.name_n = b.name_n and a.place = b.place and a.row_no < b.row_no
    where b.name_n <> ''
    group by b.row_no
  ),
  hits as (
    select x.row_no, min(x.first_no) as first_no
    from (select * from near union all select * from named) x
    group by x.row_no
  )
  update public.import_rows ir
  set state = 'duplicate',
      action = 'skip',
      warnings = ir.warnings || (private.import_issue(null, 'duplicate_in_file',
          format('looks like the same project as row %s of this file', h.first_no))
        || jsonb_build_object('row_no', h.first_no))
  from hits h
  where ir.batch_id = p_batch_id and ir.row_no = h.row_no;

  update public.import_batches b
  set state = 'validated',
      errors = v_unknown
  where b.id = p_batch_id;

  perform private.import_refresh_stats(p_batch_id);
end;
$$;

revoke execute on function private.import_validate_batch(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- import_template(p_lang)
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_template(p_lang text default 'ar')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_lang text := coalesce(nullif(btrim(p_lang), ''), 'ar');
  v_columns jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;
  if v_lang not in ('ar', 'sw', 'en') then
    raise exception 'unsupported language: %', v_lang using errcode = 'PT422';
  end if;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'key', c.key,
           'header', case v_lang when 'ar' then c.ar when 'sw' then c.sw else c.en end,
           'headers', jsonb_build_object('ar', c.ar, 'sw', c.sw, 'en', c.en),
           'required', c.required,
           'kind', c.kind,
           'min', c.min_value,
           'max', c.max_value,
           'example', c.example,
           'allowed', case
             when c.kind in ('enum', 'boolean') then (
               select jsonb_agg(jsonb_build_object('code', l.code,
                        'label', case v_lang when 'ar' then l.ar when 'sw' then l.sw else l.en end)
                      order by l.sort_order)
               from private.enum_labels l where l.enum_key = c.enum_key)
             when c.kind = 'list' then (
               select jsonb_agg(jsonb_build_object('code', o.code,
                        'label', case v_lang when 'ar' then coalesce(o.name_ar, o.name_en, o.name_sw)
                                             when 'sw' then coalesce(o.name_sw, o.name_en, o.name_ar)
                                             else coalesce(o.name_en, o.name_sw, o.name_ar) end)
                      order by o.sort_order, o.code)
               from public.option_values o
               where o.list_key = c.key and o.deleted_at is null and o.active)
           end))
         order by c.position)
    into v_columns
  from private.import_columns c;

  return jsonb_build_object(
    'version', 1,
    'lang', v_lang,
    'dir', case when v_lang = 'ar' then 'rtl' else 'ltr' end,
    'max_rows', 5000,
    'list_separator', '|',
    'date_format', 'YYYY-MM-DD',
    'merge_key', 'external_id',
    'columns', coalesce(v_columns, '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- import_stage(p_meta, p_rows)
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_stage(p_meta jsonb, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
set statement_timeout = '180s'
as $$
declare
  c_max_rows constant integer := 5000;
  v_uid uuid := auth.uid();
  v_meta jsonb := case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  v_n integer;
  v_kind text;
  v_country uuid;
  v_branch uuid;
  v_path text;
  v_batch_id uuid := private.uuid_v7();
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;
  if not (private.write_all()
          or cardinality(private.write_countries()) > 0
          or cardinality(private.write_branches()) > 0) then
    raise exception 'only users with write access may import' using errcode = 'PT403';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array of objects' using errcode = 'PT422';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 then
    raise exception 'the file contains no rows' using errcode = 'PT422';
  end if;
  if v_n > c_max_rows then
    raise exception 'too many rows: % (maximum % per batch)', v_n, c_max_rows using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e.value) <> 'object') then
    raise exception 'every row must be a JSON object' using errcode = 'PT422';
  end if;

  perform private.rate_limit('import_stage', 30, interval '1 hour');

  v_kind := coalesce(nullif(v_meta ->> 'source_kind', ''), 'csv');
  if v_kind not in ('csv', 'xlsx', 'v2_json', 'v2_local') then
    raise exception 'unsupported source kind: %', v_kind using errcode = 'PT422';
  end if;

  v_country := nullif(v_meta ->> 'country_id', '')::uuid;
  v_branch := nullif(v_meta ->> 'branch_id', '')::uuid;
  if v_country is not null
     and not exists (select 1 from public.countries c where c.id = v_country and c.deleted_at is null) then
    raise exception 'unknown country_id' using errcode = 'PT422';
  end if;
  if v_branch is not null then
    select b.country_id into v_country
    from public.branches b
    where b.id = v_branch and b.deleted_at is null and (v_country is null or b.country_id = v_country);
    if not found then
      raise exception 'unknown branch_id' using errcode = 'PT422';
    end if;
  end if;

  -- an uploaded source file must live in the caller's own folder of bucket "imports"
  v_path := nullif(v_meta ->> 'storage_path', '');
  if v_path is not null and v_path not like v_uid::text || '/%' then
    raise exception 'storage_path must be inside your own folder' using errcode = 'PT422';
  end if;

  insert into public.import_batches
    (id, user_id, source_kind, file_name, storage_path, country_id, branch_id, state, meta, row_count)
  values
    (v_batch_id, v_uid, v_kind, left(v_meta ->> 'file_name', 255), v_path, v_country, v_branch,
     'staged', v_meta, v_n);

  insert into public.import_rows (batch_id, row_no, raw)
  select v_batch_id, e.ord::integer, e.value
  from jsonb_array_elements(p_rows) with ordinality e(value, ord);

  perform private.import_validate_batch(v_batch_id);

  return private.import_summary(v_batch_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- import_preview(p_batch_id, p_after, p_limit, p_only)
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_preview(
  p_batch_id uuid,
  p_after integer default 0,
  p_limit integer default 100,
  p_only text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_after integer := coalesce(p_after, 0);
  v_rows jsonb;
  v_last integer;
  v_more boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;
  if p_only is not null and p_only not in ('invalid', 'duplicate', 'valid', 'warnings', 'create', 'update', 'skip') then
    raise exception 'invalid filter: %', p_only using errcode = 'PT422';
  end if;
  if not exists (
    select 1 from public.import_batches b
    where b.id = p_batch_id and b.deleted_at is null
      and (b.user_id = auth.uid() or private.is_hq())
  ) then
    raise exception 'import batch not found' using errcode = 'PT404';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
             'row_no', x.row_no, 'state', x.state, 'action', x.action,
             'external_id', x.external_id, 'errors', x.errors, 'warnings', x.warnings,
             'duplicate_of', x.duplicate_of, 'target_id', x.target_id,
             'raw', x.raw, 'parsed', x.parsed)
           order by x.row_no), '[]'::jsonb),
         max(x.row_no),
         count(*) > v_limit
    into v_rows, v_last, v_more
  from (
    select r.*
    from public.import_rows r
    where r.batch_id = p_batch_id and r.deleted_at is null and r.row_no > v_after
      and (p_only is null
           or (p_only in ('invalid', 'duplicate', 'valid') and r.state = p_only)
           or (p_only = 'warnings' and jsonb_array_length(r.warnings) > 0)
           or (p_only in ('create', 'update', 'skip') and r.action = p_only))
    order by r.row_no
    limit v_limit + 1
  ) x;

  if v_more then
    -- drop the look-ahead row
    select jsonb_agg(e.value order by e.ord), max((e.value ->> 'row_no')::integer)
      into v_rows, v_last
    from jsonb_array_elements(v_rows) with ordinality e(value, ord)
    where e.ord <= v_limit;
  end if;

  return private.import_summary(p_batch_id) || jsonb_build_object(
    'rows', v_rows,
    'next', case when v_more then v_last end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- import_set_action(p_batch_id, p_row_no, p_action, p_target_id)
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_set_action(
  p_batch_id uuid,
  p_row_no integer,
  p_action text,
  p_target_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_batch public.import_batches%rowtype;
  v_row public.import_rows%rowtype;
  v_target uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;
  if p_action is null or p_action not in ('create', 'update', 'skip') then
    raise exception 'invalid action: %', coalesce(p_action, 'null') using errcode = 'PT422';
  end if;

  select * into v_batch
  from public.import_batches b
  where b.id = p_batch_id and b.deleted_at is null
  for update;
  if not found or v_batch.user_id <> auth.uid() then
    raise exception 'import batch not found' using errcode = 'PT404';
  end if;
  if v_batch.state <> 'validated' then
    raise exception 'import batch is %', v_batch.state using errcode = 'PT409';
  end if;

  select * into v_row
  from public.import_rows r
  where r.batch_id = p_batch_id and r.row_no = p_row_no and r.deleted_at is null
  for update;
  if not found then
    raise exception 'row % not found', p_row_no using errcode = 'PT404';
  end if;
  if v_row.state not in ('valid', 'duplicate') then
    raise exception 'row % has errors and cannot be imported', p_row_no using errcode = 'PT422';
  end if;

  if p_action = 'skip' then
    update public.import_rows r set action = 'skip' where r.id = v_row.id;

  elsif p_action = 'create' then
    if v_row.external_id is not null
       and exists (select 1 from public.projects p where p.external_id = v_row.external_id) then
      raise exception 'a record with this external_id exists: the row can only update it'
        using errcode = 'PT422';
    end if;
    -- a row prepared as an update only carries the cells of the file: it cannot become a new record
    if not (v_row.parsed -> 'project' ? 'name_ar' and v_row.parsed -> 'project' ? 'type'
            and v_row.parsed -> 'project' ? 'lon' and v_row.parsed -> 'project' ? 'country_id') then
      raise exception 'row % lacks the mandatory fields of a new record', p_row_no using errcode = 'PT422';
    end if;
    update public.import_rows r set action = 'create', target_id = null where r.id = v_row.id;

  else
    v_target := coalesce(p_target_id, v_row.target_id, v_row.duplicate_of);
    if v_target is null then
      raise exception 'a target project is required to merge row %', p_row_no using errcode = 'PT422';
    end if;
    if not private.import_can_update(v_target) then
      raise exception 'you may not update the target project' using errcode = 'PT403';
    end if;
    update public.import_rows r set action = 'update', target_id = v_target where r.id = v_row.id;
  end if;

  perform private.import_refresh_stats(p_batch_id);

  select * into v_row from public.import_rows r where r.id = v_row.id;
  return jsonb_build_object(
    'row_no', v_row.row_no, 'state', v_row.state, 'action', v_row.action,
    'external_id', v_row.external_id, 'errors', v_row.errors, 'warnings', v_row.warnings,
    'duplicate_of', v_row.duplicate_of, 'target_id', v_row.target_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- import_commit(p_batch_id): all or nothing
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_commit(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
set statement_timeout = '300s'
as $$
declare
  v_uid uuid := auth.uid();
  v_batch public.import_batches%rowtype;
  v_w_all boolean;
  v_w_countries uuid[];
  v_w_branches uuid[];
  r record;
  v_row_no integer;
  v_prj jsonb;
  v_ln jsonb;
  v_dn jsonb;
  v_mn jsonb;
  v_img jsonb;
  v_res jsonb;
  v_created_aux jsonb;
  v_pid uuid;
  v_loc_id uuid;
  v_donor_id uuid;
  v_child uuid;
  v_new_id uuid;
  v_target record;
  v_pt geometry(Point, 4326);
  v_new_localities uuid[] := '{}'::uuid[];
  v_new_donors uuid[] := '{}'::uuid[];
  v_pair record;
  v_given jsonb;
  v_norm text;
  v_ref_country uuid;
  v_ref_area uuid;
  v_year smallint;
  v_ext text;
  v_msg text;
  v_detail text;
  v_sqlstate text;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;

  select * into v_batch
  from public.import_batches b
  where b.id = p_batch_id and b.deleted_at is null
  for update;
  if not found or v_batch.user_id <> v_uid then
    raise exception 'import batch not found' using errcode = 'PT404';
  end if;
  if v_batch.state <> 'validated' then
    raise exception 'import batch is %', v_batch.state using errcode = 'PT409';
  end if;

  perform private.rate_limit('import_commit', 30, interval '1 hour');

  v_w_all := private.write_all();
  v_w_countries := private.write_countries();
  v_w_branches := private.write_branches();

  begin
    for r in
      select ir.*
      from public.import_rows ir
      where ir.batch_id = p_batch_id and ir.deleted_at is null
        and ir.action in ('create', 'update') and ir.state in ('valid', 'duplicate')
      order by ir.row_no
    loop
      v_row_no := r.row_no;
      v_prj := coalesce(r.parsed -> 'project', '{}'::jsonb);
      v_img := '{}'::jsonb;
      v_created_aux := '{}'::jsonb;
      v_pt := case when v_prj ? 'lon' and v_prj ? 'lat'
                   then st_setsrid(st_makepoint((v_prj ->> 'lon')::double precision,
                                                (v_prj ->> 'lat')::double precision), 4326) end;

      -- locality: reuse or create a proposed one ---------------------------------------------------
      v_loc_id := nullif(v_prj ->> 'locality_id', '')::uuid;
      if v_loc_id is null and r.parsed ? 'locality_new' then
        v_ln := r.parsed -> 'locality_new';
        -- Plain values first: the look-up then compares columns with parameters only (no
        -- function call per scanned row, index-friendly), also for rows created by this batch.
        v_norm := coalesce(private.norm(concat_ws(' ', v_ln ->> 'name_ar', v_ln ->> 'name_latin')), '');
        v_ref_country := (v_ln ->> 'country_id')::uuid;
        v_ref_area := nullif(v_ln ->> 'admin_area_id', '')::uuid;
        select l.id into v_loc_id
        from public.localities l
        where l.country_id = v_ref_country and l.name_norm = v_norm and l.deleted_at is null
          and l.admin_area_id is not distinct from v_ref_area
        order by l.created_at, l.id
        limit 1;
        if v_loc_id is null then
          v_loc_id := private.uuid_v7();
          insert into public.localities (id, country_id, admin_area_id, name_ar, name_latin, geom, status)
          values (v_loc_id, v_ref_country, v_ref_area, v_ln ->> 'name_ar', v_ln ->> 'name_latin', v_pt, 'proposed');
          v_new_localities := v_new_localities || v_loc_id;
        end if;
        v_prj := v_prj || jsonb_build_object('locality_id', v_loc_id);
      end if;

      if r.action = 'create' then
        -- scope and merge key are re-checked at commit time
        if not (v_w_all
                or (v_prj ->> 'country_id')::uuid = any (v_w_countries)
                or coalesce((v_prj ->> 'branch_id')::uuid = any (v_w_branches), false)) then
          raise exception 'row is outside your write scope' using errcode = 'PT403';
        end if;
        v_ext := v_prj ->> 'external_id';
        if v_ext is not null and exists (select 1 from public.projects p where p.external_id = v_ext) then
          raise exception 'external_id "%" was taken by another record after the preview', v_ext
            using errcode = 'PT409';
        end if;

        v_pid := private.uuid_v7();
        insert into public.projects
          (id, external_id, name_ar, name_latin, type, status, capacity, geom, gps_accuracy_m,
           location_source, country_id, admin_area_id, locality_id, branch_id, builder,
           build_year, build_date, record_state, import_batch_id)
        select v_pid, x.external_id, x.name_ar, x.name_latin, x.type, coalesce(x.status, 'active'),
               x.capacity, v_pt, x.gps_accuracy_m, 'import', x.country_id, x.admin_area_id,
               x.locality_id, x.branch_id, x.builder, x.build_year, x.build_date, 'draft', p_batch_id
        from jsonb_populate_record(null::public.projects, v_prj) x;

        for v_pair in
          select * from (values ('land', 'project_land'), ('facilities', 'project_facilities'),
                                ('community', 'community_profiles')) t(k, tbl)
        loop
          if r.parsed ? v_pair.k then
            perform private.import_insert_child(v_pair.tbl, v_pid, r.parsed -> v_pair.k);
          end if;
        end loop;

      else
        v_pid := r.target_id;
        select p.id, p.country_id, p.branch_id, p.external_id into v_target
        from public.projects p
        where p.id = v_pid and p.deleted_at is null
        for update;
        if not found then
          raise exception 'the target project no longer exists' using errcode = 'PT409';
        end if;
        if not private.import_can_update(v_pid) then
          raise exception 'you may not update the target project' using errcode = 'PT403';
        end if;
        -- A merge writes only what the file really contained: defaults that validation filled in
        -- for a new record (status, branch, country, copied name) are dropped. This matters for
        -- rows that were prepared as "create" and then merged by hand into an existing project.
        v_given := coalesce(r.parsed -> 'given', '[]'::jsonb);
        select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_prj
        from jsonb_each(v_prj) e
        where case
                when e.key in ('lon', 'lat') then v_given ? 'lat' and v_given ? 'lon'
                when e.key in ('country_id', 'admin_area_id') then v_given ? 'lat' or v_given ? 'country' or v_given ? 'area'
                when e.key = 'branch_id' then v_given ? 'branch'
                when e.key = 'locality_id' then v_given ? 'locality'
                when e.key = 'external_id' then true
                else v_given ? e.key
              end;
        -- a merge decided by hand never overwrites an existing merge key
        if v_target.external_id is not null then
          v_prj := v_prj - 'external_id';
        end if;
        -- moving the record: the destination must be writable too
        if (v_prj ? 'country_id' and (v_prj ->> 'country_id')::uuid is distinct from v_target.country_id)
           or (v_prj ? 'branch_id' and (v_prj ->> 'branch_id')::uuid is distinct from v_target.branch_id) then
          if not (v_w_all
                  or coalesce((v_prj ->> 'country_id')::uuid, v_target.country_id) = any (v_w_countries)
                  or coalesce(coalesce((v_prj ->> 'branch_id')::uuid, v_target.branch_id) = any (v_w_branches), false)) then
            raise exception 'row would move the record outside your write scope' using errcode = 'PT403';
          end if;
        end if;

        v_res := private.import_apply('projects', v_pid, v_prj);
        if v_res is not null then
          v_img := v_img || jsonb_build_object('projects', v_res);
        end if;

        for v_pair in
          select * from (values ('land', 'project_land'), ('facilities', 'project_facilities'),
                                ('community', 'community_profiles')) t(k, tbl)
        loop
          if r.parsed ? v_pair.k then
            execute format('select t.id from public.%I t where t.project_id = $1 and t.deleted_at is null limit 1', v_pair.tbl)
              into v_child using v_pid;
            if v_child is null then
              v_child := private.import_insert_child(v_pair.tbl, v_pid, r.parsed -> v_pair.k);
              if v_child is not null then
                v_img := v_img || jsonb_build_object(v_pair.tbl, jsonb_build_object('id', v_child, 'created', true));
              end if;
            else
              v_res := private.import_apply(v_pair.tbl, v_child, r.parsed -> v_pair.k);
              if v_res is not null then
                v_img := v_img || jsonb_build_object(v_pair.tbl, v_res);
              end if;
            end if;
          end if;
        end loop;
      end if;

      -- donor link ---------------------------------------------------------------------------------
      if r.parsed ? 'donor' then
        v_dn := r.parsed -> 'donor';
        v_donor_id := nullif(v_dn ->> 'donor_id', '')::uuid;
        if v_donor_id is null then
          v_norm := private.norm(v_dn ->> 'name');
          select dn.id into v_donor_id
          from public.donors dn
          where dn.name_norm = v_norm and dn.deleted_at is null
          order by dn.created_at, dn.id
          limit 1;
        end if;
        v_year := (v_dn ->> 'year')::smallint;
        if v_donor_id is null then
          v_donor_id := private.uuid_v7();
          insert into public.donors (id, name_ar, name_latin)
          values (v_donor_id,
                  case when (v_dn ->> 'name') ~ U&'[\0600-\06FF]' then v_dn ->> 'name' end,
                  case when (v_dn ->> 'name') !~ U&'[\0600-\06FF]' then v_dn ->> 'name' end);
          v_new_donors := v_new_donors || v_donor_id;
        end if;
        if not exists (
          select 1 from public.project_donors pd
          where pd.project_id = v_pid and pd.donor_id = v_donor_id and pd.deleted_at is null
            and coalesce(pd.year, 0) = coalesce(v_year, 0)
        ) then
          v_new_id := private.uuid_v7();
          insert into public.project_donors (id, project_id, donor_id, amount, currency, year)
          values (v_new_id, v_pid, v_donor_id, (v_dn ->> 'amount')::numeric, v_dn ->> 'currency', v_year);
          v_created_aux := v_created_aux || jsonb_build_object('project_donors', jsonb_build_array(v_new_id));
        end if;
      end if;

      -- maintenance entry (never duplicated on re-import) ----------------------------------------
      if r.parsed ? 'maintenance' then
        v_mn := r.parsed -> 'maintenance';
        v_norm := btrim(v_mn ->> 'description');
        if not exists (
          select 1 from public.project_maintenance m
          where m.project_id = v_pid and m.deleted_at is null
            and btrim(m.description) = v_norm
        ) then
          v_new_id := private.uuid_v7();
          insert into public.project_maintenance (id, project_id, description, priority)
          values (v_new_id, v_pid, v_mn ->> 'description', coalesce(v_mn ->> 'priority', 'medium'));
          v_created_aux := v_created_aux || jsonb_build_object('project_maintenance', jsonb_build_array(v_new_id));
        end if;
      end if;

      if r.action = 'update' and v_created_aux <> '{}'::jsonb then
        v_img := v_img || jsonb_build_object('created', v_created_aux);
      end if;

      update public.import_rows ir
      set state = 'applied',
          target_id = v_pid,
          pre_image = case when r.action = 'update' then v_img end,
          applied_at = now()
      where ir.id = r.id;
    end loop;
    v_row_no := null;

    update public.import_rows ir
    set state = 'skipped'
    where ir.batch_id = p_batch_id and ir.deleted_at is null
      and ir.state in ('valid', 'duplicate') and coalesce(ir.action, 'skip') = 'skip';

    update public.import_batches b
    set state = 'committed',
        committed_at = now(),
        committed_by = v_uid,
        stats = b.stats || jsonb_build_object('created', jsonb_build_object(
                  'localities', to_jsonb(v_new_localities), 'donors', to_jsonb(v_new_donors)))
    where b.id = p_batch_id;

  exception when others then
    -- Everything written inside the block has been rolled back. Flag the failing row so that the
    -- user can fix or skip it and commit again.
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail,
                            v_sqlstate = returned_sqlstate;
    if v_row_no is not null then
      update public.import_rows ir
      set state = 'invalid',
          action = null,
          errors = ir.errors || jsonb_build_array(
            private.import_issue(null, 'commit_failed', v_msg)
            || jsonb_build_object('sqlstate', v_sqlstate, 'detail', nullif(v_detail, '')))
      where ir.batch_id = p_batch_id and ir.row_no = v_row_no;
    end if;
    perform private.import_refresh_stats(p_batch_id);
    return private.import_summary(p_batch_id) || jsonb_build_object(
      'committed', false,
      'failed_row', v_row_no,
      'error', jsonb_build_object('code', v_sqlstate, 'message', v_msg));
  end;

  perform private.import_refresh_stats(p_batch_id);
  return private.import_summary(p_batch_id) || jsonb_build_object('committed', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- import_rollback(p_batch_id): undo the whole batch
-- ---------------------------------------------------------------------------------------------

create or replace function public.import_rollback(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
set statement_timeout = '300s'
as $$
declare
  v_uid uuid := auth.uid();
  v_batch public.import_batches%rowtype;
  r record;
  v_tbl text;
  v_id text;
  v_reverted integer := 0;
  v_kept integer := 0;
  v_conflicts integer := 0;
  v_del uuid[];
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'PT401';
  end if;

  select * into v_batch
  from public.import_batches b
  where b.id = p_batch_id and b.deleted_at is null
  for update;
  if not found or not (v_batch.user_id = v_uid or private.is_hq()) then
    raise exception 'import batch not found' using errcode = 'PT404';
  end if;
  if v_batch.state <> 'committed' then
    raise exception 'import batch is %', v_batch.state using errcode = 'PT409';
  end if;

  perform private.rate_limit('import_rollback', 30, interval '1 hour');

  -- 1. Projects created by the batch (set-based: a handful of statements for the whole batch).
  --    Still drafts -> soft-deleted with their children. Submitted / approved since the import
  --    -> somebody's work now: kept, the row stays "applied" and is reported.
  select coalesce(array_agg(p.id) filter (where p.record_state = 'draft'), '{}'::uuid[]),
         count(*) filter (where p.record_state <> 'draft')
    into v_del, v_kept
  from public.import_rows ir
  join public.projects p on p.id = ir.target_id and p.deleted_at is null
  where ir.batch_id = p_batch_id and ir.deleted_at is null
    and ir.state = 'applied' and ir.action = 'create';

  if cardinality(v_del) > 0 then
    -- lock the projects first so that nobody submits them halfway through
    perform 1 from public.projects p where p.id = any (v_del) order by p.id for update;

    foreach v_tbl in array array['project_land', 'project_facilities', 'community_profiles',
                                 'community_sensitive', 'project_donors', 'project_maintenance',
                                 'project_photos'] loop
      execute format('update public.%I t set deleted_at = now() where t.project_id = any ($1) and t.deleted_at is null', v_tbl)
        using v_del;
    end loop;
    update public.staff_compensation sc
    set deleted_at = now()
    from public.project_staff s
    where s.project_id = any (v_del) and sc.project_staff_id = s.id and sc.deleted_at is null;
    update public.project_staff s
    set deleted_at = now()
    where s.project_id = any (v_del) and s.deleted_at is null;
    -- the merge key is released so that the corrected file can be imported again
    update public.projects p
    set deleted_at = now(), external_id = null
    where p.id = any (v_del);
  end if;

  update public.import_rows ir
  set state = 'reverted'
  where ir.batch_id = p_batch_id and ir.deleted_at is null
    and ir.state = 'applied' and ir.action = 'create'
    and not exists (select 1 from public.projects p where p.id = ir.target_id and p.deleted_at is null);
  get diagnostics v_reverted = row_count;

  -- 2. Updated projects: restore field by field from the pre-image, newest row first.
  for r in
    select ir.*
    from public.import_rows ir
    where ir.batch_id = p_batch_id and ir.deleted_at is null
      and ir.state = 'applied' and ir.action = 'update'
    order by ir.row_no desc
  loop
    -- rows created next to the updated project
    for v_tbl in select jsonb_object_keys(coalesce(r.pre_image -> 'created', '{}'::jsonb)) loop
      if v_tbl in ('project_donors', 'project_maintenance') then
        for v_id in select jsonb_array_elements_text(r.pre_image -> 'created' -> v_tbl) loop
          execute format('update public.%I t set deleted_at = now() where t.id = $1 and t.deleted_at is null', v_tbl)
            using v_id::uuid;
        end loop;
      end if;
    end loop;
    foreach v_tbl in array array['community_profiles', 'project_facilities', 'project_land', 'projects'] loop
      if r.pre_image ? v_tbl then
        v_conflicts := v_conflicts + private.import_restore(v_tbl, r.pre_image -> v_tbl);
      end if;
    end loop;

    update public.import_rows ir set state = 'reverted' where ir.id = r.id;
    v_reverted := v_reverted + 1;
  end loop;

  -- proposed localities and donors created by the batch, when nothing else uses them
  update public.localities l
  set deleted_at = now()
  where l.id in (select e.v::uuid from jsonb_array_elements_text(
                   coalesce(v_batch.stats -> 'created' -> 'localities', '[]'::jsonb)) e(v))
    and l.deleted_at is null and l.status = 'proposed'
    and not exists (select 1 from public.projects p where p.locality_id = l.id and p.deleted_at is null);

  update public.donors dn
  set deleted_at = now()
  where dn.id in (select e.v::uuid from jsonb_array_elements_text(
                    coalesce(v_batch.stats -> 'created' -> 'donors', '[]'::jsonb)) e(v))
    and dn.deleted_at is null
    and not exists (select 1 from public.project_donors pd where pd.donor_id = dn.id and pd.deleted_at is null);

  update public.import_batches b
  set state = 'rolled_back',
      rolled_back_at = now(),
      rolled_back_by = v_uid,
      stats = b.stats || jsonb_build_object('rollback', jsonb_build_object(
                'reverted', v_reverted, 'kept', v_kept, 'conflicting_fields', v_conflicts))
  where b.id = p_batch_id;

  perform private.import_refresh_stats(p_batch_id);
  return private.import_summary(p_batch_id) || jsonb_build_object(
    'rolled_back', true,
    'reverted', v_reverted,
    'kept', v_kept,
    'conflicting_fields', v_conflicts);
end;
$$;

-- Privileges ----------------------------------------------------------------------------------

revoke execute on function public.import_template(text) from public, anon;
revoke execute on function public.import_stage(jsonb, jsonb) from public, anon;
revoke execute on function public.import_preview(uuid, integer, integer, text) from public, anon;
revoke execute on function public.import_set_action(uuid, integer, text, uuid) from public, anon;
revoke execute on function public.import_commit(uuid) from public, anon;
revoke execute on function public.import_rollback(uuid) from public, anon;

grant execute on function public.import_template(text) to authenticated;
grant execute on function public.import_stage(jsonb, jsonb) to authenticated;
grant execute on function public.import_preview(uuid, integer, integer, text) to authenticated;
grant execute on function public.import_set_action(uuid, integer, text, uuid) to authenticated;
grant execute on function public.import_commit(uuid) to authenticated;
grant execute on function public.import_rollback(uuid) to authenticated;

comment on function public.import_template(text) is
  'Official import template: ordered columns (key, localised header, required, kind, allowed values, example).';
comment on function public.import_stage(jsonb, jsonb) is
  'Stages and validates up to 5,000 rows for the caller (writers only); returns the preview summary.';
comment on function public.import_preview(uuid, integer, integer, text) is
  'Pages through the rows of the caller''s import batch with errors, warnings, duplicates and action.';
comment on function public.import_set_action(uuid, integer, text, uuid) is
  'Lets the owner skip a row, force its creation, or merge it into an existing project.';
comment on function public.import_commit(uuid) is
  'Applies a validated batch atomically: merges by external_id, creates new projects as drafts, stores pre-images.';
comment on function public.import_rollback(uuid) is
  'Undoes a committed batch: created drafts are soft-deleted, updated rows are restored from their pre-images.';
