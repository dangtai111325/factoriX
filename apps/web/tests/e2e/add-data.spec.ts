import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Add Data Wizard (TC-UI-AD)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('AD-01..05 5-step wizard structure and initial target step', async ({ page }) => {
    await page.goto(`${BASE}/collector/add-data`);
    await expect(page.getByRole('heading', { name: /Choose Target Resource/i })).toBeVisible();

    // Verify 5 wizard steps are present in step indicator
    await expect(page.getByText('Target', { exact: true })).toBeVisible();
    await expect(page.getByText('Source', { exact: true })).toBeVisible();
    await expect(page.getByText('Address', { exact: true })).toBeVisible();
    await expect(page.getByText('Fields', { exact: true })).toBeVisible();
    await expect(page.getByText('Review', { exact: true })).toBeVisible();
  });
});
