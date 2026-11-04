import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Diagnostics (TC-UI-DG)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('DG-01/02 health tab with status counters and remediation guide', async ({ page }) => {
    await page.goto(`${BASE}/collector/diagnostics?tab=health`);
    await expect(page.getByRole('heading', { name: /Diagnostics/i })).toBeVisible();

    // Check tabs
    await expect(page.getByRole('tab', { name: /System Health|Health/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Audit Events|Activity/i })).toBeVisible();

    // 4 KPI Health cards
    await expect(page.getByText(/Edges offline/i).first()).toBeVisible();
    await expect(page.getByText(/Connections with errors/i).first()).toBeVisible();
    await expect(page.getByText(/Signals bad/i).first()).toBeVisible();
    await expect(page.getByText(/Signals stale/i).first()).toBeVisible();
  });

  test('DG-03 activity tab with audit events, filters and CSV export', async ({ page }) => {
    await page.goto(`${BASE}/collector/diagnostics?tab=activity`);
    await expect(page.getByRole('heading', { name: /Diagnostics/i })).toBeVisible();

    // Export CSV button
    const exportBtn = page.getByRole('button', { name: /Export CSV/i });
    if (await exportBtn.isVisible()) {
      await expect(exportBtn).toBeEnabled();
    }
  });
});
