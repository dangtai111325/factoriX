import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Removed Feature: Layout Designer (Review 4 S5.4 REMOVE-01..18)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('REMOVE-01..18 /factory/layout redirects to hierarchy structure, no layout canvas', async ({ page }) => {
    await page.goto(`${BASE}/factory/layout`);
    // Should be safely redirected to /factory/structure
    await expect(page).toHaveURL(new RegExp('/factory/structure'));
    await expect(page.getByRole('heading', { name: /Hierarchy Structure/i })).toBeVisible();

    // Verify layout designer components are completely absent
    await expect(page.getByRole('heading', { name: /Factory Layout Designer/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Auto Grid' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Layout Designer' })).toHaveCount(0);
  });
});
