import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Removed Feature: Edge Collectors Management UI (Review 4 S5.8 REMOVE-19..28)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('REMOVE-19..28 /collector/edges redirects to connections, no edge management UI', async ({ page }) => {
    await page.goto(`${BASE}/collector/edges`);
    // Should be safely redirected to /collector/connections
    await expect(page).toHaveURL(new RegExp('/collector/connections'));
    await expect(page.getByRole('heading', { name: 'Data Connections' })).toBeVisible();

    // Verify Edge collectors management screen is absent
    await expect(page.getByRole('heading', { name: 'Edge Collectors', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Edge Collectors' })).toHaveCount(0);
  });
});
