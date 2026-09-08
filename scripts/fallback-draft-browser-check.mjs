// Local qualification of actual packaged runtimes, never live services/models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRuntimePackage, verifyRuntimePackage } from './runtime-package.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const candidateCommit = '9745978c784b71ac90487d37b4e5d7b26fa45ef4';
const fallbackCommit = process.env.ROOM_DRAFT_FALLBACK_COMMIT ?? '4d22189ccdebc56db23397e6cc75b07eff0e3c2c';

for (const touch of [false, true]) test(`packaged browser fallback ${touch ? 'touch' : 'desktop'}: drafts survive and sign-out clears private state`, { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-draft-switch-')), fixture = createAcceptanceFixture();
  let browser, server, runtimeStore, port;
  const stop = async () => {
    if (server) { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
    runtimeStore?.close(); runtimeStore = null;
  };
  t.after(async () => { await browser?.close(); await stop(); fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); });
  assert.notEqual(candidateCommit, fallbackCommit, 'Qualify a genuinely distinct fallback');
  const packages = new Map([['candidate', candidateCommit], ['fallback', fallbackCommit]].map(([name, commit]) => {
    const path = join(directory, name), receipt = createRuntimePackage({ repository, commit, destination: path });
    assert.equal(receipt.schemaVersion, 12); return [name, { path, receipt }];
  }));
  const start = async name => {
    await stop(); const pkg = packages.get(name);
    const { RoomStore } = await import(pathToFileURL(join(pkg.path, 'server/store.mjs')));
    const { createRoomServer } = await import(pathToFileURL(join(pkg.path, 'server/http.mjs')));
    runtimeStore = new RoomStore(join(fixture.directory, 'room.sqlite'));
    server = createRoomServer({ store: runtimeStore, streamInterval: 50 });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port ?? 0, '127.0.0.1', resolve); });
    port = server.address().port;
  };
  await start('candidate'); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
  const page = await context.newPage(), issues = [], errors = [];
  page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept()); // Explicit synthetic reload/sign-out choices.
  const origin = `http://127.0.0.1:${port}`;
  const enter = async (who = 'owner') => {
    await page.locator('#access-key').fill(fixture.keys[who]);
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#main').waitFor({ state: 'visible' });
  };
  const remember = async () => {
    if (!await page.locator('#remember-drafts').isVisible()) await page.locator('#composer-options > summary').click();
    await page.locator('#remember-drafts').check();
  };
  const switchTo = async name => {
    // Preserve the same page/sessionStorage/cookies and the same service origin.
    await start(name); await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  };
  const noDrafts = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => /^project-room:drafts:v\d+$/.test(key)).length === 0);
  await page.goto(origin); await enter(); await remember();
  const sequence = fixture.store.room('commons').sequence;
  await page.locator('#message-input').fill('Private ordinary draft');
  await page.locator('#request-reply').click();
  await page.locator('#message-to-select').selectOption('guest');
  await page.locator('#message-input').fill('Private request draft');
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message-input').inputValue(), 'Private request draft');
  await switchTo('fallback');
  if (await page.locator('#message-input').inputValue() !== 'Private ordinary draft') issues.push('ordinary draft unavailable on fallback');
  await remember(); await page.locator('#message-input').fill('Ordinary draft edited on fallback');
  await switchTo('candidate');
  if (await page.locator('#request-mode-bar').isVisible()) await page.locator('#request-exit').click();
  if (await page.locator('#message-input').inputValue() !== 'Ordinary draft edited on fallback') issues.push('fallback ordinary edit lost on return');
  if (!await page.locator('#request-reply').isVisible()) await page.locator('#composer-options > summary').click();
  await page.locator('#request-reply').click();
  assert.equal(await page.locator('#message-input').inputValue(), 'Private request draft', 'request draft remains separate from ordinary chat');
  assert.equal(fixture.store.room('commons').sequence, sequence, 'draft transitions never send messages');
  const commands = []; let lose = true;
  await page.route('**/api/rooms/commons/commands', async route => {
    commands.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled && document.querySelector('#composer-status').classList.contains('error'));
  assert.equal(await page.locator('#message-input').evaluate(node => node.readOnly), true);
  const requestId = commands[0].data.messageId;
  assert.equal(fixture.store.room('commons').sequence, sequence + 1);
  await switchTo('fallback');
  assert.equal(fixture.store.room('commons').sequence, sequence + 1, 'fallback never converts a request retry into ordinary chat');
  await switchTo('candidate');
  if (!await page.locator('#request-mode-bar').isVisible()) {
    if (!await page.locator('#request-reply').isVisible()) await page.locator('#composer-options > summary').click();
    await page.locator('#request-reply').click();
  }
  assert.equal(await page.locator('#message-input').evaluate(node => node.readOnly), true);
  await page.locator('#message-form button[type=submit]').click();
  await page.locator('#request-mode-bar').waitFor({ state: 'hidden' });
  assert.equal(commands.length, 2); assert.deepEqual(commands[1], commands[0], 'unknown request retries exactly once with original identity/content');
  assert.equal(fixture.store.room('commons').sequence, sequence + 1);
  assert.equal(fixture.store.room('commons').state.messages.filter(message => message.id === requestId).length, 1);
  lose = true;
  await page.locator('#message-input').fill('Ordinary message with lost response');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled && document.querySelector('#composer-status').classList.contains('error'));
  assert.equal(fixture.store.room('commons').sequence, sequence + 2);
  await switchTo('fallback');
  assert.equal(await page.locator('#message-input').inputValue(), 'Ordinary message with lost response');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled && !document.querySelector('#message-input').value);
  assert.equal(commands.length, 4); assert.deepEqual(commands[3], commands[2], 'ordinary unknown retry is exact on fallback');
  assert.equal(fixture.store.room('commons').sequence, sequence + 2);
  await switchTo('candidate');
  if (!await page.locator('#request-reply').isVisible()) await page.locator('#composer-options > summary').click();
  await page.locator('#request-reply').click();
  await page.locator('#message-input').fill('Private request after exact retry');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/fallback-draft-${touch ? 'touch' : 'desktop'}-returned.png` });
  await switchTo('fallback');
  await page.locator('#signout-button').click(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  if (!await noDrafts()) issues.push('newer private draft storage remains after fallback sign-out');
  await page.screenshot({ path: `test-results/fallback-draft-${touch ? 'touch' : 'desktop'}-signed-out.png` });
  await start('candidate'); await page.reload(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  await enter(); assert.equal(await page.locator('#message-input').inputValue(), '');
  assert.equal(await noDrafts(), true, 'returning after sign-out must not restore private drafts');
  await page.locator('#signout-button').click(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  await enter('guest'); assert.equal(await page.locator('#message-input').inputValue(), '');
  assert.equal(await noDrafts(), true, 'another identity never inherits private drafts');
  assert.deepEqual(errors, []);
  for (const pkg of packages.values()) assert.deepEqual(verifyRuntimePackage(pkg.path), pkg.receipt);
  t.diagnostic(JSON.stringify({ candidateCommit, fallbackCommit, issues, boundary: 'Local simulated human browser/package switch only' }));
  assert.deepEqual(issues, [], 'Selected fallback is not browser draft/privacy compatible');
});
