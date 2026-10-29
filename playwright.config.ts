import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    viewport: { width: 1672, height: 941 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  webServer: {
    command: 'npm.cmd run preview',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
