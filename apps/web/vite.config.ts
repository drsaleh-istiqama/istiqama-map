import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, normalizePath, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// Explicit extension: Vite's native config loader (future default) needs it.
import { buildCsp, type CspInput } from './src/ui/pwa/csp.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));
// Single source of truth for the version: the root package.json (brief §12).
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

/**
 * Content-Security-Policy (brief §11). The origins come from the build environment:
 *  - index.html gets a `<meta http-equiv>` policy (dev, preview and any static host);
 *  - `dist/_headers` (Netlify / Cloudflare Pages) gets the same policy as a real header.
 * See docs/SECURITY_HEADERS.md.
 */
function cspPlugin(input: CspInput): Plugin {
  let outDir = '';
  let isBuild = false;
  return {
    name: 'istiqama:csp',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === 'build';
    },
    transformIndexHtml(html) {
      const policy = buildCsp({ ...input, dev: !isBuild }, 'meta');
      return html.replace(
        '<!--csp-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
    closeBundle() {
      const file = path.join(outDir, '_headers');
      if (!isBuild || !existsSync(file)) return;
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replaceAll('__CSP__', buildCsp(input, 'header')));
    },
  };
}

/** Preload the two Arabic font files needed for first paint (hashed names exist only after bundling). */
function fontPreloadPlugin(): Plugin {
  let base = '/';
  return {
    name: 'istiqama:font-preload',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return;
        const fonts = Object.keys(ctx.bundle)
          .filter((file) => /tajawal-arabic-(400|700)-normal[^/]*\.woff2$/.test(file))
          .sort();
        return fonts.map((file) => ({
          tag: 'link',
          attrs: {
            rel: 'preload',
            as: 'font',
            type: 'font/woff2',
            href: `${base}${file}`,
            crossorigin: '',
          },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

/** Dev server: keep locales/{ar,sw,en}.json in step with the `_parts` fragments (the build script does it itself). */
function localesPlugin(): Plugin {
  const parts = normalizePath(path.join(webRoot, 'locales', '_parts'));
  const merge = (): void => {
    try {
      execFileSync(
        process.execPath,
        [
          path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(root, 'scripts', 'merge-locales.ts'),
        ],
        { stdio: 'inherit' },
      );
    } catch {
      // The script already printed which keys are missing; keep the dev server running.
    }
  };
  return {
    name: 'istiqama:locales',
    apply: 'serve',
    configureServer(server) {
      merge();
      server.watcher.add(parts);
      const onChange = (file: string): void => {
        if (normalizePath(file).startsWith(parts)) merge();
      };
      server.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    },
  };
}

export default defineConfig(({ mode }) => {
  // VITE_* variables live in the repository root (.env.local / .env.example).
  const env = loadEnv(mode, root, 'VITE_');
  const csp: CspInput = {
    supabaseUrl: env.VITE_SUPABASE_URL ?? '',
    tilesUrl: env.VITE_TILES_URL,
    sentryDsn: env.VITE_SENTRY_DSN,
  };

  return {
    envDir: root,
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [
      preact(),
      localesPlugin(),
      cspPlugin(csp),
      fontPreloadPlugin(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        manifest: false, // public/manifest.webmanifest is hand-written
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest,json}'],
          // The icon source drawings are build inputs, not runtime assets.
          globIgnores: ['icons/*-source.svg'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
    build: {
      target: 'es2020',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
    },
    server: { port: 5173, strictPort: true },
    // 127.0.0.1, not "localhost": on Windows "localhost" may bind to ::1 only (the e2e suite
    // and the CSP use the IPv4 loopback).
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    test: {
      name: 'web',
      environment: 'happy-dom',
      setupFiles: ['src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      globals: false,
      restoreMocks: true,
    },
  };
});
