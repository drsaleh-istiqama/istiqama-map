-- Reports: materialized views, refresh_reports, dashboard, report_project / donor / country
-- (brief §5, §9; contract docs/contracts/reports-import-export.md)
begin;
set local search_path = public, extensions, tests;

select plan(71);

select tests.fixture_extra();

-- Extra rows on top of the fixture -------------------------------------------------------------
-- A teacher in Pemba paid in USD (mixed currencies inside one branch) ...
insert into public.persons (id, name_ar, name_latin, country_id, branch_id)
values (tests._uuid('rep:person_usd'), 'معلم الدولار', 'Usd Teacher', tests.id('tz'), tests.id('br_pemba'));
insert into public.project_staff (id, project_id, person_id, role, start_date)
values (tests._uuid('rep:staff_usd'), tests.id('p_pemba_1'), tests._uuid('rep:person_usd'), 'teacher', date '2023-01-01');
-- ... with a superseded amount that must not be counted,
insert into public.staff_compensation (id, project_staff_id, monthly_amount, currency, effective_from)
values (tests._uuid('rep:comp_usd_old'), tests._uuid('rep:staff_usd'), 80, 'USD', date '2023-01-01'),
       (tests._uuid('rep:comp_usd'), tests._uuid('rep:staff_usd'), 100, 'USD', date '2024-01-01');
-- a former staff member (assignment ended) who must not be counted either,
insert into public.persons (id, name_ar, name_latin, country_id, branch_id)
values (tests._uuid('rep:person_gone'), 'موظف سابق', 'Former Staff', tests.id('tz'), tests.id('br_pemba'));
insert into public.project_staff (id, project_id, person_id, role, start_date, end_date)
values (tests._uuid('rep:staff_gone'), tests.id('p_pemba_1'), tests._uuid('rep:person_gone'), 'agent',
        date '2020-01-01', date '2021-01-01');
insert into public.staff_compensation (id, project_staff_id, monthly_amount, currency, effective_from)
values (tests._uuid('rep:comp_gone'), tests._uuid('rep:staff_gone'), 999999, 'TZS', date '2020-01-01');
-- today's TZS rate,
insert into public.fx_rates (currency, usd_per_unit, effective_date)
values ('TZS', 0.0004, current_date)
on conflict (currency, effective_date) do update set usd_per_unit = excluded.usd_per_unit;
-- and an imam-housing gap.
update public.project_facilities set imam_housing = false where id = tests.id('fac:p_pemba_2');

-- refresh_reports ----------------------------------------------------------------------------------
select lives_ok('select public.refresh_reports()', 'refresh_reports() runs for cron / owner sessions');
select ok((select m.refreshed_at is not null from private.report_meta m), 'refresh time is recorded');

select tests.login_as(tests.id('u_hq'));
select throws_ok('select public.refresh_reports()', '42501', null, 'authenticated users cannot refresh the reports');
select tests.logout();

select tests.login_anon();
select throws_ok($$select public.dashboard('global', null)$$, '42501', null, 'anon cannot call dashboard()');
select tests.logout();

-- Country manager, branch scope: numbers equal the fixture ---------------------------------------
select tests.login_as(tests.id('u_mgr_tz'));
select set_config('t.d', public.dashboard('branch', tests.id('br_pemba'))::text, true);

select is((current_setting('t.d')::jsonb #>> '{scope,type}'), 'branch', 'branch dashboard: scope header');
select is((current_setting('t.d')::jsonb #>> '{totals,projects}')::int, 2, 'branch dashboard: 2 projects');
select is((current_setting('t.d')::jsonb #>> '{totals,capacity}')::int, 200, 'branch dashboard: capacity 200');
select is(current_setting('t.d')::jsonb #> '{totals,by_type}',
          '{"mosque": 1, "school": 1, "combined": 0}'::jsonb, 'branch dashboard: totals by type');
select is(current_setting('t.d')::jsonb #> '{totals,by_status}',
          '{"active": 2, "maintenance": 0, "building": 0, "inactive": 0}'::jsonb, 'branch dashboard: totals by status');
select is(current_setting('t.d')::jsonb #> '{totals,by_record_state}',
          '{"draft": 1, "submitted": 0, "approved": 1, "returned": 0}'::jsonb, 'branch dashboard: totals by record state');
select is(jsonb_array_length(current_setting('t.d')::jsonb #> '{totals,by_area}'), 1, 'branch dashboard: one level-1 area');
select is((current_setting('t.d')::jsonb #>> '{totals,by_area,0,area_id}')::uuid, tests.id('tz_pemba_north'),
          'branch dashboard: projects are attributed to their level-1 area');
select is((current_setting('t.d')::jsonb #>> '{maintenance,open_total}')::int, 2, 'branch dashboard: 2 open maintenance entries');
select is((current_setting('t.d')::jsonb #>> '{maintenance,by_priority,high}')::int, 2, 'branch dashboard: both are high priority');
select is(jsonb_array_length(current_setting('t.d')::jsonb #> '{maintenance,items}'), 2, 'branch dashboard: open maintenance list');
select is((current_setting('t.d')::jsonb #>> '{maintenance,estimated_cost,0,amount}')::numeric, 3000::numeric,
          'branch dashboard: estimated maintenance cost per currency');
select is((current_setting('t.d')::jsonb #>> '{staff,assignments}')::int, 3, 'branch dashboard: 3 current staff (ended assignment excluded)');
select is((current_setting('t.d')::jsonb #>> '{staff,by_role,imam}')::int, 2, 'branch dashboard: 2 imams');
select is((current_setting('t.d')::jsonb #>> '{staff,by_role,teacher}')::int, 1, 'branch dashboard: 1 teacher');
select is((current_setting('t.d')::jsonb #>> '{needs,quran_need}')::int, 120, 'branch dashboard: Quran copies needed');
select is((current_setting('t.d')::jsonb #>> '{needs,transport_needed}')::int, 2, 'branch dashboard: transport needed');
select is((current_setting('t.d')::jsonb #>> '{needs,expandable_sites}')::int, 2, 'branch dashboard: expandable sites');
select is((current_setting('t.d')::jsonb #>> '{needs,imam_housing_gaps}')::int, 1, 'branch dashboard: imam housing gap');
select is((current_setting('t.d')::jsonb #>> '{needs,teacher_housing_gaps}')::int, 0, 'branch dashboard: no teacher housing gap');
select is((current_setting('t.d')::jsonb #>> '{completeness,projects}')::int, 2, 'branch dashboard: completeness covers both projects');
select ok((current_setting('t.d')::jsonb #>> '{last_refreshed_at}') is not null, 'branch dashboard: last_refreshed_at present');
select is(jsonb_array_length(current_setting('t.d')::jsonb #> '{entry_activity,weeks}'), 12, 'entry activity: 12 weeks');
select is((current_setting('t.d')::jsonb #>> '{entry_activity,totals,11,created}')::int, 2, 'entry activity: 2 projects created this week');
select is((current_setting('t.d')::jsonb #>> '{entry_activity,collectors,0,user_id}')::uuid, tests.id('u_col_pemba'),
          'entry activity: per-collector breakdown for non-viewers');

-- Payroll: currencies are never added together; a USD total is given next to them
select is(jsonb_array_length(current_setting('t.d')::jsonb #> '{payroll,by_currency}'), 2, 'payroll: TZS and USD are reported separately');
select is((jsonb_path_query_first(current_setting('t.d')::jsonb, '$.payroll.by_currency[*] ? (@.currency == "TZS")') ->> 'monthly_total')::numeric,
          500000::numeric, 'payroll: TZS monthly total in local currency');
select is((jsonb_path_query_first(current_setting('t.d')::jsonb, '$.payroll.by_currency[*] ? (@.currency == "TZS")') ->> 'monthly_total_usd')::numeric,
          200::numeric, 'payroll: TZS total converted with the latest rate');
select is((jsonb_path_query_first(current_setting('t.d')::jsonb, '$.payroll.by_currency[*] ? (@.currency == "USD")') ->> 'monthly_total')::numeric,
          100::numeric, 'payroll: USD monthly total uses the latest amount only');
select is((current_setting('t.d')::jsonb #>> '{payroll,monthly_total_usd}')::numeric, 300::numeric, 'payroll: USD grand total');
select is(current_setting('t.d')::jsonb #> '{payroll,missing_rates}', '[]'::jsonb, 'payroll: no missing rates');

-- Country scope agrees with the tables (robust against seed data in the same country)
select set_config('t.c', public.dashboard('country', tests.id('tz'))::text, true);
select tests.logout();
select is((current_setting('t.c')::jsonb #>> '{totals,projects}')::bigint,
          (select count(*) from public.projects p where p.country_id = tests.id('tz') and p.deleted_at is null),
          'country dashboard: project total equals the table');
select is((current_setting('t.c')::jsonb #>> '{totals,capacity}')::bigint,
          (select coalesce(sum(p.capacity), 0) from public.projects p where p.country_id = tests.id('tz') and p.deleted_at is null),
          'country dashboard: capacity equals the table');
select ok(current_setting('t.c')::jsonb #> '{totals,by_branch}' @> jsonb_build_array(jsonb_build_object('branch_id', tests.id('br_pemba'), 'projects', 2)),
          'country dashboard: per-branch distribution');
select ok((select count(*) from public.restricted_access_log l
           where l.user_id = tests.id('u_mgr_tz') and l.table_name = 'staff_compensation'
             and l.context like 'dashboard.payroll:%') = 2,
          'payroll reads are written to restricted_access_log');

-- Who gets what --------------------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.x', public.dashboard('branch', tests.id('br_pemba'))::text, true);
select ok(not (current_setting('t.x')::jsonb ? 'payroll'), 'field collector: no payroll section');
select is((current_setting('t.x')::jsonb #>> '{totals,projects}')::int, 2, 'field collector: sees the dashboard of the own branch');
select throws_ok(format('select public.dashboard(%L, %L)', 'country', tests.id('tz')), 'PT403', null, 'field collector: no country dashboard');
select throws_ok(format('select public.dashboard(%L, %L)', 'branch', tests.id('br_tanga')), 'PT403', null, 'field collector: no dashboard of another branch');
select throws_ok($$select public.dashboard('global', null)$$, 'PT403', null, 'field collector: no global dashboard');
select throws_ok($$select public.dashboard('planet', null)$$, 'PT422', null, 'unknown scope type is rejected');
select tests.logout();

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select ok(not (public.dashboard('branch', tests.id('br_pemba')) ? 'payroll'), 'branch supervisor: no payroll section');
select tests.logout();

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select set_config('t.x', public.dashboard('country', tests.id('tz'))::text, true);
select ok(not (current_setting('t.x')::jsonb ? 'payroll'), 'viewer: no payroll section');
select ok(not (current_setting('t.x')::jsonb -> 'entry_activity' ? 'collectors'), 'viewer: no collector names');
select ok((current_setting('t.x')::jsonb #>> '{totals,projects}')::int >= 3, 'viewer: gets the totals');
select throws_ok(format('select public.dashboard(%L, %L)', 'country', tests.id('ke')), 'PT403', null, 'viewer: no dashboard of another country');
select tests.logout();

select tests.login_as(tests.id('u_mgr_ke'));
select throws_ok(format('select public.dashboard(%L, %L)', 'country', tests.id('tz')), 'PT403', null, 'Kenya manager: no Tanzania dashboard');
select tests.logout();

select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select throws_ok(format('select public.dashboard(%L, %L)', 'country', tests.id('tz')), 'PT403', null, 'manager without MFA (aal1) has no access');
select tests.logout();

select tests.login_as(tests.id('u_hq'));
select set_config('t.x', public.dashboard('global', null)::text, true);
select tests.logout();
select is((current_setting('t.x')::jsonb #>> '{totals,projects}')::bigint,
          (select count(*) from public.projects p where p.deleted_at is null), 'global dashboard: project total equals the table');
select is((select count(*) from jsonb_array_elements(current_setting('t.x')::jsonb #> '{payroll,by_currency}') e),
          (select count(distinct e.value ->> 'currency') from jsonb_array_elements(current_setting('t.x')::jsonb #> '{payroll,by_currency}') e),
          'global dashboard: one payroll line per currency');
select ok((select count(*) from jsonb_array_elements(current_setting('t.x')::jsonb #> '{payroll,by_currency}') e) >= 3,
          'global dashboard: TZS, KES and USD are all listed');

-- report_project ---------------------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.p', public.report_project(tests.id('p_pemba_1'))::text, true);
select is((current_setting('t.p')::jsonb #>> '{project,id}')::uuid, tests.id('p_pemba_1'), 'report_project: project card');
select ok((current_setting('t.p')::jsonb #>> '{photos,0,storage_path_thumb}') like 'projects/TZ/%_thumb.webp', 'report_project: photo thumbnail paths');
select is(jsonb_array_length(current_setting('t.p')::jsonb -> 'maintenance'), 1, 'report_project: maintenance history');
select ok(jsonb_array_length(current_setting('t.p')::jsonb -> 'staff') = 3
          and not (current_setting('t.p')::jsonb #> '{staff,0}' ? 'monthly_amount')
          and not (current_setting('t.p')::jsonb ? 'sensitive'),
          'report_project: collector sees staff but neither salaries nor sensitive data');
select tests.logout();

select tests.login_as(tests.id('u_mgr_tz'));
select set_config('t.p', public.report_project(tests.id('p_pemba_1'))::text, true);
select ok((select bool_or(e.value ? 'monthly_amount') from jsonb_array_elements(current_setting('t.p')::jsonb -> 'staff') e)
          and (current_setting('t.p')::jsonb #>> '{sensitive,ibadi_families}')::int = 12,
          'report_project: manager sees salaries and sensitive data');
select tests.logout();
select ok((select count(*) from public.restricted_access_log l
           where l.user_id = tests.id('u_mgr_tz') and l.context = 'report_project:' || tests.id('p_pemba_1')::text) = 2,
          'report_project: restricted reads are logged (compensation + sensitive)');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select set_config('t.p', public.report_project(tests.id('p_pemba_1'))::text, true);
select ok(not (current_setting('t.p')::jsonb ? 'staff') and (current_setting('t.p')::jsonb ->> 'staff_count')::int = 2,
          'report_project: viewer gets a staff count but no names');
select tests.logout();

select tests.login_as(tests.id('u_col_ke'), 'aal1');
select throws_ok(format('select public.report_project(%L)', tests.id('p_pemba_1')), 'PT404', null,
                 'report_project: a Kenya collector cannot read a Tanzania project');

-- report_donor: only projects inside the caller's scope
select is((public.report_donor(tests.id('donor:p_pemba_1')) ->> 'projects_total')::int, 0,
          'report_donor: projects outside the caller''s scope are not listed');
select tests.logout();

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select set_config('t.p', public.report_donor(tests.id('donor:p_pemba_1'))::text, true);
select ok((current_setting('t.p')::jsonb #>> '{projects,0,id}')::uuid = tests.id('p_pemba_1')
          and jsonb_array_length(current_setting('t.p')::jsonb #> '{projects,0,photos}') = 1
          and (current_setting('t.p')::jsonb #>> '{projects,0,status}') = 'active',
          'report_donor: donor with its projects, photos and status');
select tests.logout();

-- report_country
select tests.login_as(tests.id('u_mgr_tz'));
select set_config('t.p', public.report_country(tests.id('tz'))::text, true);
select ok(current_setting('t.p')::jsonb -> 'branches' @> jsonb_build_array(jsonb_build_object(
            'branch_id', tests.id('br_pemba'), 'projects', 2, 'open_maintenance', 2, 'staff', 3))
          and current_setting('t.p')::jsonb ? 'payroll'
          and current_setting('t.p')::jsonb ? 'totals',
          'report_country: dashboard sections plus the per-branch table (with payroll for the manager)');
select tests.logout();

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('select public.report_country(%L)', tests.id('tz')), 'PT403', null,
                 'report_country: a branch user cannot read the country report');
select tests.logout();

-- Session gate: every report RPC refuses a revoked session with the sync error (the client signs out)
update public.profiles set sessions_revoked_at = now() + interval '1 minute' where id = tests.id('u_mgr_tz');
select tests.login_as(tests.id('u_mgr_tz'));
select throws_ok(format('select public.dashboard(%L, %L)', 'branch', tests.id('br_pemba')), 'PT403', 'session_revoked',
                 'revoked session: dashboard refused');
select throws_ok(format('select public.report_project(%L)', tests.id('p_pemba_1')), 'PT403', 'session_revoked',
                 'revoked session: report_project refused');
select throws_ok(format('select public.report_donor(%L)', tests.id('donor:p_pemba_1')), 'PT403', 'session_revoked',
                 'revoked session: report_donor refused');
select throws_ok(format('select public.report_country(%L)', tests.id('tz')), 'PT403', 'session_revoked',
                 'revoked session: report_country refused');
select tests.logout();
update public.profiles set sessions_revoked_at = null where id = tests.id('u_mgr_tz');

select * from finish();
rollback;
