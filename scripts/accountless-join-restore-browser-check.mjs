// Account-less join restore: an invite-redeemed room session (authMode "room",
// account null) must land inside the room and survive a reload — the #817
// regression where hardened ownsResponse() rejected valid account-less
// sessions and stranded fresh joiners at the account gate.
// All state and credentials are disposable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const chromiumOptions = process.env.ROOM_TEST_CHROMIUM_PATH
  ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH }
  : {};

test("account-less invite join: consent, land in the room, survive reload", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-accountless-join-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // Mint a single-use invite as the room owner.
  const minted = await (await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "chat" }),
  })).json();
  assert.match(minted.code, /^RM-/, "owner minted an invite code");

  browser = await chromium.launch({ headless: true, ...chromiumOptions });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(15000);

  // 1. The join page previews the invite and shows the consent screen.
  await page.goto(`${origin}/join/${minted.code}`);
  await page.locator("#join-consent:not([hidden])").waitFor({ state: "visible" });
  assert.match(await page.locator("#join-room-title").innerText(), /commons/i);

  // 2. Consent with a display name; the success screen names us and shows the
  // genuine server-supplied session expiry (#860).
  await page.locator("#join-name").fill("Browser Joiner");
  await page.locator("#join-submit").click();
  await page.locator("#join-success:not([hidden])").waitFor({ state: "visible" });
  assert.match(await page.locator("#join-success-name").innerText(), /Browser Joiner/);
  const expiry = page.locator("#join-session-expiry:not([hidden])");
  await expiry.waitFor({ state: "visible" });
  assert.match(await expiry.innerText(), /session expires/i, "success screen shows the genuine session expiry");

  // 3. "Open room" lands inside the room — not the account gate. This is the
  // #817 regression point: the old ownsResponse() rejected account-less
  // room sessions, so refresh() endAccess()ed the session here.
  await page.locator("#join-open-room").click();
  await page.locator("#main:not([hidden])").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-panel").getAttribute("hidden"), "", "auth panel stays hidden for the room session");
  await page.waitForFunction(() => document.querySelector("#identity-label")?.textContent.startsWith("Browser Joiner"));

  // 4. A reload restores the same account-less session from the cookie.
  await page.reload();
  await page.locator("#main:not([hidden])").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-panel").getAttribute("hidden"), "", "reload keeps the account-less session out of the account gate");
  await page.waitForFunction(() => document.querySelector("#identity-label")?.textContent.startsWith("Browser Joiner"));
});
