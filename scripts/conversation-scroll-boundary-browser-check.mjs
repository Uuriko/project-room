import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';

// Real layout regression: an unrelated gesture must not relinquish ownership
// of the timeline when the composer or surrounding chrome subsequently grows.
for (const gesture of ['wheel', 'touchmove', 'keydown']) {
  test(`unrelated ${gesture} preserves conversation follow during resize`, { timeout: 30000 }, async t => {
    const f = createAcceptanceFixture();
    f.store.roomFlood = { consume() {} };
    for (let i = 0; i < 45; i++) f.store.command(f.keys.owner, 'commons', {
      id: `scroll-seed-${i}`, type: 'message.posted', data: { messageId: `scroll-message-${i}`, body: `Conversation message ${i}\n${'Visible context. '.repeat(12)}` }
    });
    const server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await signInFixture(page, f.keys.owner);
    await page.locator('[data-message-record-id="scroll-message-44"]').waitFor();
    await page.waitForFunction(() => {
      const list = document.querySelector('#message-list');
      return list.scrollHeight > list.clientHeight && list.scrollHeight - list.scrollTop - list.clientHeight < 2;
    });
    await page.evaluate(kind => {
      const target = document.querySelector('#topbar-search-toggle');
      const event = kind === 'wheel' ? new WheelEvent(kind, { bubbles: true, deltaY: 80 })
        : kind === 'keydown' ? new KeyboardEvent(kind, { bubbles: true, key: 'PageDown' })
        : new Event(kind, { bubbles: true });
      target.dispatchEvent(event);
    }, gesture);
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.waitForFunction(() => {
      const list = document.querySelector('#message-list');
      return list.scrollHeight - list.scrollTop - list.clientHeight < 2;
    }, null, { timeout: 2500 });
    // Reader input in the actual timeline must still release follow.
    await page.locator('#message-list').evaluate(list => {
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
      list.scrollTop -= 200;
    });
    const before = await page.locator('#message-list').evaluate(list => list.scrollTop);
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await page.locator('#message-list').evaluate(list => list.scrollTop);
    assert.equal(after, before, 'reading older messages keeps the reader position');
  });
}
