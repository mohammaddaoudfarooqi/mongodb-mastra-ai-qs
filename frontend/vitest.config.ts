import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Spec 550: vitest for the SSO/auth front-end logic. jsdom so AuthContext +
// Header component tests can render; setup wires @testing-library/jest-dom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
