#!/usr/bin/env node
/* global process, console */
/**
 * Prints the CI Supabase stack's URLs and keys as KEY=value lines for $GITHUB_ENV:
 *
 *   node .github/scripts/supabase-ci-env.mjs >> "$GITHUB_ENV"
 *
 * Names follow .env.example, so the Vite build, the Playwright specs (helpers.ts reads
 * process.env first, .env.local only as a fallback) and the /dev/otp proxy all see the same
 * values. These are the local stack's well-known development keys — not secrets.
 */
import { execFileSync } from 'node:child_process';

const raw = execFileSync('supabase', ['status', '-o', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const status = JSON.parse(raw.slice(raw.indexOf('{')));
const pick = (...names) => {
  for (const name of names) if (status[name]) return String(status[name]);
  return '';
};

const apiUrl = pick('API_URL').replace('localhost', '127.0.0.1') || 'http://127.0.0.1:54321';
const anon = pick('ANON_KEY', 'PUBLISHABLE_KEY');
const service = pick('SERVICE_ROLE_KEY', 'SECRET_KEY');
const mail = pick('MAILPIT_URL', 'INBUCKET_URL').replace('localhost', '127.0.0.1');
if (!anon || !service) {
  console.error(
    'supabase status did not report the anon / service-role keys:',
    Object.keys(status),
  );
  process.exit(1);
}

const out = {
  SUPABASE_URL: apiUrl,
  SUPABASE_ANON_KEY: anon,
  SUPABASE_SERVICE_ROLE_KEY: service,
  SUPABASE_JWT_SECRET: pick('JWT_SECRET'),
  DATABASE_URL: pick('DB_URL'),
  MAIL_CATCHER_URL: mail || 'http://127.0.0.1:54324',
  VITE_SUPABASE_URL: apiUrl,
  VITE_SUPABASE_ANON_KEY: anon,
  VITE_TILES_URL: `${apiUrl}/storage/v1/object/public/tiles`,
  VITE_APP_ENV: 'ci',
  OTP_PROVIDER: 'fake',
};
for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`);
