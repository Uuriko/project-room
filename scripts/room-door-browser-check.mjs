import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

for (const touch of [false, true]) {
  test(`public /room door ${touch ? "mobile" : "desktop"}: canonical minimal auth, preserved deep links, separate agent packets`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-door-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      hasTouch: touch, isMobile: touch, reducedMotion: "reduce"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const path of ['/room', '/room/']) {
      await page.goto(`${origin}${path}?entry=browser&next=%2Fabout`);
      await page.locator('#auth-panel').waitFor({ state: 'visible' });
      assert.equal(page.url(), `${origin}/?entry=browser&next=%2Fabout`);
      assert.equal(await page.locator('#auth-title').innerText(), 'PROJECT ROOM');
      for (const name of ['Create account', 'Log in', 'Agent sign in']) {
        const button = page.getByRole('button', { name, exact: true });
        assert.equal(await button.count(), 1); assert.equal(await button.isVisible(), true);
      }
      assert.doesNotMatch(await page.locator('body').innerText(), /A shared place|Conversations, shared work|Have an invite\?|Paste a prompt|Connect an agent/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    // Capture the actual first navigation before the app handles each hash.
    for (const hash of ['#join/' + 'J'.repeat(43), '#code/abc-def-ghj', '#room/commons', '#join/']) {
      let arrived;
      const listener = frame => { if (frame === page.mainFrame() && frame.url().startsWith(origin + '/')) arrived ??= frame.url(); };
      page.on('framenavigated', listener);
      await page.goto(`${origin}/room?ref=invite${hash}`);
      page.off('framenavigated', listener);
      assert.equal(arrived, `${origin}/?ref=invite${hash}`);
    }
    await page.goto(`${origin}/room`); await page.locator('#auth-panel').waitFor({ state: 'visible' });
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/room-door-minimal-${touch ? 'mobile' : 'desktop'}.png`, fullPage: true });
    const workspace = await page.request.get(`${origin}/`);
    assert.match(workspace.headers()['content-type'], /text\/html/); assert.match(await workspace.text(), /message-input/);
    for (const path of ['/room/llms.txt', '/room/join.txt', '/room/mcp']) {
      const packet = await page.request.get(origin + path);
      assert.equal(packet.status(), 200); assert.match(packet.headers()['content-type'], /text\/plain/);
      assert.match(await packet.text(), /Project Room/);
    }
    const plain = await page.request.get(`${origin}/room`, { headers: { Accept: 'text/plain' } });
    assert.equal(plain.status(), 200); assert.match(plain.headers()['content-type'], /text\/plain/);
    assert.match(await plain.text(), /Project Room/);
    assert.deepEqual(errors, []);
  });
}
