import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

const ARTIFACT_DIR = 'C:/Users/Ave-T14-001/.gemini/antigravity/brain/53bc9a76-577a-4ba5-8175-947e53bf5611';

test.describe('Section 9 End-to-End User Experience Walkthrough (Review 4 Validated)', () => {
  test.setTimeout(120000);

  test('full end-to-end user sequence per Review 4 spec', async ({ page }) => {
    page.on('console', (msg) => console.log(`[BROWSER ${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.log('[BROWSER UNCAUGHT]:', err.message));
    page.on('response', async (res) => {
      if (res.status() >= 400) {
        let body = '';
        try {
          body = await res.text();
        } catch {}
        console.log(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()}: ${body.slice(0, 200)}`);
      }
    });

    // 1. Sign in & Navigation Check
    await ensureSignedIn(page);
    await page.goto(`${BASE}/overview`);
    await page.waitForLoadState('networkidle');

    // Title & Favicon
    await expect(page).toHaveTitle(/· FactoriX/);
    const faviconRes = await page.request.get(`${BASE}/favicon.ico`);
    expect(faviconRes.status()).toBe(200);

    // Sidebar structure verification per Review 4 §0.1
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Factory Model').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hierarchy Structure' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Knowledge Graph' })).toBeVisible();
    await expect(page.getByText('Data Collector').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connections' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Signals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Model Catalog' })).toBeVisible();

    // Verify removed features are absent (Review 4 S5.4 / S5.8)
    await expect(page.getByRole('link', { name: 'Layout Designer' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Edge Collectors' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Diagnostics' })).toHaveCount(0);

    // Coming soon section
    const comingSoonSection = page.getByText(/Coming soon/i).first();
    await expect(comingSoonSection).toBeVisible();

    // 2. Hierarchy Structure
    await page.goto(`${BASE}/factory/structure`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Hierarchy Structure/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_hierarchy_structure.png` });

    // 3. Connections
    await page.goto(`${BASE}/collector/connections`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Data Connections' })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_connections.png` });

    // 4. Signals
    await page.goto(`${BASE}/collector/signals`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Signals', exact: true })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_signals_catalog.png` });

    // 5. Factory Graph (Knowledge Graph)
    await page.goto(`${BASE}/factory/graph`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Knowledge Graph/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_knowledge_graph.png` });

    // 6. Data Models (Model Catalog)
    await page.goto(`${BASE}/models`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Model Catalog', exact: true })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_models.png` });

    // 7. Verify Safe Redirects for Removed Features
    await page.goto(`${BASE}/factory/layout`);
    await expect(page).toHaveURL(new RegExp('/factory/structure'));

    await page.goto(`${BASE}/collector/edges`);
    await expect(page).toHaveURL(new RegExp('/collector/connections'));

    await page.goto(`${BASE}/collector/diagnostics`);
    await expect(page).toHaveURL(new RegExp('/collector/connections'));

    // 8. Overview final verification
    await page.goto(`${BASE}/overview`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_overview_final.png` });
  });
});
