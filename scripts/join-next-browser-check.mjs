// The join page follows next only when it is one relative path on this origin.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("join page ignores an off-origin next and follows a relative one", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "join-next-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function invite() {
    const response = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ profile: "chat" }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.match(body.code, /^RM-/);
    return body.code;
  }

  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  const hostile = await invite();
  await page.goto(`${origin}/join/${hostile}?next=//evil.example/phish`);
  await page.locator("#join-name").waitFor({ state: "visible" });
  await page.locator("#join-name").fill("Hostile Next");
  await page.locator("#join-submit").click();
  const open = page.locator("#join-open-room");
  await open.waitFor({ state: "visible" });
  assert.equal(await page.locator("#join-success h2").evaluate(el => el === document.activeElement), true);
  await page.locator(".join-key-details summary").click();
  assert.equal(await page.getByLabel("Agent access key", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Copy agent access key", exact: true }).count(), 1);
  assert.equal(await page.locator("#join-secret").getAttribute("aria-describedby"), "join-secret-hint");
  assert.match(await page.locator("#join-secret-hint").textContent(), /password/);
  const hostileHref = await open.getAttribute("href");
  assert.equal(new URL(hostileHref, origin).origin, new URL(origin).origin);
  assert.equal(new URL(hostileHref, origin).hostname, new URL(origin).hostname);
  assert.equal(hostileHref.includes("evil.example"), false);

  const relative = await invite();
  await page.goto(`${origin}/join/${relative}?next=/offers`);
  await page.locator("#join-name").fill("Relative Next");
  await page.locator("#join-submit").click();
  await open.waitFor({ state: "visible" });
  const relativeHref = await open.getAttribute("href");
  assert.equal(new URL(relativeHref, origin).href, `${origin}/offers`);
  await open.click();
  await page.waitForURL(`${origin}/offers`);
  assert.equal(new URL(page.url()).origin, new URL(origin).origin);
  assert.deepEqual(errors, []);
});

test("signed-out mobile visitors can read agent instructions and paste shared invitations", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "join-mobile-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.goto(`${origin}/#join-agent`);
  await page.locator("#connect-guide-dialog").waitFor({ state: "visible" });
  assert.ok(await page.locator("#join-agent-prompt").isVisible());
  await page.locator("#connect-guide-close").click();
  await page.evaluate(() => { location.hash = ""; });
  await page.waitForURL(url => !url.hash);
  await page.evaluate(() => { location.hash = "#join-agent"; });
  await page.locator("#connect-guide-dialog").waitFor({ state: "visible" });
  await page.goto(`${origin}/docs/agents/paste`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "paste instructions fit a phone");
  await page.goto(`${origin}/join`);
  const token = "a".repeat(43);
  await page.locator("#join-enter-code").fill(`${origin}/#join/${token}`);
  await page.locator("#join-enter-submit").click();
  await page.waitForURL(url => url.hash === `#join/${token}`);
  assert.equal(new URL(page.url()).origin, origin);
});

test("terminal join refusal moves keyboard focus to its explained outcome", { timeout: 30000 }, async t => {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`${origin}/api/rooms/commons/agent-invites`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` }, body: JSON.stringify({ profile: "chat" }) });
  assert.equal(response.status, 201); const { code } = await response.json();
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${origin}/join/${code}`); await page.locator("#join-name").fill("Keyboard visitor");
  await page.route("**/api/join", route => route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ error: { code: "invite_revoked" } }) }));
  await page.locator("#join-submit").focus(); await page.keyboard.press("Enter");
  await page.locator("#join-error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#join-error-title").evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator("#join-error-title").getAttribute("aria-describedby"), "join-error-message");
  assert.ok((await page.locator("#join-error-message").textContent()).trim());
  await page.keyboard.press("Tab"); assert.equal(await page.locator("#join-home-link").evaluate(el => el === document.activeElement), true);
});
