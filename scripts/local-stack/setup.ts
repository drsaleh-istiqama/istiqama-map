/**
 * One-time setup of the Docker-less local stack (Windows x64).
 *
 * Downloads only the files we need from the official archives (HTTP range requests through
 * zip_range_fetch.py — field connections are slow and the full archives are ~500 MB):
 *   - PostgreSQL 17 binaries  (get.enterprisedb.com)
 *   - PostGIS 3.6 core        (download.osgeo.org)
 *   - PostgREST               (github.com/PostgREST/postgrest)
 *   - pgTAP                   (api.pgxn.org)
 * then runs initdb, tunes postgresql.conf and writes .env.local with random dev secrets.
 * Idempotent: every step is skipped when its result already exists.
 *
 * On Linux/macOS (or anywhere Docker exists) use the real stack instead: `supabase start`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import {
  DOWNLOADS,
  LOCAL,
  LOG_DIR,
  PG_DATA,
  PG_HOME,
  ROOT,
  RUN_DIR,
  capture,
  pgBin,
  run,
} from './lib.ts';

const VERSIONS = {
  pg: 'https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip',
  postgis: 'https://download.osgeo.org/postgis/windows/pg17/postgis-bundle-pg17-3.6.2x64.zip',
  postgrest:
    'https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-windows-x86-64.zip',
  pgtap: 'https://api.pgxn.org/dist/pgtap/1.3.4/pgtap-1.3.4.zip',
};

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error(
    'The portable local stack supports Windows x64 only. Elsewhere run `supabase start` (Docker).',
  );
  process.exit(1);
}

const python = ['python', 'py', 'python3'].find((p) => {
  try {
    return capture(p, ['--version']).status === 0;
  } catch {
    return false;
  }
});
const fetcher = path.join(ROOT, 'scripts', 'local-stack', 'zip_range_fetch.py');
const rangeFetch = (
  url: string,
  dest: string,
  cache: string,
  include: string,
  exclude: string | null,
  strip: number,
): void => {
  if (!python)
    throw new Error(
      'Python 3 is required for the selective download (python.org) — or unzip the archives manually.',
    );
  const a = [
    fetcher,
    url,
    dest,
    '--cache',
    path.join(DOWNLOADS, cache),
    '--include',
    include,
    '--strip',
    String(strip),
  ];
  if (exclude) a.push('--exclude', exclude);
  run(python, a);
};
const download = async (url: string, dest: string): Promise<void> => {
  if (fs.existsSync(dest)) return;
  console.log(`downloading ${path.basename(dest)} …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
};
const copyNoClobber = (from: string, to: string): void => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyNoClobber(s, d);
    } else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
};

for (const d of [LOCAL, DOWNLOADS, LOG_DIR, RUN_DIR]) fs.mkdirSync(d, { recursive: true });

// 1. PostgreSQL (bin, lib, share — no pgAdmin, docs, headers, symbols, translations)
if (!fs.existsSync(pgBin('postgres'))) {
  rangeFetch(
    VERSIONS.pg,
    PG_HOME,
    'pg17.sparse',
    '^pgsql/(bin|lib|share)/',
    '^pgsql/(share/locale/|share/doc/|lib/.*\\.(lib|a)$|bin/(stackbuilder|pgbench|ecpg|.*wx).*)|\\.pdb$',
    1,
  );
}

// 2. PostGIS core (extension DLL + runtime DLLs + extension SQL + PROJ database); existing
//    PostgreSQL files are never overwritten.
if (!fs.existsSync(path.join(PG_HOME, 'lib', 'postgis-3.dll'))) {
  const tmp = path.join(LOCAL, 'postgis');
  rangeFetch(
    VERSIONS.postgis,
    tmp,
    'postgis.sparse',
    'x64/lib/postgis-3\\.dll$|x64/bin/[^/]+\\.dll$|x64/share/extension/postgis(--[^/]*\\.sql|\\.control)$|x64/share/contrib/postgis-3\\.6/proj/[^/]+$',
    'libgdal|libSFCGAL|libgsl|libfreexl|libopenjp2|libarchive|\\.tif$|_TIN\\.json$|\\.geojson$',
    1,
  );
  copyNoClobber(tmp, PG_HOME);
}

// 3. pgTAP (pure SQL extension; reproduce the two sed substitutions of its Makefile)
const extDir = path.join(PG_HOME, 'share', 'extension');
if (!fs.existsSync(path.join(extDir, 'pgtap.control'))) {
  const zip = path.join(DOWNLOADS, 'pgtap-1.3.4.zip');
  await download(VERSIONS.pgtap, zip);
  const src = path.join(LOCAL, 'src');
  fs.mkdirSync(src, { recursive: true });
  run('tar', ['-xf', zip, '-C', src], {
    shell: false,
    env: { ...process.env, PATH: `C:\\Windows\\System32;${process.env.PATH}` },
  });
  const dir = path.join(src, 'pgtap-1.3.4');
  const control = fs.readFileSync(path.join(dir, 'pgtap.control'), 'utf8');
  const version = /default_version\s*=\s*'([^']+)'/.exec(control)![1]!;
  const numVersion = /^(\d+\.\d+)/.exec(version)![1]!;
  const sql = fs
    .readFileSync(path.join(dir, 'sql', 'pgtap.sql.in'), 'utf8')
    .replaceAll('MODULE_PATHNAME', 'pgtap')
    .replaceAll('__OS__', 'mswin32')
    .replaceAll('__VERSION__', numVersion);
  fs.writeFileSync(path.join(extDir, `pgtap--${version}.sql`), sql);
  fs.writeFileSync(path.join(extDir, 'pgtap.control'), control);
  console.log(`pgTAP ${version} installed`);
}

// 4. PostgREST
const postgrestDir = path.join(LOCAL, 'postgrest');
if (!fs.existsSync(path.join(postgrestDir, 'postgrest.exe'))) {
  const zip = path.join(DOWNLOADS, path.basename(VERSIONS.postgrest));
  await download(VERSIONS.postgrest, zip);
  fs.mkdirSync(postgrestDir, { recursive: true });
  run('tar', ['-xf', zip, '-C', postgrestDir], {
    env: { ...process.env, PATH: `C:\\Windows\\System32;${process.env.PATH}` },
  });
}

// 5. .env.local with random development secrets (never committed)
const envFile = path.join(ROOT, '.env.local');
if (!fs.existsSync(envFile)) {
  const secret = crypto.randomBytes(48).toString('base64url');
  const tenYears = 60 * 60 * 24 * 365 * 10;
  const key = (role: string): string =>
    jwt.sign({ role, iss: 'supabase-local' }, secret, { algorithm: 'HS256', expiresIn: tenYears });
  const anon = key('anon');
  const service = key('service_role');
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const out = example
    .replace(/^SUPABASE_ANON_KEY=.*$/m, `SUPABASE_ANON_KEY=${anon}`)
    .replace(/^VITE_SUPABASE_ANON_KEY=.*$/m, `VITE_SUPABASE_ANON_KEY=${anon}`)
    .replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, `SUPABASE_SERVICE_ROLE_KEY=${service}`)
    .replace(/^SUPABASE_JWT_SECRET=.*$/m, `SUPABASE_JWT_SECRET=${secret}`);
  fs.writeFileSync(envFile, out);
  console.log('.env.local written with random development secrets');
}

// 6. initdb + tuning
if (!fs.existsSync(path.join(PG_DATA, 'PG_VERSION'))) {
  run(pgBin('initdb'), [
    '-D',
    PG_DATA,
    '-U',
    'postgres',
    '-A',
    'trust',
    '-E',
    'UTF8',
    '--locale=C',
    '--no-instructions',
  ]);
}
const conf = path.join(PG_DATA, 'postgresql.conf');
const marker = '# --- istiqama-map local stack ---';
if (!fs.readFileSync(conf, 'utf8').includes(marker)) {
  fs.appendFileSync(
    conf,
    [
      '',
      marker,
      `port = ${process.env.PG_PORT ?? 54322}`,
      "listen_addresses = '127.0.0.1'",
      'max_connections = 200',
      'shared_buffers = 1GB',
      'effective_cache_size = 4GB',
      'work_mem = 16MB',
      'maintenance_work_mem = 512MB',
      'random_page_cost = 1.1',
      'max_wal_size = 4GB',
      'checkpoint_timeout = 15min',
      'synchronous_commit = off  # development only',
      'log_min_duration_statement = 1000',
      "timezone = 'UTC'",
      '',
    ].join('\n'),
  );
}

console.log('\nLocal stack is set up. Next: npm run stack:start && npm run db:reset');
