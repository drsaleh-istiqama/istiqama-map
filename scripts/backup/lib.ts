/**
 * Shared helpers for the backup / restore scripts (brief §11, acceptance criterion 8).
 *
 * The scripts only need the PostgreSQL client tools (pg_dump, pg_restore, psql) and Node. They
 * work against the local portable stack and against hosted / self-hosted Supabase alike:
 * every connection is a libpq URL, nothing is hard-wired to the development machine.
 *
 * Tool lookup order: $PG_BIN, then .local/pg/bin (local stack), then PATH.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Schemas owned by the application (created by supabase/migrations). Dumped schema + data. */
export const APP_SCHEMAS = ['public', 'private'] as const;

/**
 * Platform tables (auth / storage are owned by Supabase) whose DATA belongs to us. Their
 * structure comes from the platform of the target project, so only rows are dumped.
 * Sessions, refresh tokens, one-time tokens and MFA challenges are deliberately NOT restored:
 * after a disaster every user signs in again (and sync_rebase forces a full resync anyway).
 */
export const PLATFORM_DATA_TABLES = [
  'auth.users',
  'auth.identities',
  'auth.mfa_factors',
  'storage.buckets',
  'storage.objects',
] as const;

/** Platform schemas whose app-made objects (policies on storage.objects …) must be re-created. */
export const PLATFORM_SCHEMAS = ['auth', 'storage'] as const;

/** Optional schema of the Supabase CLI migration history; dumped when it exists. */
export const MIGRATION_HISTORY_SCHEMA = 'supabase_migrations';

export const MANIFEST_FILE = 'manifest.json';
export const APP_DUMP = 'app.dump';
export const PLATFORM_DATA_DUMP = 'platform-data.dump';
export const PLATFORM_SCHEMA_DUMP = 'platform-schema.dump';
export const STORAGE_MANIFEST = 'storage-manifest.json';

export interface Manifest {
  format: 'istiqama-backup/1';
  created_at: string;
  app_version: string;
  source: { host: string; port: string; database: string };
  server_version: string;
  pg_dump_version: string;
  snapshot: string | null;
  extensions: Array<{ name: string; schema: string; version: string }>;
  schemas: string[];
  platform_data_tables: string[];
  /** Exact row counts of every base table of the dumped schemas, read in the dump snapshot. */
  row_counts: Record<string, number>;
  /** Materialized views: rows stored in the source and rows of the defining query (see countMatViews). */
  matview_counts: Record<string, { stored: number; fresh: number }>;
  /** Normalised privileges of every object of the dumped schemas (aclSnapshot). */
  acl: Record<string, string>;
  sync_epoch: string | null;
  files: Record<string, { bytes: number; sha256: string }>;
  durations_ms: Record<string, number>;
}

export function pgBin(name: string): string {
  const candidates = [
    process.env.PG_BIN ? path.join(process.env.PG_BIN, name + EXE) : '',
    path.join(ROOT, '.local', 'pg', 'bin', name + EXE),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name; // rely on PATH
}

/** Parse a dotenv-style file without overriding variables that are already set. */
export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

export function loadEnv(): void {
  loadEnvFile(path.join(ROOT, '.env.local'));
  loadEnvFile(path.join(ROOT, '.env'));
}

/** `--name value` / `--flag` parser. */
export function parseArgs(argv: string[], flags: string[] = []): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (flags.includes(key) || argv[i + 1] === undefined || argv[i + 1]!.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = argv[++i]!;
    }
  }
  return out;
}

export function str(args: Record<string, string | true>, key: string, fallback: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}

/** Local default: the running stack's superuser on 127.0.0.1:$PG_PORT. */
export function localUrl(database: string): string {
  const port = process.env.PG_PORT ?? '54322';
  return `postgresql://postgres@127.0.0.1:${port}/${database}`;
}

/** Same server, other database (used to reach the maintenance database "postgres"). */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = '/' + database;
  return u.toString();
}

export function describeUrl(url: string): { host: string; port: string; database: string } {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '5432', database: u.pathname.replace(/^\//, '') };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...opts,
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    ms: Date.now() - t0,
  };
}

export function mustRun(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(
      `${path.basename(cmd)} exited with ${r.status}\n${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r;
}

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** All base tables of the given schemas (partitioned parents included, partitions excluded). */
export async function listTables(client: pg.Client, schemas: string[]): Promise<string[]> {
  const res = await client.query<{ t: string }>(
    `select n.nspname || '.' || c.relname as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition
      order by 1`,
    [schemas],
  );
  return res.rows.map((r) => r.t);
}

/**
 * Materialized views: pg_restore REFRESHES them after loading the data, so the restored
 * contents equal the view's defining query over the restored tables — not the (possibly
 * stale) stored contents of the source. `fresh` = count of the defining query in the current
 * snapshot, `stored` = count of what the source currently holds.
 */
export async function countMatViews(
  client: pg.Client,
  schemas: string[],
): Promise<Record<string, { stored: number; fresh: number }>> {
  const res = await client.query<{ t: string; def: string }>(
    `select n.nspname || '.' || c.relname as t, pg_get_viewdef(c.oid) as def
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind = 'm'
      order by 1`,
    [schemas],
  );
  const out: Record<string, { stored: number; fresh: number }> = {};
  for (const r of res.rows) {
    const [schema, name] = r.t.split('.') as [string, string];
    const stored = await client.query<{ n: string }>(
      `select count(*)::bigint as n from ${quoteIdent(schema)}.${quoteIdent(name)}`,
    );
    const fresh = await client.query<{ n: string }>(
      `select count(*)::bigint as n from (${r.def.trim().replace(/;$/, '')}) mv`,
    );
    out[r.t] = { stored: Number(stored.rows[0]!.n), fresh: Number(fresh.rows[0]!.n) };
  }
  return out;
}

/** Exact row counts (count(*)) — runs inside whatever transaction / snapshot `client` holds. */
export async function countRows(
  client: pg.Client,
  tables: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [schema, name] = t.split('.') as [string, string];
    const res = await client.query<{ n: string }>(
      `select count(*)::bigint as n from ${quoteIdent(schema)}.${quoteIdent(name)}`,
    );
    out[t] = Number(res.rows[0]!.n);
  }
  return out;
}

/**
 * Privileges of every object of the given schemas, normalised: a NULL acl is replaced by the
 * built-in default (acldefault), items are listed as grantee=privilege[*] in a stable order.
 * Key: "<kind> <identity>". Used to prove that a restore reproduced the source's grants
 * exactly — see restore.ts "normalise privileges" for why this is not automatic.
 */
export const ACL_QUERY = `
with objs as (
  select 'schema' as k, quote_ident(n.nspname) as ident,
         coalesce(n.nspacl, acldefault('n'::"char", n.nspowner)) as acl
    from pg_namespace n where n.nspname = any($1)
  union all
  select case c.relkind when 'S' then 'sequence' else 'relation' end,
         quote_ident(n.nspname) || '.' || quote_ident(c.relname),
         coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'column', quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname), a.attacl
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any($1) and a.attacl is not null and a.attnum > 0 and not a.attisdropped
  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         coalesce(p.proacl, acldefault('f'::"char", p.proowner))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = any($1)
  union all
  select 'type', quote_ident(n.nspname) || '.' || quote_ident(t.typname),
         coalesce(t.typacl, acldefault('T'::"char", t.typowner))
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = any($1) and t.typtype in ('d', 'e', 'r', 'm')
  union all
  select 'default-privileges', pg_get_userbyid(d.defaclrole) || ' in ' || quote_ident(n.nspname)
         || ' on ' || d.defaclobjtype::text, d.defaclacl
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = any($1)
)
select o.k || ' ' || o.ident as key,
       coalesce((select string_agg(s.item, ',' order by s.item)
                   from (select case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end
                                || '=' || x.privilege_type
                                || case when x.is_grantable then '*' else '' end as item
                           from aclexplode(o.acl) x) s), '') as acl
  from objs o`;

export async function aclSnapshot(
  client: pg.Client,
  schemas: string[],
): Promise<Record<string, string>> {
  // Type names in function signatures depend on search_path: print them fully qualified.
  const old = (
    await client.query<{ p: string }>('select current_setting($1) as p', ['search_path'])
  ).rows[0]!.p;
  await client.query(`select set_config('search_path', 'pg_catalog', false)`);
  let res: pg.QueryResult<{ key: string; acl: string }>;
  try {
    res = await client.query<{ key: string; acl: string }>(ACL_QUERY, [schemas]);
  } finally {
    await client.query(`select set_config('search_path', $1, false)`, [old]);
  }
  const out: Record<string, string> = {};
  for (const r of res.rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    out[r.key] = r.acl;
  return out;
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function appVersion(): string {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    return 'unknown';
  }
}
