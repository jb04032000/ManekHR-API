// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // External-runner load-test scripts (k6 globals + a standalone Node ESM
      // harness) — not part of the TS project, run by k6 / node directly.
      'load-test/**',
      // Embedded font payloads — base64 blobs, no value in linting.
      'src/modules/finance/sales/print/fonts/*.js',
      'src/modules/finance/sales/print/fonts/*.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Phase 0 tightening (off → warn). Module sweep fixes per module.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Phase 5 extension — same warn-then-sweep pattern. Mongoose
      // ObjectId / Document<any> shapes trip these across services that
      // pre-date strict typing. Tightened to error in the upcoming
      // typing audit (paired with F-OOM-1 Mongoose Model<T> work).
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],

      // Activated after Phase 0.6 BE env loader migration completed.
      // Forces all process.env access through src/config/env.ts.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"]',
          message:
            'Do not access process.env directly — import the typed `env` from src/config/env.ts.',
        },
      ],
    },
  },
  {
    // Files allowed to read process.env directly: env loader + test fixtures.
    files: [
      'src/config/env.ts',
      'src/main.ts',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.vitest.ts',
      '__tests__/**',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
