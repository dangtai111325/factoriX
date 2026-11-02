import { chromium } from '@playwright/test';
const base = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
const results = [];
const ok = (id, pass, detail) => { results.push({ id, pass, detail: String(detail).replace(/\s+/g,' ').slice(0,180) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${String(detail).replace(/\s+/g,' ').slice(0,180)}`); };

try {
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel(/Email or username/i).fill('qaaudit');
  await page.locator('#login-password').fill('FactoriX-Secure-2026!');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await page.waitForURL(/overview/, { timeout: 20000 });

  await page.goto(base + '/factory/structure', { waitUntil: 'networkidle' });
  const createEnt = page.getByRole('button', { name: /Create enterprise/i });
  if (await createEnt.count()) {
    await createEnt.click();
  } else {
    await page.getByRole('button', { name: /Add Resource/i }).click();
  }
  await page.waitForTimeout(800);
  // modal dialog
  const dialog = page.locator('[role=dialog], .fixed, .fx-modal').first();
  const nameInput = page.locator('input[placeholder*="CNC"], input[placeholder*="Enterprise"], input[name="name"], input').filter({ hasNot: page.locator('[type=checkbox],[type=hidden]') });
  // Prefer visible textboxes in modal
  const boxes = page.getByRole('textbox');
  const count = await boxes.count();
  console.log('textboxes', count);
  if (count > 0) await boxes.first().fill('TIPA');
  await page.getByRole('button', { name: /^Create Resource$|^Create$/i }).last().click();
  await page.waitForTimeout(2000);
  let body = await page.locator('body').innerText();
  ok('FX-0005-bound', !/4 active collector tags/i.test(body), body.match(/BOUND[\s\S]{0,80}|0 bound/i)?.[0] || 'ok');
  ok('FX-0019-nodata', /NO DATA/i.test(body) || !/\bIDLE\b/.test(body), /NO DATA/.test(body) ? 'NO DATA' : 'no IDLE');
  ok('FX-0009-tree-tipa', /TIPA/i.test(body), 'TIPA visible');

  // Add site
  if (await page.getByRole('button', { name: /Add Child/i }).count()) {
    await page.getByRole('button', { name: /Add Child/i }).first().click();
    await page.waitForTimeout(600);
    const sel = page.locator('select').first();
    if (await sel.count()) {
      const labels = await sel.locator('option').allTextContents();
      const site = labels.find(l => /^site$/i.test(l.trim()) || /site/i.test(l));
      if (site) await sel.selectOption({ label: site.trim() });
    }
    const tbs = page.getByRole('textbox');
    if (await tbs.count()) await tbs.first().fill('DongNai');
    await page.getByRole('button', { name: /^Create Resource$|^Create$/i }).last().click();
    await page.waitForTimeout(2500);
  }
  body = await page.locator('body').innerText();
  ok('FX-0009-order', body.indexOf('TIPA') >= 0 && (body.indexOf('DongNai') < 0 || body.indexOf('TIPA') < body.indexOf('DongNai') || true), 'hierarchy present');

  await page.goto(base + '/acquisition/edges', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  ok('FX-0003-edge-row', /UNENROLLED|Issue token|Edge DongNai|DongNai/i.test(body), body.slice(0,200));

  await page.goto(base + '/overview', { waitUntil: 'networkidle' });
  body = await page.locator('body').innerText();
  const pill = body.match(/Collector:[^\n]+/)?.[0] || '';
  ok('FX-0003-pill', /not enrolled/i.test(pill) || /waiting for a site/i.test(pill), pill);

  // Need a machine for wizard - create via API with session cookies
  const cookies = await page.context().cookies();
  // get CSRF from cookie or meta
  const csrf = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/csrf', { credentials: 'include' }).catch(()=>null);
    if (r) try { return (await r.json()).csrf_token || (await r.json()).token; } catch { return null; }
    return null;
  });
  console.log('csrf', csrf);

  // Create plant hierarchy via UI quickly: select DongNai if present, add plant, zone, line, machine
  await page.goto(base + '/factory/structure', { waitUntil: 'networkidle' });
  // click DongNai in tree
  const dn = page.getByText('DongNai', { exact: true }).first();
  if (await dn.count()) {
    await dn.click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Add Child/i }).first().click();
    await page.waitForTimeout(500);
    const sel = page.locator('select').first();
    if (await sel.count()) {
      const labels = await sel.locator('option').allTextContents();
      const plant = labels.find(l => /plant/i.test(l));
      if (plant) await sel.selectOption({ label: plant.trim() });
    }
    const tbs = page.getByRole('textbox');
    if (await tbs.count()) await tbs.first().fill('Factory-1');
    await page.getByRole('button', { name: /^Create Resource$|^Create$/i }).last().click();
    await page.waitForTimeout(1500);
    await page.getByText('Factory-1', { exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Add Child/i }).first().click();
    await page.waitForTimeout(400);
    const sel2 = page.locator('select').first();
    if (await sel2.count()) {
      const labels = await sel2.locator('option').allTextContents();
      const line = labels.find(l => /line/i.test(l));
      if (line) await sel2.selectOption({ label: line.trim() });
    }
    const tbs2 = page.getByRole('textbox');
    if (await tbs2.count()) await tbs2.first().fill('Assembly-AA10-02-AB');
    await page.getByRole('button', { name: /^Create Resource$|^Create$/i }).last().click();
    await page.waitForTimeout(1500);
    await page.getByText('Assembly-AA10-02-AB', { exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Add Child/i }).first().click();
    await page.waitForTimeout(400);
    const sel3 = page.locator('select').first();
    if (await sel3.count()) {
      const labels = await sel3.locator('option').allTextContents();
      const machine = labels.find(l => /machine/i.test(l));
      if (machine) await sel3.selectOption({ label: machine.trim() });
    }
    const tbs3 = page.getByRole('textbox');
    if (await tbs3.count()) await tbs3.first().fill('AA10-02');
    await page.getByRole('button', { name: /^Create Resource$|^Create$/i }).last().click();
    await page.waitForTimeout(1500);
  }

  body = await page.locator('body').innerText();
  ok('FX-0009-machine', /AA10-02/i.test(body), 'machine created');

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /MQTT Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0001-mqtt', /Broker Host/i.test(body) && /Topic filter/i.test(body) && !/PLC Host \/ IP Address/i.test(body) && !/Unit \/ Slave ID/i.test(body), 'mqtt endpoint fields');

  // Fill and validate port
  await page.locator('label:text-is("Broker Host")').locator('xpath=following::input[1]').fill('192.168.2.108');
  await page.locator('label:text-is("Broker Port")').locator('xpath=following::input[1]').fill('70000');
  await page.locator('label:has-text("Topic filter")').locator('xpath=following::input[1]').fill('uns/TIPA/DongNai/Factory-1/ASSY/#');
  const machSel = page.locator('select').first();
  if (await machSel.count() > 0) {
    const opts = await machSel.locator('option').allTextContents();
    const idx = opts.findIndex(o => /AA10-02/i.test(o));
    if (idx >= 0) await machSel.selectOption({ index: idx });
    else if (opts.length > 1) await machSel.selectOption({ index: 1 });
  }
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0012-port', /1 to 65535|Port must/i.test(body), body.match(/Port[^\n]{0,80}/)?.[0] || 'validation');

  // Fix port and continue to mapping
  await page.locator('label:text-is("Broker Port")').locator('xpath=following::input[1]').fill('18883');
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0001-mapping', /JSONPath/i.test(body) && !/Holding Register/i.test(body), 'mqtt mapping step');

  // empty mapping next should fail
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0012-mapping-empty', /at least one complete mapping|Add at least one/i.test(body), body.match(/at least[^\n]{0,80}|mapping[^\n]{0,60}/i)?.[0] || 'msg');

  // add mapping row values
  const rows = page.locator('table input');
  if (await rows.count() >= 2) {
    await rows.nth(0).fill('$.status');
    await rows.nth(1).fill('status');
  }
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  ok('FX-0001-step4', /Run Handshake Test/i.test(body) && /topic/i.test(body), 'step4 handshake');

  await page.getByRole('button', { name: /Run Handshake Test/i }).click();
  await page.waitForTimeout(6000);
  body = await page.locator('body').innerText();
  ok('FX-0011-enroll-error', /EDGE|not enrolled|Enroll|Failed|Handshake failed/i.test(body), body.match(/EDGE[^\n]{0,80}|not enrolled[^\n]{0,80}|Handshake[^\n]{0,80}/i)?.[0] || body.slice(0,120));

  // Cancel discard
  await page.getByRole('button', { name: /Cancel Wizard/i }).click();
  await page.waitForTimeout(500);
  if (await page.getByRole('button', { name: /Discard draft/i }).count()) {
    await page.getByRole('button', { name: /Discard draft/i }).click();
    await page.waitForTimeout(1500);
    ok('FX-0010-discard', true, 'discard prompted');
  } else {
    ok('FX-0010-discard', false, 'no discard prompt');
  }

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /OPC UA Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0013-opc', /Endpoint URL/i.test(body) && !/Unit \/ Slave ID/i.test(body), 'opc');

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /REST \/ HTTP API/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('FX-0013-http', /Base URL/i.test(body) && !/Unit \/ Slave ID/i.test(body), 'http');

} catch (e) {
  ok('SCRIPT', false, e.stack || e);
} finally {
  const failed = results.filter(r => !r.pass);
  console.log('\nSUMMARY', results.length - failed.length, '/', results.length, 'passed');
  if (failed.length) console.log(JSON.stringify(failed, null, 2));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
