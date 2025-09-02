import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/ui/a11y/*.test.tsx'],
    setupFiles: ['packages/ui/a11y/setup.ts'],
    globals: true
  }
});
