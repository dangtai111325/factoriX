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

test.use({
  viewport: { width: 1672, height: 941 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
});

for (const [path, name] of routes) {
  test(`verify route ${name}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  });
}
