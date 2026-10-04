#!/usr/bin/env node
/* global process, console, URL */
/**
 * Bundle budget report for apps/web/dist (brief §1: initial JS <= 200 kB gzip).
 *
 *   node apps/web/scripts/chunk-report.mjs [--budget 200]
 *
 * "Initial" = every JS file loaded before first paint: the entry scripts and modulepreloads in
 * dist/index.html plus, transitively, every STATIC import of those files. Dynamic imports
 * (`import()`) are lazy chunks and are listed separately. Exits 1 when the budget is exceeded.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const budgetArg = process.argv.indexOf('--budget');
const budgetKb = budgetArg > 0 ? Number(process.argv[budgetArg + 1]) : 200;

const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const entries = new Set();
for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+\.js)"/g))
  entries.add(m[1]);
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+\.js)"/g))
  entries.add(m[1]);

/** Static `import … from "./x.js"` / `import "./x.js"` / `export … from "./x.js"` specifiers. */
function staticImports(file) {
  const code = readFileSync(path.join(dist, file), 'utf8');
  const out = [];
  const re = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+\.js)["']/g;
  for (const m of code.matchAll(re)) {
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return out;
}

const initial = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.shift();
  if (initial.has(file)) continue;
  initial.add(file);
  queue.push(...staticImports(file));
}

const gz = (file) => gzipSync(readFileSync(path.join(dist, file)), { level: 9 }).length;
const all = readdirSync(path.join(dist, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `assets/${f}`);
const rows = all
  .map((file) => ({ file, gzip: gz(file), initial: initial.has(file) }))
  .sort((a, b) => b.gzip - a.gzip);

const kb = (n) => (n / 1024).toFixed(1).padStart(7);
let initialTotal = 0;
console.log('gzip kB  initial  chunk');
for (const r of rows) {
  if (r.initial) initialTotal += r.gzip;
  console.log(`${kb(r.gzip)}  ${r.initial ? '  yes  ' : '       '}  ${r.file}`);
}
const lazyTotal = rows.filter((r) => !r.initial).reduce((s, r) => s + r.gzip, 0);
console.log(
  `\ninitial JS: ${initialTotal} B = ${(initialTotal / 1024).toFixed(1)} kB gzip (${initial.size} files)`,
);
console.log(
  `lazy JS:    ${(lazyTotal / 1024).toFixed(1)} kB gzip (${rows.length - initial.size} files)`,
);
console.log(`budget:     ${budgetKb} kB`);
if (initialTotal / 1024 > budgetKb) {
  console.error('initial JS exceeds the budget');
  process.exit(1);
}
