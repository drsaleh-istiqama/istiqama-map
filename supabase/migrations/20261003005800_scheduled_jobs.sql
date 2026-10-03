-- Scheduled jobs (brief §5: reports refreshed every 15 minutes).
--
-- Production / hosted Supabase: pg_cron runs the jobs inside the database.
-- Local stack and any PostgreSQL without pg_cron: the gateway timer calls
-- refresh_reports() with the service-role key instead (docs/ARCHITECTURE.md Appendix A.6),
-- so this migration must succeed silently when pg_cron is absent or cannot be created.
--
-- The photo purge (90-day retention) needs object storage and therefore runs in the
-- `purge-photos` Edge Function, triggered by the platform scheduler (not from here).

do $jobs$
declare
  v_has_cron boolean;
begin
  select exists (select 1 from pg_available_extensions where name = 'pg_cron') into v_has_cron;
  if not v_has_cron then
    raise notice 'pg_cron is not available: report refresh must be triggered externally (gateway timer)';
    return;
  end if;

  begin
    create extension if not exists pg_cron;
  exception when others then
    -- e.g. pg_cron present on disk but not in shared_preload_libraries, or this is not the
    -- database named by cron.database_name.
    raise notice 'pg_cron could not be enabled (%): report refresh must be triggered externally', sqlerrm;
    return;
  end;

  begin
    -- cron.schedule(job_name, schedule, command) upserts by job name (pg_cron >= 1.4).
    perform cron.schedule('istiqama-refresh-reports', '*/15 * * * *',
                          'select public.refresh_reports()');
    -- Hourly: drop expired rate-limit windows of callers that never came back.
    if to_regprocedure('private.rate_limit_cleanup(interval)') is not null then
      perform cron.schedule('istiqama-rate-limit-cleanup', '7 * * * *',
                            'select private.rate_limit_cleanup()');
    end if;
    -- Daily: forget finished export jobs older than 30 days (files are removed by the
    -- export function / storage lifecycle; only the bookkeeping rows are soft-deleted here).
    perform cron.schedule('istiqama-expire-exports', '23 2 * * *',
                          'select private.expire_export_jobs()');
  exception when others then
    raise notice 'pg_cron jobs could not be scheduled (%)', sqlerrm;
  end;
end
$jobs$;
