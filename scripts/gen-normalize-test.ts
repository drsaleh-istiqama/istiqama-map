/**
 * Shared fixture of the search normalisation -> pgTAP file.
 *
 *   supabase/tests/fixtures/normalize.json   [{ name, input, expected }, ...]   (source of truth)
 *   supabase/tests/03_normalize.test.sql     one is() per case                  (generated, committed)
 *
 * The same JSON is read by the unit test of the TypeScript twin
 * (apps/web/src/lib/normalize.ts), so SQL `private.norm()` and the web app cannot drift apart.
 *
 *   npx tsx scripts/gen-normalize-test.ts
 *       regenerate the SQL file from the JSON (no database needed)
 *   npx tsx scripts/gen-normalize-test.ts --check
 *       exit 1 when the JSON is not in canonical form or the committed SQL file is stale
 *   npx tsx scripts/gen-normalize-test.ts --update --db imap_x
 *   npx tsx scripts/gen-normalize-test.ts --update --database-url postgres://...
 *       recompute every "expected" by calling private.norm() in that database (the database is
 *       the truth; read-only), rewrite the JSON in canonical form, then regenerate the SQL file
 *
 * Adding a case: append { "name": "...", "input": "...", "expected": "" } to the JSON and run
 * --update. `name` is printable ASCII and unique; `input` may use any JSON escape.
 *
 * Both files are pure ASCII on purpose: every other character is written as an escape
 * (JSON \uXXXX, SQL U&'\XXXX'), so no editor or tool can silently alter the invisible and
 * combining characters this fixture is about.
 *
 * Keep characters out of the fixture that PostgreSQL's `unaccent` rewrites but the documented
 * TypeScript algorithm does not (docs/contracts/schema.md, section 2.1), and letters whose
 * lower-casing depends on the database locale (non-ASCII letters without a Latin base).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface NormCase {
  name: string;
  input: string;
  expected: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'supabase', 'tests', 'fixtures', 'normalize.json');
const TEST_FILE = path.join(ROOT, 'supabase', 'tests', '03_normalize.test.sql');
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

/** Assertions of the generated file that do not come from a fixture case. */
const EXTRA_ASSERTIONS = 3;
const DOLLAR_TAG = '$norm_cases$';

// Written without escape sequences on purpose (see the header).
const BACKSLASH = String.fromCharCode(0x5c);
const QUOTE = String.fromCharCode(0x22);
const APOSTROPHE = String.fromCharCode(0x27);

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0');
const isPlainAscii = (code: number): boolean => code >= 0x20 && code <= 0x7e;
const codePoints = (s: string): number[] => Array.from(s, (ch) => ch.codePointAt(0) ?? 0);

// ----------------------------------------------------------------------------------------------
// Fixture
// ----------------------------------------------------------------------------------------------
function validate(raw: unknown): NormCase[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${rel(FIXTURE)}: expected a non-empty JSON array`);
  }
  const names = new Set<string>();
  return raw.map((item: unknown, i): NormCase => {
    const where = `${rel(FIXTURE)} [${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${where}: expected an object`);
    }
    const rec = item as Record<string, unknown>;
    const extra = Object.keys(rec).filter((k) => !['name', 'input', 'expected'].includes(k));
    if (extra.length) throw new Error(`${where}: unknown key(s) ${extra.join(', ')}`);
    const { name, input, expected } = rec;
    if (typeof name !== 'string' || typeof input !== 'string' || typeof expected !== 'string') {
      throw new Error(`${where}: "name", "input" and "expected" must be strings`);
    }
    if (name.length < 1 || name.length > 80 || !codePoints(name).every(isPlainAscii)) {
      throw new Error(`${where}: "name" must be 1-80 printable ASCII characters`);
    }
    if (names.has(name)) throw new Error(`${where}: duplicate name "${name}"`);
    names.add(name);
    for (const [key, value] of [
      ['input', input],
      ['expected', expected],
    ] as const) {
      for (const code of codePoints(value)) {
        if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
          throw new Error(
            `${where}: "${key}" contains U+${hex(code, 4)}, which PostgreSQL text cannot hold`,
          );
        }
      }
    }
    return { name, input, expected };
  });
}

/** JSON string literal with every character outside printable ASCII as \uXXXX. */
function jsonString(value: string): string {
  let out = QUOTE;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) out += BACKSLASH + String.fromCharCode(unit);
    else if (isPlainAscii(unit)) out += String.fromCharCode(unit);
    else out += BACKSLASH + 'u' + hex(unit, 4);
  }
  return out + QUOTE;
}

/** Canonical (Prettier-stable, pure ASCII) text of the fixture. */
function fixtureText(cases: NormCase[]): string {
  const items = cases.map(
    (c) =>
      '  {\n' +
      `    "name": ${jsonString(c.name)},\n` +
      `    "input": ${jsonString(c.input)},\n` +
      `    "expected": ${jsonString(c.expected)}\n` +
      '  }',
  );
  return '[\n' + items.join(',\n') + '\n]\n';
}

// ----------------------------------------------------------------------------------------------
// SQL
// ----------------------------------------------------------------------------------------------
/** SQL string literal; anything outside printable ASCII becomes a U&'...' Unicode escape. */
function sqlLiteral(value: string): string {
  const codes = codePoints(value);
  if (codes.every(isPlainAscii)) {
    return APOSTROPHE + value.split(APOSTROPHE).join(APOSTROPHE + APOSTROPHE) + APOSTROPHE;
  }
  let out = 'U&' + APOSTROPHE;
  for (const code of codes) {
    if (code === 0x27) out += APOSTROPHE + APOSTROPHE;
    else if (code === 0x5c) out += BACKSLASH + BACKSLASH;
    else if (isPlainAscii(code)) out += String.fromCodePoint(code);
    else if (code <= 0xffff) out += BACKSLASH + hex(code, 4);
    else out += BACKSLASH + '+' + hex(code, 6);
  }
  return out + APOSTROPHE;
}

function testFileText(cases: NormCase[]): string {
  const width = String(cases.length).length;
  const lines: string[] = [
    '-- =============================================================================',
    '-- 03  private.norm() against the shared normalisation fixture',
    '--',
    '-- GENERATED FILE - DO NOT EDIT.',
    `--   source:      ${rel(FIXTURE)}`,
    '--   regenerate:  npx tsx scripts/gen-normalize-test.ts',
    '--',
    '-- The unit test of the TypeScript twin (apps/web/src/lib/normalize.ts) runs the same',
    "-- cases. Every character outside printable ASCII is written as a U&'\\XXXX' escape.",
    '-- Algorithm: docs/contracts/schema.md, section 2.1.',
    '-- =============================================================================',
    'begin;',
    'set local search_path = public, extensions, tests;',
    "-- U&'...' literals and literal backslashes need the standard string syntax.",
    'set local standard_conforming_strings = on;',
    '',
    `select plan(${cases.length + EXTRA_ASSERTIONS});`,
    '',
    "select is(private.norm(null), null, 'norm(NULL) is NULL');",
    'select is(',
    "  (select p.provolatile::text || '/' || p.proisstrict::text || '/'",
    "          || (exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text",
    "   from pg_proc p where p.oid = 'private.norm(text)'::regprocedure),",
    "  'i/true/true',",
    "  'private.norm(text) is IMMUTABLE and STRICT with a pinned search_path');",
    '',
  ];

  cases.forEach((c, i) => {
    const label = `norm ${String(i + 1).padStart(width, '0')}: ${c.name}`;
    lines.push(
      'select is(',
      `  private.norm(${sqlLiteral(c.input)}),`,
      `  ${sqlLiteral(c.expected)},`,
      `  ${sqlLiteral(label)});`,
    );
  });

  const values = cases.map((c) => `       (${sqlLiteral(c.expected)})`);
  if (values.some((v) => v.includes(DOLLAR_TAG))) {
    throw new Error(`a fixture value contains the dollar-quote tag ${DOLLAR_TAG}`);
  }
  lines.push(
    '',
    '-- Normalising a normalised value changes nothing.',
    'select is_empty(',
    `  ${DOLLAR_TAG} select v.expected`,
    '     from (values',
    values.join(',\n'),
    '     ) as v (expected)',
    `     where private.norm(v.expected) is distinct from v.expected ${DOLLAR_TAG},`,
    "  'private.norm() is idempotent on every expected value');",
    '',
    'select * from finish();',
    'rollback;',
    '',
  );
  return lines.join('\n');
}

// ----------------------------------------------------------------------------------------------
// Database (only for --update)
// ----------------------------------------------------------------------------------------------
async function normInDatabase(inputs: string[], connectionString: string): Promise<string[]> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ out: string | null }>(
      `select private.norm(t.input) as out
         from unnest($1::text[]) with ordinality as t (input, ord)
        order by t.ord`,
      [inputs],
    );
    if (res.rows.length !== inputs.length) {
      throw new Error(
        `private.norm() returned ${res.rows.length} rows for ${inputs.length} inputs`,
      );
    }
    return res.rows.map((row, i) => {
      if (row.out === null) throw new Error(`private.norm() returned NULL for case ${i}`);
      return row.out;
    });
  } finally {
    await client.end();
  }
}

interface Options {
  check: boolean;
  update: boolean;
  help: boolean;
  db?: string;
  databaseUrl?: string;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = { check: false, update: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--update') opts.update = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--db' || arg === '--database-url') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--db') opts.db = value;
      else opts.databaseUrl = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.check && opts.update) throw new Error('--check and --update exclude each other');
  return opts;
}

function connectionString(opts: Options): string {
  if (opts.databaseUrl) return opts.databaseUrl;
  if (opts.db) {
    if (!/^[a-z_][a-z0-9_]*$/.test(opts.db)) throw new Error(`invalid database name: ${opts.db}`);
    // Docker-less local stack (docs/ARCHITECTURE.md section 1): superuser, trust authentication.
    return `postgres://postgres@127.0.0.1:${process.env.PG_PORT ?? '54322'}/${opts.db}`;
  }
  throw new Error('--update needs --db <local database> or --database-url <url>');
}

// ----------------------------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------------------------
const USAGE =
  'usage: tsx scripts/gen-normalize-test.ts [--check | --update (--db <name> | --database-url <url>)]';
const lf = (s: string): string => s.split('\r\n').join('\n');

async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseOptions(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(USAGE);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const fixtureOnDisk = fs.readFileSync(FIXTURE, 'utf8');
  let cases = validate(JSON.parse(fixtureOnDisk));

  if (opts.update) {
    const outputs = await normInDatabase(
      cases.map((c) => c.input),
      connectionString(opts),
    );
    let changed = 0;
    cases = cases.map((c, i) => {
      const expected = outputs[i] ?? '';
      if (expected !== c.expected) {
        changed++;
        console.log(`  updated: ${c.name}`);
      }
      return { ...c, expected };
    });
    console.log(
      `${cases.length} cases normalised by the database, ${changed} expected value(s) changed`,
    );
  }

  const fixture = fixtureText(cases);
  const sql = testFileText(cases);

  if (opts.check) {
    const problems: string[] = [];
    if (lf(fixtureOnDisk) !== fixture) problems.push(`${rel(FIXTURE)} is not in canonical form`);
    if (!fs.existsSync(TEST_FILE) || lf(fs.readFileSync(TEST_FILE, 'utf8')) !== sql) {
      problems.push(`${rel(TEST_FILE)} is stale`);
    }
    for (const p of problems) console.error(`✗ ${p} (run: npx tsx scripts/gen-normalize-test.ts)`);
    if (!problems.length)
      console.log(`✓ ${rel(TEST_FILE)} matches ${rel(FIXTURE)} (${cases.length} cases)`);
    return problems.length ? 1 : 0;
  }

  if (lf(fixtureOnDisk) !== fixture) {
    fs.writeFileSync(FIXTURE, fixture);
    console.log(`✓ ${rel(FIXTURE)} rewritten in canonical form`);
  }
  fs.writeFileSync(TEST_FILE, sql);
  console.log(
    `✓ ${rel(TEST_FILE)}: ${cases.length} cases, ${cases.length + EXTRA_ASSERTIONS} assertions`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
