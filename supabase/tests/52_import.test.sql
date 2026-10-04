-- Import: template, stage -> preview -> commit (drafts) -> merge by external_id -> rollback
-- (brief §10; contract docs/contracts/reports-import-export.md)
begin;
set local search_path = public, extensions, tests;

select plan(91);

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

-- Session gate (authz.md §3 rule 1): the owner-only RPCs use no scope helper, so they check the
-- session themselves. A revoked session, a deactivated account or a revoked device (lost phone,
-- brief §3) can neither read nor change its batches. ----------------------------------------------------
update public.projects set external_id = 'T-P2' where id = tests.id('p_pemba_2');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.b4', public.import_stage('{}'::jsonb,
  '[{"external_id": "T-IMP-4", "name_ar": "مسجد الجلسة", "type": "mosque", "lat": "-5.1500", "lon": "39.6500"}]'::jsonb) ->> 'batch_id', true);
select set_config('t.c4', public.import_commit(current_setting('t.b4')::uuid)::text, true);
select set_config('t.b5', public.import_stage('{}'::jsonb, '[{"external_id": "T-P2", "capacity": "555"}]'::jsonb) ->> 'batch_id', true);
select set_config('t.c5', public.import_commit(current_setting('t.b5')::uuid)::text, true);
select set_config('t.b6', public.import_stage('{}'::jsonb,
  '[{"external_id": "T-IMP-6", "name_ar": "مسجد معلق", "type": "mosque", "lat": "-5.1200", "lon": "39.6200"}]'::jsonb) ->> 'batch_id', true);
select tests.logout();
select ok((current_setting('t.c4')::jsonb ->> 'committed')::boolean and (current_setting('t.c5')::jsonb ->> 'committed')::boolean
          and (select b.state from public.import_batches b where b.id = current_setting('t.b6')::uuid) = 'validated'
          and (select p.capacity from public.projects p where p.id = tests.id('p_pemba_2')) = 555,
          'session gate: setup (one created draft, one update of an own draft, one validated batch)');

-- what admin_revoke_sessions does
update public.profiles set sessions_revoked_at = now() + interval '1 minute' where id = tests.id('u_col_pemba');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('select public.import_preview(%L)', current_setting('t.b4')), 'PT403', 'session_revoked',
                 'revoked session: import_preview refused');
select throws_ok(format('select public.import_set_action(%L, 1, %L)', current_setting('t.b6'), 'skip'), 'PT403', 'session_revoked',
                 'revoked session: import_set_action refused');
select throws_ok(format('select public.import_commit(%L)', current_setting('t.b6')), 'PT403', 'session_revoked',
                 'revoked session: import_commit refused');
select throws_ok(format('select public.import_rollback(%L)', current_setting('t.b4')), 'PT403', 'session_revoked',
                 'revoked session: import_rollback refused');
select throws_ok($$select public.import_template('en')$$, 'PT403', 'session_revoked', 'revoked session: import_template refused');
select throws_ok($$select public.import_stage('{}'::jsonb, '[{"name_ar": "x"}]'::jsonb)$$, 'PT403', 'session_revoked',
                 'revoked session: import_stage refused');
select tests.logout();
update public.profiles set sessions_revoked_at = null where id = tests.id('u_col_pemba');

update public.profiles set active = false where id = tests.id('u_col_pemba');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('select public.import_rollback(%L)', current_setting('t.b4')), 'PT403', 'session_revoked',
                 'deactivated account: import_rollback refused');
select tests.logout();
update public.profiles set active = true where id = tests.id('u_col_pemba');

update public.devices set revoked_at = now() where id = tests.id('device:u_col_pemba');
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-u_col_pemba');
select throws_ok(format('select public.import_rollback(%L)', current_setting('t.b4')), 'PT403', 'session_revoked',
                 'revoked device: import_rollback refused');
select tests.logout();
update public.devices set revoked_at = null where id = tests.id('device:u_col_pemba');

select ok((select p.deleted_at is null and p.external_id = 'T-IMP-4' from public.projects p
           where p.import_batch_id = current_setting('t.b4')::uuid)
          and (select b.state from public.import_batches b where b.id = current_setting('t.b4')::uuid) = 'committed'
          and (select b.state from public.import_batches b where b.id = current_setting('t.b6')::uuid) = 'validated'
          and (select r.action from public.import_rows r where r.batch_id = current_setting('t.b6')::uuid) = 'create',
          'session gate: the refused calls changed nothing');

-- Rollback re-checks the caller's rights NOW (private.import_can_update), not those it had at commit time.
-- The supervisor approves p_pemba_2 and moves the imported draft to the Tanga branch.
update public.projects set record_state = 'approved' where id = tests.id('p_pemba_2');
update public.projects set branch_id = tests.id('br_tanga') where import_batch_id = current_setting('t.b4')::uuid;

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.r5', public.import_rollback(current_setting('t.b5')::uuid)::text, true);
select set_config('t.r4', public.import_rollback(current_setting('t.b4')::uuid)::text, true);
select tests.logout();

select is(jsonb_build_object('reverted', current_setting('t.r5')::jsonb -> 'reverted', 'kept', current_setting('t.r5')::jsonb -> 'kept',
                             'no_access', current_setting('t.r5')::jsonb -> 'no_access'),
          '{"reverted": 0, "kept": 1, "no_access": 1}'::jsonb,
          'rollback by a collector: an update of a record approved since is kept (no_access)');
select is((select p.capacity || '/' || p.record_state || '/' || r.state
           from public.projects p join public.import_rows r on r.target_id = p.id
           where p.id = tests.id('p_pemba_2') and r.batch_id = current_setting('t.b5')::uuid),
          '555/approved/applied', 'rollback by a collector: the approved record is not touched');
select is(jsonb_build_object('reverted', current_setting('t.r4')::jsonb -> 'reverted', 'kept', current_setting('t.r4')::jsonb -> 'kept',
                             'no_access', current_setting('t.r4')::jsonb -> 'no_access'),
          '{"reverted": 0, "kept": 1, "no_access": 1}'::jsonb,
          'rollback by a collector: a draft moved outside its scope is kept (no_access)');
select ok((select p.deleted_at is null and p.external_id = 'T-IMP-4' and p.branch_id = tests.id('br_tanga')
           from public.projects p where p.import_batch_id = current_setting('t.b4')::uuid),
          'rollback by a collector: the moved draft is neither deleted nor stripped of its merge key');

-- hq_admin may still roll back another user's batch on the approved record (reviewer of every scope);
-- the capacity written later by batch 5 is somebody else's change and is kept (conflicting field).
select tests.login_as(tests.id('u_hq'));
select set_config('t.r3', public.import_rollback((current_setting('t.b3')::jsonb ->> 'batch_id')::uuid)::text, true);
select tests.logout();
select ok((current_setting('t.r3')::jsonb ->> 'reverted')::int = 1 and (current_setting('t.r3')::jsonb ->> 'no_access')::int = 0
          and (current_setting('t.r3')::jsonb ->> 'conflicting_fields')::int >= 1,
          'rollback by hq_admin: the merge into the approved record is reverted');
select is((select p.name_ar || '/' || p.capacity || '/' || p.record_state from public.projects p where p.id = tests.id('p_pemba_2')),
          (select (r.pre_image #>> '{projects,before,name_ar}') || '/555/approved' from public.import_rows r
           where r.batch_id = (current_setting('t.b3')::jsonb ->> 'batch_id')::uuid),
          'rollback by hq_admin: the name is restored, the later capacity change is kept, the record stays approved');

-- Look-ups stay inside the caller's read scope (brief §14.5): preview rows and errors never reveal a
-- record the caller could not read himself, and a commit never links a donor he cannot see. ----------

-- Donors: a Kenya collector naming a donor that is linked only to Tanzania projects neither learns its
-- id nor links it (linking would make it, and its notes, visible); a donor he can see is reused.
update public.donors set notes = 'TZ-ONLY NOTES' where id = tests.id('donor:p_pemba_1');
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select set_config('t.b7', public.import_stage('{}'::jsonb, jsonb_build_array(
    jsonb_build_object('name_ar', 'مسجد كيني', 'type', 'mosque', 'lat', '-4.10', 'lon', '39.70', 'country', 'KE',
                       'donor', 'Donor p_pemba_1', 'donor_year', '2021'),
    jsonb_build_object('name_ar', 'مدرسة كينية', 'type', 'school', 'lat', '-4.15', 'lon', '39.75', 'country', 'KE',
                       'donor', 'Donor p_ke_1', 'donor_year', '2021'))) ->> 'batch_id', true);
select set_config('t.pv7', public.import_preview(current_setting('t.b7')::uuid)::text, true);
select ok(current_setting('t.pv7')::jsonb #>> '{rows,0,state}' = 'valid'
          and current_setting('t.pv7')::jsonb #>> '{rows,0,parsed,donor,name}' = 'Donor p_pemba_1'
          and current_setting('t.pv7')::jsonb #> '{rows,0,parsed,donor,donor_id}' = 'null'::jsonb,
          'donor look-up: a donor linked only to Tanzania projects is not matched for a Kenya collector');
select is((current_setting('t.pv7')::jsonb #>> '{rows,1,parsed,donor,donor_id}')::uuid, tests.id('donor:p_ke_1'),
          'donor look-up: a donor the caller can see is reused');
select ok((public.import_commit(current_setting('t.b7')::uuid) ->> 'committed')::boolean, 'donor look-up: batch committed');
select is(tests.visible('donors', array[tests.id('donor:p_pemba_1')]), '{}'::uuid[],
          'donor link: the Tanzania donor is still invisible to the Kenya collector after the commit');
select tests.logout();
select is((select count(*)::int from public.project_donors pd join public.projects p on p.id = pd.project_id
           where p.import_batch_id = current_setting('t.b7')::uuid and pd.donor_id = tests.id('donor:p_pemba_1')), 0,
          'donor link: the foreign donor is not linked to the Kenya project');
select ok((select d.created_by = tests.id('u_col_ke') and d.name_latin = 'Donor p_pemba_1' and d.notes is null
           from public.project_donors pd join public.projects p on p.id = pd.project_id
           join public.donors d on d.id = pd.donor_id
           where p.import_batch_id = current_setting('t.b7')::uuid and p.type = 'mosque'),
          'donor link: a new donor of that name is created by the importer instead');
select is((select count(*)::int from public.project_donors pd join public.projects p on p.id = pd.project_id
           where p.import_batch_id = current_setting('t.b7')::uuid and pd.donor_id = tests.id('donor:p_ke_1')), 1,
          'donor link: the visible donor is linked');

-- The donor is re-checked at commit time: visible at preview (linked to a Tanga project), invisible
-- at commit (that project moved to Pemba) -> not linked, a new donor is created.
insert into public.donors (id, created_by, name_ar, name_latin)
values (tests._uuid('imp:donor_hq'), tests.id('u_hq'), 'متبرع المقر', 'HQ Donor');
insert into public.project_donors (id, created_by, project_id, donor_id, amount, currency, year)
values (tests._uuid('imp:pdonor_hq'), tests.id('u_hq'), tests.id('p_tanga_1'), tests._uuid('imp:donor_hq'), 100, 'USD', 2019);
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select set_config('t.b8', public.import_stage('{}'::jsonb, jsonb_build_array(
    jsonb_build_object('name_ar', 'مسجد تانغا', 'type', 'mosque', 'lat', '-5.30', 'lon', '39.00', 'country', 'TZ',
                       'donor', 'HQ Donor'))) ->> 'batch_id', true);
select is((public.import_preview(current_setting('t.b8')::uuid) #>> '{rows,0,parsed,donor,donor_id}')::uuid,
          tests._uuid('imp:donor_hq'), 'commit re-check: the donor of a project in scope is matched at preview');
select tests.logout();
update public.projects set branch_id = tests.id('br_pemba') where id = tests.id('p_tanga_1');
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select ok((public.import_commit(current_setting('t.b8')::uuid) ->> 'committed')::boolean, 'commit re-check: committed');
select tests.logout();
update public.projects set branch_id = tests.id('br_tanga') where id = tests.id('p_tanga_1');
select ok((select d.id <> tests._uuid('imp:donor_hq') and d.created_by = tests.id('u_col_tanga') and d.name_latin = 'HQ Donor'
           from public.project_donors pd join public.projects p on p.id = pd.project_id
           join public.donors d on d.id = pd.donor_id
           where p.import_batch_id = current_setting('t.b8')::uuid),
          'commit re-check: a donor that left the caller''s visibility since the preview is not linked (a new one is created)');

-- Localities: a row in a country whose localities the caller cannot read gets no locality answer at all
-- (neither the id of an existing one nor "locality_new" for an unknown name).
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select set_config('t.b9', public.import_stage('{}'::jsonb, jsonb_build_array(
    jsonb_build_object('name_ar', 'مسجد أ', 'type', 'mosque', 'lat', '-5.10', 'lon', '39.05', 'locality', 'Village tz_tanga'),
    jsonb_build_object('name_ar', 'مسجد ب', 'type', 'mosque', 'lat', '-5.12', 'lon', '39.07', 'locality', 'Kijiji Hakipo')))
  ->> 'batch_id', true);
select set_config('t.pv9', public.import_preview(current_setting('t.b9')::uuid)::text, true);
select tests.logout();
select ok(current_setting('t.pv9')::jsonb #> '{rows,0,errors}' @> '[{"code": "out_of_scope"}]'::jsonb
          and current_setting('t.pv9')::jsonb #> '{rows,1,errors}' @> '[{"code": "out_of_scope"}]'::jsonb
          and not (current_setting('t.pv9')::jsonb #> '{rows,0,parsed,project}' ? 'locality_id')
          and not (current_setting('t.pv9')::jsonb #> '{rows,0,parsed}' ? 'locality_new')
          and not (current_setting('t.pv9')::jsonb #> '{rows,1,parsed}' ? 'locality_new')
          and not jsonb_path_exists(current_setting('t.pv9')::jsonb, '$.rows[*].warnings[*] ? (@.code == "locality_new")'),
          'locality look-up: rows in another country neither resolve nor propose a locality');

-- external_id held by a record outside the caller's read scope: one neutral answer whether that record
-- is live or deleted (the key itself is globally unique); a deleted record in scope still says so.
update public.projects set external_id = 'T-TZ-LIVE' where id = tests.id('p_tanga_1');
insert into public.projects
  (id, created_by, name_ar, type, status, geom, location_source, country_id, branch_id, record_state, external_id, deleted_at)
values
  (tests._uuid('imp:deleted_tz'), tests.id('u_col_tanga'), 'مشروع محذوف', 'mosque', 'active',
   st_setsrid(st_makepoint(39.20, -5.20), 4326), 'gps', tests.id('tz'), tests.id('br_tanga'), 'draft', 'T-TZ-DELETED', now()),
  (tests._uuid('imp:deleted_ke'), tests.id('u_col_ke'), 'مشروع محذوف كيني', 'mosque', 'active',
   st_setsrid(st_makepoint(39.55, -3.95), 4326), 'gps', tests.id('ke'), tests.id('br_mombasa'), 'draft', 'T-KE-DELETED', now());
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select set_config('t.b10', public.import_stage('{}'::jsonb, jsonb_build_array(
    jsonb_build_object('external_id', 'T-TZ-LIVE', 'name_ar', 'مسجد ج', 'type', 'mosque', 'lat', '-4.12', 'lon', '39.62'),
    jsonb_build_object('external_id', 'T-TZ-DELETED', 'name_ar', 'مسجد د', 'type', 'mosque', 'lat', '-4.14', 'lon', '39.64'),
    jsonb_build_object('external_id', 'T-TZ-FREE', 'name_ar', 'مسجد ه', 'type', 'mosque', 'lat', '-4.16', 'lon', '39.66'),
    jsonb_build_object('external_id', 'T-KE-DELETED', 'name_ar', 'مسجد و', 'type', 'mosque', 'lat', '-4.18', 'lon', '39.68')))
  ->> 'batch_id', true);
select set_config('t.pv10', public.import_preview(current_setting('t.b10')::uuid)::text, true);
select tests.logout();
select ok(current_setting('t.pv10')::jsonb #> '{rows,0,errors}' = current_setting('t.pv10')::jsonb #> '{rows,1,errors}'
          and current_setting('t.pv10')::jsonb #> '{rows,0,errors}' @> '[{"field": "external_id", "code": "no_write_access"}]'::jsonb
          and current_setting('t.pv10')::jsonb #>> '{rows,2,state}' = 'valid',
          'external_id: a key held by a live or a deleted record of another country gets the same answer');
select ok(current_setting('t.pv10')::jsonb #> '{rows,3,errors}' @> '[{"field": "external_id", "code": "external_id_deleted"}]'::jsonb,
          'external_id: a key held by a deleted record inside the caller''s scope is reported as deleted');

select * from finish();
rollback;
