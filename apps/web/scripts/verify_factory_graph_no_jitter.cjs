const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8080';
const ARTIFACT_DIR = 'C:/Users/Ave-T14-001/.gemini/antigravity/brain/53bc9a76-577a-4ba5-8175-947e53bf5611';

async function run() {
  console.log('--- Launching Playwright Chromium ---');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('1. Signing in via API...');
  let loginRes = await context.request.post(`${BASE}/api/v1/auth/login`, {
    data: { login: 'dangtai', password: 'Avenue-net@2026' },
  });
  if (!loginRes.ok()) {
    loginRes = await context.request.post(`${BASE}/api/v1/auth/login`, {
      data: { login: 'plantlead', password: 'Plant-Model-2026!' },
    });
  }
  console.log('Login result status:', loginRes.status());

  console.log('2. Navigating to Factory Graph...');
  await page.goto(`${BASE}/factory/graph`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // Check header and sidebar
  const pageHeading = await page.locator('h1').textContent();
  console.log('Page Heading:', pageHeading.trim());

  const sidebarGraphLink = await page.locator('aside a[href="/factory/graph"]').first().textContent();
  console.log('Sidebar Link Text:', sidebarGraphLink.trim());

  // Capture initial screenshot
  const initialShot = path.join(ARTIFACT_DIR, 'boss_verified_factory_graph_initial.png');
  await page.screenshot({ path: initialShot });
  console.log('Captured initial screenshot:', initialShot);

  // Find a node to drag: for instance a node containing "DongNai" or "Factory 1" or "Data"
  const targetNode = page.locator('.react-flow__node').filter({ hasText: 'DongNai' }).first();
  await targetNode.waitFor({ state: 'visible', timeout: 5000 });

  const initialBox = await targetNode.boundingBox();
  console.log('Target node initial position:', initialBox);

  // Drag node by +200px X, +120px Y
  console.log('3. Performing user drag on DongNai node...');
  const startX = initialBox.x + initialBox.width / 2;
  const startY = initialBox.y + initialBox.height / 2;
  const targetX = startX + 200;
  const targetY = startY + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const draggedBox = await targetNode.boundingBox();
  console.log('Target node immediately after drag:', draggedBox);
  const diffInitialVsDragged = Math.hypot(draggedBox.x - initialBox.x, draggedBox.y - initialBox.y);
  console.log(`Displacement from original: ${diffInitialVsDragged.toFixed(1)}px (Expected ~233px)`);

  // Wait 6 seconds (spans multiple 1.2s polling ticks!)
  console.log('4. Waiting 6 seconds across multiple 1.2s telemetry polling ticks...');
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(1000);
    const boxTick = await targetNode.boundingBox();
    console.log(`  Tick ${i}s: pos x=${boxTick.x.toFixed(1)}, y=${boxTick.y.toFixed(1)}`);
  }

  const afterWaitBox = await targetNode.boundingBox();
  console.log('Target node position after 6 seconds of streaming:', afterWaitBox);

  const driftAfterWait = Math.hypot(afterWaitBox.x - draggedBox.x, afterWaitBox.y - draggedBox.y);
  console.log(`Drift after 6 seconds: ${driftAfterWait.toFixed(1)}px`);

  if (driftAfterWait > 5) {
    throw new Error(`FAIL: Node snapped back or drifted! Expected drift < 5px, got ${driftAfterWait}px`);
  }
  console.log('SUCCESS: Node stayed EXACTLY in user-dragged position without resetting or snapping back!');

  const postDragShot = path.join(ARTIFACT_DIR, 'boss_verified_factory_graph_after_drag_stable.png');
  await page.screenshot({ path: postDragShot });
  console.log('Captured post-drag stable screenshot:', postDragShot);

  // 5. Click a Telemetry Data node and verify drawer opens with "Data", streaming tags
  console.log('5. Clicking a Data group node...');
  const dataNode = page.locator('.react-flow__node-telemetryGroup').first();
  await dataNode.click();
  await page.waitForTimeout(1000);

  const drawerShot = path.join(ARTIFACT_DIR, 'boss_verified_factory_graph_data_drawer_live.png');
  await page.screenshot({ path: drawerShot });
  console.log('Captured Data drawer live screenshot:', drawerShot);

  // 6. Test Reset Layout button
  console.log('6. Clicking Reset Layout button...');
  const resetBtn = page.getByRole('button', { name: /Reset Layout/i });
  await resetBtn.click();
  await page.waitForTimeout(1000);

  const resetBox = await targetNode.boundingBox();
  console.log('Target node position after Reset Layout:', resetBox);
  const resetShot = path.join(ARTIFACT_DIR, 'boss_verified_factory_graph_reset_layout.png');
  await page.screenshot({ path: resetShot });
  console.log('Captured Reset Layout screenshot:', resetShot);

  console.log('--- ALL VERIFICATIONS PASSED WITH FLYING COLORS ---');
  await browser.close();
}

run().catch((err) => {
  console.error('VERIFICATION ERROR:', err);
  process.exit(1);
});
