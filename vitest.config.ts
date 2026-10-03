import { defineConfig } from 'vitest/config';

// `npm test` at the repository root runs every unit-test project:
//  - web:  apps/web (happy-dom + fake-indexeddb), configured in apps/web/vite.config.ts
//  - node: local-stack gateway, Edge Functions (shared pure logic), scripts
export default defineConfig({
  test: {
    projects: [
      'apps/web/vite.config.ts',
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['scripts/**/*.test.ts', 'supabase/functions/**/*.test.ts', 'load-tests/**/*.test.ts'],
        },
      },
    ],
  },
});
