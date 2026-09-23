// Synthetic restart journey in a real browser; no real user data or agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { fillAccessKey } from './auth-signin.mjs';

for (const mobile of [false, true]) test(`resume handoff ${mobile ? 'phone' : 'desktop'}: visible next step, opt-in export and no writes`, { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (type, data) => f.store.command(f.keys.producer, 'commons', { id: crypto.randomUUID(), type, data });
  send(T.WORK_ACCEPTED, { workItemId: 'test-handoff', expectedRevision: 0 });
  send(T.WORK_HANDOFF_RECORDED, { workItemId: 'test-handoff', expectedRevision: 1,
    doneSummary: 'Parser built; escaped separators still need testing.', nextAction: 'Check escaped separators.', limitReason: '<script>window.handoffExecuted=true</script>Session ended.' });
  const before = f.store.snapshot(f.keys.owner, 'commons');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await fillAccessKey(page, f.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  const card = page.locator('[data-work-record-id="test-handoff"]');
  const handoff = card.locator('[data-work-handoff]'); await handoff.waitFor({ state: 'visible' });
  assert.match(await handoff.innerText(), /Check escaped separators/);
  assert.equal(await handoff.getByRole("link", { name: "Open discussion" }).count(), 1);
  await handoff.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/project-room-resume-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  assert.equal(await handoff.getByText('Session ended.', { exact: false }).isVisible(), false);
  await handoff.getByText('Why work paused', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.handoffExecuted), undefined);
  await card.locator('details.work-details > summary').click();
  await card.getByRole('button', { name: 'Use my AI', exact: true }).click();
  const preview = page.locator('#packet-preview');
  assert.equal((await preview.inputValue()).includes('Parser built'), false);
  await page.locator('#portable-progress').check();
  assert.match(await preview.inputValue(), /Parser built/);
  await page.screenshot({ path: `/tmp/project-room-resume-prompt-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  assert.match(await preview.inputValue(), /Check escaped separators/);
  assert.match(await preview.inputValue(), /does not authorize external changes/);
  assert.equal((await preview.inputValue()).includes('Please prepare an agenda'), false);
  await page.locator('#portable-progress').uncheck();
  assert.equal((await preview.inputValue()).includes('Parser built'), false);
  await page.locator('#portable-close').click();
  await card.getByRole('button', { name: 'Use my AI', exact: true }).click();
  assert.equal(await page.locator('#portable-progress').isChecked(), false);
  await page.locator('#portable-close').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.store.snapshot(f.keys.owner, 'commons').state.workItems, before.state.workItems);
  assert.deepEqual(errors, []);
  // A subsequent real transition closes the handoff; its urgent card disappears.
  send(T.WORK_STARTED, { workItemId: 'test-handoff', expectedRevision: 2 });
  await handoff.waitFor({ state: 'detached' });
});
