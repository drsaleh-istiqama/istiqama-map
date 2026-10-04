/**
 * Content-Security-Policy builder (brief §11).
 *
 * Pure and dependency-free: it is imported by `vite.config.ts` at build time (to fill the
 * `<meta>` tag of index.html and the `_headers` file) and unit-tested like any other module.
 * Every origin comes from the build environment — nothing is hard-coded.
 */

export interface CspInput {
  /** VITE_SUPABASE_URL — REST, Auth, Storage (TUS), Functions and Realtime. */
  supabaseUrl: string;
  /** VITE_TILES_URL — PMTiles basemap, glyphs, sprites and map packs. */
  tilesUrl?: string;
  /** VITE_SENTRY_DSN — only its ingest origin is allowed, and only when set. */
  sentryDsn?: string;
  /** Vite dev server: HMR needs a websocket and injected <style> elements. */
  dev?: boolean;
}

export type CspDirectives = Record<string, string[]>;

/** `scheme://host[:port]` of an absolute URL, or null when it is empty or invalid. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Websocket twin of an http(s) origin (Supabase Realtime). */
export function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}

/** Ingest origin of a Sentry DSN (`https://<key>@o123.ingest.sentry.io/456` → host only, no key). */
export function sentryIngestOrigin(dsn: string | undefined | null): string | null {
  return originOf(dsn);
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

export function cspDirectives(input: CspInput): CspDirectives {
  const supabase = originOf(input.supabaseUrl);
  const tiles = originOf(input.tilesUrl);
  const sentry = sentryIngestOrigin(input.sentryDsn);
  const remote = unique([supabase, tiles, sentry]);
  const allHttps = remote.length > 0 && remote.every((o) => o.startsWith('https://'));

  const directives: CspDirectives = {
    'default-src': ["'self'"],
    // No inline scripts, no eval, no wasm: MapLibre GL 6 shapes Arabic text itself (the
    // WebAssembly RTL plugin is deprecated and not loaded), so 'wasm-unsafe-eval' is not needed.
    'script-src': ["'self'"],
    // Production CSS is extracted into hashed files. Preact and MapLibre set element styles
    // through the CSSOM (element.style), which CSP does not restrict, so no 'unsafe-inline'.
    // The Vite dev server injects <style> elements for HMR, hence the dev-only exception.
    'style-src': input.dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // blob: local photo previews and MapLibre images; data: MapLibre's tiny inline images.
    'img-src': unique(["'self'", 'blob:', 'data:', supabase, tiles]),
    'font-src': ["'self'"],
    // blob: lets the app read back its own object URLs with fetch().
    'connect-src': unique([
      "'self'",
      'blob:',
      supabase,
      supabase ? wsOrigin(supabase) : null,
      tiles,
      sentry,
      ...(input.dev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
    ]),
    // MapLibre GL 6 starts its module worker from a same-origin URL; blob: workers are only
    // used for cross-origin worker scripts, which this app never has.
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  if (allHttps && !input.dev) directives['upgrade-insecure-requests'] = [];
  return directives;
}

/** Directives a `<meta http-equiv>` policy ignores (they only work as HTTP headers). */
const HEADER_ONLY = new Set(['frame-ancestors', 'report-uri', 'report-to', 'sandbox']);

export function serializeCsp(directives: CspDirectives, target: 'header' | 'meta'): string {
  return Object.entries(directives)
    .filter(([name]) => target === 'header' || !HEADER_ONLY.has(name))
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

export function buildCsp(input: CspInput, target: 'header' | 'meta'): string {
  return serializeCsp(cspDirectives(input), target);
}
