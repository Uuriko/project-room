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
  await page.goto(`${origin}/join.html?next=//evil.example/phish`);
  await page.locator("#join-name").waitFor({ state: "visible" });
  await page.locator("#join-name").fill("Hostile Next");
  await page.locator("#join-submit").click();
  const open = page.locator("#join-open-room");
  await open.waitFor({ state: "visible" });
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
