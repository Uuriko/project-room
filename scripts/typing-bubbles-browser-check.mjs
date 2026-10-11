import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { recordBeat, clearBeat, typingBeats } from '../server/typing.mjs';

test('live typing renders compact avatar bubbles, preserves animations, expires and respects reduced motion', { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    typingBeats.delete('commons'); await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await signInFixture(page, f.keys.owner);
  recordBeat(typingBeats, 'commons', { id: 'producer', displayName: 'Ada Lovelace', kind: 'human' });
  const bubble = page.locator('.typing-bubble'); await bubble.waitFor();
  assert.equal(await bubble.locator('.typing-avatar').innerText(), 'AL');
  assert.equal(await bubble.locator('.typing-dots i').count(), 3);
  assert.equal(await bubble.innerText(), 'AL\nAda Lovelace is typing');
  assert.equal(await bubble.locator('.sr-only').textContent(), 'Ada Lovelace is typing');
  assert.equal(await bubble.locator('.typing-dots i').first().evaluate(el => getComputedStyle(el).animationName), 'typing-dot');
  await page.evaluate(() => { window.typingNode = document.querySelector('.typing-bubble'); });
  recordBeat(typingBeats, 'commons', { id: 'producer', displayName: 'Ada Lovelace', kind: 'human' });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.typingNode === document.querySelector('.typing-bubble')), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await bubble.locator('.typing-dots i').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('#typing-indicator').screenshot({ path: '/tmp/project-room-typing-bubbles.png' });
  clearBeat(typingBeats, 'commons', 'producer');
  await page.locator('#typing-indicator').waitFor({ state: 'hidden' });
});
