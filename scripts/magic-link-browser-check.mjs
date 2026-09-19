// Magic-link one-tap sign-in: loading /?magic=<code>&email=<addr> in a fresh
// browser context must sign the visitor straight in with zero typing.
// Regression test for RC-2026-09-19-066: the auto-redeem ran synchronously
// during signinUI.mount(), before `let accountRestoreFlight` was initialized,
// so a temporal-dead-zone ReferenceError killed the redeem before any network
// call and the visitor was left on the welcome screen. The manual code-entry
// path kept working (it runs after module evaluation), which is why unit
// tests never caught it.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

async function setup(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); }, baseUrl: null });
  const server = createRoomServer({ store: f.store, magicLinkMailer: mailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  // Issue a magic code the same way the UI does: boot a slot, POST request.
  const bootRes = await fetch(`${origin}/api/account-session`);
  const cookie = bootRes.headers.get("set-cookie").split(";")[0];
  const { csrf } = await bootRes.json();
  const email = "magic-link-check@example.invalid";
  const reqRes = await fetch(`${origin}/api/auth/magic/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf, Origin: origin },
    body: JSON.stringify({ email })
  });
  assert.equal(reqRes.status, 200, "magic link request is accepted");
  assert.equal(sent.length, 1, "one magic email is captured");
  const code = sent[0].code;
  assert.match(code || "", /^[A-Za-z0-9_-]{32}$/, "email carries a code");
  return { origin, browser, email, code };
}

async function freshPage(t, browser, origin) {
  const errors = [];
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "no page errors"));
  return page;
}

test("magic link: fresh visit with ?magic= signs straight in", { timeout: 60000 }, async t => {
  const { origin, browser, email, code } = await setup(t);
  const page = await freshPage(t, browser, origin);
  await page.goto(`${origin}/?magic=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`,
    { waitUntil: "networkidle" });
  // Zero typing: the auth panel hides and the identity label shows the account.
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  await page.locator("#identity-label", { hasText: "Personal account" }).waitFor({ state: "visible" });
  // The one-tap token is stripped from the URL so it cannot leak via referrers.
  assert.doesNotMatch(page.url(), /magic=/, "magic param is removed from the URL");
});

test("magic link: replay of a consumed link does not sign in", { timeout: 60000 }, async t => {
  const { origin, browser, email, code } = await setup(t);
  const target = `${origin}/?magic=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`;
  const first = await freshPage(t, browser, origin);
  await first.goto(target, { waitUntil: "networkidle" });
  await first.locator("#auth-panel").waitFor({ state: "hidden" });
  // Second visit with the same single-use link: stays signed out with a
  // clear invalid-code message instead of failing silently.
  const second = await freshPage(t, browser, origin);
  await second.goto(target, { waitUntil: "networkidle" });
  await second.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await second.locator("#identity-label").isVisible(), false, "identity label stays hidden while signed out");
  const status = await second.locator("[data-signin-status]").textContent();
  assert.match(status || "", /not valid|expired/i, "replay shows an invalid/expired message");
});
