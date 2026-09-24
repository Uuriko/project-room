import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

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
  await page.locator("#signin-more").click();
  await page.locator('[name="identityId"]').fill(identity.identityId);
  await page.locator('[name="secret"]').fill(identity.secret);
  await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
  await page.locator('[data-room-id="commons"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(secret => Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => value.includes(secret)), identity.secret), false);
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});
