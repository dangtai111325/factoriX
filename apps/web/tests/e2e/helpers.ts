import { Page, expect } from '@playwright/test';

export const BASE = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080';
export const PASSWORD = 'Plant-Model-2026!';

export async function ensureSignedIn(page: Page) {
  // Check if admin exists
  const statusRes = await page.request.get(`${BASE}/api/v1/auth/status`);
  const status = await statusRes.json();

  if (!status.admin_exists) {
    // First run bootstrap
    await page.goto(`${BASE}/register`);
    await page.getByLabel('Full name').fill('Plant Lead');
    await page.getByLabel('Work email').fill('plantlead@example.com');
    await page.getByLabel('Username').fill('plantlead');
    await page.locator('#register-password').fill(PASSWORD);
    await page.locator('#register-confirm').fill(PASSWORD);
    await page.getByRole('button', { name: /Create account|Sign up/i }).click();
    await expect(page).toHaveURL(/created=1|login/);
  }

  // Direct login via API sets session cookie in page context
  let loginRes = await page.request.post(`${BASE}/api/v1/auth/login`, {
    data: { login: 'dangtai', password: 'Avenue-net@2026' },
  });

  if (!loginRes.ok()) {
    loginRes = await page.request.post(`${BASE}/api/v1/auth/login`, {
      data: { login: 'plantlead', password: PASSWORD },
    });
  }

  if (!loginRes.ok()) {
    // Fallback via UI if needed
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('domcontentloaded');
    await page.getByLabel('Email or username').fill('dangtai');
    await page.getByLabel('Password', { exact: true }).fill('Avenue-net@2026');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page).toHaveURL(/\/overview|\/factory/);
  }
}
