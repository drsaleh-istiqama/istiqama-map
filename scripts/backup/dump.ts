/**
 * Daily logical backup (brief §11): pg_dump -Fc of the application schemas, the data of the
 * platform tables we own (auth users / identities / MFA factors, storage buckets / objects),
 * the app-made objects inside the platform schemas (policies on storage.objects), a storage
 * manifest and a manifest with exact row counts — all read in ONE exported snapshot, so the
 * counts describe exactly what the dump files contain. Read-only on the source database.
 *
 *   node --import tsx scripts/backup/dump.ts                                   # local "istiqama"
 *   node --import tsx scripts/backup/dump.ts --db-url "$BACKUP_DATABASE_URL" --out /backups
 *   node --import tsx scripts/backup/dump.ts --storage-dir .local/storage      # hash local objects
 *   node --import tsx scripts/backup/dump.ts --upload                          # rclone copy (placeholder)
 *
 * Options
 *   --db-url <url>       source (default: local stack, database "istiqama"). On hosted Supabase use
 *                        the DIRECT connection (db.<ref>.supabase.co:5432), not the pooler: exported
 *                        snapshots do not survive a transaction-mode pooler.
 *   --out <dir>          parent directory (default .local/backups); a <UTC stamp> folder is created
 *   --storage-dir <dir>  local gateway storage root: adds size + sha256 of every object file
 *   --no-snapshot        run pg_dump without a shared snapshot (counts may then drift under writes)
 *   --upload             copy the folder to $BACKUP_RCLONE_TARGET with rclone (no real target is
 *                        configured in this repository; see docs/RUNBOOK.md §4)
 *
 * Exit code 0 only when every file was written and pg_restore can read each archive's TOC.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  APP_DUMP,
  APP_SCHEMAS,
  MANIFEST_FILE,
  MIGRATION_HISTORY_SCHEMA,
  PLATFORM_DATA_DUMP,
  PLATFORM_DATA_TABLES,
  PLATFORM_SCHEMA_DUMP,
  PLATFORM_SCHEMAS,
  ROOT,
  STORAGE_MANIFEST,
  aclSnapshot,
  appVersion,
  countMatViews,
  countRows,
  describeUrl,
  fmtMs,
  listTables,
  loadEnv,
  localUrl,
  mustRun,
  parseArgs,
  pgBin,
  run,
  sha256File,
  str,
  type Manifest,
} from './lib.ts';
import { objectFsPath } from '../local-stack/gateway/storage/paths.ts';

loadEnv();
const args = parseArgs(process.argv.slice(2), ['no-snapshot', 'upload']);
const dbUrl = str(args, 'db-url', process.env.BACKUP_DATABASE_URL ?? localUrl('istiqama'));
const outParent = path.resolve(ROOT, str(args, 'out', path.join('.local', 'backups')));
const storageDir =
  typeof args['storage-dir'] === 'string' ? path.resolve(ROOT, args['storage-dir']) : null;
const useSnapshot = !args['no-snapshot'];

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const outDir = path.join(outParent, stamp);

interface StorageObject {
  bucket_id: string;
  name: string;
  size: number | null;
  mimetype: string | null;
  updated_at: string | null;
  file_bytes?: number;
  file_sha256?: string;
  file_missing?: boolean;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const durations: Record<string, number> = {};
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`backup of ${JSON.stringify(describeUrl(dbUrl))} → ${outDir}`);

  // One read-only repeatable-read transaction holds the snapshot that every pg_dump below uses.
  const client = new pg.Client({ connectionString: dbUrl, application_name: 'istiqama-backup' });
  await client.connect();
  await client.query('begin isolation level repeatable read read only');
  const snapshot = useSnapshot
    ? (await client.query<{ s: string }>('select pg_export_snapshot() as s')).rows[0]!.s
    : null;

  const serverVersion = (await client.query<{ v: string }>('show server_version')).rows[0]!.v;
  const extensions = (
    await client.query<{ name: string; schema: string; version: string }>(
      `select e.extname as name, n.nspname as schema, e.extversion as version
         from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname <> 'plpgsql' order by 1`,
    )
  ).rows;
  const hasHistory = (
    await client.query<{ ok: boolean }>(
      'select exists (select 1 from pg_namespace where nspname = $1) as ok',
      [MIGRATION_HISTORY_SCHEMA],
    )
  ).rows[0]!.ok;
  const schemas: string[] = [...APP_SCHEMAS, ...(hasHistory ? [MIGRATION_HISTORY_SCHEMA] : [])];

  let t = Date.now();
  const tables = await listTables(client, [...schemas]);
  const rowCounts = await countRows(client, [...tables, ...PLATFORM_DATA_TABLES]);
  const matviewCounts = await countMatViews(client, [...schemas]);
  const acl = await aclSnapshot(client, [...schemas]);
  durations.count_rows = Date.now() - t;

  const epochRes = await client.query<{ e: string | null }>(
    `select case when to_regclass('private.sync_state') is null then null
                 else (select epoch::text from private.sync_state limit 1) end as e`,
  );

  // Storage manifest: every object row, and (optionally) the file behind it.
  t = Date.now();
  const objects = (
    await client.query<StorageObject>(
      `select bucket_id, name, (metadata->>'size')::bigint as size,
              metadata->>'mimetype' as mimetype, updated_at::text as updated_at
         from storage.objects order by bucket_id, name`,
    )
  ).rows.map((o) => ({ ...o, size: o.size === null ? null : Number(o.size) }));
  const referenced = (
    await client.query<{ path: string }>(
      `select distinct p as path from (
         select storage_path_full as p from public.project_photos where purged_at is null
         union all
         select storage_path_thumb from public.project_photos where purged_at is null) x
        where p is not null`,
    )
  ).rows.map((r) => r.path);
  durations.storage_manifest_query = Date.now() - t;

  const pgDump = pgBin('pg_dump');
  const common = ['--dbname', dbUrl, '-Fc', ...(snapshot ? ['--snapshot', snapshot] : [])];

  // 1. application schemas: structure + data + privileges.
  t = Date.now();
  mustRun(pgDump, [
    ...common,
    ...schemas.flatMap((s) => ['--schema', s]),
    '-f',
    path.join(outDir, APP_DUMP),
  ]);
  durations.pg_dump_app = Date.now() - t;

  // 2. platform tables we own: data only (the target platform provides the structure).
  t = Date.now();
  mustRun(pgDump, [
    ...common,
    '--data-only',
    ...PLATFORM_DATA_TABLES.flatMap((tbl) => ['--table', tbl]),
    '-f',
    path.join(outDir, PLATFORM_DATA_DUMP),
  ]);
  durations.pg_dump_platform_data = Date.now() - t;

  // 3. platform schemas, structure only: restore.ts replays just the POLICY entries from it
  //    (storage.objects policies of migration 0015), never the platform tables themselves.
  t = Date.now();
  mustRun(pgDump, [
    ...common,
    '--schema-only',
    ...PLATFORM_SCHEMAS.flatMap((s) => ['--schema', s]),
    '-f',
    path.join(outDir, PLATFORM_SCHEMA_DUMP),
  ]);
  durations.pg_dump_platform_schema = Date.now() - t;

  await client.query('commit');
  await client.end();

  // Storage files (local stack only): size + sha256, and objects whose file is missing.
  t = Date.now();
  if (storageDir) {
    for (const o of objects) {
      try {
        const f = objectFsPath(storageDir, o.bucket_id, o.name);
        if (fs.existsSync(f)) {
          o.file_bytes = fs.statSync(f).size;
          o.file_sha256 = sha256File(f);
        } else o.file_missing = true;
      } catch {
        o.file_missing = true;
      }
    }
  }
  const photoNames = new Set(objects.filter((o) => o.bucket_id === 'photos').map((o) => o.name));
  const missingReferenced = referenced.filter((p) => !photoNames.has(p));
  const byBucket: Record<string, { objects: number; bytes: number }> = {};
  for (const o of objects) {
    const b = (byBucket[o.bucket_id] ??= { objects: 0, bytes: 0 });
    b.objects++;
    b.bytes += o.size ?? o.file_bytes ?? 0;
  }
  fs.writeFileSync(
    path.join(outDir, STORAGE_MANIFEST),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        storage_dir_hashed: storageDir !== null,
        buckets: byBucket,
        referenced_photo_paths: referenced.length,
        referenced_photo_paths_without_object: missingReferenced,
        objects_without_file: objects
          .filter((o) => o.file_missing)
          .map((o) => `${o.bucket_id}/${o.name}`),
        objects,
      },
      null,
      2,
    ) + '\n',
  );
  durations.storage_manifest = Date.now() - t + (durations.storage_manifest_query ?? 0);
  delete durations.storage_manifest_query;

  // Sanity: every archive must have a readable table of contents.
  const pgRestore = pgBin('pg_restore');
  for (const f of [APP_DUMP, PLATFORM_DATA_DUMP, PLATFORM_SCHEMA_DUMP]) {
    const r = run(pgRestore, ['-l', path.join(outDir, f)]);
    if (r.status !== 0) throw new Error(`pg_restore cannot read ${f}: ${r.stderr}`);
  }

  const files: Manifest['files'] = {};
  for (const f of [APP_DUMP, PLATFORM_DATA_DUMP, PLATFORM_SCHEMA_DUMP, STORAGE_MANIFEST]) {
    const p = path.join(outDir, f);
    files[f] = { bytes: fs.statSync(p).size, sha256: sha256File(p) };
  }
  durations.total = Date.now() - t0;

  const manifest: Manifest = {
    format: 'istiqama-backup/1',
    created_at: new Date().toISOString(),
    app_version: appVersion(),
    source: describeUrl(dbUrl),
    server_version: serverVersion,
    pg_dump_version: run(pgDump, ['--version']).stdout.trim(),
    snapshot,
    extensions,
    schemas,
    platform_data_tables: [...PLATFORM_DATA_TABLES],
    row_counts: rowCounts,
    matview_counts: matviewCounts,
    acl,
    sync_epoch: epochRes.rows[0]?.e ?? null,
    files,
    durations_ms: durations,
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');

  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  const stale = Object.entries(matviewCounts).filter(([, v]) => v.stored !== v.fresh);
  console.log(
    `✓ ${Object.keys(rowCounts).length} tables, ${totalRows} rows, ` +
      `${Object.keys(matviewCounts).length} materialized views${stale.length ? ` (${stale.length} not refreshed since the last change: ${stale.map(([k]) => k).join(', ')})` : ''}, ` +
      `${objects.length} storage objects` +
      (missingReferenced.length
        ? ` (! ${missingReferenced.length} photo paths without object)`
        : ''),
  );
  for (const [f, v] of Object.entries(files))
    console.log(`  ${f.padEnd(22)} ${String(v.bytes).padStart(10)} B  ${v.sha256.slice(0, 16)}…`);
  console.log(
    `  durations: ${Object.entries(durations)
      .map(([k, v]) => `${k} ${fmtMs(v)}`)
      .join(', ')}`,
  );

  if (args.upload) upload();
  console.log(outDir);
}

/**
 * Off-site copy. PLACEHOLDER: the target is chosen by the owner (decision #1, hosting account /
 * region). Configure an rclone remote in ANOTHER account / region — ideally an rclone `crypt`
 * remote on top of an S3-compatible bucket with object lock — and set
 *   BACKUP_RCLONE_TARGET=istiqama-offsite-crypt:db/production
 * No credentials live in this repository.
 */
function upload(): void {
  const target = process.env.BACKUP_RCLONE_TARGET;
  if (!target) {
    console.log(
      '! upload skipped: BACKUP_RCLONE_TARGET is not set (placeholder, docs/RUNBOOK.md §4)',
    );
    return;
  }
  const rclone = process.env.RCLONE_BIN ?? 'rclone';
  const dest = `${target.replace(/\/$/, '')}/${stamp}`;
  const t = Date.now();
  mustRun(rclone, ['copy', outDir, dest, '--checksum', '--immutable', '--retries', '5'], {
    stdio: 'inherit',
  });
  mustRun(rclone, ['check', outDir, dest, '--one-way'], { stdio: 'inherit' });
  console.log(`✓ uploaded to ${dest} in ${fmtMs(Date.now() - t)}`);
}

main().catch((e: unknown) => {
  console.error(`✗ backup failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
