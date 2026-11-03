import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = path.resolve('artifacts/user_review_qa');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function runReview() {
  console.log('Starting User-Role Chrome Automated Verification...');

  // Launch Chrome Headless at 1672x941
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1672,941'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1672, height: 941 });

  // 1. Review Overview
  console.log('1. Reviewing Overview Dashboard...');
  await page.goto('http://localhost:3000/overview', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_overview.png') });

  // 2. Review Factory Structure & Add/Move Modals
  console.log('2. Reviewing Factory Structure & Modals...');
  await page.goto('http://localhost:3000/factory/structure', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(800);

  // Click "Add Resource"
  const addResourceBtn = await page.$('button ::-p-text(Add Resource)');
  if (addResourceBtn) {
    await addResourceBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_add_resource_modal_open.png') });
    console.log('  -> Captured Add Resource Modal');

    // Type a resource name and submit
    await page.type('input[placeholder*="e.g. CNC-03"]', 'CNC-03 Mazak Alpha');
    await page.waitForTimeout(300);
    const submitBtn = await page.$('button ::-p-text(Create Resource)');
    if (submitBtn) await submitBtn.click();
    await page.waitForTimeout(500);
  }

  // Click "Move"
  const moveBtn = await page.$('button ::-p-text(Move)');
  if (moveBtn) {
    await moveBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_move_resource_modal_open.png') });
    console.log('  -> Captured Move Resource Modal');
    const cancelMove = await page.$('button ::-p-text(Cancel)');
    if (cancelMove) await cancelMove.click();
    await page.waitForTimeout(300);
  }

  // 3. Review Connections & Universal Add Data Wizard & Ping Test
  console.log('3. Reviewing Connections & Wizard...');
  await page.goto('http://localhost:3000/acquisition/connections', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(800);

  // Click "New Connection" to trigger Wizard
  const newConnBtn = await page.$('button ::-p-text(New Connection)');
  if (newConnBtn) {
    await newConnBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_add_data_wizard_step1.png') });
    console.log('  -> Captured Add Data Wizard Step 1');

    // Step 2: Click Next
    const nextBtn = await page.$('button ::-p-text(Next)');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_add_data_wizard_step2.png') });
      console.log('  -> Captured Add Data Wizard Step 2');

      // Step 3
      await nextBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_add_data_wizard_step3.png') });
      console.log('  -> Captured Add Data Wizard Step 3');

      // Step 4
      await nextBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_add_data_wizard_step4.png') });
      console.log('  -> Captured Add Data Wizard Step 4');

      // Step 5
      await nextBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_add_data_wizard_step5.png') });
      console.log('  -> Captured Add Data Wizard Step 5');
    }

    const cancelWizard = await page.$('button ::-p-text(Cancel)');
    if (cancelWizard) await cancelWizard.click();
    await page.waitForTimeout(300);
  }

  // Click "Test Diagnostics"
  const testDiagBtn = await page.$('button ::-p-text(Test Diagnostics)');
  if (testDiagBtn) {
    await testDiagBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_connection_ping_test.png') });
    console.log('  -> Captured Connection Diagnostics & Ping Test');
    const closeTest = await page.$('button ::-p-text(Close)');
    if (closeTest) await closeTest.click();
    await page.waitForTimeout(300);
  }

  // 4. Review 3-Pane JSON Mapping Studio
  console.log('4. Reviewing 3-Pane JSON Mapping Studio...');
  await page.goto('http://localhost:3000/acquisition/studio/mqtt', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '14_json_mapping_studio_3pane.png') });
  console.log('  -> Captured 3-Pane JSON Mapping Studio');

  // Click Simulate Inbound Event
  const simBtn = await page.$('button ::-p-text(Simulate Inbound Event)');
  if (simBtn) {
    await simBtn.click();
    await page.waitForTimeout(400);
    console.log('  -> Clicked Simulate Inbound Event successfully');
  }

  // 5. Review Live Acquisition Monitor
  console.log('5. Reviewing Live Acquisition Monitor...');
  await page.goto('http://localhost:3000/live/monitor', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_live_acquisition_monitor.png') });
  console.log('  -> Captured Live Acquisition Monitor');

  // Click row to select signal inspector
  const tableRows = await page.$$('table tbody tr');
  if (tableRows.length > 2) {
    await tableRows[2].click();
    await page.waitForTimeout(400);
    console.log('  -> Selected row for signal inspection');
  }

  // 6. Review Diagnostics & Root-Cause Troubleshooting
  console.log('6. Reviewing Diagnostics & Root-Cause Troubleshooting...');
  await page.goto('http://localhost:3000/live/diagnostics', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(800);

  // Click "Run All Test Suites"
  const runAllBtn = await page.$('button ::-p-text(Run All Test Suites)');
  if (runAllBtn) {
    await runAllBtn.click();
    await page.waitForTimeout(600);
    console.log('  -> Clicked Run All Test Suites');
  }

  // Click first error in diagnostics stream
  const diagRows = await page.$$('table tbody tr');
  if (diagRows.length > 0) {
    await diagRows[0].click();
    await page.waitForTimeout(500);
    console.log('  -> Opened Issue Details drawer for Paint_Line_PLC');
  }

  // Click "Test Connection Now" in drawer
  const testConnNowBtn = await page.$('button ::-p-text(Test Connection Now)');
  if (testConnNowBtn) {
    await testConnNowBtn.click();
    await page.waitForTimeout(800);
    console.log('  -> Executed Test Connection ping');
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11_diagnostics_root_cause_troubleshooting.png') });
  console.log('  -> Captured Diagnostics with Root-Cause Drawer & Test Result');

  await browser.close();
  console.log('Automated User Review Complete! All screenshots saved to artifacts/user_review_qa');
}

runReview().catch((err) => {
  console.error('User review script error:', err);
  process.exit(1);
});
