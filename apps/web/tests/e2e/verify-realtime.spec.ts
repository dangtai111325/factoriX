import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test('Verify Realtime Stream in Signals UI', async ({ page }) => {
  await ensureSignedIn(page);
  await page.goto(`${BASE}/collector/signals`);
  await page.waitForLoadState('networkidle');

  // Wait 2 seconds for live telemetry polling to fetch latest observations
  await page.waitForTimeout(2500);

  // Take screenshot 1
  await page.screenshot({ path: '../../realtime_signals_1.png' });

  // Get table cell texts for some signals
  const names = await page.locator('table tbody tr td:nth-child(2)').allInnerTexts();
  const firstValues = await page.locator('table tbody tr td:nth-child(4)').allInnerTexts();
  const qualities = await page.locator('table tbody tr td:nth-child(6)').allInnerTexts();
  const updated = await page.locator('table tbody tr td:nth-child(7)').allInnerTexts();

  console.log('Sample signal values at T=0:');
  for (let i = 0; i < Math.min(8, names.length); i++) {
    console.log(`  ${names[i].split('\n')[0]}: ${firstValues[i]} | ${qualities[i]} | ${updated[i]}`);
  }

  // Wait another 3 seconds for next polling cycles
  await page.waitForTimeout(3000);

  // Take screenshot 2
  await page.screenshot({ path: '../../realtime_signals_2.png' });
  const secondValues = await page.locator('table tbody tr td:nth-child(4)').allInnerTexts();
  const secondUpdated = await page.locator('table tbody tr td:nth-child(7)').allInnerTexts();
  console.log('Sample signal values at T=3s:');
  for (let i = 0; i < Math.min(8, names.length); i++) {
    console.log(`  ${names[i].split('\n')[0]}: ${secondValues[i]} | ${qualities[i]} | ${secondUpdated[i]}`);
  }
});
