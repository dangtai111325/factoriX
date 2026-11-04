import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Navigation and Shell (TC-UI-NAV)', () => {
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
    await expect(page.getByRole('link', { name: 'Layout Designer' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Knowledge Graph' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Add Connection|Connections/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Add Data|Signals/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edge Collectors' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Diagnostics' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Model Catalog' })).toBeVisible();

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
    await expect(page.getByRole('link', { name: /Alarms & Events/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Analytics/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Reports/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Administration/i })).toBeVisible();

    // Navigate to Dashboards
    await page.getByRole('link', { name: /Dashboards/i }).click();
    await expect(page).toHaveURL(/\/dashboards/);
    await expect(page.getByText(/Coming soon/i).first()).toBeVisible();
    await expect(page.getByText(/Workstream|development candidate|IoTDB|Keycloak/i)).toHaveCount(0);
  });

  test('NAV-06 query-preserving legacy redirects', async ({ page }) => {
    // 1. /acquisition/connections -> /collector/connections
    await page.goto(`${BASE}/acquisition/connections`);
    await expect(page).toHaveURL(`${BASE}/collector/connections`);

    // 2. /acquisition/edges -> /collector/edges
    await page.goto(`${BASE}/acquisition/edges`);
    await expect(page).toHaveURL(`${BASE}/collector/edges`);

    // 3. /acquisition/add-data?resourceId=X -> /collector/add-data?resourceId=X
    await page.goto(`${BASE}/acquisition/add-data?resourceId=test-123`);
    await expect(page).toHaveURL(`${BASE}/collector/add-data?resourceId=test-123`);

    // 4. /signals?signalId=Y -> /collector/signals?signalId=Y
    await page.goto(`${BASE}/signals?signalId=sig-999`);
    await expect(page).toHaveURL(`${BASE}/collector/signals?signalId=sig-999`);

    // 5. /live/monitor -> /collector/signals?view=live
    await page.goto(`${BASE}/live/monitor`);
    await expect(page).toHaveURL(/view=live/);

    // 6. /live/diagnostics -> /collector/diagnostics?tab=health
    await page.goto(`${BASE}/live/diagnostics`);
    await expect(page).toHaveURL(/tab=health/);

    // 7. /live/activity -> /collector/diagnostics?tab=activity
    await page.goto(`${BASE}/live/activity`);
    await expect(page).toHaveURL(/tab=activity/);

    // 8. /signals/output-groups -> /models
    await page.goto(`${BASE}/signals/output-groups`);
    await expect(page).toHaveURL(`${BASE}/models`);

    // 9. /signals/calculated -> /models?tab=calculations
    await page.goto(`${BASE}/signals/calculated`);
    await expect(page).toHaveURL(/tab=calculations/);

    // 10. /storage -> /historian
    await page.goto(`${BASE}/storage`);
    await expect(page).toHaveURL(`${BASE}/historian`);

    // 11. /topology -> /factory/structure
    await page.goto(`${BASE}/topology`);
    await expect(page).toHaveURL(`${BASE}/factory/structure`);

    // 12. /factory-layout -> /factory/layout
    await page.goto(`${BASE}/factory-layout`);
    await expect(page).toHaveURL(`${BASE}/factory/layout`);

    // 13. /knowledge-graph -> /factory/graph
    await page.goto(`${BASE}/knowledge-graph`);
    await expect(page).toHaveURL(`${BASE}/factory/graph`);
  });

  test('NAV-07 topbar has clean status and no fake pause or live refresh', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    await expect(page.getByText('LIVE REFRESH')).toHaveCount(0);
    await expect(page.getByText('Collector: waiting')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  });

  test('NAV-08 data collection edge status chip navigates to edges', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const edgeChip = page.getByRole('button', { name: /edges online/i });
    await expect(edgeChip).toBeVisible();
    await edgeChip.click();
    await expect(page).toHaveURL(/\/collector\/edges/);
  });

  test('NAV-09 plant selector shows scope and sites', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const plantBtn = page.getByRole('button', { name: /Plant:/i });
    await expect(plantBtn).toBeVisible();
    await plantBtn.click();
    await expect(page.getByText(/All sites/i).first()).toBeVisible();
  });

  test('NAV-10 search modal keyboard navigation and empty state', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const searchTrigger = page.getByRole('button', { name: /Search model, signals/i });
    await searchTrigger.click();
    const searchInput = page.getByPlaceholder(/Search resources, tags/i);
    await expect(searchInput).toBeVisible();

    // Empty search query for non-existent item
    await searchInput.fill('zzz');
    await expect(page.getByText('No results for "zzz"')).toBeVisible();

    // Close on Escape
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeVisible();
  });

  test('NAV-11 revert to zero modal behavior', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const revertBtn = page.getByRole('button', { name: /Revert to zero/i });
    await expect(revertBtn).toBeVisible();
    await revertBtn.click();

    const dialog = page.getByRole('dialog', { name: /Revert to Zero/i });
    await expect(dialog).toBeVisible();

    const confirmBtn = dialog.getByRole('button', { name: /^Revert to zero$/i });
    await expect(confirmBtn).toBeDisabled();

    // Type partial string
    const input = dialog.locator('#revert-confirmation-input');
    await input.fill('REV');
    await expect(confirmBtn).toBeDisabled();

    // Type full REVERT
    await input.fill('REVERT');
    await expect(confirmBtn).toBeEnabled();

    // Cancel closes dialog without reverting
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('NAV-12 absence of forbidden demo and stray mock strings', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const content = await page.content();
    const forbidden = [
      '18/20',
      'CPU: 32%',
      'Reactor 1',
      'LineA_PLC',
      'Tank_03',
      'CNC Milling Unit',
      'Stamping Press',
      'ZONE A - MACHINING',
      'DEMO',
      'node-center',
    ];
    for (const term of forbidden) {
      expect(content).not.toContain(term);
    }
  });

  test('NAV-13 responsive layout at 1366x768 and 1024x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`${BASE}/overview`);
    await expect(page.getByRole('banner')).toBeVisible();

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole('banner')).toBeVisible();
  });
});
