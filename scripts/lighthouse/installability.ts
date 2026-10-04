/**
 * Installability checks — what Lighthouse's former PWA category verified (removed in
 * Lighthouse 12), asked of Chrome itself where possible:
 *
 *   Page.getInstallabilityErrors   Chrome's own verdict (empty list = installable; needs a
 *                                  PERSISTENT profile — an incognito context reports
 *                                  "in-incognito")
 *   Page.getAppManifest            the manifest Chrome parsed, with its parse errors
 *   + the manifest fields and icons of brief §12 (PNG 192 and 512, separate maskable icon,
 *     apple-touch-icon), the service worker controlling the start URL, the start URL served
 *     OFFLINE by the service worker, viewport / theme-color / lang / dir.
 */
import type { BrowserContext } from 'playwright';

export interface Check {
  id: string;
  ok: boolean;
  /** "error" checks fail --enforce; "warn" checks are reported only. */
  level: 'error' | 'warn';
  detail: string;
}

interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

interface Manifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  lang?: string;
  dir?: string;
  icons?: ManifestIcon[];
}

/** Width × height from a PNG's IHDR chunk (bytes 16–23), or null if not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function checkInstallability(
  context: BrowserContext,
  baseUrl: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, level: Check['level'] = 'error'): void => {
    checks.push({ id, ok, level, detail });
  };

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const response = await page.goto(baseUrl + '/', { waitUntil: 'load' });
  add(
    'start-url-200',
    response?.status() === 200,
    `GET / → ${response?.status() ?? 'no response'}`,
  );

  // Service worker: registered, activated, and controlling the page after a reload.
  const swReady = await page
    .evaluate(
      () =>
        Promise.race([
          navigator.serviceWorker.ready.then((r) => r.active?.scriptURL ?? 'no active worker'),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 20_000)),
        ]),
      undefined,
    )
    .catch(() => '');
  add('service-worker-registered', !!swReady, swReady || 'no service worker within 20 s');
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  add(
    'service-worker-controls-start-url',
    controlled,
    controlled ? 'controller present' : 'page not controlled after reload',
  );

  // Chrome's own installability verdict.
  const inst = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string; errorArguments: { name: string; value: string }[] }[];
  };
  const errs = inst.installabilityErrors.map(
    (e) =>
      e.errorId +
      (e.errorArguments.length ? `(${e.errorArguments.map((a) => a.value).join(', ')})` : ''),
  );
  add(
    'chrome-installable',
    errs.length === 0,
    errs.length ? errs.join('; ') : 'Chrome reports no installability error',
  );

  // The manifest Chrome parsed.
  const parsed = (await cdp.send('Page.getAppManifest')) as {
    url: string;
    errors: { message: string; critical: number }[];
    data?: string;
  };
  add('manifest-linked', !!parsed.url, parsed.url || 'no <link rel="manifest">');
  add(
    'manifest-parses',
    parsed.errors.length === 0 && !!parsed.data,
    parsed.errors.length ? parsed.errors.map((e) => e.message).join('; ') : 'no parse errors',
  );
  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(parsed.data ?? '{}') as Manifest;
  } catch {
    // reported by manifest-parses
  }
  add('manifest-name', !!manifest.name, `name: ${manifest.name ?? '—'}`);
  add('manifest-short-name', !!manifest.short_name, `short_name: ${manifest.short_name ?? '—'}`);
  add(
    'manifest-short-name-length',
    (manifest.short_name ?? '').length <= 12,
    `${(manifest.short_name ?? '').length} characters (launchers may truncate after ~12)`,
    'warn',
  );
  add('manifest-id', !!manifest.id, `id: ${manifest.id ?? '—'}`, 'warn');
  add(
    'manifest-display',
    ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display ?? ''),
    `display: ${manifest.display ?? '—'}`,
  );
  const manifestUrl = parsed.url || baseUrl + '/manifest.webmanifest';
  const startUrl = new URL(manifest.start_url ?? '/', manifestUrl);
  const scopeUrl = new URL(manifest.scope ?? '/', manifestUrl);
  add(
    'manifest-start-url-in-scope',
    startUrl.href.startsWith(scopeUrl.href),
    `start_url ${startUrl.pathname} within scope ${scopeUrl.pathname}`,
  );
  add(
    'manifest-theme-color',
    !!manifest.theme_color,
    `theme_color: ${manifest.theme_color ?? '—'}`,
  );
  add(
    'manifest-background-color',
    !!manifest.background_color,
    `background_color: ${manifest.background_color ?? '—'}`,
  );
  add(
    'manifest-lang-dir',
    !!manifest.lang && !!manifest.dir,
    `lang: ${manifest.lang ?? '—'}, dir: ${manifest.dir ?? '—'}`,
    'warn',
  );

  // Icons: fetched and decoded, sizes must be what the manifest says.
  const icons = manifest.icons ?? [];
  const iconFacts: { purpose: string; size: number; png: boolean }[] = [];
  for (const icon of icons) {
    const url = new URL(icon.src, manifestUrl).href;
    const res = await context.request.get(url);
    const body = await res.body();
    const dims = pngSize(body);
    const declared = /^(\d+)x(\d+)$/.exec((icon.sizes ?? '').split(/\s+/)[0] ?? '');
    const sizeOk =
      !!dims &&
      !!declared &&
      dims.width === Number(declared[1]) &&
      dims.height === Number(declared[2]);
    add(
      `icon ${icon.src}`,
      res.status() === 200 && !!dims && sizeOk,
      `${res.status()} ${res.headers()['content-type'] ?? '?'} ${dims ? `${dims.width}×${dims.height}` : 'not a PNG'} (declared ${icon.sizes ?? '—'}, purpose ${icon.purpose ?? 'any'})`,
    );
    if (dims) {
      for (const purpose of (icon.purpose ?? 'any').split(/\s+/)) {
        iconFacts.push({ purpose, size: Math.min(dims.width, dims.height), png: true });
      }
    }
  }
  const has = (purpose: string, size: number): boolean =>
    iconFacts.some((i) => i.purpose === purpose && i.size >= size && i.png);
  add('icon-png-192', has('any', 192), 'PNG icon ≥ 192 px (purpose any)');
  add('icon-png-512', has('any', 512), 'PNG icon ≥ 512 px (purpose any)');
  add('icon-maskable', has('maskable', 192), 'separate maskable PNG icon (brief §12)');

  // Document head.
  const head = await page.evaluate(() => {
    const meta = (name: string): string | null =>
      document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
    return {
      viewport: meta('viewport'),
      themeColor: meta('theme-color'),
      appleTouchIcon:
        document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
      lang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      title: document.title,
    };
  });
  add(
    'viewport',
    !!head.viewport &&
      /width=device-width/.test(head.viewport) &&
      !/user-scalable=no|maximum-scale=1(\.0)?\b/.test(head.viewport),
    `viewport: ${head.viewport ?? '—'}`,
  );
  add(
    'theme-color-meta',
    !!head.themeColor,
    `<meta name="theme-color">: ${head.themeColor ?? '—'}`,
  );
  if (head.appleTouchIcon) {
    const res = await context.request.get(new URL(head.appleTouchIcon, baseUrl + '/').href);
    const dims = pngSize(await res.body());
    add(
      'apple-touch-icon',
      res.status() === 200 && !!dims && dims.width >= 180,
      `${head.appleTouchIcon}: ${res.status()} ${dims ? `${dims.width}×${dims.height}` : 'not a PNG'}`,
    );
  } else add('apple-touch-icon', false, 'no <link rel="apple-touch-icon">');
  add('document-title', !!head.title, `title: ${head.title || '—'}`);
  add('html-lang-dir', !!head.lang && !!head.dir, `<html lang="${head.lang}" dir="${head.dir}">`);

  // Offline: the service worker must serve the start URL with the network gone.
  await context.setOffline(true);
  let offlineDetail: string;
  let offlineOk = false;
  try {
    const off = await page.goto(startUrl.href, { waitUntil: 'load', timeout: 20_000 });
    // The shell is rendered by JavaScript after load: wait for the first test id to appear.
    await page
      .locator('[data-testid]')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    const shell = await page.evaluate(() => ({
      title: document.title,
      nodes: document.body?.querySelectorAll('*').length ?? 0,
    }));
    offlineOk = (off?.status() ?? 0) === 200 && shell.nodes > 10;
    offlineDetail = `offline GET ${startUrl.pathname} → ${off?.status() ?? 'none'}, ${shell.nodes} elements rendered`;
  } catch (error) {
    offlineDetail = `offline load failed: ${String(error).split('\n')[0]}`;
  }
  await context.setOffline(false);
  add('offline-start-url', offlineOk, offlineDetail);

  const scheme = new URL(baseUrl).protocol;
  add(
    'https',
    scheme === 'https:' || ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname),
    scheme === 'https:'
      ? 'served over HTTPS'
      : 'loopback over http (allowed by Chrome); production must be HTTPS + HSTS (public/_headers)',
  );

  await page.close();
  return checks;
}
