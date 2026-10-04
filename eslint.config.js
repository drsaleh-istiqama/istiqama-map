// Flat ESLint config for the whole monorepo (scripts, Edge Functions, web app).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.local/**',
      '**/dist/**',
      '**/coverage/**',
      'reference/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/public/**',
      'apps/web/dev-dist/**',
      'load-tests/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // Browser code must not log secrets or leave debug output behind.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // UI strings must come from the locale files (see docs/contracts/web.md).
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='localStorage']",
          message: 'Use src/lib/prefs.ts for UI preferences; data belongs in IndexedDB (Dexie).',
        },
      ],
    },
  },
);
