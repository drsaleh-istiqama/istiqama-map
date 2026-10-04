-- Load generator, part 2: reference rows and the batch procedure.
-- Triggers enabled; one batch = 1,000 projects with all their children = one transaction
-- (one sync_xid per batch). A finished batch is recorded in loadgen.progress in the same
-- transaction, so an interrupted load resumes with the first missing batch.

create or replace procedure loadgen.load_refs()
language plpgsql
as $$
begin
  -- donors: 20k
  insert into public.donors (id, name_ar, name_latin, notes)
  select md5('load:donor:' || g)::uuid, f.ar || ' ' || l.ar || ' ' || g, f.la || ' ' || l.la || ' ' || g, null
  from generate_series(1, 20000) g
  join loadgen.nm_first f on f.i = 1 + g % 40
  join loadgen.nm_last l on l.i = 1 + (g * 7) % 30
  on conflict (id) do nothing;
  commit;

  -- localities: one per 5 projects, at the point of project 5L
  insert into public.localities (id, created_by, country_id, name_ar, name_latin, geom, status)
  select md5('load:loc:' || (p.g / 5))::uuid, null, p.country_id, null,
         pl.la || ' ' || (p.g / 5 % 97), p.geom,
         case when p.g % 20 = 0 then 'proposed' else 'approved' end
  from loadgen.pj p
  join loadgen.nm_place pl on pl.i = 1 + (p.g / 5) % 600
  where p.g % 5 = 0
  on conflict (id) do nothing;
  commit;
end;
$$;

create or replace procedure loadgen.load_batch(p_batch int)
language plpgsql
as $$
declare
  v_max_loc int := (select max(g) / 5 from loadgen.pj);
begin
  -- projects
  insert into public.projects
    (id, created_by, created_at, name_ar, name_latin, type, status, capacity, geom, gps_accuracy_m,
     location_source, country_id, branch_id, locality_id, builder, build_year, record_state)
  select pj.id,
         md5('load:user:col:' || pj.iso2 || b.bno || ':' || pj.coll)::uuid,
         now() - make_interval(secs => ((select projects from loadgen.cfg) - pj.g + 10) * 900),
         x.name_ar, x.name_latin, x.type,
         case when pj.r2 < 0.75 then 'active' when pj.r2 < 0.87 then 'maintenance' when pj.r2 < 0.95 then 'building' else 'inactive' end,
         (20 + floor(pj.r3 * 600))::int,
         pj.geom, (3 + pj.r4 * 40)::real, 'gps', pj.country_id, pj.branch_id,
         case when pj.r5 < 0.6 and ceil(pj.g / 5.0)::int between 1 and v_max_loc
              then md5('load:loc:' || ceil(pj.g / 5.0)::int)::uuid end,
         case when pj.r4 < 0.5 then 'Istiqama' end,
         case when pj.r5 < 0.8 then (1980 + floor(pj.r5 * 55))::smallint end,
         case when pj.r3 < 0.8 then 'approved' when pj.r3 < 0.9 then 'submitted' when pj.r3 < 0.97 then 'draft' else 'returned' end
  from loadgen.pj pj
  join loadgen.b b on b.id = pj.branch_id
  join loadgen.nm_proj np on np.i = pj.n1
  join loadgen.nm_place pl on pl.i = pj.n2
  cross join lateral (
    select case when pj.r1 < 0.55 then 'mosque' when pj.r1 < 0.85 then 'school' else 'combined' end as type,
           case when pj.r1 < 0.55 then 'مسجد ' when pj.r1 < 0.85 then 'مدرسة ' else 'مسجد ومدرسة ' end || np.ar
             || case when pj.r2 < 0.6 then ' - ' || pl.la else '' end as name_ar,
           case when pj.r1 < 0.55 then 'Masjid ' when pj.r1 < 0.85 then 'Madrasat ' else 'Masjid na Madrasa ' end || np.la
             || ' ' || pl.la as name_latin
  ) x
  where pj.batch = p_batch;

  insert into public.project_land (id, project_id, ownership, owner_name, area_m2, utilization_pct, expandable)
  select md5('load:land:' || g)::uuid, id,
         (array['association','waqf','person','government','other'])[1 + g % 5], 'Owner ' || g,
         (200 + r1 * 3000)::numeric(14,2), (r2 * 100)::numeric(5,2), r3 < 0.4
  from loadgen.pj where batch = p_batch and r3 < 0.8;

  insert into public.project_facilities
    (id, project_id, teacher_housing, imam_housing, guest_housing, library, hall, quran_count, quran_need,
     hall_capacity, student_transport, students_origin)
  select md5('load:fac:' || g)::uuid, id, r1 < 0.5, r2 < 0.4, r3 < 0.2, r4 < 0.3, r5 < 0.3,
         (r3 * 100)::int, (r4 * 80)::int, (r5 * 200)::int,
         case when r1 < 0.2 then 'needed' when r1 < 0.5 then 'available' else 'not_needed' end,
         (array['nearby','mixed','distant'])[1 + g % 3]
  from loadgen.pj where batch = p_batch and r4 < 0.7;

  insert into public.project_maintenance (id, project_id, reported_on, description, priority, estimated_cost, currency, state)
  select md5('load:maint:' || g || ':' || k)::uuid, id, current_date - ((g + k) % 700),
         'Repair item ' || k || ' of project ' || g,
         (array['low','medium','high','urgent'])[1 + (g + k) % 4], (100 + r1 * 5000)::numeric(14,2),
         case when k = 1 then 'USD' else cur end,
         case when (g + k) % 3 = 0 then 'done' when (g + k) % 3 = 1 then 'open' else 'in_progress' end
  from loadgen.pj cross join generate_series(1, 2) k
  where batch = p_batch and r5 < 0.3;

  insert into public.project_photos
    (id, project_id, storage_path_full, storage_path_thumb, taken_at, width, height, bytes, is_cover, category, upload_state)
  select ph.pid, pj.id,
         'projects/' || pj.iso2 || '/' || pj.id || '/' || ph.pid || '_full.webp',
         'projects/' || pj.iso2 || '/' || pj.id || '/' || ph.pid || '_thumb.webp',
         now() - make_interval(days => (pj.g + k) % 900), 1600, 1200, 180000 + k * 1000, k = 1,
         (array['mosque_front','mosque_inside','school_front','school_inside','land','facilities','maintenance','other','unspecified','other'])[k],
         'uploaded'
  from loadgen.pj pj cross join generate_series(1, 10) k
  cross join lateral (select md5('load:photo:' || pj.g || ':' || k)::uuid as pid) ph
  where pj.batch = p_batch;

  insert into public.project_donors (id, project_id, donor_id, amount, currency, year)
  select md5('load:pd:' || g)::uuid, id, md5('load:donor:' || donor_no)::uuid, (1000 + r1 * 50000)::numeric(14,2), 'USD', 2015 + g % 10
  from loadgen.pj where batch = p_batch;

  insert into public.persons
    (id, name_ar, name_latin, phone_e164, gender, birth_year, home_admin_area_id, education_level, country_id, branch_id)
  select md5('load:person:' || pj.g || ':' || k)::uuid,
         f1.ar || ' بن ' || f2.ar || ' ' || l.ar,
         f1.la || ' bin ' || f2.la || ' ' || l.la,
         case when k <= 3 then '+' || case pj.iso2 when 'TZ' then '255' when 'KE' then '254' when 'UG' then '256'
                                          when 'RW' then '250' when 'BI' then '257' when 'MZ' then '258' else '968' end
                               || '7' || lpad((pj.g * 5 + k)::text, 8, '0') end,
         case when f1.i between 31 and 36 then 'female' else 'male' end,
         (1955 + (pj.g + k * 7) % 50)::smallint,
         case when k <= 2 then pj.ward_id end,
         (array['primary','secondary','diploma','university',null])[1 + (pj.g + k) % 5],
         pj.country_id, pj.branch_id
  from loadgen.pj pj cross join generate_series(1, 5) k
  join loadgen.nm_first f1 on f1.i = 1 + floor(40 * power(((pj.g * 7919 + k * 104729) % 1000) / 1000.0, 2.2))::int
  join loadgen.nm_first f2 on f2.i = 1 + ((pj.g * 31 + k * 17) % 40)
  join loadgen.nm_last l on l.i = 1 + ((pj.g * 13 + k * 7) % 30)
  where pj.batch = p_batch;

  insert into public.project_staff (id, project_id, person_id, role, start_date)
  select md5('load:staff:' || g || ':' || k)::uuid, id, md5('load:person:' || g || ':' || k)::uuid,
         (array['imam','teacher','agent','administrator','manager'])[k], date '2018-01-01' + (g % 2000)
  from loadgen.pj cross join generate_series(1, 5) k
  where batch = p_batch;

  insert into public.staff_compensation (id, project_staff_id, monthly_amount, currency, effective_from)
  select md5('load:comp:' || g || ':' || k)::uuid, md5('load:staff:' || g || ':' || k)::uuid,
         (50 + r1 * 400 * k)::numeric(14,2) * case cur when 'OMR' then 1 when 'KES' then 130 else 2500 end,
         case when g % 25 = 0 then 'USD' else cur end, date '2024-01-01'
  from loadgen.pj cross join generate_series(1, 3) k
  where batch = p_batch;

  insert into public.community_profiles
    (id, project_id, branch_name, population, muslim_pct, daawa_activities, livelihoods, social_challenges)
  select md5('load:cp:' || g)::uuid, id, 'Community ' || g, (500 + r2 * 20000)::int, (r3 * 100)::numeric(5,2),
         (select array_agg(o.id) from (select id from public.option_values where list_key = 'daawa_activities' and active order by id limit 2) o),
         (select array_agg(o.id) from (select id from public.option_values where list_key = 'livelihoods' and active order by id limit 2) o),
         (select array_agg(o.id) from (select id from public.option_values where list_key = 'social_challenges' and active order by id limit 1) o)
  from loadgen.pj where batch = p_batch and r1 < 0.6;

  insert into public.community_sensitive
    (id, project_id, ibadi_families, omani_families, omani_student_pct, ibadi_student_pct, omani_teacher_pct,
     ibadi_teacher_pct, guest_financial_capacity)
  select md5('load:cs:' || g)::uuid, id, (r1 * 40)::int, (r2 * 10)::int, (r3 * 20)::numeric(5,2), (r4 * 80)::numeric(5,2),
         (r5 * 20)::numeric(5,2), (r1 * 80)::numeric(5,2), (array['good','limited','none'])[1 + g % 3]
  from loadgen.pj where batch = p_batch and r2 < 0.4;
  insert into loadgen.progress (batch) values (p_batch);
end;
$$;
