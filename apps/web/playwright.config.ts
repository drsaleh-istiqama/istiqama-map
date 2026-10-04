/**
 * End-to-end suite (docs/contracts/web.md §1, §4): Playwright against the BUILT app served by
 * `vite preview` on http://127.0.0.1:4173 and a running stack (local gateway on :54321 or a
 * staging Supabase project with the staging seed).
 *
 *   npm run e2e -w apps/web               # builds + previews unless a server already listens
 *   E2E_SUPABASE_URL=… npm run e2e -w apps/web
 *
 * Browsers are not downloaded: the installed Google Chrome is used (`channel: 'chrome'`).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { loadEnv } from 'vite';

const baseURL = 'http://127.0.0.1:4173';

// The specs see the same PUBLIC variables the build uses (VITE_* of the repository's
// .env.local / environment) — never the service-role key or the JWT secret.
const publicEnv = loadEnv('production', fileURLToPath(new URL('../..', import.meta.url)), 'VITE_');
for (const [key, value] of Object.entries(publicEnv)) process.env[key] ??= value;

export default defineConfig({
  testDir: './tests/e2e',
  // The specs share one staging database and real accounts: run them one after the other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  webServer: {
    // Build first so the service worker and the CSP match the current sources and .env.local.
    command: 'npm run build && npm run preview',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
