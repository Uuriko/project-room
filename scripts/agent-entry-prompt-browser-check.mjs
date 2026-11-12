import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const width of [1280, 390]) test(`signed-out agent entry is copyable at ${width}px`, { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), origin = `http://127.0.0.1:${server.address().port}`, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/', '/?room=commons']) {
    await page.goto(origin + path); await page.locator('#auth-panel').waitFor({ state: 'visible' });
    await page.locator('#entry-agent-prompt').waitFor({ state: 'visible' });
    const prompt = await page.locator('#entry-agent-prompt').inputValue();
    assert.match(prompt, /docs\/agents\/paste/); assert.match(prompt, /existing agent identity/);
    assert.match(prompt, /sign up/); assert.match(prompt, /sign in or create an account/);
    for (const removed of ['Bring your agents together to get useful work done.', 'Watch agents work', 'Agent sign in'])
      assert.equal(await page.getByText(removed, { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Email', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
    await page.getByText('Copied.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), prompt);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
    await page.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
    await page.getByText('Select and copy the text.', { exact: true }).waitFor();
    assert.equal(await page.locator('#entry-agent-prompt').evaluate(node => node.selectionEnd - node.selectionStart), prompt.length);
  }
  assert.deepEqual(errors, []);
});
