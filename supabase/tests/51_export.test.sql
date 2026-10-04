-- Export: export_columns, export_request, export_rows, export_finish
-- (brief §9; contract docs/contracts/reports-import-export.md)
begin;
set local search_path = public, extensions, tests;

select plan(50);

select tests.fixture_extra();

insert into public.fx_rates (currency, usd_per_unit, effective_date)
values ('TZS', 0.0004, current_date)
on conflict (currency, effective_date) do update set usd_per_unit = excluded.usd_per_unit;

-- Privileges ---------------------------------------------------------------------------------------
select tests.login_anon();
select throws_ok($$select public.export_columns('ar')$$, '42501', null, 'anon cannot call export_columns()');
select throws_ok($$select public.export_request('csv', 'ar', '{}'::jsonb)$$, '42501', null, 'anon cannot request an export');
select tests.logout();

-- Localised headers and values ---------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'));
select is(jsonb_path_query_first(public.export_columns('ar'), '$.columns[*] ? (@.key == "type")') ->> 'header', 'النوع', 'ar: header of "type"');
select is(public.export_columns('ar') #>> '{enums,project_type,mosque}', 'مسجد', 'ar: mosque');
select is(public.export_columns('ar') #>> '{enums,project_status,active}', 'يعمل', 'ar: active');
select is(public.export_columns('sw') #>> '{enums,project_type,mosque}', 'Msikiti', 'sw: mosque');
select is(jsonb_path_query_first(public.export_columns('sw'), '$.columns[*] ? (@.key == "status")') ->> 'header', 'Hali', 'sw: header of "status"');
select is(public.export_columns('en') #>> '{enums,project_type,mosque}', 'Mosque', 'en: mosque');
select is(public.export_columns('en') #>> '{enums,boolean,true}', 'Yes', 'en: boolean label');
select is(public.export_columns('ar') ->> 'dir', 'rtl', 'ar: right-to-left');
select throws_ok($$select public.export_columns('fr')$$, 'PT422', null, 'unsupported language is rejected');
select ok(jsonb_path_exists(public.export_columns('ar'), '$.columns[*] ? (@.key == "monthly_payroll")')
          and jsonb_path_exists(public.export_columns('ar'), '$.columns[*] ? (@.key == "staff_list")'),
          'manager: salary and staff columns are offered');

-- Manager export: restricted columns present and logged ---------------------------------------------
select throws_ok($$select public.export_request('pdf', 'ar', '{}'::jsonb)$$, 'PT422', null, 'unsupported format is rejected');
select set_config('t.job_mgr', public.export_request('xlsx', 'ar', '{}'::jsonb) ->> 'id', true);
select is((select j.state from public.export_jobs j where j.id = current_setting('t.job_mgr')::uuid), 'queued', 'export_request creates a queued job');
select set_config('t.rows', public.export_rows(current_setting('t.job_mgr')::uuid, null, 1000)::text, true);
select ok((current_setting('t.rows')::jsonb ->> 'done')::boolean, 'manager export: one page is enough');
select is(jsonb_path_query_first(current_setting('t.rows')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))) ->> 'monthly_payroll',
          'TZS 250000', 'manager export: monthly payroll in the local currency');
select is((jsonb_path_query_first(current_setting('t.rows')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))) ->> 'monthly_payroll_usd')::numeric,
          100::numeric, 'manager export: monthly payroll in USD');
select is((jsonb_path_query_first(current_setting('t.rows')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))) ->> 'ibadi_families')::int,
          12, 'manager export: sensitive community columns');
select is(jsonb_path_query_first(current_setting('t.rows')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))) ->> 'country',
          'تنزانيا', 'manager export: names are resolved in the job language');
select ok(not jsonb_path_exists(current_setting('t.rows')::jsonb, '$.rows[*] ? (@.country_iso2 == "KE")'),
          'Tanzania manager export: no Kenya rows');
select is((select j.state from public.export_jobs j where j.id = current_setting('t.job_mgr')::uuid), 'running', 'export_rows marks the job as running');

-- Filters and keyset paging
select set_config('t.job_f', public.export_request('csv', 'en', '{"type": "school"}'::jsonb) ->> 'id', true);
select set_config('t.rows_f', public.export_rows(current_setting('t.job_f')::uuid, null, 1000)::text, true);
select ok(jsonb_path_exists(current_setting('t.rows_f')::jsonb, '$.rows[*] ? (@.id == $id)', jsonb_build_object('id', tests.id('p_pemba_2')))
          and not jsonb_path_exists(current_setting('t.rows_f')::jsonb, '$.rows[*] ? (@.type != "school")'),
          'filters of the job are applied (type = school)');
select set_config('t.page1', public.export_rows(current_setting('t.job_mgr')::uuid, null, 1)::text, true);
select ok(not (current_setting('t.page1')::jsonb ->> 'done')::boolean and current_setting('t.page1')::jsonb -> 'next' ? 'id',
          'keyset paging: first page of one row returns a cursor');
select set_config('t.page2', public.export_rows(current_setting('t.job_mgr')::uuid, current_setting('t.page1')::jsonb -> 'next', 1)::text, true);
select ok((current_setting('t.page2')::jsonb #>> '{rows,0,id}') > (current_setting('t.page1')::jsonb #>> '{rows,0,id}'),
          'keyset paging: the second page continues after the cursor');
select tests.logout();

select ok((select count(*) from public.restricted_access_log l
           where l.user_id = tests.id('u_mgr_tz') and l.context = 'export:' || current_setting('t.job_mgr')
             and l.table_name = 'staff_compensation') >= 1
          and (select count(*) from public.restricted_access_log l
           where l.user_id = tests.id('u_mgr_tz') and l.context = 'export:' || current_setting('t.job_mgr')
             and l.table_name = 'community_sensitive') >= 1,
          'restricted columns in an export are written to restricted_access_log');

-- Kenya collector: scope + no salary columns ---------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select ok(not jsonb_path_exists(public.export_columns('sw'), '$.columns[*] ? (@.key == "monthly_payroll" || @.key == "ibadi_families")')
          and jsonb_path_exists(public.export_columns('sw'), '$.columns[*] ? (@.key == "staff_list")'),
          'collector: staff columns offered, salary / sensitive columns not offered');
select set_config('t.job_ke', public.export_request('csv', 'sw', '{}'::jsonb) ->> 'id', true);
select set_config('t.rows_ke', public.export_rows(current_setting('t.job_ke')::uuid, null, 1000)::text, true);
select ok(jsonb_path_exists(current_setting('t.rows_ke')::jsonb, '$.rows[*] ? (@.id == $id)', jsonb_build_object('id', tests.id('p_ke_1'))),
          'Kenya collector export: own project present');
select ok(not jsonb_path_exists(current_setting('t.rows_ke')::jsonb, '$.rows[*] ? (@.country_iso2 == "TZ")'),
          'Kenya collector export: no Tanzania rows');
select ok(not (current_setting('t.rows_ke')::jsonb #> '{rows,0}' ? 'monthly_payroll')
          and not (current_setting('t.rows_ke')::jsonb #> '{rows,0}' ? 'monthly_payroll_usd')
          and not (current_setting('t.rows_ke')::jsonb #> '{rows,0}' ? 'ibadi_families'),
          'Kenya collector export: salary and sensitive columns are omitted, not null-filled');
select is(jsonb_path_query_first(current_setting('t.rows_ke')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_ke_1'))) ->> 'staff_list',
          'Imam p_ke_1 (Imamu)', 'Kenya collector export: staff list with the role in Swahili');
select is(jsonb_path_query_first(current_setting('t.rows_ke')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_ke_1'))) ->> 'maintenance_open_details',
          '[Juu] Roof repair (p_ke_1)', 'Kenya collector export: maintenance summary with the priority in Swahili');
select throws_ok(format('select public.export_rows(%L, null, 10)', current_setting('t.job_mgr')), 'PT404', null,
                 'a job of another user cannot be read');
select throws_ok(format('select public.export_finish(%L, %L, %L, 1, null)', current_setting('t.job_ke'), 'done', tests.id('u_col_ke')::text || '/x.csv'),
                 '42501', null, 'users cannot finish export jobs themselves');
select tests.logout();

-- Viewer: no people columns ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select ok(not jsonb_path_exists(public.export_columns('en'), '$.columns[*] ? (@.key == "staff_list" || @.key == "manager_phone" || @.key == "monthly_payroll")'),
          'viewer: neither staff nor salary columns are offered');
select set_config('t.job_v', public.export_request('csv', 'en', '{}'::jsonb) ->> 'id', true);
select set_config('t.rows_v', public.export_rows(current_setting('t.job_v')::uuid, null, 1000)::text, true);
select ok((current_setting('t.rows_v')::jsonb ->> 'count')::int >= 3
          and not (current_setting('t.rows_v')::jsonb #> '{rows,0}' ? 'staff_list')
          and not (current_setting('t.rows_v')::jsonb #> '{rows,0}' ? 'entered_by')
          and not (current_setting('t.rows_v')::jsonb #> '{rows,0}' ? 'monthly_payroll')
          and (current_setting('t.rows_v')::jsonb #> '{rows,0}' ? 'staff_count'),
          'viewer export: rows without staff names, collectors or salaries');
select is(jsonb_path_query_first(current_setting('t.rows_v')::jsonb, '$.rows[*] ? (@.id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))) ->> 'donors',
          'Donor p_pemba_1 (2015, 5000 USD)', 'viewer export: donors are included');
select tests.logout();

-- export_finish (service role / Edge Function) -------------------------------------------------------
select throws_ok(format('select public.export_finish(%L, %L, %L, 1, null)', current_setting('t.job_ke'), 'done', 'someone-else/x.csv'),
                 'PT422', null, 'export_finish: the file must be inside the owner''s folder');
select lives_ok(format('select public.export_finish(%L, %L, %L, 1, null, %L, 1234)', current_setting('t.job_ke'), 'done',
                       tests.id('u_col_ke')::text || '/export.csv', 'export.csv'),
                'export_finish: done');
select is((select j.state || '/' || j.row_count || '/' || j.bytes || '/' || (j.expires_at > now())
           from public.export_jobs j where j.id = current_setting('t.job_ke')::uuid),
          'done/1/1234/true', 'export_finish: job row is completed');
select is((select n.payload ->> 'storage_path' from public.notifications n
           where n.user_id = tests.id('u_col_ke') and n.kind = 'export.ready'
             and n.payload ->> 'job_id' = current_setting('t.job_ke')),
          tests.id('u_col_ke')::text || '/export.csv', 'export_finish: the owner is notified with the download path');
select throws_ok(format('select public.export_finish(%L, %L, null, null, %L)', current_setting('t.job_ke'), 'failed', 'x'),
                 'PT409', null, 'export_finish: a finished job cannot be finished again');
select lives_ok(format('select public.export_finish(%L, %L, null, null, %L)', current_setting('t.job_v'), 'failed', 'disk full'),
                'export_finish: failed');
select is((select n.payload ->> 'error' from public.notifications n
           where n.user_id = tests.id('u_viewer_tz') and n.kind = 'export.failed'),
          'disk full', 'export_finish: failure is notified too');

select tests.login_as(tests.id('u_col_ke'), 'aal1');
select throws_ok(format('select public.export_rows(%L, null, 10)', current_setting('t.job_ke')), 'PT409', null,
                 'export_rows: a finished job yields no more rows');
select tests.logout();

-- Session gate (authz.md §3 rule 1): a revoked session can neither page through nor cancel its own job.
-- export_rows must fail (PT403) rather than return an empty "done" page that would finish the job
-- as an empty file.
update public.profiles set sessions_revoked_at = now() + interval '1 minute' where id = tests.id('u_mgr_tz');
select tests.login_as(tests.id('u_mgr_tz'));
select throws_ok(format('select public.export_rows(%L, null, 10)', current_setting('t.job_f')), 'PT403', 'session_revoked',
                 'revoked session: export_rows fails');
select throws_ok(format('select public.export_cancel(%L)', current_setting('t.job_f')), 'PT403', 'session_revoked',
                 'revoked session: export_cancel refused');
select throws_ok($$select public.export_columns('en')$$, 'PT403', 'session_revoked', 'revoked session: export_columns refused');
select throws_ok($$select public.export_request('csv', 'en', '{}'::jsonb)$$, 'PT403', 'session_revoked',
                 'revoked session: export_request refused');
select tests.logout();
update public.profiles set sessions_revoked_at = null where id = tests.id('u_mgr_tz');
select is((select j.state from public.export_jobs j where j.id = current_setting('t.job_f')::uuid), 'running',
          'revoked session: the job is untouched');

select tests.login_as(tests.id('u_mgr_tz'));
select is(public.export_cancel(current_setting('t.job_f')::uuid) ->> 'state', 'cancelled', 'export_cancel: the owner can cancel a running job');
select tests.logout();

select * from finish();
rollback;
