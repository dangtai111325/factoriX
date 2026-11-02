/**
 * MQTT lab handshake against 192.168.2.108:18883 — archives QA-REVIEW connections after.
 */
import { chromium } from 'playwright';

const base = process.env.FACTORIX_BASE || 'http://127.0.0.1:8080';
const user = { username: 'qaaudit', password: 'FactoriX-Secure-2026!' };
const broker = { host: '192.168.2.108', port: '18883', topic: 'uns/TIPA/DongNai/Factory-1/ASSY/#' };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const api = async (path, opts = {}) =>
  page.evaluate(
    async ({ path, opts }) => {
      const res = await fetch(path, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts,
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!res.ok) throw new Error(`${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      return body;
    },
    { path, opts },
  );

try {
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel(/Email or username/i).fill(user.username);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await page.waitForURL(/overview/, { timeout: 20000 });

  const edges = await api('/api/v1/edges');
  const edgeList = edges.items || edges.edges || edges || [];
  const enrolled = (Array.isArray(edgeList) ? edgeList : []).filter(
    (e) => String(e.enrollment_status || e.enrollmentStatus || '').toUpperCase() === 'ENROLLED',
  );
  console.log('EDGES', JSON.stringify((Array.isArray(edgeList) ? edgeList : []).map((e) => ({
    id: e.id,
    name: e.name,
    status: e.enrollment_status || e.enrollmentStatus,
    health: e.health,
  }))));
  if (!enrolled.length) {
    console.log('FAIL: no enrolled edge — cannot complete MQTT lab handshake');
    process.exit(2);
  }

  await page.goto(base + '/acquisition/add-data', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Add data connection/i }).waitFor();
  await page.getByRole('button', { name: /MQTT Client/i }).click();
  await page.getByRole('button', { name: /^(Next Step|Next)$/i }).click();
  await page.waitForTimeout(400);

  const machSel = page.locator('select').first();
  const opts = await machSel.locator('option').allTextContents();
  const idx = opts.findIndex((o) => /AA10-02/i.test(o));
  if (idx >= 0) await machSel.selectOption({ index: idx });
  else if (opts.length > 1) await machSel.selectOption({ index: 1 });

  await page.getByPlaceholder('mqtt-connection').fill('QA-REVIEW-MQTT-lab');
  const host = page.getByLabel(/Broker Host/i).or(page.locator('label:has-text("Broker Host")').locator('xpath=following::input[1]'));
  const port = page.getByLabel(/Broker Port/i).or(page.locator('label:has-text("Broker Port")').locator('xpath=following::input[1]'));
  const topic = page.getByLabel(/Topic filter/i).or(page.locator('label:has-text("Topic filter")').locator('xpath=following::input[1]'));
  await host.first().fill(broker.host);
  await port.first().fill(broker.port);
  await topic.first().fill(broker.topic);
  await page.getByRole('button', { name: /^(Next Step|Next)$/i }).click();
  await page.waitForTimeout(500);

  const mapInputs = page.locator('table tbody tr').first().locator('input');
  await mapInputs.nth(1).fill('$.status');
  await mapInputs.nth(2).fill('status');
  await page.getByRole('button', { name: /^(Next Step|Next)$/i }).click();
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: /Test connection/i }).click();
  await page.waitForTimeout(12000);
  const body = await page.locator('body').innerText();
  const good =
    /Pass|PASSED|Handshake succeeded|Map fields.*pass|Start collecting/i.test(body) &&
    !/EDGE_NOT_ENROLLED|not enrolled/i.test(body);
  const failHint = body.match(/Handshake[^\n]{0,120}|EDGE[^\n]{0,80}|failed[^\n]{0,80}/i)?.[0] || body.slice(0, 240);
  console.log(good ? 'PASS MQTT-lab handshake' : `FAIL MQTT-lab: ${failHint.replace(/\s+/g, ' ')}`);

  // Cleanup: discard draft / archive QA-REVIEW connections
  const cancel = page.getByRole('button', { name: /^Cancel$/i }).first();
  if (await cancel.count()) {
    await cancel.click();
    await page.waitForTimeout(400);
    const discard = page.getByRole('button', { name: /Discard draft/i });
    if (await discard.count()) await discard.click();
    await page.waitForTimeout(800);
  }

  const conns = await api('/api/v1/connections');
  const items = conns.items || [];
  for (const c of items) {
    if (!/QA-REVIEW/i.test(c.name || '')) continue;
    try {
      await api(`/api/v1/connections/${c.id}/archive`, { method: 'POST', body: '{}' });
      console.log('ARCHIVED', c.name, c.id);
    } catch (err) {
      console.log('ARCHIVE-FAIL', c.name, String(err.message || err));
    }
  }

  process.exit(good ? 0 : 1);
} catch (e) {
  console.error('SCRIPT', e.stack || e);
  process.exit(1);
} finally {
  await browser.close();
}
