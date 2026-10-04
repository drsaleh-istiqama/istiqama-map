/** Start PostgreSQL, PostgREST and the Supabase-compatible gateway (idempotent). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL,
  LOG_DIR,
  PG_DATA,
  PG_ENV,
  PG_HOME,
  ROOT,
  RUN_DIR,
  capture,
  config,
  isPortOpen,
  parseArgs,
  pgBin,
  psqlArgs,
  startDetached,
  waitForPort,
} from './lib.ts';

const args = parseArgs(process.argv.slice(2), ['no-gateway', 'no-postgrest']);
const cfg = config();
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true });

if (!fs.existsSync(path.join(PG_DATA, 'PG_VERSION'))) {
  console.error('Local stack is not set up. Run: npm run stack:setup');
  process.exit(1);
}

// 1. PostgreSQL — stdio must be ignored, otherwise the postmaster inherits our pipes and the
//    caller never sees EOF.
if (await isPortOpen(cfg.pgPort)) console.log(`PostgreSQL already running on :${cfg.pgPort}`);
else {
  const res = spawnSync(
    pgBin('pg_ctl'),
    ['-D', PG_DATA, '-l', path.join(LOG_DIR, 'postgres.log'), '-w', '-t', '60', 'start'],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (res.status !== 0 || !(await waitForPort(cfg.pgPort, 60_000))) {
    console.error(`PostgreSQL failed to start — see ${path.join(LOG_DIR, 'postgres.log')}`);
    process.exit(1);
  }
  console.log(`PostgreSQL started on :${cfg.pgPort}`);
}

const dbExists =
  capture(
    pgBin('psql'),
    [
      ...psqlArgs('postgres'),
      '-A',
      '-t',
      '-c',
      `select 1 from pg_database where datname = '${cfg.dbName}'`,
    ],
    {
      env: PG_ENV,
    },
  ).stdout.trim() === '1';

// 2. PostgREST (needs libpq from the PostgreSQL bin directory on PATH)
if (!args['no-postgrest']) {
  if (await isPortOpen(cfg.postgrestPort))
    console.log(`PostgREST already running on :${cfg.postgrestPort}`);
  else if (!dbExists)
    console.log(
      `database "${cfg.dbName}" does not exist yet — run "npm run db:reset", then "npm run stack:start" again`,
    );
  else if (!cfg.jwtSecret)
    console.log('SUPABASE_JWT_SECRET missing (.env.local) — PostgREST not started');
  else {
    startDetached('postgrest', path.join(LOCAL, 'postgrest', 'postgrest.exe'), [], {
      PATH: `${path.join(PG_HOME, 'bin')}${path.delimiter}${process.env.PATH}`,
      PGRST_DB_URI: `postgres://authenticator:postgres@127.0.0.1:${cfg.pgPort}/${cfg.dbName}`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
      PGRST_DB_POOL: process.env.PGRST_DB_POOL ?? '40',
      PGRST_DB_MAX_ROWS: '1000',
      PGRST_JWT_SECRET: cfg.jwtSecret,
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: String(cfg.postgrestPort),
      PGRST_DB_CHANNEL_ENABLED: 'true',
    });
    console.log(
      (await waitForPort(cfg.postgrestPort, 30_000))
        ? `PostgREST started on :${cfg.postgrestPort}`
        : 'PostgREST did not open its port — see .local/logs/postgrest.log',
    );
  }
}

// 3. Gateway (Auth / Storage / Functions emulation in front of PostgREST)
const gateway = path.join(ROOT, 'scripts', 'local-stack', 'gateway', 'server.ts');
if (!args['no-gateway'] && fs.existsSync(gateway)) {
  if (await isPortOpen(cfg.gatewayPort))
    console.log(`gateway already running on :${cfg.gatewayPort}`);
  else if (!dbExists) console.log('gateway not started (database missing)');
  else {
    startDetached('gateway', process.execPath, ['--import', 'tsx', gateway]);
    console.log(
      (await waitForPort(cfg.gatewayPort, 30_000))
        ? `gateway started on :${cfg.gatewayPort}  (API URL http://127.0.0.1:${cfg.gatewayPort})`
        : 'gateway did not open its port — see .local/logs/gateway.log',
    );
  }
}
