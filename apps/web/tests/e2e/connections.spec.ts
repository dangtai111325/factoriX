import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Connections (TC-UI-CN)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('CN-01..05 connections list view and add connection button', async ({ page }) => {
    await page.goto(`${BASE}/collector/connections`);
    await expect(page.getByRole('heading', { name: 'Data Connections', exact: true })).toBeVisible();

    // Verify Add Connection button exists
    const addBtn = page.getByRole('button', { name: /New Connection|Add Connection/i });
    await expect(addBtn).toBeVisible();
  });
});
