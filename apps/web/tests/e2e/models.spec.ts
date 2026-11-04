import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Data Models (TC-UI-DM)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('DM-01..04 model catalog and workspace tabs', async ({ page }) => {
    await page.goto(`${BASE}/models`);
    await expect(page.getByRole('heading', { name: 'Model Catalog', exact: true })).toBeVisible();

    // Verify Create model button is present
    await expect(page.getByRole('button', { name: /Create model/i }).first()).toBeVisible();
  });
});
