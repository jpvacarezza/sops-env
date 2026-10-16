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
      // The floors tripgency measured for `tools/`; re-measured in Task 10.
      thresholds: { lines: 68, functions: 75, branches: 71, statements: 68 },
    },
  },
});
