import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    // A few tests build a real Mastra / MongoDBStore against a placeholder Atlas URI (to
    // assert store/memory config). Mastra's background createDefaultIndexes() then rejects
    // on DNS failure AFTER the test finishes — Vitest reports it as an unhandled error only
    // in the full run. The setupFile drops ONLY that specific rejection; every other console
    // log and unhandled rejection still surfaces, so real failures remain visible. No
    // production code is touched.
    setupFiles: ['./test/ignore-mastra-storage-init-rejection.ts'],
    onConsoleLog(log) {
      if (log.includes('Storage init failed; will retry on next storage call')) return false;
      if (log.includes('MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED')) return false;
      return undefined;
    },
  },
  resolve: {
    alias: {
      'voyageai/dist/esm/api': 'voyageai/dist/esm/api/index.mjs',
    },
  },
});
