#!/usr/bin/env node
/* global process, console, URL */
/**
 * Static checks of .github/workflows/*.yml (no network, no GitHub needed):
 *  - the file parses as YAML (js-yaml, already in node_modules through ESLint);
 *  - `on` and `jobs` exist, every job has `runs-on` + `steps` or `uses` (reusable workflow);
 *  - every step has exactly one of `run` / `uses`;
 *  - every `needs` names an existing job and there is no cycle;
 *  - `${{ … }}` expressions are balanced;
 *  - local helper scripts referenced as `node .github/scripts/…` / `tsx scripts/…` exist.
 *
 *   node .github/scripts/validate-workflows.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.join(root, '.github', 'workflows');
const errors = [];
let jobsSeen = 0;

for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(path.join(dir, name), 'utf8');
  const err = (msg) => errors.push(`${name}: ${msg}`);
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    err(`YAML parse error: ${e.message}`);
    continue;
  }
  if (!doc || typeof doc !== 'object') {
    err('empty document');
    continue;
  }
  // YAML 1.1 turns a bare `on` key into `true`; GitHub accepts both spellings.
  if (!('on' in doc) && !(true in doc)) err('missing "on"');
  const jobs = doc.jobs ?? {};
  if (!Object.keys(jobs).length) err('no jobs');
  for (const [id, job] of Object.entries(jobs)) {
    jobsSeen++;
    if (job.uses) {
      if (!/^\.\/\.github\/workflows\/.+\.ya?ml$|^[\w-]+\/[\w.-]+\/.+@.+$/.test(job.uses))
        err(`job ${id}: unexpected reusable workflow reference ${job.uses}`);
      const local = /^\.\/(.+)$/.exec(job.uses)?.[1];
      if (local && !existsSync(path.join(root, local))) err(`job ${id}: ${job.uses} not found`);
    } else {
      if (!job['runs-on']) err(`job ${id}: missing runs-on`);
      if (!Array.isArray(job.steps) || !job.steps.length) err(`job ${id}: no steps`);
      (job.steps ?? []).forEach((step, i) => {
        const kinds = ['run', 'uses'].filter((k) => k in step);
        if (kinds.length !== 1) err(`job ${id} step ${i + 1}: needs exactly one of run/uses`);
      });
    }
    for (const need of [].concat(job.needs ?? [])) {
      if (!(need in jobs)) err(`job ${id}: needs unknown job "${need}"`);
    }
  }
  // Cycles in `needs`.
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') return err(`needs cycle: ${[...trail, id].join(' → ')}`);
    state.set(id, 'open');
    for (const need of [].concat(jobs[id]?.needs ?? []))
      if (need in jobs) visit(need, [...trail, id]);
    state.set(id, 'done');
  };
  Object.keys(jobs).forEach((id) => visit(id, []));
  // Expressions.
  const opens = (text.match(/\$\{\{/g) ?? []).length;
  const closes = (text.match(/\}\}/g) ?? []).length;
  if (opens > closes) err(`unbalanced \${{ }} (${opens} opened, ${closes} closed)`);
  // Local scripts.
  for (const m of text.matchAll(
    /(?:node|tsx)\s+((?:\.github\/)?scripts\/[\w./-]+\.(?:m?js|ts))/g,
  )) {
    if (!existsSync(path.join(root, m[1]))) err(`referenced script ${m[1]} does not exist`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`workflows OK (${jobsSeen} jobs checked)`);
