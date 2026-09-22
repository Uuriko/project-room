// Synthetic browser journeys in disposable rooms; no real users or external data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const closed of ['full', 'cancelled', 'expired']) test(`a guest can reopen their original ${closed} invitation`, { timeout: 30000 }, async t => {
  const fixture = createAcceptanceFixture();
  const token = randomBytes(32).toString('base64url');
  const invitation = fixture.store.shareLinks.create(fixture.keys.owner, 'commons', {
    requestId: randomUUID(), linkToken: token, expiresAt: Date.now() + 3600000,
    maxJoins: closed === 'full' ? 1 : 2, expectedMemberRevision: 0,
  }, null);
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#join/${token}`);
  await page.locator('#join-link-name').fill('Returning guest');
  await page.locator('#join-link-submit').click();
  await page.locator('#main').waitFor({ state: 'visible' });
  const count = Object.keys(fixture.store.room('commons').state.members).length;
  if (closed === 'cancelled') fixture.store.shareLinks.cancel(fixture.keys.owner, 'commons', invitation.link.id, null);
  if (closed === 'expired') fixture.store.now = () => Date.now() + 3600001;
  await page.goto(`${origin}/#join/${token}`);
  await page.locator('#join-link-submit').waitFor({ state: 'visible' });
  await page.locator('#join-link-name').fill('Returning guest');
  await page.locator('#join-link-submit').click();
  await page.locator('#join-link-dialog').waitFor({ state: 'hidden' });
  await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(Object.keys(fixture.store.room('commons').state.members).length, count);
  assert.deepEqual(errors, []);
});
