/**
 * Live integration tests of the web modules against a running stack (local gateway on
 * http://127.0.0.1:54321, or a real Supabase project with the staging seed).
 *
 *   npx vitest run --config apps/web/vitest.integration.config.ts
 *
 * Not part of `npm test`. Node environment + fake-indexeddb. Only the public VITE_* variables
 * of the repository's .env.local are loaded (`import.meta.env` and `process.env`): the
 * service-role key and the JWT secret never enter the test process.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, normalizePath, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * While neighbouring modules are still being written, a relative import below src/ that has
 * no file yet resolves to an empty module instead of failing the whole run (the tests replace
 * those neighbours through ports or vi.mock anyway). A real file always wins.
 */
function missingNeighbours(): Plugin {
  const src = normalizePath(path.join(webRoot, 'src'));
  const suffixes = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
  const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
  const prefix = '\0missing-neighbour:';
  return {
    name: 'istiqama:missing-neighbours',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const from = normalizePath(importer.split('?')[0] ?? '');
      if (!from.startsWith(`${src}/`)) return null;
      const target = normalizePath(path.resolve(path.dirname(from), source.split('?')[0] ?? ''));
      if (!target.startsWith(`${src}/`) || suffixes.some((s) => isFile(target + s))) return null;
      return prefix + target;
    },
    load(id) {
      return id.startsWith(prefix) ? 'export {};' : null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const publicEnv = loadEnv(mode, repoRoot, 'VITE_');
  return {
    root: webRoot,
    envDir: repoRoot,
    define: { __APP_VERSION__: JSON.stringify('0.0.0-integration') },
    plugins: [missingNeighbours()],
    test: {
      name: 'web-integration',
      environment: 'node',
      include: ['tests/integration/**/*.live.test.ts'],
      setupFiles: ['fake-indexeddb/auto'],
      env: publicEnv,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      fileParallelism: false,
    },
  };
});
