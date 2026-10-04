/**
 * Minimal TAP harness for pgTAP files (local replacement for `pg_prove`; CI uses
 * `supabase test db`).
 *
 *   npm run test:db                                   # all supabase/tests/*.sql on "istiqama"
 *   npm run test:db -- --db imap_x supabase/tests/00_helpers.test.sql supabase/tests/2*.sql
 */
import fs from 'node:fs';
import path from 'node:path';
import { PG_ENV, ROOT, capture, config, parseArgs, pgBin, psqlArgs } from './lib.ts';

const args = parseArgs(process.argv.slice(2), ['verbose']);
const db = typeof args.db === 'string' ? args.db : config().dbName;
const testsDir = path.join(ROOT, 'supabase', 'tests');

const expand = (pattern: string): string[] => {
  const abs = path.resolve(ROOT, pattern);
  if (!pattern.includes('*')) return [abs];
  const dir = path.dirname(abs);
  const rx = new RegExp(
    '^' +
      path
        .basename(abs)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$',
  );
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => rx.test(f))
        .map((f) => path.join(dir, f))
    : [];
};

let files = args._.length
  ? args._.flatMap(expand)
  : fs.existsSync(testsDir)
    ? fs
        .readdirSync(testsDir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => path.join(testsDir, f))
    : [];
files = [...new Set(files)].sort();
if (!files.length) {
  console.error('no pgTAP files found');
  process.exit(1);
}

let failedFiles = 0;
let totalOk = 0;
let totalNotOk = 0;
const t0 = Date.now();
for (const f of files) {
  const res = capture(
    pgBin('psql'),
    [...psqlArgs(db), '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0', '-f', f],
    {
      env: PG_ENV,
    },
  );
  const lines = (res.stdout + '\n' + res.stderr).split(/\r?\n/);
  let plan = -1;
  let ok = 0;
  const failures: string[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^1\.\.(\d+)/.exec(t))) plan = Number(m[1]);
    else if (/^ok \d+/.test(t)) ok++;
    else if (/^not ok \d+/.test(t)) {
      const diag = lines
        .slice(i + 1, i + 8)
        .filter((l) => l.trim().startsWith('#'))
        .join('\n');
      failures.push(`${t}\n${diag}`);
    } else if (/psql:.*(ERROR|FATAL):/.test(t) || /^(ERROR|FATAL):/.test(t)) errors.push(t);
    else if (/^# Looks like you planned \d+ tests? but ran \d+/.test(t)) errors.push(t);
  });
  const passed = plan >= 0 && failures.length === 0 && errors.length === 0 && ok === plan;
  totalOk += ok;
  totalNotOk += failures.length;
  const rel = path.relative(ROOT, f);
  if (passed) console.log(`✓ ${rel}  (${ok}/${plan})`);
  else {
    failedFiles++;
    console.log(
      `✗ ${rel}  (${ok} ok, ${failures.length} failed, plan ${plan < 0 ? 'missing' : plan})`,
    );
    for (const x of failures) console.log('   ' + x.replace(/\n/g, '\n   '));
    for (const x of errors.slice(0, 15)) console.log('   ' + x);
  }
  if (args.verbose) console.log(lines.join('\n'));
}
console.log(
  `\n${files.length - failedFiles}/${files.length} files passed, ${totalOk} assertions ok, ${totalNotOk} failed, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
process.exit(failedFiles ? 1 : 0);
