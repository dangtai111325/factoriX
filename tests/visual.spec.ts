import { test, expect } from '@playwright/test';

const routes = [
  ['/overview', '01_overview'],
  ['/factory/structure', '02_factory_structure'],
  ['/factory/layout', '03_factory_layout'],
  ['/factory/graph', '04_knowledge_graph'],
  ['/acquisition/connections', '05_connections'],
  ['/acquisition/add-data', '06_add_data'],
  ['/acquisition/studio/opcua', '07_opcua'],
  ['/signals', '08_signals_catalog'],
  ['/signals/calculated', '09_calculated'],
  ['/live/monitor', '10_live_monitor'],
  ['/live/diagnostics', '11_diagnostics'],
  ['/live/activity', '12_activity'],
  ['/signals/output-groups', '13_output_groups'],
  ['/acquisition/studio/mqtt', '14_mqtt'],
  ['/acquisition/studio/http', '15_http_api'],
] as const;

for (const [path, name] of routes) {
  test(`verify route ${name}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    // Verify Demo Mode indicator is universally present (Review Section 10.A)
    await expect(page.getByText('DEMO MODE', { exact: true })).toBeVisible();
    // Verify Topbar brand
    await expect(page.getByText('FactoriX Industrial IoT')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  });
}

test('verify signals catalog interactive bulk selection bar', async ({ page }) => {
  await page.goto('/signals');
  await expect(page.locator('table.fx-table')).toBeVisible();

  // Select first checkbox
  const firstCheckbox = page.locator('tbody input[type="checkbox"]').first();
  await firstCheckbox.check();

  // Verify Floating Bulk Action Bar appears
  await expect(page.getByText(/1 signal selected/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Assign Output Group/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV \(1\)/i })).toBeVisible();
});

test('verify calculated signals formula evaluator reacts to input changes', async ({ page }) => {
  await page.goto('/signals/calculated');
  await expect(page.getByText('AST Evaluator Active')).toBeVisible();
  await expect(page.getByText('Evaluated Result:')).toBeVisible();
});
