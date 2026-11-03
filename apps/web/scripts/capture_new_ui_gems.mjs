import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

const outDir = path.resolve('artifacts', 'gems_evidence');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1680,1000'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000 });

  console.log('Navigating to http://localhost:3000/signals ...');
  await page.goto('http://localhost:3000/signals', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1000));

  // 1. Capture Micro-Sparklines in Signals Table
  console.log('Capturing micro-sparklines in signals table...');
  await page.screenshot({ path: path.join(outDir, '01_signals_micro_sparklines.png'), fullPage: false });

  // 2. Select 2 checkboxes to trigger Floating Bulk Action Bar
  console.log('Selecting checkboxes to trigger Floating Bulk Action Bar...');
  const checkboxes = await page.$$('tbody input[type="checkbox"]');
  if (checkboxes.length >= 2) {
    await checkboxes[0].click();
    await checkboxes[1].click();
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(outDir, '02_floating_bulk_action_bar.png'), fullPage: false });
  }

  // 3. Click Plant Switcher dropdown in Topbar
  console.log('Opening Plant Switcher Dropdown...');
  const plantBtn = await page.$('button[title*="switch physical plant"]');
  if (plantBtn) {
    await plantBtn.click();
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(outDir, '03_plant_switcher_dropdown.png'), fullPage: false });
    // Click again to close
    await plantBtn.click();
    await new Promise(r => setTimeout(r, 300));
  }

  // 4. Click Daemon Health pill in Topbar
  console.log('Opening Collector Daemon Health Popover...');
  const daemonBtn = await page.$('button[title*="Edge Collector Daemon health"]');
  if (daemonBtn) {
    await daemonBtn.click();
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(outDir, '04_daemon_health_popover.png'), fullPage: false });
  }

  console.log('Done capturing UI gems evidence!');
  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
