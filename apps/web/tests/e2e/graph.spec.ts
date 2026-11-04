import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Knowledge Graph (TC-UI-KG)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('KG-01..03 graph visualization renders', async ({ page }) => {
    await page.goto(`${BASE}/factory/graph`);
    await expect(page.getByRole('heading', { name: /Knowledge Graph/i })).toBeVisible();
  });
});
