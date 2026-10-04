/**
 * The full restore drill of docs/RUNBOOK.md §8 in one command (acceptance criterion 8):
 *
 *   1. dump.ts        logical backup of the source database (read-only)
 *   2. restore.ts     into a NEW private database, sync_rebase, row counts + privileges checked
 *   3. schema diff    pg_dump --schema-only of source and restored copy (only cosmetic
 *                     re-parenthesised CHECK expressions are tolerated)
 *   4. verify-client  private PostgREST + gateway on the copy: sign-in, sync_pull, sync_push,
 *                     reset of pre-restore cursors
 *   5. pgTAP          (--pgtap) the full suite on another fresh database built from the
 *                     UNCHANGED migrations, proving the restore needed no migration change
 *   6. drop           the restored database (and the pgTAP database) unless --keep
 *
 *   node --import tsx scripts/backup/drill.ts --source istiqama --target imap_restore --pgtap
 *
 * Writes .local/backup-drill/drill-<stamp>.json with every duration and result.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  fmtMs,
  loadEnv,
  localUrl,
  mustRun,
  parseArgs,
  pgBin,
  run,
  str,
  withDatabase,
} from './lib.ts';

loadEnv();
const args = parseArgs(process.argv.slice(2), ['pgtap', 'keep']);
const source = str(args, 'source', 'istiqama');
const target = str(args, 'target', 'imap_restore');
const tapDb = str(args, 'pgtap-db', `${target}_tap`);
if (!target.startsWith('imap_') || !tapDb.startsWith('imap_'))
  throw new Error('drill databases must be named imap_<label>');
const gatewayPort = str(args, 'gateway-port', '54371');
const postgrestPort = str(args, 'postgrest-port', '54373');
const outDir = path.join(ROOT, '.local', 'backup-drill');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');

const node = process.execPath;
const tsx = ['--import', 'tsx'];
const results: Array<{ step: string; ok: boolean; ms: number; command: string; tail: string }> = [];

function step(
  name: string,
  cmd: string,
  cmdArgs: string[],
  opts: { allowFail?: boolean } = {},
): string {
  process.stdout.write(`▶ ${name} … `);
  const r = run(cmd, cmdArgs, { cwd: ROOT });
  const out = (r.stdout + r.stderr).trim();
  const ok = r.status === 0;
  const shown = [path.basename(cmd), ...cmdArgs].join(' ').replace(process.execPath, 'node');
  results.push({
    step: name,
    ok,
    ms: r.ms,
    command: shown,
    tail: out.split(/\r?\n/).slice(-25).join('\n'),
  });
  console.log(`${ok ? 'ok' : 'FAILED'} (${fmtMs(r.ms)})`);
  if (!ok && !opts.allowFail) {
    console.error(out);
    finish(1);
  }
  return out;
}

function dropDb(db: string): void {
  const psql = pgBin('psql');
  const admin = withDatabase(localUrl(db), 'postgres');
  run(psql, [
    '--dbname',
    admin,
    '-X',
    '-q',
    '-c',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`,
  ]);
  mustRun(psql, ['--dbname', admin, '-X', '-q', '-c', `drop database if exists ${db}`]);
}

function finish(code: number): never {
  const file = path.join(outDir, `drill-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, source, target, results }, null, 2) + '\n');
  console.log(`report: ${path.relative(ROOT, file)}`);
  process.exit(code);
}

// A previous interrupted drill may have left the target behind; restore.ts refuses to overwrite.
dropDb(target);

const dumpOut = step('1 dump (read-only on the source)', node, [
  ...tsx,
  'scripts/backup/dump.ts',
  '--db-url',
  localUrl(source),
  '--storage-dir',
  '.local/storage',
]);
const backupDir = dumpOut.split(/\r?\n/).pop()!.trim();
step('2 restore + sync_rebase + counts + privileges', node, [
  ...tsx,
  'scripts/backup/restore.ts',
  '--from',
  backupDir,
  '--db',
  target,
]);

// 3. schema diff
{
  const t = Date.now();
  const pgDump = pgBin('pg_dump');
  const dumpSchema = (db: string): string[] =>
    mustRun(pgDump, [
      '--dbname',
      localUrl(db),
      '--schema-only',
      '-n',
      'public',
      '-n',
      'private',
      '-n',
      'auth',
      '-n',
      'storage',
      '--restrict-key',
      'drill',
    ]).stdout.split(/\r?\n/);
  const a = dumpSchema(source);
  const b = dumpSchema(target);
  // Line-level multiset difference; a re-parenthesised CHECK expression is the only tolerated kind.
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const onlyA = [...ca].filter(([l, n]) => (cb.get(l) ?? 0) < n).map(([l]) => l);
  const onlyB = [...cb].filter(([l, n]) => (ca.get(l) ?? 0) < n).map(([l]) => l);
  const norm = (l: string): string => l.replace(/[()\s]/g, '');
  const unexplained = onlyA.filter(
    (l) => !onlyB.some((m) => norm(m) === norm(l) && /CHECK/.test(l)),
  );
  const ok = unexplained.length === 0 && onlyA.length === onlyB.length;
  results.push({
    step: '3 schema diff source vs restored',
    ok,
    ms: Date.now() - t,
    command: 'pg_dump --schema-only (public, private, auth, storage) of both databases',
    tail:
      `${a.length} vs ${b.length} lines; ${onlyA.length} differing lines (${onlyA.length - unexplained.length} re-parenthesised CHECK constraints)` +
      (unexplained.length
        ? `\nunexplained:\n${unexplained.slice(0, 10).join('\n')}\n---\n${onlyB.slice(0, 10).join('\n')}`
        : ''),
  });
  console.log(`▶ 3 schema diff … ${ok ? 'ok' : 'FAILED'} (${results.at(-1)!.tail.split('\n')[0]})`);
  if (!ok) finish(1);
}

step('4 client: sign-in + sync_pull + sync_push on the restored copy', node, [
  ...tsx,
  'scripts/backup/verify-client.ts',
  '--db',
  target,
  '--source-db',
  source,
  '--gateway-port',
  gatewayPort,
  '--postgrest-port',
  postgrestPort,
]);

if (args.pgtap) {
  step('5a fresh database from the unchanged migrations', node, [
    ...tsx,
    'scripts/local-stack/db-reset.ts',
    '--db',
    tapDb,
    '--no-seed',
    '--quiet',
  ]);
  step('5b full pgTAP suite', node, [...tsx, 'scripts/local-stack/run-pgtap.ts', '--db', tapDb]);
}

if (!args.keep) {
  const t = Date.now();
  dropDb(target);
  if (args.pgtap) dropDb(tapDb);
  results.push({
    step: '6 drop drill databases',
    ok: true,
    ms: Date.now() - t,
    command: `drop database ${target}${args.pgtap ? `, ${tapDb}` : ''}`,
    tail: '',
  });
  console.log(`▶ 6 dropped ${target}${args.pgtap ? ` and ${tapDb}` : ''}`);
}
finish(0);
