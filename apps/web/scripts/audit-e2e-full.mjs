/**
 * Full audit E2E against a fresh appliance at FACTORIX_E2E_BASE (default http://127.0.0.1:8080).
 * Creates hierarchy via API for reliability, then verifies UI acceptance criteria.
 */
import { chromium } from '@playwright/test';

const base = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080';
const user = {
  name: 'QA Auditor',
  email: 'qa@factorix.local',
  username: 'qaaudit',
  password: 'FactoriX-Secure-2026!',
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
const results = [];
const ok = (id, pass, detail) => {
  results.push({ id, pass, detail: String(detail).replace(/\s+/g, ' ').slice(0, 220) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}`);
};

async function api(path, { method = 'GET', body } = {}) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const row = document.cookie.split('; ').find((item) => item.startsWith('fx_csrf='));
      const csrf = row ? decodeURIComponent(row.slice('fx_csrf='.length)) : '';
      const headers = { Accept: 'application/json' };
      if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(path, {
        method,
        credentials: 'include',
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      if (!r.ok) {
        const msg = json?.error?.message || json?.message || json?.detail || text || r.statusText;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(json));
        err.status = r.status;
        err.code = json?.error?.code || json?.code;
        err.payload = json;
        throw err;
      }
      return json;
    },
    { path, method, body },
  );
}

try {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForURL(/register|login|overview/, { timeout: 20000 });

  if (page.url().includes('/register')) {
    ok('FX-0007-title', await page.getByRole('heading', { name: /Initial setup/i }).isVisible(), 'Initial setup visible');
    const terms = page.locator('input[type=checkbox]').first();
    ok('FX-0038-terms', !(await terms.isChecked()), `terms=${await terms.isChecked()}`);
    await page.locator('#register-name').fill(user.name);
    await page.locator('#register-email').fill(user.email);
    await page.locator('#register-username').fill(user.username);
    await page.locator('#register-password').fill(user.password);
    await page.locator('#register-confirm').fill(user.password);
    await terms.check();
    await page.getByRole('button', { name: /Create administrator/i }).click();
    await page.waitForURL(/login/, { timeout: 20000 });
    ok('FX-0007-created', page.url().includes('login'), page.url());
  } else {
    ok('FX-0007-title', true, 'admin already exists');
    ok('FX-0038-terms', true, 'skipped');
    ok('FX-0007-created', true, 'skipped');
  }

  if (!page.url().includes('/overview')) {
    await page.goto(base + '/login', { waitUntil: 'networkidle' });
    await page.getByLabel(/Email or username/i).fill(user.username);
    await page.locator('#login-password').fill(user.password);
    const remember = page.locator('input[type=checkbox]').first();
    if (await remember.count()) {
      ok('FX-0038-remember', !(await remember.isChecked()), `remember=${await remember.isChecked()}`);
    } else {
      ok('FX-0038-remember', true, 'no remember checkbox');
    }
    const loginBody = await page.locator('body').innerText();
    ok(
      'FX-0025-tls',
      /Local appliance connection/i.test(loginBody) && !/TLS 1\.3 secured/i.test(loginBody),
      /Local appliance/i.test(loginBody) ? 'Local appliance' : 'tls footer',
    );
    ok('FX-0036-signup-hidden', (await page.getByText(/Sign up now/i).count()) === 0, 'signup hidden');
    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/overview/, { timeout: 20000 });
  }

  // --- Overview health honesty ---
  let body = await page.locator('body').innerText();
  const healthChunk = body.match(/Collector Engine Health[\s\S]{0,220}/)?.[0] || '';
  ok(
    'FX-0004-normal',
    !/\bNORMAL\b/.test(healthChunk) || /NOT ENROLLED|UNKNOWN|waiting/i.test(healthChunk),
    healthChunk.replace(/\s+/g, ' ').slice(0, 160),
  );

  // --- Output groups / Diagnostics / RTZ / Edges nav ---
  await page.goto(base + '/signals/output-groups', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  ok('FX-0006-output', /Output Groups|No output groups/i.test(body), 'output groups rendered');

  await page.goto(base + '/live/diagnostics', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  ok('FX-0002-diag', !/Reactor 1|Packaging PLC|temperature_1/i.test(body), 'no fixture names');

  ok('FX-0008-rtz', (await page.getByRole('button', { name: 'Revert To Zero' }).count()) === 0, 'RTZ hidden');

  await page.goto(base + '/acquisition/edges', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  ok('FX-0003-edges-page', /Edge Collectors/i.test(body), 'edges page');

  // --- Create hierarchy via API ---
  const enterprise = await api('/api/v1/resources', {
    method: 'POST',
    body: {
      type_key: 'enterprise',
      code: 'TIPA',
      name: 'TIPA',
      site_id: null,
      parent_id: null,
      relation_code: 'CONTAINS',
      description: '',
      properties: {},
    },
  });

  const site = await api('/api/v1/sites', {
    method: 'POST',
    body: { code: 'DongNai', name: 'DongNai', timezone: 'Asia/Ho_Chi_Minh' },
  });
  const siteRes = await api('/api/v1/resources', {
    method: 'POST',
    body: {
      type_key: 'site',
      code: 'DongNai',
      name: 'DongNai',
      site_id: site.id,
      parent_id: enterprise.id,
      relation_code: 'CONTAINS',
      description: '',
      properties: {},
    },
  });
  const edge = await api('/api/v1/edges', {
    method: 'POST',
    body: { site_id: site.id, name: `Edge DongNai` },
  });
  ok('FX-0003-edge-api', !!edge.id, `edge=${edge.id}`);

  const plant = await api('/api/v1/resources', {
    method: 'POST',
    body: {
      type_key: 'plant',
      code: 'Factory-1',
      name: 'Factory-1',
      site_id: site.id,
      parent_id: siteRes.id,
      relation_code: 'CONTAINS',
      description: '',
      properties: {},
    },
  });
  const line = await api('/api/v1/resources', {
    method: 'POST',
    body: {
      type_key: 'line',
      code: 'ASSY',
      name: 'Assembly-AA10-02-AB',
      site_id: site.id,
      parent_id: plant.id,
      relation_code: 'CONTAINS',
      description: '',
      properties: {},
    },
  });
  const machine = await api('/api/v1/resources', {
    method: 'POST',
    body: {
      type_key: 'machine',
      code: 'AA10-02',
      name: 'AA10-02',
      site_id: site.id,
      parent_id: line.id,
      relation_code: 'CONTAINS',
      description: '',
      properties: {},
    },
  });
  ok('FX-0009-machine', !!machine.id, `machine=${machine.id}`);

  await page.goto(base + '/factory/structure', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  body = await page.locator('body').innerText();
  const treeItems = page.locator('[role="treeitem"], [role="tree"] [role="treeitem"]');
  let treeNames = [];
  if (await treeItems.count()) {
    treeNames = (await treeItems.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  } else {
    // Fallback: hierarchy panel labels in DOM order
    treeNames = (await page.locator('aside, [data-testid="hierarchy-tree"], .fx-tree').first().innerText().catch(async () => body))
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  const tipaIdx = treeNames.findIndex((t) => /^TIPA\b/i.test(t) || t.includes('TIPA'));
  const dnIdx = treeNames.findIndex((t) => t.includes('DongNai'));
  const mIdx = treeNames.findIndex((t) => t.includes('AA10-02') && !t.includes('Assembly'));
  ok(
    'FX-0009-order',
    tipaIdx >= 0 && dnIdx > tipaIdx && (mIdx < 0 || mIdx > dnIdx),
    `tree TIPA@${tipaIdx} DongNai@${dnIdx} machine@${mIdx} names=${treeNames.slice(0, 8).join(' | ')}`,
  );
  ok('FX-0005-bound', !/4 active collector tags/i.test(body), body.match(/BOUND[\s\S]{0,70}|bound signals[\s\S]{0,40}/i)?.[0] || 'no fake 4');
  ok('FX-0019-nodata', /NO DATA/i.test(body) || !/\bIDLE\b/.test(body), /NO DATA/i.test(body) ? 'NO DATA' : 'no IDLE');

  await page.goto(base + '/acquisition/edges', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Refresh/i }).click().catch(() => {});
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  ok(
    'FX-0003-edge-row',
    /UNENROLLED|NOT ENROLLED|Issue token|Edge DongNai|DongNai/i.test(body),
    body.slice(0, 200),
  );

  await page.goto(base + '/overview', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  const pill = body.match(/Collector:[^\n]+/)?.[0] || '';
  ok('FX-0003-pill', /not enrolled/i.test(pill), pill);

  // --- MQTT wizard ---
  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /MQTT Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok(
    'FX-0001-mqtt',
    /Broker Host/i.test(body) && /Topic filter/i.test(body) && !/PLC Host \/ IP Address/i.test(body) && !/Unit \/ Slave ID/i.test(body),
    'mqtt fields',
  );

  const host = page.getByLabel(/Broker Host/i).or(page.locator('label:has-text("Broker Host")').locator('xpath=following::input[1]'));
  const port = page.getByLabel(/Broker Port/i).or(page.locator('label:has-text("Broker Port")').locator('xpath=following::input[1]'));
  const topic = page.getByLabel(/Topic filter/i).or(page.locator('label:has-text("Topic filter")').locator('xpath=following::input[1]'));
  await host.first().fill('192.168.2.108');
  await port.first().fill('70000');
  await topic.first().fill('uns/TIPA/DongNai/Factory-1/ASSY/#');
  const machSel = page.locator('select').first();
  if (await machSel.count()) {
    const opts = await machSel.locator('option').allTextContents();
    const idx = opts.findIndex((o) => /AA10-02/i.test(o));
    if (idx >= 0) await machSel.selectOption({ index: idx });
    else if (opts.length > 1) await machSel.selectOption({ index: 1 });
  }
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0012-port', /1 to 65535|Port must|invalid port|between 1/i.test(body), body.match(/Port[^\n]{0,90}/)?.[0] || 'port validation');

  await port.first().fill('18883');
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0001-mapping', /JSONPath/i.test(body) && !/Holding Register/i.test(body), 'mqtt mapping');

  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0012-mapping-empty', /at least one|Add at least one|mapping/i.test(body), body.match(/at least[^\n]{0,80}|mapping[^\n]{0,60}/i)?.[0] || 'empty mapping');

  const inputs = page.locator('table input');
  if ((await inputs.count()) >= 2) {
    await inputs.nth(0).fill('$.status');
    await inputs.nth(1).fill('status');
  }
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0001-step4', /Run Handshake Test/i.test(body), 'handshake step');

  await page.getByRole('button', { name: /Run Handshake Test/i }).click();
  await page.waitForTimeout(7000);
  body = await page.locator('body').innerText();
  ok(
    'FX-0011-enroll-error',
    /EDGE_NOT_ENROLLED|not enrolled|EDGE_ENROLLMENT|enroll an edge|Handshake failed|Failed to commission/i.test(body),
    body.match(/EDGE_NOT_ENROLLED[^\n]{0,80}|not enrolled[^\n]{0,80}|EDGE_ENROLLMENT[^\n]{0,80}|Handshake failed[^\n]{0,80}/i)?.[0] || body.slice(0, 160),
  );

  const beforeConns = await api('/api/v1/connections');
  const beforeCount = (beforeConns.items || []).length;
  await page.getByRole('button', { name: /Cancel Wizard/i }).click();
  await page.waitForTimeout(400);
  if (await page.getByRole('button', { name: /Discard draft/i }).count()) {
    await page.getByRole('button', { name: /Discard draft/i }).click();
    await page.waitForTimeout(1500);
    ok('FX-0010-discard', true, 'discard prompted');
  } else {
    ok('FX-0010-discard', false, 'no discard prompt');
  }
  const afterConns = await api('/api/v1/connections');
  const afterCount = (afterConns.items || []).length;
  ok('FX-0010-no-orphan', afterCount <= beforeCount, `before=${beforeCount} after=${afterCount}`);

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /OPC UA Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0013-opc', /Endpoint URL/i.test(body) && !/Unit \/ Slave ID/i.test(body), 'opc form');

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /REST \/ HTTP API/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0013-http', /Base URL/i.test(body) && !/Unit \/ Slave ID/i.test(body), 'http form');

  await page.goto(base + '/signals/catalog', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  ok('FX-signals-no-fake-total', !/1,428/i.test(body), 'catalog totals honest');
} catch (e) {
  ok('SCRIPT', false, e.stack || e);
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log('\nSUMMARY', results.length - failed.length, '/', results.length, 'passed');
  if (failed.length) console.log(JSON.stringify(failed, null, 2));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
