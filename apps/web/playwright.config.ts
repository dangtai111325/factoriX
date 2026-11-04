import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080',
    viewport: { width: 1672, height: 941 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        viewport: { width: 1672, height: 941 },
      },
    },
  ],
});
