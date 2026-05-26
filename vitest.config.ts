import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sourceAlias = {
  '@moorline/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
  '@moorline/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  '@moorline/control-api': fileURLToPath(new URL('./packages/control-api/src/index.ts', import.meta.url)),
  '@moorline/http': fileURLToPath(new URL('./packages/http/src/index.ts', import.meta.url))
};

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@moorline\/contracts\/(.+)\.js$/,
        replacement: fileURLToPath(new URL('./packages/contracts/src/$1.ts', import.meta.url))
      },
      {
        find: /^@moorline\/core\/(.+)\.js$/,
        replacement: fileURLToPath(new URL('./packages/core/src/$1.ts', import.meta.url))
      },
      {
        find: /^@moorline\/control-api\/(.+)\.js$/,
        replacement: fileURLToPath(new URL('./packages/control-api/src/$1.ts', import.meta.url))
      },
      {
        find: /^@moorline\/http\/(.+)\.js$/,
        replacement: fileURLToPath(new URL('./packages/http/src/$1.ts', import.meta.url))
      },
      ...Object.entries(sourceAlias).map(([find, replacement]) => ({ find, replacement }))
    ]
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['packages/**/*.ts'],
      thresholds: {
        lines: 72,
        functions: 80,
        branches: 70,
        statements: 72
      }
    }
  }
});
