import { defineConfig } from 'vitest/config';
import { transformSync } from '@swc/core';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * Custom SWC transform plugin for Vitest — integration test files only.
 *
 * Integration test suites live under src/**‌/__tests__/ and use real Mongoose
 * models against mongodb-memory-server. The production schemas they import
 * must have explicit { type } on every @Prop() — NestJS docs requirement —
 * so that SchemaFactory.createForClass works without emitDecoratorMetadata.
 *
 * This plugin ONLY applies SWC to:
 *   1. src/**‌/__tests__/*.vitest.ts  — integration test suites
 *   2. src/test-utils/               — shared test helpers
 *
 * All other .ts files (unit tests, schemas, services) continue to be
 * processed by Vitest's default esbuild transform, which preserves vi.fn()
 * mock semantics and does not require emitDecoratorMetadata.
 *
 * Pre-requisite: every @Prop() on schemas imported by integration tests MUST
 * have an explicit { type: TYPE } option (String, Number, Boolean, Date, etc.)
 * so NestJS can resolve types without decorator metadata.
 *
 * Paired with setupFiles: ['src/test-utils/setup.ts'] which imports
 * reflect-metadata for the SWC-transformed files.
 */
function swcIntegrationPlugin(): Plugin {
  return {
    name: 'swc-integration-decorator-metadata',
    enforce: 'pre' as const,

    transform(code, id) {
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) return null;
      if (id.includes('node_modules')) return null;

      const normalised = id.replace(/\\/g, '/');

      // Narrow scope: ONLY integration test suites and test utilities.
      // Schema/service files are processed by esbuild (unit tests use vi.mock
      // which intercepts @nestjs/mongoose at resolution time, not at transform).
      const isIntegrationTest = normalised.includes('/__tests__/');
      const isTestUtil = normalised.includes('/test-utils/');

      if (!isIntegrationTest && !isTestUtil) {
        return null;
      }

      const result = transformSync(code, {
        filename: id,
        jsc: {
          parser: {
            syntax: 'typescript',
            decorators: true,
            dynamicImport: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          target: 'es2022',
          keepClassNames: true,
        },
        module: {
          type: 'es6',
        },
        sourceMaps: true,
      });

      return {
        code: result.code,
        map: result.map,
      };
    },
  };
}

export default defineConfig({
  plugins: [swcIntegrationPlugin()],
  resolve: {
    alias: {
      // dotenv is not declared in package.json (phantom transitive dep pulled in
      // by @nestjs/config). pnpm strict mode does not hoist it the same way, so
      // Vite cannot resolve 'dotenv/config' from the project root during test
      // runs. This alias points at the hoisted top-level copy under node_modules,
      // which is stable across dotenv version bumps (the old pinned
      // .pnpm/dotenv@17.4.1 path went stale on upgrade). The declared-dep fix
      // (pnpm add dotenv) is the correct long-term action; owner can then remove
      // this alias.
      'dotenv/config': resolve(__dirname, 'node_modules/dotenv/config.js'),
    },
  },
  test: {
    include: [
      'src/**/*.vitest.ts',
      'src/modules/finance/purchases/__tests__/*.spec.ts',
      'src/modules/finance/loan-accounts/loan-schedule.spec.ts',
      'src/modules/localization/__tests__/*.spec.ts',
      'src/modules/feedback/__tests__/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    // Import reflect-metadata before any test suite so NestJS SchemaFactory
    // can resolve TypeScript decorator metadata at runtime.
    setupFiles: ['src/test-utils/setup.ts'],
  },
});
