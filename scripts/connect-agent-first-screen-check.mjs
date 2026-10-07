import { signInFixture } from "./auth-signin.mjs";
import { openSettings, closeSettings } from "./room-chrome.mjs";
// Agent instructions stay discoverable behind one disclosure; direct links open it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

for (const touch of [false, true]) {
  test(`connect an agent ${touch ? 'touch' : 'desktop'}: sign-in stays minimal and connection guide opens post-login on request and deep link`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'room-connect-agent-'));
    const store = new RoomStore(join(directory, 'room.sqlite'));
    store.initialize(initialRoom());
    const server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Two hooks: the server and its directory are cleaned up even if the
    // browser never launches.
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());

    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      hasTouch: touch, isMobile: touch, reducedMotion: 'reduce'
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    const errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(origin);
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    const fontStates = await page.locator('#auth-title').evaluate(async node => {
      const style = getComputedStyle(node);
      return (await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, node.textContent)).map(face => face.status);
    });
    assert.deepEqual(fontStates, ['loaded'], 'the entrance wordmark loads its configured font instead of silently falling back');

    const prompt = page.locator('#join-agent-prompt');
    assert.equal(await prompt.isVisible(), false, 'setup instructions stay off anonymous entrance');
    assert.equal(await page.getByRole('button', { name: 'Agent sign in', exact: true }).count(), 1);
    await page.locator('#agent-signin-button').focus();
    await page.keyboard.press('Enter');
    await page.locator('#agent-signin-ui [name=identityId]').waitFor({ state: 'visible' });
    assert.equal(await prompt.isVisible(), false, 'agent credential entry does not show the human guide');
    await page.locator('#agent-auth-back').click();
    assert.equal(await page.locator('#agent-signin-button').evaluate(node => node === document.activeElement), true);
    const owner = store.issueAccessKey('commons', 'owner');
    await signInFixture(page, owner);
    await openSettings(page, 'advanced-room-tools');
    await page.locator('#connect-guide-open').click();
    await prompt.waitFor({ state: 'visible' });
    assert.ok(await page.locator('#join-agent-title').isVisible());

    // 3. It names the host actually being served, not a written-down address.
    const text = await prompt.inputValue();
    assert.ok(text.includes(`${origin}/llms.txt`), `the prompt points at this origin, got: ${text}`);
    assert.ok(!/staging/.test(text), 'no staging address');
    assert.ok(text.length < 160, 'short enough to read in one line');

    // 4. Selectable text, so the clipboard fallback has something to fall back
    //    to. A Copy button that only copies is useless without one.
    assert.equal(await prompt.getAttribute('readonly'), '', 'shown, not editable');

    // 6. None of this is an error state on a normal signed-out arrival.
    assert.equal(await page.locator('#join-agent-status').textContent(), '');

    // Now interact: copy really copies, and the expand really expands.
    await page.locator('#join-agent-copy').click();
    await page.locator('#join-agent-status').filter({ hasText: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, 'the clipboard holds what was shown');

    assert.equal(await page.locator('#join-agent-card').getAttribute('href'), `${origin}/.well-known/agent.json`);
    assert.equal(await page.locator('#join-agent-kits').getAttribute('href'), `${origin}/kits.txt`);

    // The packet the prompt sends an agent to has to actually answer.
    const response = await page.request.get(`${origin}/llms.txt`);
    assert.equal(response.status(), 200, 'the address in the prompt is a live door');
    assert.ok((await response.text()).length > 0);

    await page.locator('#connect-guide-close').click();
    await closeSettings(page);
    await page.goto(origin + '/#join-agent');
    await prompt.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#connect-guide-dialog').evaluate(node => node.open), true, 'signed-in direct links reveal the guide');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, [], 'no page errors');
  });
}
