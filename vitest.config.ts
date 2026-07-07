import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'voyageai/dist/esm/api': 'voyageai/dist/esm/api/index.mjs',
    },
  },
});
