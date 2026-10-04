import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, normalizePath, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { buildCsp, type CspInput } from './src/ui/pwa/csp';

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
  return {
    name: 'istiqama:font-preload',
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
            href: `/${file}`,
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

/**
 * TEMPORARY, behind a flag: while neighbouring modules (`src/lib`, `src/auth`, `src/sync`,
 * `src/db`, …) are still being written, a relative import that has no real file falls back to
 * the file with the same path under `src/ui/__stubs__/`. A real module always wins.
 * Enabled with ISTIQAMA_STUBS=1 (build / dev) and under Vitest. Delete together with the
 * stub folder once every module in docs/contracts/web.md exists.
 */
function stubFallbackPlugin(enabled: boolean): Plugin {
  const src = normalizePath(path.join(webRoot, 'src'));
  const stubs = `${src}/ui/__stubs__`;
  const suffixes = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
  const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
  const find = (base: string): string | undefined => suffixes.map((s) => base + s).find(isFile);
  const used = new Set<string>();
  return {
    name: 'istiqama:stub-fallback',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!enabled || !importer || !source.startsWith('.')) return null;
      const from = normalizePath(importer.split('?')[0] ?? '');
      if (!from.startsWith(`${src}/`) || from.startsWith(`${stubs}/`)) return null;
      const target = normalizePath(path.resolve(path.dirname(from), source.split('?')[0] ?? ''));
      if (!target.startsWith(`${src}/`) || target.startsWith(`${stubs}/`) || find(target))
        return null;
      const stub = find(`${stubs}/${target.slice(src.length + 1)}`);
      if (!stub) return null;
      used.add(target.slice(src.length + 1));
      return stub;
    },
    buildEnd() {
      if (used.size)
        this.warn(
          `TEMPORARY STUBS used instead of missing modules: ${[...used].sort().join(', ')}`,
        );
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
  const useStubs = process.env.ISTIQAMA_STUBS === '1' || Boolean(process.env.VITEST);

  return {
    envDir: root,
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [
      stubFallbackPlugin(useStubs),
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
    preview: { port: 4173, strictPort: true },
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
