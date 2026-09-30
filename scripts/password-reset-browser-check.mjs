// Actual reset mail links and fresh sign-in, using local synthetic delivery only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createMagicLinkMailer } from '../server/magic-links.mjs';
import { hashPassword } from '../src/password-auth.mjs';
const email = 'reset-browser@example.invalid', oldPassword = 'synthetic-old-password', newPassword = 'synthetic-new-password';
async function setup(t) {
  const f = createAcceptanceFixture(), delivered = [];
  f.store.createAccount('reset-browser-account'); f.store.completeOnboarding('reset-browser-account');
  f.store.accountLogins.linkPasswordMethod('reset-browser-account', { email, verifier: hashPassword(oldPassword) });
  const server = createRoomServer({ store: f.store, magicLinkMailer: { isConfigured: () => mailer.isConfigured(), sendMagicLink: p => mailer.sendMagicLink(p) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mailer = createMagicLinkMailer({ baseUrl: origin, send: async p => delivered.push(p) });
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin);
  return { ...f, origin, browser, page, delivered };
}
async function requestReset(f) {
  await f.page.locator('#auth-signin-ui [name="email"]').fill(email);
  await f.page.locator('[data-forgot-password]').click();
  assert.equal(await f.page.locator('[data-reset-password]').evaluate(el => el === document.activeElement), true, 'Forgot moves keyboard focus to its first recovery choice');
  await f.page.locator('[data-reset-password]').click();
  assert.equal(await f.page.locator('[data-signin-form="reset-request"] [name="email"]').evaluate(el => el === document.activeElement), true, 'reset request focuses email after host placement');
  await f.page.locator('[data-signin-back]').click();
  await f.page.locator('[data-reset-password]').waitFor();
  assert.equal(await f.page.locator('[data-reset-password]').evaluate(el => el === document.activeElement), true, 'Back restores recovery choice focus');
  await f.page.locator('[data-signin-back]').click();
  await f.page.locator('[data-signin-form="password"]').waitFor();
  assert.equal(await f.page.locator('[data-signin-form="password"] [name="email"]').evaluate(el => el === document.activeElement), true, 'Back returns focus to the primary email field');
  await f.page.locator('[data-forgot-password]').click(); await f.page.locator('[data-reset-password]').click();
  const form = f.page.locator('[data-signin-form="reset-request"]');
  assert.equal(await form.locator('[name="email"]').inputValue(), email, 'recovery preserves typed email only');
  const response = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/request');
  await form.locator('button[type="submit"]').click(); assert.equal((await response).status(), 200);
  await f.page.locator('[data-signin-panel]').filter({ hasText: 'check your email' }).waitFor();
  assert.equal(f.delivered[0].purpose, 'password-reset'); assert.ok(f.delivered[0].link);
  return f.delivered[0].link;
}
test('delivered reset URL renders without consuming; matching passwords reset then require actual login', { timeout: 45000 }, async t => {
  const f = await setup(t), link = await requestReset(f);
  const page = await f.browser.newPage(); page.setDefaultTimeout(10000);
  let consumes = 0; page.on('request', r => { if (new URL(r.url()).pathname === '/api/auth/password/reset/consume') consumes++; });
  await page.goto(link); const form = page.locator('[data-signin-form="reset-consume"]'); await form.waitFor();
  assert.doesNotMatch(page.url(), /reset=|email=/); assert.equal(consumes, 0);
  assert.equal(await form.locator('[name="newPassword"]').evaluate(el => el === document.activeElement), true, 'fresh emailed reset focuses new password without consuming');
  await form.locator('[name="newPassword"]').fill(newPassword); await form.locator('[name="confirmPassword"]').fill('synthetic-different-password');
  await form.locator('button[type="submit"]').click(); await page.locator('[data-signin-status]').filter({ hasText: 'match' }).waitFor(); assert.equal(consumes, 0);
  await form.locator('[name="confirmPassword"]').fill(newPassword);
  const reset = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/consume');
  await form.locator('button[type="submit"]').click(); assert.equal((await reset).status(), 200);
  const login = page.locator('[data-signin-form="password"]'); await login.waitFor();
  const anonymous = await (await page.context().request.get(`${f.origin}/api/account-session`)).json(); assert.equal(anonymous.authenticated, false);
  await login.locator('[name="email"]').fill(email); await login.locator('[name="password"]').fill(oldPassword);
  const rejected = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/login');
  await login.locator('button[type="submit"]').click(); assert.equal((await rejected).status(), 401);
  await page.locator('[data-signin-status].error').waitFor(); await login.locator('[name="password"]').fill(newPassword);
  const accepted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/login');
  await login.locator('button[type="submit"]').click(); assert.equal((await accepted).status(), 200);
  await page.locator('#auth-panel').waitFor({ state: 'hidden' });
  const actual = await (await page.context().request.get(`${f.origin}/api/account-session`)).json(); assert.equal(actual.account.id, 'reset-browser-account');
  assert.equal(consumes, 1);
});

test('reset mailed from a shared invitation preserves review and blocks Back during a committed reset', { timeout: 45000 }, async t => {
  const f = await setup(t);
  await f.page.goto(`${f.origin}/#join/${f.links.valid}`);
  await f.page.locator('#join-account-signin').click();
  await f.page.locator('#join-account-auth [name="email"]').fill(email);
  await f.page.locator('#join-account-auth [data-forgot-password]').click();
  await f.page.locator('#join-account-auth [data-reset-password]').click();
  const request = f.page.locator('[data-signin-form="reset-request"]');
  const sent = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/request');
  await request.locator('button[type="submit"]').click(); await sent;
  const link = f.delivered[0].link; assert.equal(new URL(link).hash, `#join/${f.links.valid}`);
  const page = await f.browser.newPage(); page.setDefaultTimeout(10000); await page.goto(link);
  const form = page.locator('[data-signin-form="reset-consume"]'); await form.waitFor();
  assert.equal(await page.locator('#join-link-dialog').isVisible(), false, 'reset form owns startup before invitation preview');
  await form.locator('[name="newPassword"]').fill(newPassword); await form.locator('[name="confirmPassword"]').fill(newPassword);
  let committed, release;
  const held = new Promise(resolve => committed = resolve), unblock = new Promise(resolve => release = resolve); t.after(() => release());
  await page.route('**/api/auth/password/reset/consume', async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200); committed(); await unblock; await route.fulfill({ response });
  });
  await form.locator('button[type="submit"]').click(); await held;
  assert.equal(await page.locator('[data-signin-back]').isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await form.isVisible(), true);
  release(); await page.locator('#join-link-dialog').waitFor();
  assert.equal(await page.locator('#main').isVisible(), false, 'password reset never grants room access');
  await page.locator('#join-account-signin').click();
  const login = page.locator('#join-account-auth [data-signin-form="password"]');
  await login.locator('[name="email"]').fill(email); await login.locator('[name="password"]').fill(newPassword);
  const signed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/login');
  await login.locator('button[type="submit"]').click(); assert.equal((await signed).status(), 200);
  await page.locator('#join-account-signin').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#main').isVisible(), false, 'fresh sign-in still requires explicit review/join');
});

test('foreign-account reset requires confirmed logout and fresh password entry without burning the link', { timeout: 45000 }, async t => {
  const f = await setup(t), link = await requestReset(f), foreignEmail = 'foreign-reset-browser@example.invalid';
  f.store.createAccount('foreign-reset-account'); f.store.completeOnboarding('foreign-reset-account');
  f.store.accountLogins.linkPasswordMethod('foreign-reset-account', { email: foreignEmail, verifier: hashPassword(oldPassword) });
  const page = await f.browser.newPage(); page.setDefaultTimeout(10000); await page.goto(f.origin);
  const login = page.locator('[data-signin-form="password"]'); await login.locator('[name="email"]').fill(foreignEmail); await login.locator('[name="password"]').fill(oldPassword);
  const signed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/login');
  await login.locator('button[type="submit"]').click(); await signed; await page.locator('#auth-panel').waitFor({ state: 'hidden' });
  await page.goto(link); const form = page.locator('[data-signin-form="reset-consume"]'); await form.waitFor();
  await form.locator('[name="newPassword"]').fill(newPassword); await form.locator('[name="confirmPassword"]').fill(newPassword);
  const mismatch = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/consume');
  await form.locator('button[type="submit"]').click(); assert.equal((await mismatch).status(), 409);
  const unchanged = await (await page.context().request.get(`${f.origin}/api/account-session`)).json(); assert.equal(unchanged.account.id, 'foreign-reset-account');
  const switchButton = page.locator('[data-magic-switch]'); await switchButton.waitFor();
  page.once('dialog', dialog => dialog.dismiss()); await switchButton.click(); assert.equal(await switchButton.isVisible(), true);
  page.once('dialog', dialog => dialog.accept()); await switchButton.click(); await form.waitFor();
  assert.equal(await form.locator('[name="newPassword"]').inputValue(), '');
  assert.equal(await form.locator('[name="confirmPassword"]').inputValue(), '');
  await form.locator('[name="newPassword"]').fill(newPassword); await form.locator('[name="confirmPassword"]').fill(newPassword);
  const reset = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/consume');
  await form.locator('button[type="submit"]').click(); assert.equal((await reset).status(), 200);
  await page.locator('[data-signin-form="password"]').waitFor();
  assert.equal((await (await page.context().request.get(`${f.origin}/api/account-session`)).json()).authenticated, false);
});

test('targeted invitation survives mailed reset and still requires explicit acceptance after fresh login', { timeout: 45000 }, async t => {
  const f = await setup(t);
  const ownerKey = f.store.issueAccountAccessKey(f.store.accountForMember('commons', 'owner').id), slot = f.store.createAccountSessionSlot();
  const owner = f.store.loginAccountSession(slot.token, ownerKey, slot.session.sessionRevision);
  const token = randomBytes(32).toString('base64url');
  const issued = f.store.issueInvitation(slot.token, 'commons', { requestId: 'issue-reset-browser-invitation', token, intendedAccountId: 'reset-browser-account', intendedMemberId: 'reset-browser-member', displayName: 'Reset browser human', role: 'member', expiresAt: Date.now() + 3600000, expectedIssuerMemberRevision: 0, expectedSessionBinding: owner.sessionBinding });
  await f.page.goto(`${f.origin}/#invite/${token}`); await f.page.locator('#invitation-email').click();
  await f.page.locator('#invitation-methods [data-forgot-password]').click(); await f.page.locator('#invitation-methods [data-reset-password]').click();
  const request = f.page.locator('[data-signin-form="reset-request"]'); await request.locator('[name="email"]').fill(email);
  const sent = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/request'); await request.locator('button[type="submit"]').click(); await sent;
  const link = f.delivered[0].link; assert.equal(new URL(link).hash, `#invite/${token}`);
  const page = await f.browser.newPage(); page.setDefaultTimeout(10000); await page.goto(link);
  const form = page.locator('[data-signin-form="reset-consume"]'); await form.waitFor();
  assert.equal(await page.locator('#invitation-dialog').isVisible(), false);
  await form.locator('[name="newPassword"]').fill(newPassword); await form.locator('[name="confirmPassword"]').fill(newPassword);
  const reset = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/consume'); await form.locator('button[type="submit"]').click(); assert.equal((await reset).status(), 200);
  await page.locator('#invitation-email').waitFor(); await page.locator('#invitation-email').click();
  const login = page.locator('#invitation-methods [data-signin-form="password"]');
  await login.locator('[name="email"]').fill(email); await login.locator('[name="password"]').fill(newPassword);
  const signed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/login'); await login.locator('button[type="submit"]').click(); assert.equal((await signed).status(), 200);
  await page.locator('#invitation-accept').waitFor();
  assert.equal(f.store.db.prepare('SELECT status FROM membership_invitations WHERE id=?').get(issued.invitation.id).status, 'pending');
  assert.equal(await page.locator('#main').isVisible(), false);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`recovery choices stack with quieter secondary action at ${viewport.width}px`, { timeout: 25000 }, async t => {
  const f = await setup(t); await f.page.setViewportSize(viewport);
  await f.page.locator('[data-forgot-password]').click();
  const primary = f.page.locator('[data-reset-password]'), secondary = f.page.locator('[data-email-method="magic"]');
  const first = await primary.boundingBox(), second = await secondary.boundingBox();
  assert.ok(first && second);
  assert.ok(second.y >= first.y + first.height + 8, 'secondary recovery action is below primary with a real gap');
  assert.ok(Math.abs(first.x - second.x) < 1 && Math.abs(first.width - second.width) < 1, 'recovery choices occupy the same single column');
  assert.ok(first.height >= 44 && second.height >= 44, 'both remain usable touch targets');
  const sizes = await f.page.evaluate(() => ['[data-reset-password]', '[data-email-method="magic"]'].map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)));
  assert.ok(sizes[1] < sizes[0], `magic link must be smaller: primary=${sizes[0]}px secondary=${sizes[1]}px`);
  assert.equal(await f.page.locator('#auth-link-error').isVisible(), false, 'empty error block consumes no visible spacer');
});

test('unconfigured Google button returns to usable sign-in with an announced unavailable message', { timeout: 25000 }, async t => {
  const f = await setup(t);
  await f.page.locator('#google-signin').click();
  await f.page.locator('#auth-error').filter({ hasText: 'Google sign-in isn’t available' }).waitFor();
  assert.equal(new URL(f.page.url()).pathname, '/');
  assert.equal(new URL(f.page.url()).searchParams.has('google'), false, 'one-shot failure query is scrubbed');
  assert.equal(await f.page.locator('#auth-error').getAttribute('role'), 'alert');
  assert.equal(await f.page.locator('[data-signin-form="password"]').isVisible(), true);
  await f.page.locator('[data-forgot-password]').click();
  assert.equal(await f.page.locator('[data-signin-form="password"]').isVisible(), false);
  assert.doesNotMatch(await f.page.locator('#auth-error').innerText(), /below/i, 'provider failure does not point at fields hidden by recovery');
  await f.page.locator('[data-reset-password]').click();
  const form = f.page.locator('[data-signin-form="reset-request"]');
  await form.locator('[name="email"]').fill(email);
  const recovery = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/request');
  await form.locator('button[type="submit"]').click();
  assert.equal((await recovery).status(), 200);
  await f.page.locator('[data-signin-panel]').filter({ hasText: 'check your email' }).waitFor();
  assert.equal(f.delivered.length, 1, 'provider failure leaves actual password recovery usable');
  assert.equal(f.delivered[0].purpose, 'password-reset');
  await f.page.reload();
  assert.equal(await f.page.locator('#auth-error').isVisible(), false, 'reload does not resurrect the old error');
});

test('failed reset email request announces the network error and permits a real retry', { timeout: 25000 }, async t => {
  const f = await setup(t);
  await f.page.locator('[data-forgot-password]').click(); await f.page.locator('[data-reset-password]').click();
  const form = f.page.locator('[data-signin-form="reset-request"]'); await form.locator('[name="email"]').fill(email);
  await f.page.route('**/api/auth/password/reset/request', route => route.abort('failed'), { times: 1 });
  await form.locator('button[type="submit"]').click(); await f.page.locator('[data-signin-status].error').waitFor();
  assert.equal(f.delivered.length, 0, 'failed network request cannot claim mail delivery');
  assert.equal(await form.locator('button[type="submit"]').isEnabled(), true);
  assert.equal(await f.page.locator('[data-signin-back]').isEnabled(), true);
  await form.locator('[name="email"]').fill(email);
  const retry = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/password/reset/request');
  await form.locator('button[type="submit"]').click(); assert.equal((await retry).status(), 200);
  await f.page.locator('[data-signin-panel]').filter({ hasText: 'check your email' }).waitFor();
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].purpose, 'password-reset');
});

test('unconfigured Google from shared invitation restores preview with visible failure and no join', { timeout: 25000 }, async t => {
  const f = await setup(t), joinsBefore = f.store.db.prepare('SELECT count(*) AS n FROM share_link_joins').get().n;
  await f.page.goto(`${f.origin}/#join/${f.links.valid}`); await f.page.locator('#join-account-signin').click();
  await f.page.locator('#join-account-google').click();
  await f.page.locator('#join-link-dialog').waitFor();
  await f.page.locator('#join-link-status').filter({ hasText: 'Google sign-in isn’t available' }).waitFor();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM share_link_joins').get().n, joinsBefore);
  assert.equal(await f.page.locator('#main').isVisible(), false);
  assert.equal(await f.page.locator('#join-link-submit').isEnabled(), true, 'guest continuation remains usable after failed Google');
});

test('unconfigured Google from targeted invitation restores offer without accepting it', { timeout: 25000 }, async t => {
  const f = await setup(t), slot = f.store.createAccountSessionSlot();
  const owner = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(f.store.accountForMember('commons', 'owner').id), slot.session.sessionRevision);
  const token = randomBytes(32).toString('base64url');
  const issued = f.store.issueInvitation(slot.token, 'commons', { requestId: 'google-unavailable-targeted', token, intendedAccountId: 'reset-browser-account', intendedMemberId: 'google-reset-browser-member', displayName: 'Reset browser human', role: 'member', expiresAt: Date.now() + 3600000, expectedIssuerMemberRevision: 0, expectedSessionBinding: owner.sessionBinding });
  await f.page.goto(`${f.origin}/#invite/${token}`); await f.page.locator('#invitation-google').click();
  await f.page.locator('#invitation-dialog').waitFor();
  await f.page.locator('#invitation-error').filter({ hasText: 'Google sign-in isn’t available' }).waitFor();
  assert.equal(f.store.db.prepare('SELECT status FROM membership_invitations WHERE id=?').get(issued.invitation.id).status, 'pending');
  assert.equal(await f.page.locator('#main').isVisible(), false);
  await f.page.locator('#invitation-email').click();
  assert.equal(await f.page.locator('#invitation-methods [data-signin-form="password"]').isVisible(), true, 'email/password fallback remains usable');
});
