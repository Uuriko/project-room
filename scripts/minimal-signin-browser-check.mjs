import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const mobile of [false, true]) test(`Minimal sign-in and account entry (${mobile ? 'mobile' : 'desktop'})`, async t => {
  const f = createAcceptanceFixture();
  const key = f.store.issueAccountAccessKey(f.store.accountForMember('commons', 'owner').id);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(deny => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (deny) throw new Error('Clipboard denied');
      window.copiedSetup = text;
    } } });
  }, mobile);
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#access-key').isVisible(), false);
  assert.equal(await page.locator('#invite-link').isVisible(), false);
  assert.equal(await page.locator('#refresh-button').isVisible(), false);
  assert.equal(await page.locator('#key-access').innerText(), 'Sign in');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/project-room-signin-${mobile ? 'mobile' : 'desktop'}.png` });
  assert.equal(await page.locator('#auth-title').innerText(), 'Project Room');
  await page.locator('#project-help-button').click();
  await page.locator('#project-help').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#project-help').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#project-help-button').evaluate(node => node === document.activeElement), true);
  await page.locator('#copy-agent-setup').click();
  if (mobile) {
    await page.locator('#agent-setup-prompt').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#agent-setup-prompt').evaluate(node => node.selectionEnd === node.value.length), true);
    await page.locator('#project-help-close').click();
  } else {
    await page.getByText('Copied. Paste into your agent.', { exact: true }).waitFor();
    const prompt = await page.evaluate(() => window.copiedSetup);
    assert.match(prompt, /separate agent identity/);
    assert.match(prompt, /never ask me to paste my password/);
    assert.ok(!prompt.includes('?room=commons'));
  }
  await page.locator('#sign-in-entry').focus(); await page.keyboard.press('Enter');
  await page.locator('#access-key').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-lead').isVisible(), false);
  await page.locator('#auth-kind-account').click();
  await page.locator('#auth-key-file').setInputFiles({ name: 'invalid', mimeType: 'text/plain', buffer: Buffer.from('not a credential') });
  await page.getByText('Choose a valid Project Room key file.', { exact: true }).waitFor();
  assert.equal(await page.locator('#access-key').inputValue(), '');
  await page.locator('#auth-key-file').setInputFiles({ name: 'account-key', mimeType: 'text/plain', buffer: Buffer.from(key + '\n') });
  await page.waitForFunction(() => document.querySelector('#access-key').value.length === 43);
  assert.equal(await page.locator('#access-key').getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#signout-button').click();
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#access-key').isVisible(), false);
  assert.equal(await page.locator('#key-access').innerText(), 'Sign in');
  assert.deepEqual(errors, []);
});
