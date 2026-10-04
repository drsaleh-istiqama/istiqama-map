/**
 * Recreate a local database from scratch: Supabase shim → migrations → (optional) staging seed.
 *
 *   npm run db:reset                         # database "istiqama", with staging seed
 *   npm run db:reset -- --db imap_x --no-seed
 *   npm run db:reset -- --db imap_x --only 0001-0019,0020-0029   # migration sequence ranges
 *   npm run db:reset -- --db imap_x --upto 0029
 */
import fs from 'node:fs';
import path from 'node:path';
import { PG_ENV, ROOT, capture, config, parseArgs, pgBin, psqlArgs } from './lib.ts';

const args = parseArgs(process.argv.slice(2), ['no-seed', 'quiet']);
const cfg = config();
const db = typeof args.db === 'string' ? args.db : cfg.dbName;
if (!/^[a-z_][a-z0-9_]*$/.test(db)) throw new Error(`invalid database name: ${db}`);

const psql = pgBin('psql');
const sql = (database: string, statement: string): void => {
  const res = capture(
    psql,
    [...psqlArgs(database), '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement],
    { env: PG_ENV },
  );
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
};
const file = (database: string, f: string, singleTx = true): void => {
  const res = capture(
    psql,
    [...psqlArgs(database), '-v', 'ON_ERROR_STOP=1', '-q', ...(singleTx ? ['-1'] : []), '-f', f],
    { env: PG_ENV },
  );
  if (res.status !== 0) {
    console.error(`\n✗ ${path.relative(ROOT, f)}\n${res.stderr.trim() || res.stdout.trim()}`);
    process.exit(1);
  }
  const warnings = res.stderr.trim();
  if (warnings && !args.quiet) console.error(warnings);
};

/** Sequence number of a migration: 20261003<NNNN>00_name.sql → NNNN. */
const seqOf = (name: string): number => Number(name.slice(8, 12));
const ranges: Array<[number, number]> =
  typeof args.only === 'string'
    ? args.only.split(',').map((r) => {
        const [a, b] = r.split('-');
        return [Number(a), Number(b ?? a)] as [number, number];
      })
    : [[0, typeof args.upto === 'string' ? Number(args.upto) : 9999]];

const migrationsDir = path.join(ROOT, 'supabase', 'migrations');
const migrations = fs
  .readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.+\.sql$/.test(f))
  .sort()
  .filter((f) => ranges.some(([a, b]) => seqOf(f) >= a && seqOf(f) <= b));

const t0 = Date.now();
sql(
  'postgres',
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`,
);
sql('postgres', `drop database if exists ${db}`);
// pg_trgm extracts no trigrams from Arabic under LC_CTYPE "C", so the database needs a
// UTF-8-aware ctype (Supabase uses C.UTF-8 / en_US.UTF-8). Collation stays "C".
const ctype = process.platform === 'win32' ? 'en-US' : 'en_US.UTF-8';
sql(
  'postgres',
  `create database ${db} encoding 'UTF8' lc_collate 'C' lc_ctype '${ctype}' template template0`,
);

const shim = path.join(ROOT, 'scripts', 'local-stack', 'supabase-shim.sql');
if (fs.existsSync(shim)) file(db, shim, false);
else console.warn('! scripts/local-stack/supabase-shim.sql not found — continuing without it');

for (const m of migrations) {
  file(db, path.join(migrationsDir, m));
  if (!args.quiet) console.log(`✓ ${m}`);
}

const seed =
  typeof args.seed === 'string'
    ? path.resolve(args.seed)
    : path.join(ROOT, 'supabase', 'seed.staging.sql');
if (!args['no-seed'] && fs.existsSync(seed)) {
  file(db, seed);
  console.log(`✓ seed: ${path.relative(ROOT, seed)}`);
}

sql(db, `notify pgrst, 'reload schema'`);
console.log(
  `database "${db}" ready: ${migrations.length} migrations in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
