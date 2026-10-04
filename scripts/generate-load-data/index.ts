/**
 * Load-test data generator (brief §0 design volume, acceptance criterion 2).
 *
 *   npm run load:seed -- [--db imap_load] [--build] [--projects 100000] [--collectors 40]
 *                        [--parallel 1] [--tokens-only] [--vus 300] [--ttl-hours 72] [--fresh]
 *
 * Writes into a PRIVATE database (default imap_load, never `istiqama` / `postgres`):
 *   100,000 projects over the 7 countries / 36 branches / deepest admin areas, with land,
 *   facilities, maintenance, 1,000,000 photo rows (10 per project), 20,000 donors + links,
 *   500,000 persons (Arabic + Latin names) with 500,000 staff links and 300,000 salary rows,
 *   community profiles, restricted community data, ~20,000 localities and ~1,500 users.
 *
 * Set-based SQL (sql/10_prep.sql, sql/20_batch.sql), 1,000 projects per transaction, every
 * trigger enabled (std columns, derived columns, audit, sync_xid). Resumable: re-running
 * continues with the first batch that is not recorded in loadgen.progress.
 * Afterwards: refresh_reports() (cluster pyramid + report views), VACUUM ANALYZE, a check of
 * private.person_names, and load-tests/tokens.json (k6 identities, signed HS256 tokens).
 *
 * --build   recreate the database first: db:reset --no-seed + boundaries:import --offline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { buildTokens, defaultMix } from './tokens.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
dotenv.config({ path: path.join(ROOT, '.env.local'), quiet: true });

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d;
};

if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const DB = opt('db', 'imap_load');
const PROJECTS = Number(opt('projects', '100000'));
const COLLECTORS = Number(opt('collectors', '40'));
const PARALLEL = Math.max(1, Number(opt('parallel', '1')));
const VUS = Number(opt('vus', '300'));
const TTL_HOURS = Number(opt('ttl-hours', '72'));
const PG_PORT = Number(process.env.PG_PORT ?? 54322);
const TOKENS_FILE = path.join(ROOT, 'load-tests', 'tokens.json');

if (!/^imap_[a-z0-9_]+$/.test(DB) && !flag('force')) {
  console.error(
    `refusing to write into "${DB}": use a private database imap_<label> (STACK_READY rules)`,
  );
  process.exit(2);
}
if (!Number.isInteger(PROJECTS) || PROJECTS < 1000) {
  console.error('--projects must be an integer >= 1000');
  process.exit(2);
}

const t0 = Date.now();
const ts = (): string =>
  `[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 1000)}s]`;
const say = (m: string): void => console.log(`${ts()} ${m}`);

function npm(args: string[]): void {
  say(`npm ${args.join(' ')}`);
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm ${args[1] ?? args[0]} failed (exit ${r.status})`);
}

function sqlFile(name: string, vars: Record<string, string | number>): string {
  let text = fs.readFileSync(path.join(HERE, 'sql', name), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v));
  return text;
}

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({
    connectionString: `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB}`,
    application_name: 'generate-load-data',
  });
  await c.connect();
  await c.query('set client_min_messages = warning; set statement_timeout = 0');
  return c;
}

async function scalar<T = string>(c: pg.Client, sql: string): Promise<T> {
  const r = await c.query(sql);
  return Object.values(r.rows[0] ?? {})[0] as T;
}

async function main(): Promise<void> {
  if (flag('build')) {
    npm(['run', 'db:reset', '--', '--db', DB, '--no-seed', '--quiet']);
    npm([
      'run',
      'boundaries:import',
      '--',
      '--offline',
      '--cache-dir',
      '.local/downloads/geoboundaries',
      '--database-url',
      `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB}`,
    ]);
  }
  const c = await connect();
  try {
    if (!flag('tokens-only')) await seed(c);
    say('tokens');
    const tokens = await buildTokens(c, {
      database: DB,
      secret: process.env.SUPABASE_JWT_SECRET ?? '',
      mix: defaultMix(VUS),
      ttlHours: TTL_HOURS,
      outFile: TOKENS_FILE,
    });
    const modes = tokens.vus.reduce<Record<string, number>>((m, v) => {
      const k = `${v.role}/${v.mode}`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    say(
      `wrote ${path.relative(ROOT, TOKENS_FILE)}: ${tokens.vus.length} VUs ${JSON.stringify(modes)}, ` +
        `${Object.keys(tokens.areas).length} areas, seed_xid ${tokens.seed_xid}, expires ${tokens.expires_at}`,
    );
  } finally {
    await c.end();
  }
}

async function seed(c: pg.Client): Promise<void> {
  const areas = Number(await scalar(c, 'select count(*) from public.admin_areas'));
  if (areas === 0)
    throw new Error(`no admin areas in ${DB}: run with --build (or boundaries:import) first`);
  const hasSchema =
    Number(await scalar(c, "select count(*) from pg_namespace where nspname = 'loadgen'")) > 0;
  const existing = Number(await scalar(c, 'select count(*) from public.projects'));
  if (!hasSchema || flag('fresh')) {
    if (existing > 0)
      throw new Error(
        `${DB} already has ${existing} projects but no loadgen schema: rebuild with --build`,
      );
    say(`prep: ${PROJECTS} projects, ${COLLECTORS} collectors per branch`);
    await c.query(sqlFile('10_prep.sql', { PROJECTS, SEED: 0.4242, COLLECTORS }));
    const per = await c.query<{ iso2: string; n: string; branches: string }>(
      `select iso2, count(*) n, count(distinct branch_id) branches from loadgen.pt group by 1 order by 2 desc`,
    );
    say(`points: ${per.rows.map((r) => `${r.iso2} ${r.n} (${r.branches} br)`).join(', ')}`);
  } else {
    say('loadgen schema found: resuming');
  }
  await c.query(sqlFile('20_batch.sql', {}));

  if (Number(await scalar(c, 'select count(*) from public.donors')) === 0) {
    say('reference rows: donors, localities');
    await c.query('call loadgen.load_refs()');
  }

  const todo = (
    await c.query<{ batch: number }>(
      `select distinct batch from loadgen.pj p
        where not exists (select 1 from loadgen.progress g where g.batch = p.batch) order by 1`,
    )
  ).rows.map((r) => r.batch);
  const total = Number(await scalar(c, 'select count(distinct batch) from loadgen.pj'));
  say(
    `batches: ${total - todo.length}/${total} done, ${todo.length} to load (parallel ${PARALLEL})`,
  );

  const workers = await Promise.all(
    Array.from({ length: Math.min(PARALLEL, todo.length) }, connect),
  );
  let next = 0;
  let done = total - todo.length;
  await Promise.all(
    workers.map(async (w) => {
      while (next < todo.length) {
        const b = todo[next++]!;
        const s = Date.now();
        await w.query('call loadgen.load_batch($1)', [b]);
        await w.query('update loadgen.progress set seconds = $2 where batch = $1', [
          b,
          (Date.now() - s) / 1000,
        ]);
        done++;
        say(`batch ${b} (${done}/${total}) ${((Date.now() - s) / 1000).toFixed(1)} s`);
      }
    }),
  );
  await Promise.all(workers.map((w) => w.end()));

  // person_names is trigger-maintained; verify (bulk loaders that disable triggers must rebuild)
  const names = await c.query<{ persons: string; names: string }>(
    `select (select count(*) from public.persons where deleted_at is null) persons,
            (select count(distinct person_id) from private.person_names) names`,
  );
  const n = names.rows[0]!;
  if (Number(n.names) < Number(n.persons) * 0.99) {
    say(`person_names incomplete (${n.names}/${n.persons}): private.person_names_rebuild()`);
    await c.query('select private.person_names_rebuild()');
  }

  say('refresh_reports() (cluster pyramid + report views)');
  const rr = await c.query<{ r: unknown }>('select public.refresh_reports() r');
  say(`refresh_reports: ${JSON.stringify(rr.rows[0]?.r)}`);
  say('vacuum analyze');
  await c.query('vacuum analyze');

  const counts = await c.query(
    `select (select count(*) from public.projects) projects,
            (select count(*) from public.project_photos) photos,
            (select count(*) from public.persons) persons,
            (select count(*) from public.project_staff) staff,
            (select count(*) from public.staff_compensation) compensation,
            (select count(*) from public.donors) donors,
            (select count(*) from public.project_donors) donor_links,
            (select count(*) from public.localities) localities,
            (select count(*) from public.project_maintenance) maintenance,
            (select count(*) from loadgen.u) users,
            pg_size_pretty(pg_database_size(current_database())) db_size`,
  );
  say(`counts: ${JSON.stringify(counts.rows[0])}`);
}

main().catch((e: unknown) => {
  console.error(`${ts()} FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
