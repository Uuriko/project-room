import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';

// WAVE-500 g6-46 fail-first repro: Ask Room is dead for fresh users.
// In a room with no assistant connected (every brand-new room), clicking
// "Ask Room" armed the button with nothing behind it: the member's question
// had nowhere to go and nothing said so. The API rejects the invoke with
// assistant_not_connected, but the browser armed first and only surfaced the
// rejection after the user composed and sent. The ask must say so instead of
// arming silently. This test fails on main until the no-coordinator hint
// (open PR #2286) lands; it is copy-agnostic on purpose.
test('Ask Room with no assistant connected says so instead of arming', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [], pages = [];
  for (const member of ['owner','guest']) {
    const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
    page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys[member]);
    await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience'));
    await page.waitForFunction(()=>document.querySelector('#room-assistant-status')?.textContent==='Not connected'); pages.push(page);
  }
  const [owner, peer] = pages;
  // A member with no assistant behind the ask: Ask Room must not arm with
  // nothing to ask; it must say the assistant is missing.
  await peer.locator('#ask-room').click();
  assert.equal(await peer.locator('#ask-room').getAttribute('aria-pressed'),'false','Ask Room must not arm with no assistant connected');
  assert.match(await peer.locator('#assistant-error').textContent(),/assistant/i,'the member sees an honest no-assistant hint');
  // The owner gets the same honest treatment, not a dead arm.
  await owner.locator('#ask-room').click();
  assert.equal(await owner.locator('#ask-room').getAttribute('aria-pressed'),'false','owner Ask Room must not arm with no assistant connected');
  assert.match(await owner.locator('#assistant-error').textContent(),/assistant/i,'the owner sees an honest no-assistant hint');
  assert.deepEqual(errors,[]);
});
