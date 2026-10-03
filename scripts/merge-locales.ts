/**
 * Merge per-feature locale fragments into the shipped locale files.
 *
 *   apps/web/locales/_parts/<namespace>.<lang>.json   { "key": "text" }
 *     → apps/web/locales/<lang>.json                  { "<namespace>.key": "text" }
 *
 * Exits with code 1 when the three languages do not have exactly the same keys
 * (`--check` only verifies that the shipped files are up to date).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANGS = ['ar', 'sw', 'en'] as const;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'locales');
const parts = path.join(dir, '_parts');
const check = process.argv.includes('--check');

const merged: Record<string, Record<string, string>> = { ar: {}, sw: {}, en: {} };
const files = fs.existsSync(parts) ? fs.readdirSync(parts).filter((f) => f.endsWith('.json')).sort() : [];
for (const f of files) {
  const m = /^([a-z0-9-]+)\.(ar|sw|en)\.json$/.exec(f);
  if (!m) {
    console.error(`unexpected fragment name: ${f} (expected <namespace>.<ar|sw|en>.json)`);
    process.exit(1);
  }
  const [, ns, lang] = m as unknown as [string, string, (typeof LANGS)[number]];
  const data = JSON.parse(fs.readFileSync(path.join(parts, f), 'utf8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') {
      console.error(`${f}: "${k}" must be a string`);
      process.exit(1);
    }
    merged[lang]![`${ns}.${k}`] = v;
  }
}

let problems = 0;
const keys = new Set(LANGS.flatMap((l) => Object.keys(merged[l]!)));
for (const k of [...keys].sort()) {
  const missing = LANGS.filter((l) => !(k in merged[l]!));
  if (missing.length) {
    problems++;
    console.error(`missing "${k}" in: ${missing.join(', ')}`);
  }
}

for (const l of LANGS) {
  const sorted = Object.fromEntries(Object.entries(merged[l]!).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const out = JSON.stringify(sorted, null, 2) + '\n';
  const target = path.join(dir, `${l}.json`);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== out) {
      problems++;
      console.error(`${l}.json is out of date — run: npm run locales -w apps/web`);
    }
  } else fs.writeFileSync(target, out);
}

if (problems) process.exit(1);
console.log(`locales: ${keys.size} keys × ${LANGS.length} languages from ${files.length} fragments`);
