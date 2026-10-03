-- Import: template, stage -> preview -> commit (drafts) -> merge by external_id -> rollback
-- (brief §10; contract docs/contracts/reports-import-export.md)
begin;
set local search_path = public, extensions, tests;

select plan(62);

select tests.fixture_extra();

-- Privileges and template ----------------------------------------------------------------------------
select tests.login_anon();
select throws_ok($$select public.import_stage('{}'::jsonb, '[{"name_ar": "x"}]'::jsonb)$$, '42501', null, 'anon cannot import');
select tests.logout();

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok($$select public.import_stage('{}'::jsonb, '[{"name_ar": "x"}]'::jsonb)$$, 'PT403', null, 'viewers cannot import');
select tests.logout();

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(jsonb_path_query_first(public.import_template('ar'), '$.columns[*] ? (@.key == "type")') ->> 'header', 'النوع', 'template: Arabic header');
select ok((jsonb_path_query_first(public.import_template('sw'), '$.columns[*] ? (@.key == "name_ar")') ->> 'required')::boolean
          and jsonb_path_query_first(public.import_template('sw'), '$.columns[*] ? (@.key == "type")') -> 'allowed'
              @> '[{"code": "mosque", "label": "Msikiti"}]'::jsonb,
          'template: required flag and allowed values with localised labels');
select is((public.import_template('en') ->> 'max_rows')::int, 5000, 'template: 5,000 rows per batch');
select throws_ok($$select public.import_stage('{}'::jsonb, '[]'::jsonb)$$, 'PT422', null, 'an empty file is rejected');
select throws_ok(
  $$select public.import_stage('{}'::jsonb, (select jsonb_agg(jsonb_build_object('name_ar', 'x')) from generate_series(1, 5001)))$$,
  'PT422', null, 'more than 5,000 rows are rejected');

-- Stage: one good row, one broken row, one out-of-scope row, one duplicate of an existing project --------
select set_config('t.b1', public.import_stage(
  '{"file_name": "first.csv", "source_kind": "csv"}'::jsonb,
  jsonb_build_array(
    -- headers and values in Arabic, Arabic-Indic digits
    jsonb_build_object('external_id', 'T-IMP-1', 'اسم المشروع (عربي)', 'مسجد الاستيراد', 'النوع', 'مسجد',
                       'lat', '-5.0100', 'lon', '39.7100', 'country', 'TZ', 'السعة', '١٢٠',
                       'land_ownership', 'وقف', 'quran_need', '30', 'teacher_housing', 'لا',
                       'locality', 'Kijiji Kipya', 'donor', 'Mfadhili Mpya', 'donor_year', '2020',
                       'maintenance_note', 'Paa linavuja', 'unknown column', 'ignored'),
    jsonb_build_object('name_ar', '', 'type', 'church', 'lat', '95', 'lon', '39.7', 'country', 'TZ', 'capacity', 'many'),
    jsonb_build_object('name_ar', 'مسجد كينيا', 'type', 'mosque', 'lat', '-4.06', 'lon', '39.66', 'country', 'KE'),
    jsonb_build_object('name_ar', 'مسجد قريب', 'type', 'mosque', 'lat', '-5.0501', 'lon', '39.7501', 'country', 'TZ')
  ))::text, true);

select is(current_setting('t.b1')::jsonb ->> 'state', 'validated', 'stage: batch is validated');
select is(current_setting('t.b1')::jsonb -> 'counts' -> 'total', '4'::jsonb, 'stage: 4 rows');
select is(current_setting('t.b1')::jsonb -> 'counts' -> 'valid', '1'::jsonb, 'stage: 1 valid row');
select is(current_setting('t.b1')::jsonb -> 'counts' -> 'invalid', '2'::jsonb, 'stage: 2 invalid rows');
select is(current_setting('t.b1')::jsonb -> 'counts' -> 'duplicate', '1'::jsonb, 'stage: 1 duplicate row');
select is(current_setting('t.b1')::jsonb -> 'ignored_columns', '["unknown column"]'::jsonb, 'stage: unknown columns are reported');
select is((current_setting('t.b1')::jsonb #>> '{first_errors,0,row_no}')::int, 2, 'stage: first errors point at row 2');

-- Preview
select set_config('t.pv', public.import_preview((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid, 0, 10)::text, true);
select is(jsonb_array_length(current_setting('t.pv')::jsonb -> 'rows'), 4, 'preview: all rows');
select is(current_setting('t.pv')::jsonb #>> '{rows,0,action}', 'create', 'preview: row 1 will be created');
select is(current_setting('t.pv')::jsonb #>> '{rows,0,parsed,project,type}', 'mosque', 'preview: localised value mapped to its code');
select is((current_setting('t.pv')::jsonb #>> '{rows,0,parsed,project,capacity}')::int, 120, 'preview: Arabic-Indic digits parsed');
select is((current_setting('t.pv')::jsonb #>> '{rows,0,parsed,project,branch_id}')::uuid, tests.id('br_pemba'), 'preview: the collector''s branch is the default');
select ok(current_setting('t.pv')::jsonb #> '{rows,1,errors}' @> '[{"field": "type", "code": "invalid_value"}]'::jsonb
          and current_setting('t.pv')::jsonb #> '{rows,1,errors}' @> '[{"field": "lat", "code": "out_of_range"}]'::jsonb
          and current_setting('t.pv')::jsonb #> '{rows,1,errors}' @> '[{"field": "name_ar", "code": "required"}]'::jsonb
          and current_setting('t.pv')::jsonb #> '{rows,1,errors}' @> '[{"field": "capacity", "code": "invalid_number"}]'::jsonb,
          'preview: row 2 lists every validation error with its field');
select ok(current_setting('t.pv')::jsonb #> '{rows,2,errors}' @> '[{"code": "out_of_scope"}]'::jsonb,
          'preview: a Kenya row is outside the write scope of a Pemba collector');
select is(current_setting('t.pv')::jsonb #>> '{rows,3,state}', 'duplicate', 'preview: row 4 is a possible duplicate');
select is((current_setting('t.pv')::jsonb #>> '{rows,3,duplicate_of}')::uuid, tests.id('p_pemba_1'), 'preview: duplicate of the fixture mosque 16 m away');
select is(current_setting('t.pv')::jsonb #>> '{rows,3,action}', 'skip', 'preview: duplicates are skipped by default');
select is(jsonb_array_length(public.import_preview((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid, 0, 10, 'invalid') -> 'rows'), 2,
          'preview: filter by state');
select is((public.import_preview((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid, 0, 3) ->> 'next')::int, 3, 'preview: keyset paging by row number');

-- Row actions
select throws_ok(format('select public.import_set_action(%L, 2, %L)', current_setting('t.b1')::jsonb ->> 'batch_id', 'create'),
                 'PT422', null, 'set_action: an invalid row cannot be forced');
select is(public.import_set_action((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid, 4, 'create') ->> 'action', 'create',
          'set_action: a duplicate can be forced');
select is(public.import_set_action((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid, 4, 'skip') ->> 'action', 'skip',
          'set_action: ... and skipped again');
select tests.logout();

select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select throws_ok(format('select public.import_commit(%L)', current_setting('t.b1')::jsonb ->> 'batch_id'), 'PT404', null,
                 'another user cannot commit the batch');
select tests.logout();

-- Commit -----------------------------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.c1', public.import_commit((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid)::text, true);
select tests.logout();

select ok((current_setting('t.c1')::jsonb ->> 'committed')::boolean and current_setting('t.c1')::jsonb ->> 'state' = 'committed',
          'commit: batch committed');
select is(current_setting('t.c1')::jsonb -> 'counts' -> 'applied_created', '1'::jsonb, 'commit: one project created');
select is((select count(*)::int from public.projects p where p.import_batch_id = (current_setting('t.b1')::jsonb ->> 'batch_id')::uuid), 1,
          'commit: invalid and skipped rows create nothing');
select is((select p.record_state || '/' || p.location_source || '/' || p.type || '/' || p.capacity
           from public.projects p where p.external_id = 'T-IMP-1'),
          'draft/import/mosque/120', 'commit: new projects are drafts with location_source = import');
select ok((select p.created_by = tests.id('u_col_pemba') and p.branch_id = tests.id('br_pemba')
                  and p.country_id = tests.id('tz') and p.admin_area_id = tests.id('tz_pemba_north')
                  and p.code like 'TZ-PN-%'
           from public.projects p where p.external_id = 'T-IMP-1'),
          'commit: owner, branch, country, admin area and code are set');
select is((select l.ownership from public.project_land l join public.projects p on p.id = l.project_id where p.external_id = 'T-IMP-1'),
          'waqf', 'commit: land row created from the localised value');
select is((select f.quran_need::text || '/' || f.teacher_housing::text from public.project_facilities f
           join public.projects p on p.id = f.project_id where p.external_id = 'T-IMP-1'),
          '30/false', 'commit: facilities row created');
select is((select l.status from public.localities l join public.projects p on p.locality_id = l.id where p.external_id = 'T-IMP-1'),
          'proposed', 'commit: unknown locality becomes a proposed locality');
select is((select count(*)::int from public.project_donors pd join public.projects p on p.id = pd.project_id
           join public.donors d on d.id = pd.donor_id
           where p.external_id = 'T-IMP-1' and d.name_latin = 'Mfadhili Mpya' and pd.year = 2020), 1,
          'commit: donor created and linked');
select is((select count(*)::int from public.project_maintenance m join public.projects p on p.id = m.project_id
           where p.external_id = 'T-IMP-1' and m.state = 'open'), 1, 'commit: maintenance note becomes an open entry');

-- Snapshot of everything the import may touch, before the second import
create temporary table t_snap on commit drop as
select 1 as n,
       (select to_jsonb(p) - array['updated_at', 'updated_by', 'version', 'sync_xid', 'search_norm', 'completeness']
        from public.projects p where p.external_id = 'T-IMP-1') as project,
       (select to_jsonb(l) - array['updated_at', 'updated_by', 'version', 'sync_xid']
        from public.project_land l join public.projects p on p.id = l.project_id where p.external_id = 'T-IMP-1' and l.deleted_at is null) as land,
       (select count(*) from public.community_profiles c join public.projects p on p.id = c.project_id
        where p.external_id = 'T-IMP-1' and c.deleted_at is null) as communities;

-- Second import with the same external_id: update, not a duplicate ----------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.b2', public.import_stage(
  '{"file_name": "second.csv"}'::jsonb,
  jsonb_build_array(jsonb_build_object('external_id', 'T-IMP-1', 'capacity', '150', 'name_latin', 'Masjid Import',
                                       'land_notes', 'corner plot', 'population', '900'))
  )::text, true);
select is(current_setting('t.b2')::jsonb -> 'counts' -> 'update', '1'::jsonb, 'second import: the row is an update');
select set_config('t.c2', public.import_commit((current_setting('t.b2')::jsonb ->> 'batch_id')::uuid)::text, true);
select tests.logout();

select is((select count(*)::int from public.projects p where p.external_id = 'T-IMP-1'), 1, 'second import: no duplicate project');
select is((select p.capacity::text || '/' || p.name_latin || '/' || p.name_ar || '/' || p.type from public.projects p where p.external_id = 'T-IMP-1'),
          '150/Masjid Import/مسجد الاستيراد/mosque', 'second import: only the given cells changed');
select is((select l.notes || '/' || l.ownership from public.project_land l join public.projects p on p.id = l.project_id
           where p.external_id = 'T-IMP-1' and l.deleted_at is null),
          'corner plot/waqf', 'second import: child row merged field by field');
select is((select c.population from public.community_profiles c join public.projects p on p.id = c.project_id
           where p.external_id = 'T-IMP-1' and c.deleted_at is null), 900, 'second import: missing child row is created');
select ok((select r.pre_image #>> '{projects,before,capacity}' = '120' and r.pre_image #>> '{projects,after,capacity}' = '150'
                  and (r.pre_image #> '{community_profiles,created}')::boolean
           from public.import_rows r where r.batch_id = (current_setting('t.b2')::jsonb ->> 'batch_id')::uuid),
          'second import: the pre-image of the updated row is stored');

-- A reviewer-only rule: collectors cannot overwrite approved records through an import
update public.projects set external_id = 'T-APPROVED' where id = tests.id('p_pemba_1');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select ok(public.import_stage('{}'::jsonb, '[{"external_id": "T-APPROVED", "capacity": "5"}]'::jsonb)
            #> '{first_errors,0,errors}' @> '[{"code": "no_write_access"}]'::jsonb,
          'a collector cannot update an approved record by import');
select tests.logout();
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(public.import_stage('{}'::jsonb, '[{"external_id": "T-APPROVED", "capacity": "5"}]'::jsonb) -> 'counts' -> 'update', '1'::jsonb,
          'a supervisor can');
select tests.logout();

-- Rollback of the second batch restores the previous state exactly -----------------------------------------
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select throws_ok(format('select public.import_rollback(%L)', current_setting('t.b2')::jsonb ->> 'batch_id'), 'PT404', null,
                 'another user cannot roll the batch back');
select tests.logout();

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.r2', public.import_rollback((current_setting('t.b2')::jsonb ->> 'batch_id')::uuid)::text, true);
select tests.logout();

select ok((current_setting('t.r2')::jsonb ->> 'rolled_back')::boolean and (current_setting('t.r2')::jsonb ->> 'reverted')::int = 1
          and (current_setting('t.r2')::jsonb ->> 'conflicting_fields')::int = 0, 'rollback: second batch reverted');
select is((select to_jsonb(p) - array['updated_at', 'updated_by', 'version', 'sync_xid', 'search_norm', 'completeness']
           from public.projects p where p.external_id = 'T-IMP-1'),
          (select s.project from t_snap s), 'rollback: the project is exactly as before the second import');
select is((select to_jsonb(l) - array['updated_at', 'updated_by', 'version', 'sync_xid']
           from public.project_land l join public.projects p on p.id = l.project_id where p.external_id = 'T-IMP-1' and l.deleted_at is null),
          (select s.land from t_snap s), 'rollback: the land row is exactly as before');
select is((select count(*) from public.community_profiles c join public.projects p on p.id = c.project_id
           where p.external_id = 'T-IMP-1' and c.deleted_at is null),
          (select s.communities from t_snap s), 'rollback: the child row created by the batch is removed');

-- Rollback of the first batch soft-deletes what it created ---------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('select public.import_rollback(%L)', current_setting('t.b2')::jsonb ->> 'batch_id'), 'PT409', null,
                 'rollback: cannot be repeated');
select set_config('t.r1', public.import_rollback((current_setting('t.b1')::jsonb ->> 'batch_id')::uuid)::text, true);
select tests.logout();

select ok((select p.deleted_at is not null and p.external_id is null
           from public.projects p where p.import_batch_id = (current_setting('t.b1')::jsonb ->> 'batch_id')::uuid),
          'rollback: created project is soft-deleted and its merge key released');
select is((select count(*)::int from public.project_land l join public.projects p on p.id = l.project_id
           where p.import_batch_id = (current_setting('t.b1')::jsonb ->> 'batch_id')::uuid and l.deleted_at is null), 0,
          'rollback: children of the created project are soft-deleted');
select ok((select l.deleted_at is not null from public.localities l where l.name_latin = 'Kijiji Kipya')
          and (select d.deleted_at is not null from public.donors d where d.name_latin = 'Mfadhili Mpya'),
          'rollback: the proposed locality and the donor created by the batch are removed');
select is((select b.state from public.import_batches b where b.id = (current_setting('t.b1')::jsonb ->> 'batch_id')::uuid),
          'rolled_back', 'rollback: batch state');

-- "It is the same project": a duplicate merged by hand writes only the cells of the file ------------------
update public.projects set status = 'building' where id = tests.id('p_pemba_2');
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select set_config('t.b3', public.import_stage('{}'::jsonb,
  '[{"name_ar": "مدرسة مصححة", "type": "school", "lat": "-4.9501", "lon": "39.7001", "capacity": "77"}]'::jsonb)::text, true);
select is(public.import_set_action((current_setting('t.b3')::jsonb ->> 'batch_id')::uuid, 1, 'update') ->> 'target_id',
          tests.id('p_pemba_2')::text, 'set_action: a duplicate can be merged into the existing project');
select ok((public.import_commit((current_setting('t.b3')::jsonb ->> 'batch_id')::uuid) ->> 'committed')::boolean, 'merge: committed');
select tests.logout();
select is((select p.name_ar || '/' || p.capacity || '/' || p.status || '/' || p.record_state || '/' || (p.branch_id = tests.id('br_pemba'))
           from public.projects p where p.id = tests.id('p_pemba_2')),
          'مدرسة مصححة/77/building/draft/true', 'merge: only the given cells are written (no defaults, no state change)');

-- After a rollback the corrected file can be imported again
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(public.import_stage('{}'::jsonb,
            '[{"external_id": "T-IMP-1", "name_ar": "مسجد الاستيراد", "type": "mosque", "lat": "-5.01", "lon": "39.71"}]'::jsonb)
            -> 'counts' -> 'create', '1'::jsonb, 'after a rollback the same external_id can be imported again (country derived from the point)');
select tests.logout();

select * from finish();
rollback;
