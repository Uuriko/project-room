// Start a room: the door's main button opens /?start=room. A new visitor sees
// "Sign in to start your room", signs in, and lands inside their own room
// instead of the Inbox. The intent is one-shot: a later visit without it keeps
// the normal landing. Setup asks for a name only, before the room is made.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

test("Start a room: sign in lands inside a new room", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({ store: f.store, magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); }, baseUrl: null }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(`${origin}/?start=room`, { waitUntil: "networkidle" });
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-room-hint").textContent(), "Sign in to start your room. It’s free.");
  assert.doesNotMatch(page.url(), /start=room/, "the intent leaves the address bar");

  const boot = await fetch(`${origin}/api/account-session`);
  const cookie = boot.headers.get("set-cookie").split(";")[0];
  const { csrf } = await boot.json();
  const email = "start-room@example.invalid";
  await fetch(`${origin}/api/auth/magic/request`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf, Origin: origin }, body: JSON.stringify({ email }) });
  await page.goto(`${origin}/?magic=${encodeURIComponent(sent.at(-1).code)}&email=${encodeURIComponent(email)}`, { waitUntil: "networkidle" });

  // Setup asks for a name only, before the room is made, so the owner joins
  // under that name instead of "Owner".
  const setup = page.locator("#account-setup-dialog");
  await setup.waitFor({ state: "visible" });
  assert.equal(await setup.getByRole("button", { name: "Set up later" }).count(), 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM member_accounts WHERE room_id LIKE 'personal-%'").get().n, 0, "no room before the name");
  await page.locator("#setup-name").fill("Rae");
  await setup.getByRole("button", { name: "Done", exact: true }).click();
  await setup.waitFor({ state: "hidden" });

  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => /[?&]room=personal-/.test(location.search));
  const rooms = f.store.db.prepare("SELECT room_id FROM member_accounts WHERE room_id LIKE 'personal-%'").all();
  assert.equal(rooms.length, 1, "exactly one room was created");
  const members = Object.values(f.store.room(rooms[0].room_id).state.members);
  assert.deepEqual(members.map(m => m.displayName), ["Rae"]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pr-start-room")), null, "the intent is used once");
  assert.equal(await setup.isVisible(), false, "setup does not come back inside the room");
  assert.deepEqual(errors, []);
});
