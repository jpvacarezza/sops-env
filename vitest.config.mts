import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.mjs', 'test/**/*.spec.mjs'],
    setupFiles: ['./test/no-network.setup.mjs'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './test-output/coverage',
      // Config, not CLI: a `--coverage` flag is easy to drop from a CI line.
      enabled: Boolean(process.env['CI']),
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.mjs'],
      exclude: ['src/**/*.spec.mjs', 'src/config/types.d.ts'],
      // Just under the measured 77.9 / 82.8 / 78.5 / 77.3: raise when coverage does.
      thresholds: { lines: 75, functions: 80, branches: 76, statements: 75 },
    },
  },
});
