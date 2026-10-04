import { describe, expect, it } from 'vitest';
import { buildCsp, cspDirectives, cspHash, originOf, sentryIngestOrigin, wsOrigin } from './csp';

const production = {
  supabaseUrl: 'https://abcd.supabase.co',
  tilesUrl: 'https://abcd.supabase.co/storage/v1/object/public/tiles',
  sentryDsn: 'https://0123456789abcdef@o4500000.ingest.sentry.io/4500001',
};
const local = {
  supabaseUrl: 'http://127.0.0.1:54321',
  tilesUrl: 'http://127.0.0.1:54321/storage/v1/object/public/tiles',
  sentryDsn: '',
};

describe('origin helpers', () => {
  it('reduce URLs to origins and reject anything else', () => {
    expect(originOf('https://abcd.supabase.co/rest/v1/')).toBe('https://abcd.supabase.co');
    expect(originOf('http://127.0.0.1:54321/storage/v1')).toBe('http://127.0.0.1:54321');
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf("data:text/html,<script>'unsafe-inline'</script>")).toBeNull();
  });

  it('derive the websocket origin for Realtime', () => {
    expect(wsOrigin('https://abcd.supabase.co')).toBe('wss://abcd.supabase.co');
    expect(wsOrigin('http://127.0.0.1:54321')).toBe('ws://127.0.0.1:54321');
  });

  it('take only the ingest host of a Sentry DSN — never the key', () => {
    expect(sentryIngestOrigin(production.sentryDsn)).toBe('https://o4500000.ingest.sentry.io');
    expect(sentryIngestOrigin('')).toBeNull();
  });
});

describe('Content-Security-Policy', () => {
  it('is strict in production', () => {
    const d = cspDirectives(production);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['style-src']).toEqual(["'self'"]);
    expect(d['font-src']).toEqual(["'self'"]);
    expect(d['worker-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['upgrade-insecure-requests']).toEqual([]);
  });

  it('never allows inline scripts, eval, wasm or wildcards', () => {
    for (const input of [production, local, { ...local, dev: true }]) {
      const policy = buildCsp(input, 'header');
      const script = policy.split('; ').find((part) => part.startsWith('script-src')) ?? '';
      expect(script).toBe("script-src 'self'");
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).not.toMatch(/(^|\s)\*(\s|;|$)/);
      expect(policy).not.toContain('https:;');
    }
  });

  it('takes img and connect origins from the environment', () => {
    const d = cspDirectives(production);
    expect(d['img-src']).toEqual(["'self'", 'blob:', 'data:', 'https://abcd.supabase.co']);
    expect(d['connect-src']).toEqual([
      "'self'",
      'blob:',
      'https://abcd.supabase.co',
      'wss://abcd.supabase.co',
      'https://o4500000.ingest.sentry.io',
    ]);
  });

  it('adds a separate tiles origin and leaves Sentry out when no DSN is set', () => {
    const d = cspDirectives({
      supabaseUrl: 'https://api.example.org',
      tilesUrl: 'https://tiles.example.org/v1',
    });
    expect(d['img-src']).toContain('https://tiles.example.org');
    expect(d['connect-src']).toEqual([
      "'self'",
      'blob:',
      'https://api.example.org',
      'wss://api.example.org',
      'https://tiles.example.org',
    ]);
    expect(buildCsp({ supabaseUrl: 'https://api.example.org' }, 'header')).not.toContain('sentry');
  });

  it('works against the local stack over http without upgrade-insecure-requests', () => {
    const policy = buildCsp(local, 'header');
    expect(policy).toContain(
      'connect-src ' + "'self' blob: http://127.0.0.1:54321 ws://127.0.0.1:54321",
    );
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('allows the inline critical CSS by hash only, never by unsafe-inline', async () => {
    // Reference value: Node's crypto.createHash('sha256').update(text).digest('base64').
    const hash = await cspHash('body{margin:0}');
    expect(hash).toBe("'sha256-IAdwN3biDCQ3brrgp1m8kBEsPQYyqfREKOEfeoREopc='");
    expect(await cspHash('body{margin:1px}')).not.toBe(hash);
    const d = cspDirectives({ ...production, styleHashes: [hash, hash] });
    expect(d['style-src']).toEqual(["'self'", hash]);
    expect(buildCsp({ ...production, styleHashes: [hash] }, 'meta')).not.toContain('unsafe-inline');
    // In dev a hash would disable 'unsafe-inline', which Vite's injected <style> elements need.
    expect(cspDirectives({ ...local, dev: true, styleHashes: [hash] })['style-src']).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
  });

  it('relaxes only what the Vite dev server needs', () => {
    const d = cspDirectives({ ...local, dev: true });
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['connect-src']).toContain('ws://localhost:*');
    expect(d['script-src']).toEqual(["'self'"]);
  });

  it('omits header-only directives from the <meta> form', () => {
    const meta = buildCsp(production, 'meta');
    const header = buildCsp(production, 'header');
    expect(header).toContain("frame-ancestors 'none'");
    expect(meta).not.toContain('frame-ancestors');
    expect(meta).toContain("default-src 'self'");
    expect(meta).not.toContain('"'); // safe inside content="…"
    expect(header.split('; ').length).toBe(meta.split('; ').length + 1);
  });

  it('ignores a malformed environment instead of emitting a broken policy', () => {
    const policy = buildCsp(
      { supabaseUrl: 'not a url', tilesUrl: 'javascript:alert(1)', sentryDsn: 'x' },
      'header',
    );
    expect(policy).toContain("connect-src 'self' blob:;");
    expect(policy).not.toContain('javascript');
    expect(policy).not.toContain('not a url');
  });
});
