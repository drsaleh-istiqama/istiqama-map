#!/usr/bin/env node
/* global process, console, URL */
/**
 * CI-only tuning of supabase/config.toml on the RUNNER's checkout (never committed).
 *
 * The e2e suite signs in many accounts through e-mail OTP within minutes. GoTrue's defaults
 * (one OTP e-mail per address per 60 s, 30 sign-ins / 5 min per IP, …) are right for a real
 * deployment and wrong for an automated suite on the loopback, so the CI stack relaxes them:
 *
 *   [auth.email]       max_frequency = "1s"
 *   [auth.rate_limit]  email_sent / sms_sent / sign_in_sign_ups / token_verifications /
 *                      token_refresh = 1000
 *
 * Keys already present in config.toml are left as they are (the file stays the source of
 * truth). Usage: node .github/scripts/ci-supabase-config.mjs [path/to/config.toml]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file =
  process.argv[2] ?? fileURLToPath(new URL('../../supabase/config.toml', import.meta.url));

const WANTED = {
  'auth.email': { max_frequency: '"1s"' },
  'auth.rate_limit': {
    email_sent: '1000',
    sms_sent: '1000',
    sign_in_sign_ups: '1000',
    token_verifications: '1000',
    token_refresh: '1000',
  },
};

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const header = (line) => /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)?.[1]?.trim();
const changes = [];

for (const [table, keys] of Object.entries(WANTED)) {
  const start = lines.findIndex((l) => header(l) === table);
  if (start < 0) {
    lines.push('', `# Added by .github/scripts/ci-supabase-config.mjs (CI runner only)`);
    lines.push(`[${table}]`);
    for (const [k, v] of Object.entries(keys)) {
      lines.push(`${k} = ${v}`);
      changes.push(`[${table}] ${k} = ${v} (new table)`);
    }
    continue;
  }
  let end = start + 1;
  while (end < lines.length && header(lines[end]) === undefined) end++;
  const body = lines.slice(start + 1, end);
  const missing = Object.entries(keys).filter(
    ([k]) => !body.some((l) => new RegExp(`^\\s*${k}\\s*=`).test(l)),
  );
  lines.splice(start + 1, 0, ...missing.map(([k, v]) => `${k} = ${v}`));
  for (const [k, v] of missing) changes.push(`[${table}] ${k} = ${v}`);
}

writeFileSync(file, lines.join('\n'));
console.log(changes.length ? changes.join('\n') : 'config.toml already has every CI setting');
