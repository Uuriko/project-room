// Explicit operator-run acceptance for our staging app. Never runs in normal CI.
// Credentials and browser sessions stay in the ignored, private .operator folder.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const origin = 'https://project-room-staging.getdasha.workers.dev';
const privatePath = name => new URL(`./.operator/${name}`, import.meta.url);
const output = fileURLToPath(new URL('./test-results/', import.meta.url));
const { values } = parseArgs({ options: {
  return: { type: 'boolean' }, 'invite-user': { type: 'boolean' },
  work: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('Hosted check: no flags creates a synthetic guest and messages; --work also creates test work; --return only checks saved guest access; --invite-user creates a private invitation. Never runs in CI.');
  process.exit(0);
}
const returning = values.return, inviting = values['invite-user'], checkingWork = values.work;
if (returning && (inviting || checkingWork) || inviting && checkingWork) throw new Error('Choose one hosted check mode');
const { chromium } = await import('playwright');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  if (returning) {
    const receipt = JSON.parse(await readFile(privatePath('hosted-receipt.json'), 'utf8'));
    const guestContext = await browser.newContext({ storageState: fileURLToPath(privatePath('hosted-guest.json')) });
    const guest = await guestContext.newPage();
    guest.setDefaultTimeout(20000);
    await guest.goto(receipt.returnUrl);
    await guest.locator('#main').waitFor({ state: 'visible' });
    await guest.getByText(receipt.reply, { exact: true }).first().waitFor();
    assert.match(await guest.locator('#identity-label').textContent(), /test guest/i);
    await guest.screenshot({ path: `${output}/hosted-return.png`, fullPage: true });
    console.log('PASS: hosted guest session and message survived redeployment.');
  } else {
    const ownerContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const owner = await ownerContext.newPage(), guest = await guestContext.newPage();
    for (const page of [owner, guest]) page.setDefaultTimeout(20000);
    await owner.goto(origin);
    await owner.locator('#access-key').fill((await readFile(privatePath('owner-key.txt'), 'utf8')).trim());
    await owner.getByRole('button', { name: 'Enter room', exact: true }).click();
    await owner.locator('#main').waitFor({ state: 'visible' });
    await owner.locator('#invite-people-button').click();
    if (!inviting) {
      await owner.locator('#share-settings > summary').click();
      await owner.locator('#share-link-expiry').selectOption('1');
      await owner.locator('#share-link-limit').fill('1');
      await owner.locator('#share-settings > summary').click();
    }
    await owner.locator('#share-link-create').click();
    await owner.locator('#share-link-result').waitFor({ state: 'visible' });
    const invitation = await owner.locator('#share-link-url').inputValue();
    assert.equal(new URL(invitation).origin, origin);
    await owner.locator('#share-link-close').click();
    if (inviting) {
      await writeFile(privatePath('user-test-invite.txt'), invitation + '\n', { mode: 0o600 });
      console.log('User-testing invite saved privately: cloudflare/.operator/user-test-invite.txt (24 hours, up to 10 new guests).');
    } else {
    await guest.goto(invitation);
    await guest.locator('#join-link-name').fill(`Test guest ${Date.now().toString(36).slice(-4)}`);
    await guest.locator('#join-link-submit').click();
    await guest.locator('#main').waitFor({ state: 'visible' });
    const stamp = new Date().toISOString();
    const message = `Hosted invitation check ${stamp}`;
    const reply = `Hosted live reply ${stamp}`;
    await guest.locator('#message-input').fill(message);
    await guest.getByRole('button', { name: 'Send', exact: true }).click();
    await owner.getByText(message, { exact: true }).first().waitFor();
    await owner.locator('#message-input').fill(reply);
    await owner.locator('#message-input').press('Enter');
    await guest.getByText(reply, { exact: true }).first().waitFor();
    assert.equal(guest.url().includes('#join/'), false);
    if (checkingWork) {
      assert.equal(await guest.locator('#composer-work-button').isVisible(), false);
      assert.equal(await guest.locator('#new-work-button').isVisible(), false);
      const source = owner.locator('[data-message-record-id]').filter({ hasText: message });
      await source.locator('[data-message-action="work"]').click();
      assert.equal(await owner.locator('#work-title-input').inputValue(), message);
      await owner.locator('#work-title-input').fill(`Test: hosted first work ${stamp}`);
      await owner.locator('#work-done-input').fill('Synthetic operator test: guest suggestion links to work assigned to the owner.');
      await owner.locator('#assignee-select').selectOption('owner');
      await owner.locator('#reviewer-unavailable').waitFor({ state: 'visible' });
      assert.equal(await owner.locator('#require-verification').isChecked(), true);
      await owner.locator('#review-settings-button').click();
      await owner.locator('#require-verification').uncheck();
      assert.equal(await owner.locator('#require-decision').isChecked(), true);
      await owner.getByRole('button', { name: 'Create outcome', exact: true }).click();
      const card = owner.locator('[data-work-record-id]').filter({ hasText: `Test: hosted first work ${stamp}` });
      await card.waitFor();
      for (const action of ['accept', 'start']) {
        await card.locator(`[data-action="${action}"]`).click();
        await owner.getByRole('button', { name: 'Save record', exact: true }).click();
        await owner.locator('#action-dialog').waitFor({ state: 'hidden' });
      }
      await guest.locator('[data-work-record-id]').filter({ hasText: `Test: hosted first work ${stamp}` }).waitFor();
      console.log('PASS: hosted guest suggestion -> source-linked work -> explicit review choice -> owner accepts and starts; guest sees progress.');
    }
    await owner.screenshot({ path: `${output}/hosted-desktop.png`, fullPage: true });
    await guest.screenshot({ path: `${output}/hosted-mobile.png`, fullPage: true });
    await writeFile(privatePath('hosted-guest.json'), JSON.stringify(await guestContext.storageState()), { mode: 0o600 });
    await writeFile(privatePath('hosted-receipt.json'), JSON.stringify({ returnUrl: guest.url(), reply }), { mode: 0o600 });
    console.log('PASS: real HTTPS owner login, invitation, mobile Send, desktop Enter and bidirectional live updates. Private return evidence saved.');
    }
  }
} finally {
  await browser.close();
}
