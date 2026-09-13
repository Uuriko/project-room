import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const width of [390, 1280]) test(`New room ${width}: uncertain response retries one room and opens owner controls`, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  const account = f.store.createAccount('room-creator');
  const key = f.store.issueAccountAccessKey(account.id);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/?account=1');
  await page.locator('#access-key').fill(key);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.locator('#nav-rooms').click();
  await page.locator('#create-room-name').fill('Our new room');
  const bodies = []; let drop = true;
  await page.route('**/api/account-rooms', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postData());
    const response = await route.fetch();
    if (drop) { drop = false; return route.abort(); }
    return route.fulfill({ response });
  });
  await page.locator('#create-room-form button').click();
  await page.getByText('Not confirmed. Try again to check the same room.', { exact: true }).waitFor();
  assert.equal(await page.locator('#create-room-name').isDisabled(), true);
  await page.locator('#create-room-form button').click();
  await page.locator('#room-title').filter({ hasText: 'Our new room' }).waitFor().catch(async error => {
    throw new Error(error.message + '\n' + await page.locator('body').innerText());
  });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 2);
  const id = new URL(page.url()).searchParams.get('room');
  assert.equal(f.store.room(id).state.room.ownerId, 'owner');
  assert.deepEqual(Object.keys(f.store.room(id).state.members), ['owner']);
  assert.equal(await page.locator('#invite-people-button').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});
