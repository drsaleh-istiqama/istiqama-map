/**
 * Restore a backup made by scripts/backup/dump.ts into a NEW database, then re-stamp the sync
 * feed (private.sync_rebase, docs/contracts/sync.md §8) and prove that every table holds the
 * row count recorded in the manifest.
 *
 *   # local drill: creates the private database, applies the Supabase shim first
 *   node --import tsx scripts/backup/restore.ts --from .local/backups/<stamp> --db imap_restore
 *
 *   # hosted / self-hosted Supabase: an EMPTY, freshly created project (the platform provides
 *   # roles, auth, storage and extensions); nothing is created or dropped by the script
 *   node --import tsx scripts/backup/restore.ts --from <dir> --target-url "$RESTORE_DATABASE_URL" --yes
 *
 * Order (each step timed, report written to <from>/restore-report-<db>.json):
 *   1. verify sha256 of every file against manifest.json
 *   2. [local only] create database + scripts/local-stack/supabase-shim.sql
 *   3. create the extensions listed in the manifest (if missing)
 *   4. platform data (auth users / identities / MFA factors, storage buckets / objects) — first,
 *      because the app tables reference auth.users
 *   5. application schemas (structure + data + privileges), schemas that already exist skipped
 *   6. normalise privileges (strip grants added by the target's default privileges, replay the
 *      dump's ACL entries) and require them to equal the source's privileges exactly
 *   7. app-made policies inside the platform schemas (storage.objects)
 *   8. select private.sync_rebase()           (skip with --no-rebase)
 *   9. no syncable row carries a sync_xid ahead of the cluster
 *  10. row counts per table == manifest        (exit 2 on any mismatch)
 *  11. notify pgrst, 'reload schema'
 *
 * Options: --jobs N (parallel pg_restore, default 4) · --no-shim · --allow-any-name
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  APP_DUMP,
  MANIFEST_FILE,
  PLATFORM_DATA_DUMP,
  PLATFORM_SCHEMA_DUMP,
  ROOT,
  aclSnapshot,
  countRows,
  describeUrl,
  fmtMs,
  loadEnv,
  localUrl,
  mustRun,
  parseArgs,
  pgBin,
  quoteIdent,
  run,
  sha256File,
  str,
  withDatabase,
  type Manifest,
} from './lib.ts';

loadEnv();
const args = parseArgs(process.argv.slice(2), ['no-rebase', 'no-shim', 'yes', 'allow-any-name']);
if (typeof args.from !== 'string') {
  console.error(
    'usage: restore.ts --from <backup dir> (--db <new local db> | --target-url <url> --yes)',
  );
  process.exit(64);
}
const fromDir = path.resolve(ROOT, args.from);
const jobs = Number(str(args, 'jobs', '4'));
const localDb = typeof args.db === 'string' ? args.db : null;
const targetUrl = localDb
  ? localUrl(localDb)
  : typeof args['target-url'] === 'string'
    ? args['target-url']
    : null;

if (!targetUrl) {
  console.error(
    'either --db <name> (local, created) or --target-url <url> (existing empty database) is required',
  );
  process.exit(64);
}
if (localDb) {
  if (!/^[a-z_][a-z0-9_]*$/.test(localDb)) throw new Error(`invalid database name: ${localDb}`);
  if (['istiqama', 'postgres', 'template0', 'template1'].includes(localDb))
    throw new Error(`refusing to restore over "${localDb}"`);
  if (!localDb.startsWith('imap_') && !args['allow-any-name'])
    throw new Error(
      'local restores go into a private database named imap_<label> (or pass --allow-any-name)',
    );
} else if (!args.yes) {
  console.error(
    'restoring into an existing database: add --yes after checking that it is the NEW, empty project',
  );
  process.exit(64);
}

const steps: Array<{ step: string; ms: number; detail?: string }> = [];
async function step<T>(
  name: string,
  fn: () => T | Promise<T>,
  detail?: (r: T) => string,
): Promise<T> {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  const r = await fn();
  const ms = Date.now() - t;
  const d = detail ? detail(r) : undefined;
  steps.push({ step: name, ms, ...(d ? { detail: d } : {}) });
  console.log(`${fmtMs(ms)}${d ? ` (${d})` : ''}`);
  return r;
}

const psql = pgBin('psql');
const pgRestore = pgBin('pg_restore');
function sql(url: string, statement: string): string {
  return mustRun(psql, [
    '--dbname',
    url,
    '-X',
    '-q',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    statement,
  ]).stdout.trim();
}

/** pg_restore -l, minus the entries `drop` rejects, written as a use-list file. */
function useList(
  archive: string,
  keep: (line: string) => boolean,
  name: string,
): { file: string; entries: number } {
  const lines = mustRun(pgRestore, ['-l', archive]).stdout.split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== '' && !l.startsWith(';') && keep(l));
  const file = path.join(fromDir, `.uselist-${name}.txt`);
  fs.writeFileSync(file, kept.join('\n') + '\n');
  return { file, entries: kept.length };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fromDir, MANIFEST_FILE), 'utf8'),
  ) as Manifest;
  const target = describeUrl(targetUrl!);
  console.log(
    `restore ${fromDir}\n   from ${manifest.source.database} @ ${manifest.created_at} (app ${manifest.app_version})\n   into ${target.host}:${target.port}/${target.database}`,
  );

  await step(
    'verify checksums',
    () => {
      for (const [f, v] of Object.entries(manifest.files)) {
        const sha = sha256File(path.join(fromDir, f));
        if (sha !== v.sha256) throw new Error(`checksum mismatch for ${f}`);
      }
      return Object.keys(manifest.files).length;
    },
    (n) => `${n} files`,
  );

  if (localDb) {
    await step('create database', () => {
      const admin = withDatabase(targetUrl!, 'postgres');
      const exists = sql(admin, `select 1 from pg_database where datname = '${localDb}'`);
      if (exists)
        throw new Error(
          `database ${localDb} already exists — drop it first (restore never overwrites)`,
        );
      // Same locale as scripts/local-stack/db-reset.ts (pg_trgm needs a UTF-8 aware ctype).
      const ctype = process.platform === 'win32' ? 'en-US' : 'en_US.UTF-8';
      sql(
        admin,
        `create database ${localDb} encoding 'UTF8' lc_collate 'C' lc_ctype '${ctype}' template template0`,
      );
    });
    if (!args['no-shim']) {
      await step('supabase shim (stands in for the platform)', () => {
        mustRun(psql, [
          '--dbname',
          targetUrl!,
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          path.join(ROOT, 'scripts', 'local-stack', 'supabase-shim.sql'),
        ]);
      });
    }
  }

  await step(
    'extensions',
    () => {
      const made: string[] = [];
      for (const e of manifest.extensions) {
        const r = run(psql, [
          '--dbname',
          targetUrl!,
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `create schema if not exists ${quoteIdent(e.schema)}; create extension if not exists ${quoteIdent(e.name)} with schema ${quoteIdent(e.schema)}`,
        ]);
        if (r.status !== 0)
          console.warn(
            `\n  ! extension ${e.name}: ${r.stderr.trim()} (platform-managed? enable it in the dashboard)`,
          );
        else made.push(e.name);
      }
      return made;
    },
    (m) => m.join(', '),
  );

  await step('platform data (auth, storage)', () => {
    mustRun(pgRestore, [
      '--dbname',
      targetUrl!,
      '--data-only',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      path.join(fromDir, PLATFORM_DATA_DUMP),
    ]);
  });

  await step(
    'application schemas',
    () => {
      const existing = new Set(sql(targetUrl!, `select nspname from pg_namespace`).split(/\r?\n/));
      // "<id>; <cat> <oid> SCHEMA - <name> <owner>" — skip schemas the target already has.
      const list = useList(
        path.join(fromDir, APP_DUMP),
        (l) => {
          const m = / SCHEMA - (\S+) /.exec(l);
          return !(m && existing.has(m[1]!));
        },
        'app',
      );
      mustRun(pgRestore, [
        '--dbname',
        targetUrl!,
        '--exit-on-error',
        '-j',
        String(jobs),
        '-L',
        list.file,
        path.join(fromDir, APP_DUMP),
      ]);
      return list.entries;
    },
    (n) => `${n} TOC entries, -j ${jobs}`,
  );

  // Privileges. pg_dump writes each object's grants as a difference from the BUILT-IN default
  // (acldefault), but the target applies its own ALTER DEFAULT PRIVILEGES while pg_restore
  // creates the objects — on Supabase (and the shim) "grant all on tables / routines in schema
  // public to anon, authenticated, service_role". Left alone, the restored database would grant
  // EXECUTE on every admin function and ALL on every table to anon (found by the 2026-10-04
  // drill). So: strip every non-owner, non-PUBLIC grant from the restored objects, replay the
  // dump's ACL entries, then require the result to equal the source's privileges exactly.
  await step(
    'normalise privileges',
    () => {
      const schemaList = manifest.schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
      sql(
        targetUrl!,
        `do $$
      declare r record; d record; g record;
      begin
        for r in
          select 'table' as kind, format('%I.%I', n.nspname, c.relname) as obj, c.relowner as owner, c.relacl as acl
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in (${schemaList}) and c.relkind in ('r','p','v','m','f') and c.relacl is not null
          union all
          select 'sequence', format('%I.%I', n.nspname, c.relname), c.relowner, c.relacl
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in (${schemaList}) and c.relkind = 'S' and c.relacl is not null
          union all
          select 'routine', p.oid::regprocedure::text, p.proowner, p.proacl
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in (${schemaList}) and p.proacl is not null
        loop
          for g in select distinct x.grantee from aclexplode(r.acl) x where x.grantee <> 0 and x.grantee <> r.owner loop
            execute format('revoke all on %s %s from %I', r.kind, r.obj, pg_get_userbyid(g.grantee));
          end loop;
        end loop;
        -- Default privileges of the app schemas: the source revoked anon's, the platform grants
        -- them. Clear them here; the dump's DEFAULT ACL entries are replayed below.
        for d in
          select a.defaclrole, pg_get_userbyid(a.defaclrole) as role_name, n.nspname, a.defaclobjtype::text as objtype, a.defaclacl as acl
            from pg_default_acl a join pg_namespace n on n.oid = a.defaclnamespace
           where n.nspname in (${schemaList})
        loop
          for g in select distinct x.grantee from aclexplode(d.acl) x where x.grantee <> d.defaclrole loop
            execute format('alter default privileges for role %I in schema %I revoke all on %s from %s',
              d.role_name, d.nspname,
              case d.objtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' end,
              case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
          end loop;
        end loop;
      end $$`,
      );
      const list = useList(
        path.join(fromDir, APP_DUMP),
        (l) => /^\d+; \d+ \d+ (DEFAULT )?ACL /.test(l),
        'acl',
      );
      mustRun(pgRestore, [
        '--dbname',
        targetUrl!,
        '--exit-on-error',
        '--single-transaction',
        '-L',
        list.file,
        path.join(fromDir, APP_DUMP),
      ]);
      return list.entries;
    },
    (n) => `${n} ACL entries replayed`,
  );

  const aclDiff = await step(
    'privileges vs source',
    async () => {
      const client = new pg.Client({ connectionString: targetUrl! });
      await client.connect();
      try {
        const actual = await aclSnapshot(client, manifest.schemas);
        const expected = manifest.acl ?? {};
        const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
        return [...keys]
          .filter((k) => expected[k] !== actual[k])
          .map((k) => ({ object: k, expected: expected[k] ?? null, actual: actual[k] ?? null }));
      } finally {
        await client.end();
      }
    },
    (d) => `${Object.keys(manifest.acl ?? {}).length} objects, ${d.length} differences`,
  );
  if (aclDiff.length) {
    for (const d of aclDiff.slice(0, 20))
      console.error(`  ${d.object}\n    expected ${d.expected}\n    actual   ${d.actual}`);
    throw new Error(`${aclDiff.length} objects have different privileges than the source`);
  }

  await step(
    'platform policies (storage.objects …)',
    () => {
      const list = useList(
        path.join(fromDir, PLATFORM_SCHEMA_DUMP),
        (l) => / POLICY (auth|storage) /.test(l),
        'policies',
      );
      if (list.entries > 0)
        mustRun(pgRestore, [
          '--dbname',
          targetUrl!,
          '--exit-on-error',
          '--single-transaction',
          '--clean',
          '--if-exists',
          '-L',
          list.file,
          path.join(fromDir, PLATFORM_SCHEMA_DUMP),
        ]);
      return list.entries;
    },
    (n) => `${n} policies`,
  );

  let rebase: string | null = null;
  if (!args['no-rebase']) {
    rebase = await step(
      'private.sync_rebase()',
      () => sql(targetUrl!, 'select private.sync_rebase()'),
      (r) => r,
    );
  }

  // No syncable row may carry a sync_xid "from the future" of this cluster: such rows would
  // never enter a sync_pull window (docs/contracts/sync.md §5.1, §8).
  const future = await step(
    'sync feed check (no future sync_xid)',
    () => {
      const q = `do $$ declare r record; n bigint; total bigint := 0; begin
        for r in select table_name from private.sync_tables loop
          execute format('select count(*) from public.%I where sync_xid > private.current_xid()', r.table_name) into n;
          total := total + n;
        end loop;
        perform set_config('restore.future_rows', total::text, false);
      end $$; select current_setting('restore.future_rows')`;
      return Number(sql(targetUrl!, q).split(/\r?\n/).pop());
    },
    (n) => `${n} rows ahead of the cluster's xid`,
  );
  if (future > 0 && !args['no-rebase'])
    throw new Error(`${future} rows still carry a future sync_xid after sync_rebase`);

  const counts = await step(
    'row counts vs manifest',
    async () => {
      const client = new pg.Client({ connectionString: targetUrl! });
      await client.connect();
      try {
        const actual = await countRows(client, Object.keys(manifest.row_counts));
        const mismatches = Object.entries(manifest.row_counts)
          .filter(([t, n]) => actual[t] !== n)
          .map(([t, n]) => ({ table: t, expected: n, actual: actual[t] }));
        // Materialized views were refreshed by pg_restore: compare with the defining query's count.
        const mv = manifest.matview_counts ?? {};
        const mvActual = await countRows(client, Object.keys(mv));
        for (const [t, v] of Object.entries(mv))
          if (mvActual[t] !== v.fresh)
            mismatches.push({ table: t, expected: v.fresh, actual: mvActual[t] });
        Object.assign(actual, mvActual);
        const epoch =
          (
            await client.query<{ e: string }>(
              'select epoch::text as e from private.sync_state limit 1',
            )
          ).rows[0]?.e ?? null;
        return { actual, mismatches, epoch };
      } finally {
        await client.end();
      }
    },
    (r) => `${Object.keys(r.actual).length} tables, ${r.mismatches.length} mismatches`,
  );

  sql(targetUrl!, `notify pgrst, 'reload schema'`);
  const totalMs = Date.now() - t0;
  const report = {
    restored_at: new Date().toISOString(),
    backup: path.relative(ROOT, fromDir),
    target,
    total_ms: totalMs,
    steps,
    sync_rebase: rebase ? (JSON.parse(rebase) as unknown) : null,
    rows_with_future_sync_xid: future,
    privileges: { objects: Object.keys(manifest.acl ?? {}).length, differences: aclDiff.length },
    sync_epoch: {
      before: manifest.sync_epoch,
      after: counts.epoch,
      rotated: manifest.sync_epoch !== counts.epoch,
    },
    tables: Object.keys(manifest.row_counts).length,
    matviews: Object.keys(manifest.matview_counts ?? {}).length,
    rows: Object.keys(manifest.row_counts).reduce((a, t) => a + (counts.actual[t] ?? 0), 0),
    mismatches: counts.mismatches,
    row_counts: Object.fromEntries(
      Object.entries(manifest.row_counts).map(([t, n]) => [
        t,
        { expected: n, actual: counts.actual[t] },
      ]),
    ),
    matview_counts: Object.fromEntries(
      Object.entries(manifest.matview_counts ?? {}).map(([t, v]) => [
        t,
        { source_stored: v.stored, expected_fresh: v.fresh, actual: counts.actual[t] },
      ]),
    ),
  };
  const reportFile = path.join(fromDir, `restore-report-${target.database}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  for (const f of fs.readdirSync(fromDir))
    if (f.startsWith('.uselist-')) fs.rmSync(path.join(fromDir, f));

  if (counts.mismatches.length) {
    console.error(`✗ ${counts.mismatches.length} tables differ from the manifest:`);
    for (const m of counts.mismatches)
      console.error(`  ${m.table}: expected ${m.expected}, got ${m.actual}`);
    process.exit(2);
  }
  console.log(
    `✓ restored ${report.tables} tables / ${report.rows} rows in ${fmtMs(totalMs)}; epoch rotated: ${report.sync_epoch.rotated}\n  report: ${path.relative(ROOT, reportFile)}`,
  );
}

main().catch((e: unknown) => {
  console.error(`\n✗ restore failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
