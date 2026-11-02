import { chromium } from '@playwright/test';

const base = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
const results = [];
const ok = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };

try {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForURL(/register|login|overview/);
  const onRegister = page.url().includes('/register');
  ok('FX-0007-title', onRegister && await page.getByRole('heading', { name: /Initial setup/i }).isVisible(), await page.locator('h1').nth(1).innerText().catch(()=>page.locator('h1').first().innerText()));
  const terms = page.locator('input[type=checkbox]').first();
  ok('FX-0038-terms', !(await terms.isChecked()), `terms checked=${await terms.isChecked()}`);

  if (onRegister) {
    await page.locator('#register-name').fill('QA Auditor');
    await page.locator('#register-email').fill('qa@factorix.local');
    await page.locator('#register-username').fill('qaaudit');
    await page.locator('#register-password').fill('FactoriX-Secure-2026!');
    await page.locator('#register-confirm').fill('FactoriX-Secure-2026!');
    await terms.check();
    await page.getByRole('button', { name: /Create administrator/i }).click();
    await page.waitForTimeout(1500); if (!page.url().includes("login")) { const t = await page.locator("body").innerText(); throw new Error("register stuck: "+t.split("\n").filter(l=>/must|error|fail|invalid/i.test(l)).slice(0,5).join(" | ")); }
    ok('FX-0007-created', page.url().includes('login'), page.url());
  } else {
    ok('FX-0007-created', true, 'already past register: ' + page.url());
  }

  if (!page.url().includes('/overview')) {
    await page.goto(base + '/login', { waitUntil: 'networkidle' });
    await page.getByLabel(/Email or username/i).fill('qaaudit');
    await page.locator('#login-password').fill('FactoriX-Secure-2026!');
    const remember = page.locator('input[type=checkbox]').first();
    if (await remember.count()) ok('FX-0038-remember', !(await remember.isChecked()), `remember=${await remember.isChecked()}`);
    const tlsText = await page.locator('body').innerText();
    ok('FX-0025-tls', /Local appliance connection/i.test(tlsText) || !/TLS 1\.3 secured/i.test(tlsText), /Local appliance/i.test(tlsText) ? 'Local appliance shown' : 'footer check');
    ok('FX-0036-signup-hidden', !(await page.getByText(/Sign up now/i).count()), `signup count=${await page.getByText(/Sign up now/i).count()}`);
    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/overview/, { timeout: 20000 });
  }

  const overview = await page.locator('body').innerText();
  const healthChunk = overview.match(/Collector Engine Health[\s\S]{0,180}/)?.[0] || '';
  ok('FX-0004-normal', !/\bNORMAL\b/.test(healthChunk) || /NOT ENROLLED|UNKNOWN/i.test(healthChunk), healthChunk.replace(/\s+/g,' ').slice(0,160));

  await page.goto(base + '/signals/output-groups', { waitUntil: 'networkidle' });
  const og = await page.locator('body').innerText();
  ok('FX-0006-output', /No output groups yet|Output Groups/i.test(og) && (await page.locator('aside, .fx-sidebar').count()) > 0, og.slice(0,120).replace(/\s+/g,' '));

  await page.goto(base + '/live/diagnostics', { waitUntil: 'networkidle' });
  const diag = await page.locator('body').innerText();
  ok('FX-0002-diag', !/Reactor 1|Packaging PLC|temperature_1/i.test(diag), /No signal quality/i.test(diag) ? 'empty honest' : diag.match(/Invalid Signals[\s\S]{0,40}/)?.[0] || 'ok-ish');

  ok('FX-0008-rtz', await page.getByRole('button', { name: 'Revert To Zero' }).count() === 0, 'RTZ count');

  await page.goto(base + '/acquisition/edges', { waitUntil: 'networkidle' });
  const edges = await page.locator('body').innerText();
  ok('FX-0003-edges', /Edge Collectors|No edges yet|Enrollment/i.test(edges), edges.slice(0,140).replace(/\s+/g,' '));

  await page.goto(base + '/factory/structure', { waitUntil: 'networkidle' });
  if (await page.getByRole('button', { name: /Create enterprise/i }).count()) {
    await page.getByRole('button', { name: /Create enterprise/i }).click();
  } else if (await page.getByRole('button', { name: /Add Resource/i }).count()) {
    await page.getByRole('button', { name: /Add Resource/i }).click();
  }
  await page.waitForTimeout(600);
  const nameField = page.locator('input').filter({ hasNot: page.locator('[type=checkbox]') }).first();
  // Prefer labeled
  const labeled = page.getByLabel(/Resource Name|Name/i);
  if (await labeled.count()) {
    await labeled.first().fill('TIPA');
  } else {
    await page.locator('.fx-input').first().fill('TIPA');
  }
  await page.getByRole('button', { name: /^Create/i }).last().click();
  await page.waitForTimeout(2000);
  const struct = await page.locator('body').innerText();
  ok('FX-0005-bound', !/4 active collector tags/i.test(struct), struct.match(/BOUND[\s\S]{0,80}|bound signals[\s\S]{0,40}/i)?.[0]?.replace(/\s+/g,' ') || 'no fake 4');
  ok('FX-0019-nodata', /NO DATA/i.test(struct) || !/\bIDLE\b/.test(struct), /NO DATA/i.test(struct) ? 'NO DATA present' : 'IDLE absent or replaced');

  // Create site under TIPA if selected
  const addChild = page.getByRole('button', { name: /Add Child/i });
  if (await addChild.count()) {
    await addChild.first().click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').first();
    if (await typeSelect.count()) {
      const opts = await typeSelect.locator('option').allTextContents();
      const siteOpt = opts.find((o) => /site/i.test(o));
      if (siteOpt) await typeSelect.selectOption({ label: siteOpt.trim() });
    }
    const nf = page.getByLabel(/Resource Name|Name/i);
    if (await nf.count()) await nf.first().fill('DongNai');
    else await page.locator('.fx-input').first().fill('DongNai');
    await page.getByRole('button', { name: /^Create/i }).last().click();
    await page.waitForTimeout(2500);
  }

  await page.goto(base + '/acquisition/edges', { waitUntil: 'networkidle' });
  const edges2 = await page.locator('body').innerText();
  ok('FX-0003-after-site', /UNENROLLED|Issue token|DongNai|Edge/i.test(edges2), edges2.slice(0,220).replace(/\s+/g,' '));

  await page.goto(base + '/overview', { waitUntil: 'networkidle' });
  const pill = (await page.locator('body').innerText()).match(/Collector:[^\n]+/)?.[0] || '';
  ok('FX-0003-pill', /not enrolled|waiting for a site/i.test(pill), pill);

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /MQTT Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(500);
  const step2 = await page.locator('body').innerText();
  ok('FX-0001-mqtt-labels', /Broker Host/i.test(step2) && /Topic filter/i.test(step2) && !/PLC Host \/ IP Address/i.test(step2), 'mqtt form');
  ok('FX-0013-not-modbus-on-mqtt', !/Unit \/ Slave ID/i.test(step2), 'no unit/slave');

  // invalid port
  const hostBox = page.locator('label:text-is("Broker Host")').locator('xpath=following::input[1]');
  const portBox = page.locator('label:text-is("Broker Port")').locator('xpath=following::input[1]');
  const topicBox = page.locator('label:has-text("Topic filter")').locator('xpath=following::input[1]');
  if (await hostBox.count() && await portBox.count() && await topicBox.count()) {
    await hostBox.fill('192.168.2.108');
    await portBox.fill('70000');
    await topicBox.fill('uns/TIPA/DongNai/Factory-1/ASSY/#');
    // pick machine if select exists
    const mach = page.locator('select').first();
    if (await mach.count()) {
      const options = await mach.locator('option').all();
      if (options.length > 1) await mach.selectOption({ index: 1 });
    }
    await page.getByRole('button', { name: /Next Step/i }).click();
    await page.waitForTimeout(400);
    const err = await page.locator('body').innerText();
    ok('FX-0012-port', /1 to 65535|Port must/i.test(err), err.match(/Port[^\n]{0,90}/)?.[0] || 'no error text');
  } else {
    ok('FX-0012-port', false, 'mqtt fields missing');
  }

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /OPC UA Client/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  const opc = await page.locator('body').innerText();
  ok('FX-0013-opcua', /Endpoint URL/i.test(opc) && !/Unit \/ Slave ID/i.test(opc), 'opc form');

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /REST \/ HTTP API/i }).click();
  await page.getByRole('button', { name: /Next Step/i }).click();
  await page.waitForTimeout(400);
  const http = await page.locator('body').innerText();
  ok('FX-0013-http', /Base URL/i.test(http) && !/Unit \/ Slave ID/i.test(http), 'http form');

} catch (e) {
  ok('SCRIPT', false, String(e.stack || e));
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log('\nSUMMARY', results.length - failed.length, '/', results.length, 'passed');
  if (failed.length) console.log(JSON.stringify(failed, null, 2));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}


