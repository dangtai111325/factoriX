import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Layout Designer (TC-UI-LD)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('LD-01..03 layout canvas and controls', async ({ page }) => {
    await page.goto(`${BASE}/factory/layout`);
    await expect(page.getByRole('heading', { name: /Factory Layout Designer/i })).toBeVisible();

    // Verify main toolbar elements
    await expect(page.getByRole('button', { name: 'View' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  });
});
