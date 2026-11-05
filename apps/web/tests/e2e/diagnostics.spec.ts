import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Removed Feature: Standalone Diagnostics Module (Review 4 S5.8 REMOVE-29..40)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('REMOVE-29..40 /collector/diagnostics redirects to connections, no standalone diagnostics page', async ({ page }) => {
    await page.goto(`${BASE}/collector/diagnostics`);
    // Should be safely redirected to /collector/connections
    await expect(page).toHaveURL(new RegExp('/collector/connections'));
    await expect(page.getByRole('heading', { name: 'Data Connections' })).toBeVisible();

    // Verify standalone diagnostics page is absent
    await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Diagnostics' })).toHaveCount(0);
  });
});
