import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['core/**', 'plugins/**', 'utils/**', 'singleton/**', 'browser/**'],
      exclude: ['**/*.d.ts', 'dist/**', 'node_modules/**'],
    },
  },
});
