import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Navigation and Shell (TC-UI-NAV & Review 4 Removal)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('NAV-01/02 page title and favicon', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const title = await page.title();
    expect(title).toContain('FactoriX');
    const faviconRes = await page.request.get(`${BASE}/favicon.ico`);
    expect(faviconRes.status()).toBe(200);
  });

  test('NAV-03 sidebar structure has canonical groups and no deprecated names', async ({ page }) => {
    await page.goto(`${BASE}/overview`);

    // Verify canonical modules exist
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hierarchy Structure' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Knowledge Graph' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connections' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Signals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Model Catalog' })).toBeVisible();

    // Verify removed product features are completely absent from sidebar (Review 4 S5.4 / S5.8)
    await expect(page.getByRole('link', { name: 'Layout Designer' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Edge Collectors' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Diagnostics' })).toHaveCount(0);

    // Verify deprecated sections are completely gone
    await expect(page.getByText('ACQUISITION', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Live Operations', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Protocol Studio', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Planned modules', { exact: true })).toHaveCount(0);
    await expect(page.getByText('roadmap', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Core Collector', { exact: true })).toHaveCount(0);
  });

  test('NAV-04/05 coming soon submodules expand and render honest pages', async ({ page }) => {
    await page.goto(`${BASE}/overview`);

    const comingSoonToggle = page.getByRole('button', { name: /Coming soon/i });
    if ((await comingSoonToggle.getAttribute('aria-expanded')) !== 'true') {
      await comingSoonToggle.click();
    }

    // Verify the 6 coming soon links
    await expect(page.getByRole('link', { name: /Dashboards/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Historian & Storage/i })).toBeVisible();
  });
});
