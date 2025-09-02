import { defineConfig } from '@playwright/test';
export default defineConfig({
  webServer: {
    command: 'NEXT_PUBLIC_API_MOCKS=1 npm run dev:web',
    port: 3000,
    reuseExistingServer: true,
    timeout: 60_000
  },
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' }
});