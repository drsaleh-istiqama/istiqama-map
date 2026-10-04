import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, normalizePath, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// Explicit extension: Vite's native config loader (future default) needs it.
import { buildCsp, cspHash, type CspInput } from './src/ui/pwa/csp.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));
// Single source of truth for the version: the root package.json (brief §12).
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Small, safe CSS minifier for the critical CSS (comments, whitespace, last semicolons). */
function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

/**
 * Static splash + Content-Security-Policy of index.html (brief §5, §11).
 *
 * First paint (docs/CI.md §6.3): index.html carries a static splash styled by the critical CSS
 * of `src/ui/critical.css`, inlined here as the one render-blocking <style>; its SHA-256 goes
 * into `style-src`, so the policy stays free of 'unsafe-inline'. The splash texts come from
 * `locales/ar.json` and the description meta tag (UI text has one source).
 *
 * The origins of the policy come from the build environment:
 *  - index.html gets a `<meta http-equiv>` policy (dev, preview and any static host);
 *  - `dist/_headers` (Netlify / Cloudflare Pages) gets the same policy as a real header.
 * See docs/SECURITY_HEADERS.md.
 *
 * Everything happens in ONE `post` hook: nothing rewrites the inline <style> after its hash is
 * taken (Vite processes the <style> elements of the source HTML before `post` hooks run).
 */
function shellAndCspPlugin(input: CspInput, appName: string | undefined): Plugin {
  let outDir = '';
  let isBuild = false;
  let styleHashes: string[] = [];
  return {
    name: 'istiqama:shell-csp',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === 'build';
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        const ar = JSON.parse(
          readFileSync(path.join(webRoot, 'locales', 'ar.json'), 'utf8'),
        ) as Record<string, string>;
        const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
        const critical = minifyCss(
          readFileSync(path.join(webRoot, 'src', 'ui', 'critical.css'), 'utf8'),
        );
        const hash = await cspHash(critical);
        styleHashes = [hash];
        const policy = buildCsp({ ...input, dev: !isBuild, styleHashes }, 'meta');
        return html
          .replace('<!--critical-css-->', () => `<style>${critical}</style>`)
          .replace('<!--app-title-->', () => escapeHtml(appName || ar['auth.app_title'] || ''))
          .replace('<!--app-description-->', () => description)
          .replace('<!--app-loading-->', () => escapeHtml(ar['auth.loading'] ?? ''))
          .replace(
            '<!--csp-->',
            () => `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
          );
      },
    },
    closeBundle() {
      const file = path.join(outDir, '_headers');
      if (!isBuild || !existsSync(file)) return;
      const text = readFileSync(file, 'utf8');
      writeFileSync(
        file,
        text.replaceAll('__CSP__', buildCsp({ ...input, styleHashes }, 'header')),
      );
    },
  };
}

/**
 * Preloads of the first screen (brief §5). The entry chunk (src/main.tsx) is tiny and loads
 * the application with dynamic imports, so neither the stylesheets nor the heavy chunks block
 * the first paint (the static splash). To avoid paying one round trip per import level, the
 * chunks of `bootModules` — and, transitively, their static imports and CSS — are announced
 * in index.html as `modulepreload` / `preload as=style` (fetched early, executed later).
 *
 * Fonts: only Tajawal Arabic 400 (body text of the sign-in screen); bold text renders with the
 * synthetic/fallback face until 700 arrives through the stylesheet (`font-display: swap`).
 */
function bootPreloadPlugin(bootModules: readonly string[]): Plugin {
  let base = '/';
  return {
    name: 'istiqama:boot-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        const entry = ctx.chunk;
        if (!bundle || !entry) return;
        const chunks = new Map<string, { imports: string[]; modules: string[]; css: string[] }>();
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue;
          chunks.set(output.fileName, {
            imports: output.imports,
            // A dynamically imported module may share a chunk with others (no own facade).
            modules: output.moduleIds.map((id) => normalizePath(id)),
            css: [...(output.viteMetadata?.importedCss ?? [])],
          });
        }
        const walk = (file: string, into: Set<string>): void => {
          if (into.has(file)) return;
          into.add(file);
          for (const dep of chunks.get(file)?.imports ?? []) walk(dep, into);
        };
        // Vite already preloads the entry and its static imports.
        const entryClosure = new Set<string>();
        walk(entry.fileName, entryClosure);

        const boot = new Set<string>();
        for (const module of bootModules) {
          const wanted = normalizePath(path.join(webRoot, module));
          const hit = [...chunks].find(([, c]) => c.modules.includes(wanted));
          if (!hit) throw new Error(`boot-preload: no chunk for ${module}`);
          walk(hit[0], boot);
        }
        const styles = [...new Set([...boot].flatMap((file) => chunks.get(file)?.css ?? []))];
        const scripts = [...boot].filter((file) => !entryClosure.has(file));
        const fonts = Object.keys(bundle)
          .filter((file) => /tajawal-arabic-400-normal[^/]*\.woff2$/.test(file))
          .sort();

        const link = (attrs: Record<string, string>) => ({
          tag: 'link',
          attrs,
          injectTo: 'head' as const,
        });
        return [
          ...fonts.map((file) =>
            link({
              rel: 'preload',
              as: 'font',
              type: 'font/woff2',
              href: `${base}${file}`,
              crossorigin: '',
            }),
          ),
          ...styles.map((file) =>
            link({ rel: 'preload', as: 'style', href: `${base}${file}`, crossorigin: '' }),
          ),
          ...scripts.map((file) =>
            link({ rel: 'modulepreload', href: `${base}${file}`, crossorigin: '' }),
          ),
        ];
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
      shellAndCspPlugin(csp, env.VITE_APP_NAME),
      // The application chunk and the auth stack behind the first screen (src/main.tsx → app.tsx).
      bootPreloadPlugin(['src/app.tsx', 'src/auth/index.ts']),
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
