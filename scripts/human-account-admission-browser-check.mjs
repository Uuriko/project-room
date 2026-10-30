import * as visualEvidence from "./visual-regression-helper.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const PW = "synthetic-invitee-password";
const SIZES = [["desktop 1280", { viewport: { width: 1280, height: 860 } }], ["phone 390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]];

async function setup(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  let mailer = null;
  const server = createRoomServer({ store: f.store, streamInterval: 40,
    magicLinkMailer: { isConfigured: () => true, sendMagicLink: p => mailer.sendMagicLink(p), sendPasswordResetNotice: p => mailer.sendPasswordResetNotice(p) } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  mailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => { sent.push(payload); } });
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const open = async size => {
    const page = await (await browser.newContext({ ...size, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    return page;
  };
  const verifyMails = email => sent.filter(m => m.to === email && m.purpose === "email-verify");
  const session = async page => (await (await page.context().request.get(`${origin}/api/account-session`)).json());
  return { ...f, origin, open, verifyMails, session };
}

import { signInFixture } from './auth-signin.mjs';
import { writeFileSync,mkdirSync } from 'node:fs';
for (const [label, size] of SIZES) test(`signed human approval opens room with same account (${label})`, {timeout:60000}, async t => {
  const f=await setup(t),page=await f.open(size);
  await page.goto(f.origin);
  if (!size.isMobile) {
    await page.goto(`${f.origin}/join`);
    await page.locator('#join-request > summary').click();
    await page.locator('#join-request-room').fill('commons');
    await page.locator('#join-request-name').fill('Human admission audit');
    await page.locator('#join-request-submit').click();
    await page.locator('#join-request-status a').click();
  }
  const auth=page.locator('#auth-signin-ui');
  await auth.locator('[data-password-mode="signup"]').click();
  await auth.locator('[name="email"]').fill('admission-audit@example.invalid');
  await auth.locator('[name="password"]').fill(PW);
  const signup=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/password/signup');
  await auth.locator('button[type="submit"]').click();assert.equal((await signup).status(),202);
  if (!size.isMobile) await page.waitForURL(url => url.pathname === '/join' && url.searchParams.get('room') === 'commons');
  const signed=await f.session(page);
  const verification=f.verifyMails('admission-audit@example.invalid').at(-1);
  assert.ok(verification?.code);
  const verified=await page.context().request.post(f.origin+'/api/auth/email/verify',{headers:{Origin:f.origin,'X-CSRF-Token':signed.csrf,'X-Session-Binding':signed.sessionBinding},data:{code:verification.code}});
  assert.equal(verified.status(),200);
  const account=(await f.session(page)).account;
  assert.ok(account?.id);
  await page.goto(`${f.origin}/join`);
  await page.locator('#join-request > summary').click();
  await page.locator('#join-request-room').fill(`${f.origin}/?room=commons`);
  await page.locator('#join-request-name').fill('Human admission audit');
  const submitted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/account/access-requests' && r.request().method()==='POST');
  await page.locator('#join-request-submit').click();
  const response=await submitted;assert.ok(response.ok());const receipt=await response.json();assert.equal(receipt.request.principalKind,'account');assert.equal(receipt.request.identityId,null);
  await page.locator('#join-request-form').waitFor({state:'hidden'});
  mkdirSync('test-results/human-admission',{recursive:true});
  await page.screenshot({path:'test-results/human-admission/request-pending.png',fullPage:true});
  if (size.isMobile) {
    await page.reload();
    await page.getByText('Waiting for the room owner to approve your request…',{exact:true}).waitFor();
    assert.equal(await page.locator('#join-request-form').isVisible(),false);
    // Exercise persisted lifecycle handlers explicitly; native BFCache
    // eligibility varies by browser and this does not claim to test it.
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    const resumed=page.waitForEvent('load');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await resumed;
    await page.getByText('Waiting for the room owner to approve your request…',{exact:true}).waitFor();
  }
  if (size.isMobile) {
    const current=await f.session(page);
    const cancelled=await page.context().request.post(`${f.origin}/api/account/access-requests/${receipt.request.requestId}`,{
      headers:{Origin:f.origin,'X-CSRF-Token':current.csrf,'X-Session-Binding':current.sessionBinding},data:{}
    });
    assert.equal(cancelled.status(),200);
    await page.getByRole('button',{name:'Request access again',exact:true}).click();
    await page.waitForURL(url=>!url.searchParams.has('access-request'));
    await page.locator('#join-request > summary').click();
    await page.locator('#join-request-name').fill('Human admission audit');
    const resubmitted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/account/access-requests'&&r.request().method()==='POST');
    await page.locator('#join-request-submit').click();
    const newResponse=await resubmitted;assert.equal(newResponse.status(),201);
    assert.notEqual((await newResponse.json()).request.requestId,receipt.request.requestId);
    await page.locator('#join-request-form').waitFor({state:'hidden'});
  }
  await visualEvidence.captureDesignEvidence?.(page, {id:`human-admission-pending-${size.isMobile ? "phone" : "desktop"}`,title:"Human waits for room approval",fixture:"Verified synthetic human account, real server admission",testName:t.name,component:"human admission"});
  const owner=await f.open(SIZES[0][1]);await owner.goto(f.origin);await signInFixture(owner,f.keys.owner);await owner.locator('#main').waitFor({state:'visible'});
  await owner.locator('#topbar-updates').click();
  const card=owner.locator('#attention-list > li').filter({hasText:'Human admission audit'});
  await card.waitFor();
  await owner.waitForFunction(() => document.querySelector('#updates-status')?.textContent !== 'Loading updates…');
  assert.doesNotMatch(await owner.locator('.updates-list').innerText(), /Nothing needs you/);
  await owner.screenshot({path:'test-results/human-admission/owner-decision.png',fullPage:true});
  await visualEvidence.captureDesignEvidence?.(owner, {id:`human-admission-owner-${size.isMobile ? "phone" : "desktop"}`,title:"Owner reviews human request",fixture:"Verified synthetic human account, real server admission",testName:t.name,component:"human admission"});
  const approved=owner.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.includes('access-requests'));
  await card.getByRole('button',{name:/^Approve/}).click();assert.ok((await approved).ok());
  await page.waitForURL(url => url.hash === '#room/commons', {timeout:15000});
  await page.locator('#main').waitFor({state:'visible'});
  assert.equal((await f.session(page)).account.id,account.id);
  const memberships=f.store.db.prepare('SELECT room_id,member_id FROM member_accounts WHERE account_id=?').all(account.id);
  const binding=memberships.find(m=>m.room_id==='commons');assert.ok(binding,'approval binds the human account');
  const admitted=f.store.room('commons').state.members[binding.member_id];assert.equal(admitted.kind,'human');
  await page.screenshot({path:'test-results/human-admission/entered-room.png',fullPage:true});
  await visualEvidence.captureDesignEvidence?.(page, {id:`human-admission-entered-${size.isMobile ? "phone" : "desktop"}`,title:"Human enters approved room",fixture:"Verified synthetic human account, real server admission",testName:t.name,component:"human admission"});
  writeFileSync('test-results/human-admission/evidence.json',JSON.stringify({scope:'local real service, verified synthetic password account; not Google or production',sameAccount:true,memberKind:admitted.kind,roomId:binding.room_id},null,2));
});
