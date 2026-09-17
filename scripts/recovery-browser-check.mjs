// Simulated human journey on a disposable database; no production traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createRecoveryFixture } from './recovery-fixture.mjs';
import { auditRecovery } from '../server/recovery.mjs';

test('actual Node entrypoint pauses without touching populated data, then resumes the same Room in a browser', { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-recovery-browser-'));
  const fixture = createRecoveryFixture(join(directory, 'room.sqlite')), before = auditRecovery(fixture.store);
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child, stopped, browser;
  const stop = async () => { if (child) { child.kill('SIGTERM'); await stopped; child = null; } };
  t.after(async () => { await browser?.close(); await stop(); fixture.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = async paused => {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, NODE_ENV: 'development', ROOM_DEPLOYMENT: '',
      ROOM_DB: fixture.filename, ROOM_ORIGIN: origin, ROOM_MAINTENANCE: paused ? '1' : '0', HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local service did not start')), 10000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Local service stopped before readiness')); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
  };
  await start(true); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const response = await page.goto(origin);
  assert.equal(response.status(), 503); assert.match(await page.locator('body').innerText(), /temporarily paused/);
  assert.equal((await page.context().cookies()).length, 0);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/recovery-paused-desktop.png' });
  assert.deepEqual(auditRecovery(fixture.store), before);
  await page.goto('about:blank'); await stop(); await start(false);
  await page.goto(origin); await page.locator('#access-key').fill(fixture.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(fixture.store.room('commons').sequence, fixture.cursor);
  const after = auditRecovery(fixture.store);
  assert.deepEqual(after.tables.filter(row => row.table !== 'credentials'), before.tables.filter(row => row.table !== 'credentials'));
  await page.screenshot({ path: 'test-results/recovery-resumed-desktop.png', mask: [page.locator('#access-key')] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.screenshot({ path: 'test-results/recovery-resumed-mobile-large-text.png', mask: [page.locator('#access-key')] });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
