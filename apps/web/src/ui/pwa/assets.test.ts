/**
 * Static PWA and security assets (brief §11, §12): web app manifest, icons, index.html and the
 * `_headers` file. Read from disk, so a broken icon or a weakened header fails the unit tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..', '..', '..');
const publicDir = path.join(webRoot, 'public');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  lang: string;
  dir: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
  shortcuts: Array<{ name: string; url: string; icons?: ManifestIcon[] }>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'),
) as Manifest;
const indexHtml = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const headers = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');

/** Arabic letters (U+0621–U+064A), built at runtime so the source stays ASCII. */
const ARABIC = new RegExp(`[${String.fromCharCode(0x0621)}-${String.fromCharCode(0x064a)}]`);

/** Width and height from the IHDR chunk of a PNG file. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1'), `${file} is a PNG`).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function publicFile(src: string): string {
  return path.join(publicDir, src.replace(/^\//, ''));
}

describe('web app manifest', () => {
  it('is Arabic and right-to-left, standalone, rooted at the app', () => {
    expect(manifest.name).toMatch(ARABIC);
    expect(manifest.short_name).toMatch(ARABIC);
    expect(manifest.lang).toBe('ar');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color.toLowerCase()).toBe('#0f2545');
    expect(manifest.background_color.toLowerCase()).toBe('#f6f7f9');
  });

  it('has PNG icons 192 and 512 (any) and a SEPARATE maskable 512, all present with the right size', () => {
    const any = manifest.icons.filter((icon) => (icon.purpose ?? 'any') === 'any');
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    expect(any.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512']);
    expect(maskable.map((icon) => icon.sizes)).toEqual(['512x512']);
    // "any maskable" on one file is exactly what v2 got wrong: the purposes must not share a file.
    expect(manifest.icons.some((icon) => (icon.purpose ?? '').includes(' '))).toBe(false);
    const maskableSrc = maskable[0]?.src;
    expect(any.map((icon) => icon.src)).not.toContain(maskableSrc);

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(publicFile(icon.src)), icon.src).toEqual({ width: w, height: h });
    }
  });

  it('offers the "add project" and "map" shortcuts with existing icons', () => {
    expect(manifest.shortcuts.map((s) => s.url)).toEqual(['/projects/new', '/map']);
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.name).toMatch(ARABIC);
      for (const icon of shortcut.icons ?? [])
        expect(fs.existsSync(publicFile(icon.src))).toBe(true);
    }
  });

  it('keeps the SVG sources of the icons next to the PNGs', () => {
    expect(fs.existsSync(path.join(publicDir, 'icons', 'icon.svg'))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, 'icons', 'icon-maskable-source.svg'))).toBe(true);
  });
});

describe('index.html', () => {
  it('starts in Arabic, right to left, with the manifest, favicon and apple-touch-icon', () => {
    expect(indexHtml).toMatch(/<html lang="ar" dir="rtl">/);
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const touch = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml)?.[1] ?? '';
    expect(pngSize(publicFile(touch))).toEqual({ width: 180, height: 180 });
    expect(fs.existsSync(path.join(publicDir, 'favicon.ico'))).toBe(true);
  });

  it('has no inline script, no inline style attribute and a slot for the CSP meta tag', () => {
    const scripts = [...indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [tag, body] of scripts) {
      expect(tag).toMatch(/\ssrc="/);
      expect((body ?? '').trim()).toBe('');
    }
    expect(indexHtml).not.toMatch(/\sstyle="/);
    expect(indexHtml).not.toMatch(/\son[a-z]+="/);
    expect(indexHtml).toContain('<!--csp-->');
  });
});

describe('_headers (Netlify / Cloudflare Pages)', () => {
  const header = (name: string): string =>
    new RegExp(`^\\s+${name}:\\s*(.+)$`, 'm').exec(headers)?.[1]?.trim() ?? '';

  it('carries the build-time CSP placeholder and the security headers of brief §11', () => {
    expect(header('Content-Security-Policy')).toBe('__CSP__');
    const hsts = header('Strict-Transport-Security');
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1])).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain('includeSubDomains');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    const permissions = header('Permissions-Policy');
    expect(permissions).toContain('geolocation=(self)');
    expect(permissions).toContain('camera=(self)');
  });

  it('never lets the entry points be cached, while hashed assets are immutable', () => {
    expect(headers).toMatch(/\/index\.html\s+Cache-Control: no-cache/);
    expect(headers).toMatch(/\/sw\.js\s+Cache-Control: no-cache/);
    expect(headers).toMatch(/\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});
