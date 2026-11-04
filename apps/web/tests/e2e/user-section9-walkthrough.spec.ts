import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

const ARTIFACT_DIR = 'C:/Users/Ave-T14-001/.gemini/antigravity/brain/53bc9a76-577a-4ba5-8175-947e53bf5611';

const ASSY_36_TOPICS = [
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/production/order_progress',

  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/production/order_progress',

  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/AA10-03/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/AA10-03/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/AA10-03/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/AA10-03/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-A3/production/order_progress',

  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/AA10-04/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/AA10-04/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/AA10-04/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/AA10-04/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-A4/production/order_progress',

  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/production/order_progress',

  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/AA10-06/state',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/AA10-06/process',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/AA10-06/energy',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/AA10-06/condition',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/production/order',
  'uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-A6/production/order_progress',
];

test.describe('Section 9 End-to-End User Experience Walkthrough', () => {
  test.setTimeout(120000);

  test('full end-to-end user sequence per Section 9 and datasource guide', async ({ page }) => {
    page.on('console', (msg) => console.log(`[BROWSER ${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.log('[BROWSER UNCAUGHT]:', err.message));
    page.on('response', async (res) => {
      if (!res.ok()) {
        let body = '';
        try {
          body = await res.text();
        } catch {}
        console.log(`[HTTP ${res.status()}] ${res.request().method()}: ${res.url()} -> ${body}`);
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

    // Sidebar structure verification
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Factory Model').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hierarchy Structure' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Layout Designer' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Knowledge Graph' })).toBeVisible();
    await expect(page.getByText('Data Collector').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Connections/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Signals' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edge Collectors' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Diagnostics' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Model Catalog' })).toBeVisible();

    // Coming soon section
    const comingSoonSection = page.getByText(/Coming soon/i).first();
    await expect(comingSoonSection).toBeVisible();

    // 2. Hierarchy Structure: Import 36 MQTT topics
    await page.goto(`${BASE}/factory/structure`);
    await page.waitForLoadState('networkidle');

    // Check if Import Topics button is visible or if empty state shows import link
    const importBtn = page.getByRole('button', { name: /Import Topics/i });
    const importLink = page.getByText(/Import from MQTT topics/i);

    if (await importBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await importBtn.click();
    } else if (await importLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await importLink.click();
    } else {
      // If enterprise already exists, check if Import Topics button is in header
      await expect(importBtn).toBeVisible({ timeout: 5000 });
      await importBtn.click();
    }

    // Modal open
    await expect(page.getByText('Import from MQTT Topics')).toBeVisible();

    // Paste 36 topics
    const textarea = page.locator('textarea');
    await textarea.fill(ASSY_36_TOPICS.join('\n'));

    // Click Preview
    const previewBtn = page.getByRole('button', { name: /Run Preview/i });
    await previewBtn.click();

    // Verify preview results appear
    await expect(page.getByText(/resources to create|existing/i)).toBeVisible({ timeout: 10000 });

    // Click Import
    const confirmImportBtn = page.getByRole('button', { name: /Import Resources/i });
    if (await confirmImportBtn.isEnabled()) {
      await confirmImportBtn.click();
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle');
    } else {
      // Close modal if already imported
      await page.getByRole('button', { name: /Cancel/i }).click();
    }

    // Verify hierarchy tree has TIPA, DongNai, Factory-1, ASSY
    await expect(page.getByText('TIPA').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_hierarchy_imported.png` });

    // 3. Connections: Verify or Create mqtt-lab
    await page.goto(`${BASE}/collector/connections`);
    await page.waitForLoadState('networkidle');

    const connRow = page.getByText('mqtt-lab').first();
    const hasConn = await connRow.isVisible({ timeout: 2000 }).catch(() => false);

    if (!hasConn) {
      const addConnBtn = page.getByRole('button', { name: /Add Connection|New Connection/i }).first();
      await addConnBtn.click();

      // Modal open
      await expect(page.getByText('New Industrial Connection')).toBeVisible();

      // Fill form
      await page.getByPlaceholder('e.g. mqtt-192.168.2.108').fill('mqtt-lab');
      await page.getByPlaceholder('broker.example.local').fill('192.168.2.108');

      // Test connection
      const testConnBtn = page.getByRole('button', { name: /Test connection/i });
      if (await testConnBtn.isVisible()) {
        await testConnBtn.click();
        await page.waitForTimeout(1500);
      }

      // Save connection
      const saveBtn = page.getByRole('button', { name: /Create Connection/i });
      await saveBtn.click();
      await page.waitForTimeout(2000);
    }

    // Verify connection is present
    await expect(page.getByText('mqtt-lab').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_connections_saved.png` });

    // 4. Add Data Wizard: Configure signals for AA10-01
    await page.goto(`${BASE}/collector/add-data`);
    await page.waitForLoadState('networkidle');

    // Step 1: Target
    // Find AA10-01 in target tree/list
    const searchTarget = page.locator('input[placeholder*="Filter"], input[placeholder*="Search"]').first();
    if (await searchTarget.isVisible()) {
      await searchTarget.fill('AA10-01');
    }
    const targetItem = page.getByText('AA10-01').first();
    await expect(targetItem).toBeVisible({ timeout: 10000 });
    await targetItem.click();

    // Next to step 2 (Source)
    await page.getByRole('button', { name: /Next: Select Source/i }).click();

    // Step 2: Source - choose mqtt-lab
    await page.waitForTimeout(500);
    const mqttConnOption = page.getByText('mqtt-lab').first();
    await expect(mqttConnOption).toBeVisible({ timeout: 10000 });
    await mqttConnOption.click();

    // Next to step 3 (Address)
    await page.getByRole('button', { name: /Next: Source Address/i }).click();
    await page.waitForTimeout(500);

    // Step 3: Address
    const topicInput = page.locator('input[value*="uns/"]').or(page.locator('input[placeholder*="uns/"]')).first();
    if (await topicInput.isVisible()) {
      await topicInput.fill('uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/#');
    }

    // Next to step 4 (Fields)
    await page.getByRole('button', { name: /Next: Map Fields/i }).click();
    await page.waitForTimeout(500);

    // Step 4: Fields - add field
    const addFieldBtn = page.getByRole('button', { name: /Add field/i });
    if (await addFieldBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addFieldBtn.click();
      await page.waitForTimeout(500);
    } else {
      const captureBtn = page.getByRole('button', { name: /Capture sample/i });
      if (await captureBtn.isVisible()) {
        await captureBtn.click();
        await page.waitForTimeout(11000);
        const addSampleField = page.getByText('status').first();
        if (await addSampleField.isVisible()) {
          await addSampleField.click();
        }
      }
    }

    // Next to step 5 (Review)
    await page.getByRole('button', { name: /Next: Review & Test/i }).click();
    await page.waitForTimeout(500);

    // Step 5: Review & Test
    const runTestBtn = page.getByRole('button', { name: /Run test/i });
    if (await runTestBtn.isVisible()) {
      await runTestBtn.click();
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_add_data_review.png` });

    // Start collecting
    const startCollectingBtn = page.getByRole('button', { name: /Start collecting/i });
    if (await startCollectingBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
      await startCollectingBtn.click();
      await page.waitForTimeout(3000);
    }

    // 5. Signals Catalog & Live Operations
    await page.goto(`${BASE}/collector/signals`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Signals/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_signals_catalog.png` });

    // 6. Layout Designer (LD-01..04)
    await page.goto(`${BASE}/factory/layout`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Layout Designer/i })).toBeVisible();

    // Click TIPA card on canvas
    const tipaCard = page.locator('div[role="button"][aria-label*="TIPA"]').first();
    if (await tipaCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tipaCard.click({ force: true });
      await page.waitForTimeout(600);

      // Click DongNai card on canvas
      const dongNaiCard = page.locator('div[role="button"][aria-label*="DongNai"]').first();
      if (await dongNaiCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dongNaiCard.click({ force: true });
        await page.waitForTimeout(600);

        // Click Factory-1 card on canvas
        const f1Card = page.locator('div[role="button"][aria-label*="Factory-1"]').first();
        if (await f1Card.isVisible({ timeout: 3000 }).catch(() => false)) {
          await f1Card.click({ force: true });
          await page.waitForTimeout(600);

          // Click ASSY card on canvas
          const assyCard = page.locator('div[role="button"][aria-label*="ASSY"]').first();
          if (await assyCard.isVisible({ timeout: 3000 }).catch(() => false)) {
            await assyCard.click({ force: true });
            await page.waitForTimeout(600);
          }
        }
      }
    }
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_layout_assy.png` });

    // 7. Knowledge Graph
    await page.goto(`${BASE}/factory/graph`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Knowledge Graph/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_knowledge_graph.png` });

    // 8. Edge Collectors
    await page.goto(`${BASE}/collector/edges`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Edge Collectors/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_edge_collectors.png` });

    // 9. Diagnostics
    await page.goto(`${BASE}/collector/diagnostics`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Diagnostics/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_diagnostics.png` });

    // 10. Data Models
    await page.goto(`${BASE}/models`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Model Catalog', exact: true })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_models.png` });

    // 11. Overview final verification
    await page.goto(`${BASE}/overview`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /Get started/i })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/screen_e2e_overview_final.png` });
  });
});
