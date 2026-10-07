import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("visible entry choices open focused flows without hiding pending agent sign-in", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-password-mode="signup"]').isVisible(), true);
    assert.equal(await page.locator('[data-password-mode="login"]').isVisible(), true);
    assert.equal(await page.locator("#google-signin").isVisible(), false);
    await page.locator("#agent-signin-button").click();
    assert.equal(await page.locator("#join-agent-prompt").isVisible(), false);
    assert.equal(await page.locator("#signin-extra").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.name), "identityId");
    let pendingRoute;
    const pending = new Promise(resolve => { pendingRoute = resolve; });
    await page.route("**/api/auth/agent/rooms", route => pendingRoute(route));
    await page.locator('[name="identityId"]').fill("ai_test");
    await page.locator('[name="secret"]').fill("invalid-test-credential");
    await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
    const route = await pending;
    await page.locator("#agent-auth-back").click();
    assert.equal(await page.locator("#agent-auth-step").isVisible(), true, "pending request stays visible");
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Test identity could not be verified." }) });
    await page.locator('[data-agent-status]').filter({ hasText: "That agent ID and secret don’t match. Check both and try again." }).waitFor();
    await page.locator("#agent-auth-back").click();
    assert.equal(await page.locator("#google-signin").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "agent-signin-button");
    await page.locator("#agent-signin-button").click();
    await page.locator("[data-agent-new]").click();
    await page.locator("#agent-auth-back").click();
    await page.locator("#agent-signin-button").click();
    assert.equal(await page.evaluate(() => document.activeElement.name), "identityId", "leaving clears the phase and reopening focuses the saved identity field");
    await page.unroute("**/api/auth/agent/rooms");
    await page.route("**/api/auth/agent/rooms", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rooms: [], displayName: "Synthetic UI agent" }) }));
    await page.route("**/api/agent-identities", route => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ identityId: "ai_synthetic_ui", secret: "synthetic-test-secret", privateKey: "synthetic-test-private-key" }) }));
    await page.locator("[data-agent-new]").click();
    await page.locator('[name="createName"]').fill("Synthetic UI agent");
    await page.locator('[data-agent-form="create"] button[type="submit"]').click();
    await page.locator("[data-agent-created]").waitFor();
    assert.equal(await page.locator("[data-agent-have-invite], [data-agent-form='invite']").count(), 0);
    assert.equal(await page.locator("[data-agent-created] [data-agent-create-room]").count(), 0, "credential save acknowledgment precedes room creation");
    assert.match(await page.locator("[data-agent-created]").innerText(), /returns the secret and signing key only at creation/);
    assert.equal(await page.locator("[data-agent-secret][type=password]").count(), 2);
    await page.locator("[data-agent-saved]").click();
    await page.locator('[data-agent-panel]').filter({ hasText: "No rooms yet." }).waitFor();
    assert.equal(await page.locator("[data-agent-have-invite], [data-agent-form='invite']").count(), 0);
    assert.equal(await page.locator("[data-agent-create-room]").isVisible(), true);

    await page.locator("#agent-auth-back").click();
    assert.equal(await page.locator('#auth-signin-ui [data-password-mode=signup]').isVisible(), true);
    assert.equal(await page.locator("#agent-auth-step").isVisible(), false);
    assert.equal(await page.locator("#access-key, #signin-support-root, #signin-more, #signin-extra").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.close();
  }
});

test("agent browser sign-in opens a linked room and survives reload without the secret", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const identity = f.store.identities.create("Browser test agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#agent-signin-button").click();
  await page.locator('[name="identityId"]').fill(identity.identityId);
  await page.locator('[name="secret"]').fill(identity.secret);
  await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
  await page.getByRole("button", { name: f.store.room("commons").state.room.title, exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  // First-run orientation: shows once after an agent's first browser sign-in.
  await page.locator("#agent-first-run").waitFor({ state: "visible" });
  assert.match(await page.locator("#agent-first-run").textContent(), /DMs are open by default/);
  await page.locator('#agent-first-run [data-step="dismiss"]').click();
  await page.locator("#agent-first-run").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(secret => Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => value.includes(secret)), identity.secret), false);
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#agent-first-run").count(), 0, "the orientation never shows again");
  assert.deepEqual(errors, []);
});

for (const width of [1280, 390]) {
  test(`saved agent at ${width}px creates its first room without creating another identity`, { timeout: 30000 }, async t => {
    const f = createAcceptanceFixture(), identity = f.store.identities.create("Returning fixture agent");
    const server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#agent-signin-button").click();
    const otherIdentity = f.store.identities.create("Different fixture agent");
    for (const bad of [{ identityId: identity.identityId, secret: crypto.randomUUID() }, { identityId: otherIdentity.identityId, secret: identity.secret }]) {
      await page.locator('[name="identityId"]').fill(bad.identityId);
      await page.locator('[name="secret"]').fill(bad.secret);
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/agent/rooms");
      await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
      assert.equal((await refused).status(), 401,'real credential mismatch is rejected');
      await page.locator('[data-agent-status].error').waitFor();
      assert.equal(await page.locator('[data-agent-status]').textContent(), 'That agent ID and secret don’t match. Check both and try again.');
      assert.equal(await page.locator('[name="identityId"]').inputValue(), bad.identityId, 'the ID remains editable for correction');
      assert.equal(await page.locator('[name="secret"]').inputValue(), '', 'failed credential is not left rendered');
      assert.equal(await page.locator('#main').isVisible(), false);
      assert.equal(await page.evaluate(value=>Object.values(localStorage).concat(Object.values(sessionStorage)).some(entry=>entry.includes(value)), bad.secret),false);
    }
    await page.locator('[name="identityId"]').fill(identity.identityId);
    await page.locator('[name="secret"]').fill(identity.secret);
    await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
    await page.locator('[data-agent-create-room]').waitFor();
    await page.locator('[data-agent-create-room]').click();
    await page.locator('[data-agent-back-to-rooms]').click();
    assert.equal(await page.locator('[data-agent-created]').count(), 0);
    await page.locator('[data-agent-create-room]').waitFor({ state: 'visible' });
    await page.locator('[data-agent-create-room]').click();
    assert.equal(await page.locator('[data-agent-form="make-room"] input').count(), 1);
    await page.locator('[name="roomTitle"]').fill("Returning agent test room");
    let roomCreates = 0, sessionAttempts = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/agent-rooms") roomCreates += 1; });
    await page.route("**/api/auth/agent/session", async route => {
      sessionAttempts += 1;
      if (sessionAttempts === 1) {
        // The real server issues the cookie, but this response is lost to the page.
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.locator('[data-agent-form="make-room"] button[type="submit"]').click();
    await page.locator('[data-agent-status].error').waitFor();
    assert.equal(await page.locator('[data-agent-form="make-room"]').count(), 0);
    assert.equal(roomCreates, 1);
    const session = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/agent/session");
    await page.getByRole("button", { name: "Returning agent test room", exact: true }).click();
    const accepted = await session;
    assert.equal(roomCreates, 1);
    assert.equal(sessionAttempts, 2);
    assert.equal(accepted.status(), 201);
    assert.equal(accepted.request().postDataJSON().identityId, identity.identityId);
    await page.locator("#main").waitFor({ state: "visible" });
    const rooms = f.store.identities.roomsForIdentity(identity.identityId);
    assert.equal(rooms.length, 1); assert.equal(rooms[0].title, "Returning agent test room");
    assert.equal(await page.locator('[data-agent-secret]').count(), 0);
    assert.deepEqual(errors, []);
  });

  test(`new agent at ${width}px masks saved credentials and enters its room`, { timeout: 30000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#agent-signin-button").click(); await page.locator('[data-agent-new]').click();
    await page.locator('[name="createName"]').fill("New fixture agent");
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-identities");
    await page.locator('[data-agent-form="create"] button[type="submit"]').click();
    const identity = await (await created).json();
    assert.equal(await page.locator('[data-agent-secret][type="password"]').count(), 2);
    const reveal = page.locator('[data-agent-reveal]').first();
    await reveal.click(); assert.equal(await reveal.getAttribute("aria-pressed"), "true");
    await reveal.click(); assert.equal(await reveal.getAttribute("aria-pressed"), "false");
    await page.locator("[data-agent-saved]").click();
    await page.locator('[data-agent-create-room]').click();
    await page.locator('[data-agent-back-to-rooms]').click();
    assert.equal(await page.locator('[data-agent-created]').count(), 0);
    await page.locator('[data-agent-create-room]').waitFor({ state: 'visible' });
    await page.locator('[data-agent-create-room]').click();
    await page.locator('[name="roomTitle"]').fill("New agent test room");
    await page.locator('[data-agent-form="make-room"] button[type="submit"]').click();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(f.store.identities.roomsForIdentity(identity.identityId).length, 1);
    assert.equal(await page.locator('[data-agent-secret]').count(), 0);
    assert.doesNotMatch(page.url(), /pri_|secret=|privateKey=/);
  });
}

test("leaving an unsaved new agent identity requires confirmation and clears it only on acceptance", { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#agent-signin-button").click(); await page.locator('[data-agent-new]').click();
  await page.locator('[name="createName"]').fill("Unsaved fixture agent");
  await page.locator('[data-agent-form="create"] button[type="submit"]').click();
  await page.locator('[data-agent-created]').waitFor();
  page.once("dialog", dialog => { assert.match(dialog.message(), /cannot be recovered/); return dialog.dismiss(); });
  await page.locator("#agent-auth-back").click();
  assert.equal(await page.locator('[data-agent-created]').isVisible(), true);
  assert.equal(await page.locator('[data-agent-secret][type="password"]').count(), 2);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#agent-auth-back").click();
    await page.locator("#agent-signin-button").click();
  assert.equal(await page.locator('[name="identityId"]').inputValue(), "");
  assert.equal(await page.locator('[name="secret"]').inputValue(), "");
  assert.equal(await page.locator('[data-agent-secret]').count(), 0);
});
