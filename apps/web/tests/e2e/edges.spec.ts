import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Edge Collectors (TC-UI-ED)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('ED-01..04 edge collector fleet view and actions', async ({ page }) => {
    await page.goto(`${BASE}/collector/edges`);
    await expect(page.getByRole('heading', { name: 'Edge Collectors', exact: true })).toBeVisible();

    // Verify empty state or edge list table
    const emptyHeading = page.getByRole('heading', { name: 'No edge collectors', exact: true });
    if (await emptyHeading.isVisible()) {
      await expect(page.getByText('Edges are created automatically when you add a site.')).toBeVisible();
    } else {
      await expect(page.getByText('Name').first()).toBeVisible();
      await expect(page.getByText('Status').first()).toBeVisible();
      await expect(page.getByText('Site').first()).toBeVisible();
    }
  });
});
