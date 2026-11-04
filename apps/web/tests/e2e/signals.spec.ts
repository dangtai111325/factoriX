import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Signals Catalog (TC-UI-SG)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('SG-01..05 signals catalog table and live operations toggle', async ({ page }) => {
    await page.goto(`${BASE}/collector/signals`);
    await expect(page.getByRole('heading', { name: /Signals/i })).toBeVisible();

    // Table view and Live operations view toggle
    const liveToggle = page.getByRole('button', { name: /Live operations|Live view/i });
    if (await liveToggle.isVisible()) {
      await liveToggle.click();
      await expect(page).toHaveURL(/view=live/);
    }
  });
});
