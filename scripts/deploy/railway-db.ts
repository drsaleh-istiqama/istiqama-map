/**
 * One-shot production database setup for the Railway deployment (docs/DEPLOY_RAILWAY.md §3–§5).
 * Run by the OWNER on their own machine; the connection URL is read from the environment and
 * never printed or written anywhere.
 *
 *   PowerShell:  $env:DATABASE_URL = '<Railway Postgres public URL>'; npm run deploy:railway-db
 *   Git Bash:    DATABASE_URL='<…>' npm run deploy:railway-db
 *
 * Steps (idempotent — safe to re-run):
 *   1. checks roles / schemas / extensions the migrations rely on
 *   2. applies supabase/migrations in order, recorded in supabase_migrations.schema_migrations
 *      (Supabase CLI compatible). The staging seed is NEVER applied.
 *   3. per-role statement timeouts (as on hosted Supabase)
 *   4. full pgTAP suite in the still-empty production database (each file rolled back; helpers removed)
 *   5. real administrative boundaries (geoBoundaries cache) + refresh_reports()
 *   6. prints a short summary (no secrets)
 * Options: --skip-pgtap, --skip-boundaries
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, pgBin } from '../local-stack/lib.ts';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error(
    'Set DATABASE_URL to the Railway Postgres public connection URL first (see the header of this file).',
  );
  process.exit(2);
}
const args = new Set(process.argv.slice(2));
const psql = pgBin('psql');
const env = { ...process.env, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '20' };

function run(u: string, argv: string[], quiet = false): string {
  const r = spawnSync(psql, [u, '-X', '-v', 'ON_ERROR_STOP=1', ...argv], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) {
    // never echo the URL: psql errors do not contain the password, but be safe
    const msg = (r.stderr || r.stdout || '').split(url).join('<DATABASE_URL>');
    throw new Error(msg.trim());
  }
  if (!quiet && r.stderr.trim()) console.error(r.stderr.trim());
  return r.stdout;
}
const q = (u: string, sql: string): string => run(u, ['-At', '-c', sql], true).trim();

function applyMigrations(u: string, label: string): number {
  run(
    u,
    [
      '-q',
      '-c',
      'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);',
    ],
    true,
  );
  const dir = path.join(ROOT, 'supabase', 'migrations');
  let applied = 0;
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => /^\d{14}_.+\.sql$/.test(x))
    .sort()) {
    const version = f.slice(0, 14);
    const name = f.slice(15, -4);
    if (
      q(u, `select 1 from supabase_migrations.schema_migrations where version = '${version}'`) ===
      '1'
    )
      continue;
    process.stdout.write(`  [${label}] ${f} … `);
    run(
      u,
      [
        '-q',
        '--single-transaction',
        '-f',
        path.join(dir, f),
        '-c',
        `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}')`,
      ],
      true,
    );
    console.log('ok');
    applied++;
  }
  return applied;
}

const t0 = Date.now();
console.log('1/5 checking the server');
console.log(
  '  roles:',
  q(
    url,
    "select string_agg(rolname, ',' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')",
  ),
);
console.log(
  '  schemas:',
  q(
    url,
    "select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname in ('auth','storage','extensions')",
  ),
);
console.log(
  '  extensions available:',
  q(
    url,
    "select string_agg(name, ',' order by name) from pg_available_extensions where name in ('postgis','pg_trgm','unaccent','pgcrypto','pg_cron','pgtap')",
  ),
);

console.log('2/5 applying migrations (production; no seed)');
const n = applyMigrations(url, 'prod');
console.log(`  ${n} new migration(s) applied`);

console.log('3/5 role timeouts');
run(
  url,
  [
    '-q',
    '-c',
    "alter role anon set statement_timeout = '3s'; alter role authenticated set statement_timeout = '8s'; alter role authenticator set statement_timeout = '8s'; notify pgrst, 'reload config';",
  ],
  true,
);
console.log('  buckets:', q(url, "select string_agg(id, ',' order by id) from storage.buckets"));

if (!args.has('--skip-pgtap')) {
  // A database created with CREATE DATABASE on the Supabase image has no auth/storage schemas,
  // so the suite runs in the production database itself — ONLY while it is still empty (before
  // go-live). Every test file runs in a transaction that is rolled back; 00_helpers installs a
  // persistent "tests" schema and pgTAP, which are removed again afterwards.
  console.log('4/5 pgTAP (empty production database, each file rolled back)');
  const live = Number(q(url, 'select count(*) from public.projects') || '0');
  if (live > 0) {
    console.log(
      `  skipped: production already holds ${live} project(s). Run pgTAP on a staging copy instead.`,
    );
  } else {
    try {
      if (q(url, "select count(*) from pg_available_extensions where name = 'pgtap'") === '0') {
        const pgtapSql = path.join(ROOT, '.local', 'pg', 'share', 'extension', 'pgtap--1.3.4.sql');
        run(
          url,
          [
            '-q',
            '-c',
            'create schema if not exists tests_pgtap',
            '-c',
            'set search_path = tests_pgtap',
            '-f',
            pgtapSql,
          ],
          true,
        );
      }
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(ROOT, 'scripts', 'local-stack', 'run-pgtap.ts'),
          '--url',
          url,
        ],
        { env, encoding: 'utf8', maxBuffer: 64 << 20 },
      );
      const out = (r.stdout + r.stderr).split(url).join('<DATABASE_URL>');
      const NL = String.fromCharCode(10);
      const PASS = String.fromCharCode(0x2713);
      console.log(
        out
          .split(NL)
          .filter((l) => !l.startsWith(PASS))
          .join(NL)
          .trim(),
      );
      if (r.status !== 0) console.error('  pgTAP FAILED — see the lines above.');
    } finally {
      run(
        url,
        [
          '-q',
          '-c',
          'drop schema if exists tests cascade; drop schema if exists tests_pgtap cascade; drop extension if exists pgtap cascade;',
        ],
        true,
      );
      console.log(
        '  test helpers removed; projects now:',
        q(url, 'select count(*) from public.projects'),
      );
    }
  }
}

if (!args.has('--skip-boundaries')) {
  console.log('5/5 administrative boundaries + reports');
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(ROOT, 'scripts', 'import-boundaries', 'index.ts'),
      '--offline',
      '--cache-dir',
      path.join(ROOT, '.local', 'downloads', 'geoboundaries'),
      '--database-url',
      url,
    ],
    { env, encoding: 'utf8', maxBuffer: 64 << 20 },
  );
  console.log(
    (r.stdout + r.stderr).split(url).join('<DATABASE_URL>').trim().split('\n').slice(-3).join('\n'),
  );
  run(url, ['-q', '-c', 'select public.refresh_reports()'], true);
}

console.log(
  `\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s — schema version ${q(url, "select coalesce(max(version), '-') from supabase_migrations.schema_migrations")}, projects ${q(url, 'select count(*) from public.projects')} (production starts empty), admin areas ${q(url, 'select count(*) from public.admin_areas where deleted_at is null')}`,
);
