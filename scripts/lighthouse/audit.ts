/**
 * Local Lighthouse stand-in (docs/CI.md §4). Lighthouse itself is NOT installed on the
 * development machine and nothing may be downloaded, so this script reproduces what it can with
 * Playwright + the Chrome DevTools Protocol, on a PREVIEW build of the app:
 *
 *   metrics          FCP / LCP / TBT / CLS of the login page (cold load) and of the map page
 *                    (returning field user: service-worker caches warm, PIN lock → map ready)
 *                    under applied mobile throttling profiles (metrics.ts), median of N runs,
 *                    plus an ESTIMATED Lighthouse performance score (scoring.ts); the login
 *                    page also reports when the real sign-in form appears ("sign-in form"),
 *                    because the static splash of index.html is the first paint and LCP
 *                    (docs/CI.md §6.3)
 *   installability   Chrome's own installability verdict + manifest / icons / service worker /
 *                    offline start URL (installability.ts) — the former Lighthouse PWA category
 *   accessibility    axe-core with Lighthouse's rule set + estimated score, design-token
 *                    contrast, labels, landmarks, tap targets (a11y.ts)
 *
 * The OFFICIAL Lighthouse scores (brief §14.7) are produced only by Lighthouse CI in
 * .github/workflows/ci.yml. Numbers from this script are estimates and are labelled as such.
 *
 *   npx tsx scripts/lighthouse/audit.ts --serve .local/lighthouse/dist --url http://127.0.0.1:5173
 *   npx tsx scripts/lighthouse/audit.ts --url http://127.0.0.1:4173 --pages login --no-metrics --enforce
 *
 * Options: --url <origin>  --serve <built dist dir: started with `vite preview` on --url's port>
 *          --pages login,map  --profiles lh-mobile,3g,slow-3g  --runs 3  --browser chrome|chromium
 *          --api <Supabase URL with /dev/otp, map page only>  --email <seeded account>  --pin <PIN>
 *          --no-metrics  --enforce (exit 1 when an error-level check fails)  --out <report.json>
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import { checkAccessibility, type A11yReport } from './a11y.ts';
import { checkInstallability, type Check } from './installability.ts';
import {
  applyThrottling,
  clearThrottling,
  OBSERVER_SCRIPT,
  PROFILES,
  readMetrics,
  trackTransfer,
  waitQuiet,
  type LoadMetrics,
  type ThrottleProfile,
} from './metrics.ts';
import { estimatePerformance, median } from './scoring.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(ROOT, 'apps', 'web');

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const str = (k: string, d: string): string =>
  typeof args[k] === 'string' ? (args[k] as string) : d;
const BASE = str('url', 'http://127.0.0.1:5173').replace(/\/$/, '');
const PAGES = str('pages', 'login,map').split(',').filter(Boolean);
const PROFILE_IDS = str('profiles', 'lh-mobile,3g,slow-3g').split(',').filter(Boolean);
const RUNS = Math.max(1, Number(str('runs', '3')));
const CHANNEL = str('browser', 'chrome');
const API = str(
  'api',
  process.env.E2E_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321',
).replace(/\/$/, '');
const EMAIL = str('email', 'collector.pemba@example.org');
const PIN = str('pin', '482916');
const METRICS = !args['no-metrics'];

/** Lighthouse's emulated phone (Moto G Power 2022). */
const MOBILE: BrowserContextOptions = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  locale: 'ar',
  serviceWorkers: 'allow',
};

/**
 * tsx (esbuild, keepNames) wraps named inner functions in `__name(…)`; functions passed to
 * page.evaluate run in the page, where that helper does not exist. Define it there first.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((fn) => fn);';

async function newContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript(NAME_SHIM);
  return context;
}

const launchOptions = (): Parameters<typeof chromium.launch>[0] =>
  CHANNEL === 'chromium' ? { headless: true } : { channel: CHANNEL, headless: true };

// ---------------------------------------------------------------------------------------------
// Preview server (optional)
// ---------------------------------------------------------------------------------------------

async function waitFor(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startPreview(dir: string): Promise<ChildProcess> {
  const u = new URL(BASE);
  // `vite/bin/vite.js` is not in the package's exports map: resolve the package root instead.
  const vitePkg = createRequire(path.join(WEB, 'package.json')).resolve('vite/package.json');
  const vite = path.join(path.dirname(vitePkg), 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [
      vite,
      'preview',
      '--outDir',
      path.resolve(ROOT, dir),
      '--host',
      u.hostname,
      '--port',
      u.port || '80',
      '--strictPort',
    ],
    { cwd: WEB, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[preview] ${d}`));
  if (!(await waitFor(BASE + '/', 30_000))) {
    child.kill();
    throw new Error(`vite preview did not answer on ${BASE}`);
  }
  return child;
}

// ---------------------------------------------------------------------------------------------
// Sign-in on a persistent profile (map page)
// ---------------------------------------------------------------------------------------------

async function otp(identifier: string): Promise<string> {
  const res = await fetch(`${API}/dev/otp?identifier=${encodeURIComponent(identifier)}`);
  if (!res.ok) return '';
  return String(((await res.json()) as { code?: unknown }).code ?? '');
}

async function signIn(page: Page): Promise<void> {
  await page.goto(BASE + '/');
  await page.getByTestId('login-email').fill(EMAIL);
  const before = await otp(EMAIL).catch(() => '');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('login-code').waitFor({ timeout: 30_000 });
  let code = '';
  for (let i = 0; i < 40; i++) {
    code = await otp(EMAIL).catch(() => '');
    if (/^\d{6}$/.test(code) && code !== before) break;
    if (i > 6 && /^\d{6}$/.test(code)) break; // the provider may repeat a code
    await page.waitForTimeout(500);
  }
  if (!/^\d{6}$/.test(code)) throw new Error(`no OTP for ${EMAIL} at ${API}/dev/otp`);
  await page.getByTestId('login-code').fill(code);
  await page.getByTestId('login-verify').click();
  await page.getByTestId('pin-confirm').waitFor({ timeout: 30_000 });
  await page.getByTestId('pin-input').fill(PIN);
  await page.getByTestId('pin-confirm').fill(PIN);
  await page.getByTestId('pin-submit').click();
  await page.getByTestId('sync-badge').waitFor({ timeout: 30_000 });
  await page
    .locator('[data-testid="sync-last"][data-at]')
    .first()
    .waitFor({ state: 'attached', timeout: 120_000 });
  await page.waitForFunction(
    () =>
      /^\d+$/.test(
        document.querySelector('[data-testid="sync-last"]')?.getAttribute('data-at') ?? '',
      ),
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

async function openMap(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.history.pushState({ key: `lh-${Date.now()}` }, '', '/map');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

async function mapReady(page: Page, timeout = 120_000): Promise<string> {
  await page.locator('[data-testid="map-view"][data-state="ready"]').first().waitFor({ timeout });
  return (await page.getByTestId('map-view').first().getAttribute('data-basemap')) ?? '?';
}

async function persistent(dir: string, extra: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    ...launchOptions(),
    ...MOBILE,
    ...extra,
  });
  await context.addInitScript(NAME_SHIM);
  return context;
}

// ---------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------

interface RunResult extends LoadMetrics {
  unlockToMapReadyMs?: number;
  /** Login page: navigation start → the e-mail field of the real sign-in form is in the DOM. */
  signInReadyMs?: number;
  basemap?: string;
}

/**
 * Records when the interactive sign-in form appears. Since the static splash of index.html is
 * the first paint (and usually the LCP element), FCP/LCP no longer say when the user can type:
 * this is reported next to them so the splash cannot hide a slow sign-in screen.
 */
const SIGN_IN_READY_SCRIPT = `(() => {
  const mark = () => {
    if (window.__signInReady == null && document.querySelector('[data-testid="login-email"]')) {
      window.__signInReady = performance.now();
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(mark);
  observer.observe(document, { subtree: true, childList: true });
})();`;

async function measureLogin(browser: Browser, profile: ThrottleProfile): Promise<RunResult> {
  const context = await newContext(browser, MOBILE);
  await context.addInitScript(OBSERVER_SCRIPT);
  await context.addInitScript(SIGN_IN_READY_SCRIPT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await applyThrottling(cdp, profile);
  const stop = trackTransfer(cdp);
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId('login-email').waitFor({ timeout: 60_000 });
  await waitQuiet(page);
  const metrics = await readMetrics(page, stop());
  const ready = await page.evaluate(
    () => (window as unknown as { __signInReady?: number }).__signInReady ?? null,
  );
  await context.close();
  return { ...metrics, ...(ready !== null ? { signInReadyMs: Math.round(ready) } : {}) };
}

async function measureMap(dir: string, profile: ThrottleProfile): Promise<RunResult> {
  const context = await persistent(dir);
  await context.addInitScript(OBSERVER_SCRIPT);
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await applyThrottling(cdp, profile);
  const stop = trackTransfer(cdp);
  await page.goto(BASE + '/map', { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId('pin-input').waitFor({ timeout: 60_000 });
  await page.getByTestId('pin-input').fill(PIN);
  const t0 = Date.now();
  await page.getByTestId('pin-submit').click();
  const basemap = await mapReady(page);
  const unlockToMapReadyMs = Date.now() - t0;
  await waitQuiet(page, 3000, 30_000);
  const metrics = await readMetrics(page, stop());
  await clearThrottling(cdp).catch(() => undefined);
  await context.close();
  return { ...metrics, unlockToMapReadyMs, basemap };
}

interface Summary {
  page: string;
  profile: string;
  runs: RunResult[];
  median: {
    fcp: number | null;
    lcp: number | null;
    tbt: number;
    cls: number;
    load: number | null;
    unlockToMapReadyMs?: number;
    signInReadyMs?: number;
    transferKB: number;
    requests: number;
  };
  estimatedPerformance: number | null;
}

function summarize(pageName: string, profile: string, runs: RunResult[]): Summary {
  const nums = (pick: (r: RunResult) => number | null | undefined): number[] =>
    runs.map(pick).filter((v): v is number => typeof v === 'number');
  const med = (pick: (r: RunResult) => number | null | undefined): number | null => {
    const v = nums(pick);
    return v.length ? Math.round(median(v) * 1000) / 1000 : null;
  };
  const fcp = med((r) => r.fcp);
  const lcp = med((r) => r.lcp);
  const tbt = med((r) => r.tbt) ?? 0;
  const cls = med((r) => r.cls) ?? 0;
  const unlock = med((r) => r.unlockToMapReadyMs);
  const signIn = med((r) => r.signInReadyMs);
  return {
    page: pageName,
    profile,
    runs,
    median: {
      fcp,
      lcp,
      tbt,
      cls,
      load: med((r) => r.load),
      ...(unlock !== null ? { unlockToMapReadyMs: unlock } : {}),
      ...(signIn !== null ? { signInReadyMs: signIn } : {}),
      transferKB: Math.round((med((r) => r.transferBytes) ?? 0) / 1024),
      requests: med((r) => r.requests) ?? 0,
    },
    estimatedPerformance:
      fcp !== null && lcp !== null ? estimatePerformance({ fcp, lcp, tbt, cls }).score : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function printChecks(title: string, checks: Check[]): void {
  console.log(`\n${title}`);
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.level === 'error' ? 'FAIL' : 'warn';
    console.log(`  ${mark} ${c.id.padEnd(38)} ${c.detail}`);
  }
}

async function main(): Promise<void> {
  const preview = typeof args.serve === 'string' ? await startPreview(args.serve) : null;
  const work = path.join(ROOT, '.local', 'lighthouse');
  mkdirSync(work, { recursive: true });
  const report: {
    generatedAt: string;
    url: string;
    browser: string;
    note: string;
    installability?: Check[];
    accessibility: Record<string, A11yReport>;
    metrics: Summary[];
    errors: string[];
  } = {
    generatedAt: new Date().toISOString(),
    url: BASE,
    browser: CHANNEL,
    note: 'Estimates from Playwright + CDP. Official Lighthouse scores are produced only in CI (docs/CI.md §4).',
    accessibility: {},
    metrics: [],
    errors: [],
  };
  const browser = await chromium.launch(launchOptions());
  try {
    console.log(`Chrome ${browser.version()} — ${BASE}`);

    // Installability (fresh persistent mobile profile — Chrome refuses to judge installability
    // in an incognito context — no throttling).
    {
      const dir = mkdtempSync(path.join(work, 'profile-install-'));
      const context = await persistent(dir);
      report.installability = await checkInstallability(context, BASE);
      await context.close();
      rmSync(dir, { recursive: true, force: true });
      printChecks('Installability (former Lighthouse PWA category)', report.installability);
    }

    // Accessibility of the login page.
    if (PAGES.includes('login')) {
      const context = await newContext(browser, { ...MOBILE, bypassCSP: true });
      const page = await context.newPage();
      await page.goto(BASE + '/');
      await page.getByTestId('login-email').waitFor({ timeout: 30_000 });
      report.accessibility.login = await checkAccessibility(page);
      await context.close();
      printChecks(
        `Accessibility — login (axe estimate ${report.accessibility.login.axe.estimatedScore}/100)`,
        report.accessibility.login.checks,
      );
    }

    // Map page: one persistent "device", signed in once.
    let profileDir = '';
    if (PAGES.includes('map')) {
      profileDir = mkdtempSync(path.join(work, 'profile-map-'));
      try {
        const context = await persistent(profileDir, { bypassCSP: true });
        const page = context.pages()[0] ?? (await context.newPage());
        await signIn(page);
        await openMap(page);
        const basemap = await mapReady(page);
        console.log(`\nmap page signed in as ${EMAIL}; basemap: ${basemap}`);
        report.accessibility.map = await checkAccessibility(page);
        printChecks(
          `Accessibility — map (axe estimate ${report.accessibility.map.axe.estimatedScore}/100)`,
          report.accessibility.map.checks,
        );
        await context.close();
      } catch (error) {
        const msg = `map page skipped: ${String(error).split('\n')[0]}`;
        report.errors.push(msg);
        console.log(`\n${msg}`);
        profileDir = '';
      }
    }

    if (METRICS) {
      for (const id of PROFILE_IDS) {
        const profile = PROFILES[id];
        if (!profile)
          throw new Error(`unknown profile ${id} (${Object.keys(PROFILES).join(', ')})`);
        for (const pageName of PAGES) {
          if (pageName === 'map' && !profileDir) continue;
          const runs: RunResult[] = [];
          for (let i = 0; i < RUNS; i++) {
            try {
              runs.push(
                pageName === 'map'
                  ? await measureMap(profileDir, profile)
                  : await measureLogin(browser, profile),
              );
            } catch (error) {
              report.errors.push(`${pageName}/${id} run ${i + 1}: ${String(error).split('\n')[0]}`);
            }
          }
          if (!runs.length) continue;
          const s = summarize(pageName, id, runs);
          report.metrics.push(s);
          const m = s.median;
          console.log(
            `\n${pageName.padEnd(5)} ${profile.label}\n  median of ${runs.length}: FCP ${m.fcp} ms · LCP ${m.lcp} ms · TBT ${m.tbt} ms · CLS ${m.cls} · load ${m.load} ms` +
              (m.unlockToMapReadyMs !== undefined
                ? ` · unlock→map ready ${m.unlockToMapReadyMs} ms`
                : '') +
              (m.signInReadyMs !== undefined ? ` · sign-in form ${m.signInReadyMs} ms` : '') +
              ` · ${m.requests} requests / ${m.transferKB} kB · est. performance ${s.estimatedPerformance ?? '—'}` +
              `
  LCP element: ${[...new Set(runs.map((r) => r.lcpElement))].join(' | ')}`,
          );
        }
      }
    }
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  } finally {
    await browser.close();
    preview?.kill();
  }

  if (typeof args.out === 'string') {
    writeFileSync(path.resolve(process.cwd(), args.out), JSON.stringify(report, null, 2));
    console.log(`\nreport: ${args.out}`);
  }
  for (const e of report.errors) console.log(`error: ${e}`);

  const failing = [
    ...(report.installability ?? []),
    ...Object.values(report.accessibility).flatMap((a) => a.checks),
  ].filter((c) => !c.ok && c.level === 'error');
  console.log(`\n${failing.length} error-level check(s) failing`);
  if (
    args.enforce &&
    (failing.length || report.errors.some((e) => !e.startsWith('map page skipped')))
  ) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
