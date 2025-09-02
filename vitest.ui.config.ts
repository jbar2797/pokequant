import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/ui/**/*.test.tsx'],
    setupFiles: ['packages/ui/test.setup.ts']
  }
});