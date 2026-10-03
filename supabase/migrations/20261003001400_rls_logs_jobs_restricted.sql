-- =============================================================================
-- 0014  RLS: logs, job tables and restricted tables (brief §3, §11)
--
--   audit_log, restricted_access_log
--       SELECT hq_admin only (audit rows of restricted tables: nobody);
--       append-only for everybody
--   sync_applied_ops
--       no API access at all (idempotency ledger of sync_push)
--   export_jobs, import_batches, import_rows
--       SELECT own rows; written through RPC only
--   staff_compensation, community_sensitive  (RESTRICTED)
--       no privilege and no policy for any API role. They are read only through
--       logged SECURITY DEFINER functions (restricted_read, the restricted
--       section of sync_pull, payroll reports) and written through sync_push.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Logs
-- -----------------------------------------------------------------------------
-- The audit rows of the restricted tables carry full row images (salaries,
-- sensitive community figures). They are excluded from direct reads even for
-- hq_admin, otherwise the audit log would be an unlogged side door to
-- restricted data; expose them only through a SECURITY DEFINER function that
-- calls private.log_restricted().
drop policy if exists audit_log_select_hq on public.audit_log;
create policy audit_log_select_hq on public.audit_log
  for select to authenticated
  using (
    (select private.is_hq())
    and table_name not in ('staff_compensation', 'community_sensitive')
  );

drop policy if exists restricted_access_log_select_hq on public.restricted_access_log;
create policy restricted_access_log_select_hq on public.restricted_access_log
  for select to authenticated
  using ((select private.is_hq()));

-- Append-only is enforced twice: no API role holds UPDATE/DELETE/TRUNCATE on
-- these tables (0011), and the t01_append_only triggers of migration 0006
-- refuse those statements for every role, including the table owner.

-- -----------------------------------------------------------------------------
-- Own jobs
-- -----------------------------------------------------------------------------
drop policy if exists export_jobs_select_own on public.export_jobs;
create policy export_jobs_select_own on public.export_jobs
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_ok()));

drop policy if exists import_batches_select_own on public.import_batches;
create policy import_batches_select_own on public.import_batches
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_ok()));

drop policy if exists import_rows_select_own on public.import_rows;
create policy import_rows_select_own on public.import_rows
  for select to authenticated
  using (
    (select private.session_ok())
    and exists (
      select 1
      from public.import_batches b
      where b.id = import_rows.batch_id
        and b.user_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- Restricted tables (staff_compensation, community_sensitive) and the sync
-- ledger (sync_applied_ops): deliberately NO policy and NO privilege (0011).
-- With RLS forced and no policy, even an accidental GRANT exposes no rows.
-- -----------------------------------------------------------------------------
