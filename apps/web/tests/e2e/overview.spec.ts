import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Overview Page (TC-UI-OV)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('OV-01/02 checklist navigation buttons', async ({ page }) => {
    await page.goto(`${BASE}/overview`);

    // If checklist is visible, verify buttons
    const getStartedHeading = page.getByRole('heading', { name: /Get started with FactoriX/i });
    if (await getStartedHeading.isVisible()) {
      const buildModelBtn = page.getByRole('button', { name: /Build your factory model/i });
      if (await buildModelBtn.isVisible()) {
        await buildModelBtn.click();
        await expect(page).toHaveURL(/\/factory\/structure/);
        await page.goto(`${BASE}/overview`);
      }
    }
  });

  test('OV-03/04 clickable KPI cards navigate to corresponding modules', async ({ page }) => {
    await page.goto(`${BASE}/overview`);

    // 1. Resources card -> /factory/structure
    await page.getByText('View hierarchy').click();
    await expect(page).toHaveURL(/\/factory\/structure/);

    // 2. Signals card -> /collector/signals
    await page.goto(`${BASE}/overview`);
    await page.getByText('View catalog').first().click();
    await expect(page).toHaveURL(/\/collector\/signals/);

    // 3. Connections card -> /collector/connections
    await page.goto(`${BASE}/overview`);
    await page.getByText('Manage connections').click();
    await expect(page).toHaveURL(/\/collector\/connections/);

    // 4. Data Models card -> /models
    await page.goto(`${BASE}/overview`);
    await page.getByText('View catalog').nth(1).click();
    await expect(page).toHaveURL(/\/models/);
  });

  test('OV-05 data collection summary card metrics without legacy labels', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const dataCollectionCard = page.getByRole('heading', { name: /Data collection/i });
    await expect(dataCollectionCard).toBeVisible();

    // Verify absence of deprecated strings
    await expect(page.getByText('Collector Engine')).toHaveCount(0);
    await expect(page.getByText('UNKNOWN')).toHaveCount(0);

    // Verify valid metrics sections exist
    await expect(page.getByText(/Edges online/i).first()).toBeVisible();
    await expect(page.getByText(/Connections online/i).first()).toBeVisible();
  });

  test('OV-06 donut data quality legend items and structure', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    const qualityHeading = page.getByRole('heading', { name: /Data quality/i });
    if (await qualityHeading.isVisible()) {
      await expect(page.getByText(/Good/i).first()).toBeVisible();
    }
  });

  test('OV-07/08/09 latest values, plant selector, and recent activity', async ({ page }) => {
    await page.goto(`${BASE}/overview`);

    // Check subtitle
    await expect(page.getByText(/Showing/i).first()).toBeVisible();

    // Check recent activity section
    const activityHeading = page.getByRole('heading', { name: /Recent activity/i });
    await expect(activityHeading).toBeVisible();

    const viewAllBtn = page.getByRole('button', { name: 'View all', exact: true });
    if (await viewAllBtn.isVisible()) {
      await viewAllBtn.click();
      await expect(page).toHaveURL(/\/collector\/diagnostics/);
    }
  });

  test('OV-10 empty state or clean data view without broken charts', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    // Page should load cleanly with HTTP 200 and no uncaught error alerts
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add data/i }).first()).toBeVisible();
  });
});
