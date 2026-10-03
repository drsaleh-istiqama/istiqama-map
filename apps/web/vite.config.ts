import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Single source of truth for the version: the root package.json (brief §12).
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  // VITE_* variables live in the repository root (.env.local / .env.example).
  envDir: root,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    preact(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: false, // public/manifest.webmanifest is hand-written
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest,json}'],
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
});
