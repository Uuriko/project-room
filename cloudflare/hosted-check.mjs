// Explicit operator-run acceptance for our staging app. Never runs in normal CI.
// Credentials and browser sessions stay in the ignored, private .operator folder.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = 'https://project-room-staging.getdasha.workers.dev';
const privatePath = name => new URL(`./.operator/${name}`, import.meta.url);
const output = fileURLToPath(new URL('./test-results/', import.meta.url));
const returning = process.argv.includes('--return');
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
    assert.match(await guest.locator('#identity-label').textContent(), /Hosted test guest/);
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
    await owner.locator('#share-link-create').click();
    await owner.locator('#share-link-result').waitFor({ state: 'visible' });
    const invitation = await owner.locator('#share-link-url').inputValue();
    assert.equal(new URL(invitation).origin, origin);
    await owner.locator('#share-link-close').click();
    await guest.goto(invitation);
    await guest.locator('#join-link-name').fill('Hosted test guest');
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
    await owner.screenshot({ path: `${output}/hosted-desktop.png`, fullPage: true });
    await guest.screenshot({ path: `${output}/hosted-mobile.png`, fullPage: true });
    await writeFile(privatePath('hosted-guest.json'), JSON.stringify(await guestContext.storageState()), { mode: 0o600 });
    await writeFile(privatePath('hosted-receipt.json'), JSON.stringify({ returnUrl: guest.url(), reply }), { mode: 0o600 });
    console.log('PASS: real HTTPS owner login, invitation, mobile Send, desktop Enter and bidirectional live updates. Private return evidence saved.');
  }
} finally {
  await browser.close();
}
