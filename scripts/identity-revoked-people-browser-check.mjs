// R350-n1 UI half (Fo 13936, option b): a seat whose linked identity secret
// is revoked stays an active member on purpose. The server marks it
// identityRevoked on member views; People says so and keeps Remove, and the
// composer's To picker drops it. Real browser + local HTTP service at phone size.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { ensurePeopleOpen, openSettings, closeSettings, openMemberProfile } from "./room-chrome.mjs";
import { linkWithProof } from "../tests/helpers/link-with-proof.mjs";

for (const theme of ["dark", "light"]) test(`revoked identity (${theme}): People says signed out for good, keeps Remove, To drops the seat`, { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-identity-revoked-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const gone = store.identities.create("Gone agent"), kept = store.identities.create("Kept agent");
  linkWithProof(store, owner, "commons", gone, { permissions: ["accept_work"] });
  linkWithProof(store, owner, "commons", kept, { permissions: ["accept_work"] });
  store.identities.revoke(gone.identityId, gone.secret);
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })).newPage();
  await page.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.body.classList.contains("human-experience"));
  const options = () => page.locator("#message-to-select option").evaluateAll(list => list.map(o => o.value));
  await page.waitForFunction(id => [...document.querySelectorAll("#message-to-select option")].some(o => o.value === id), kept.identityId);
  assert.equal((await options()).includes(gone.identityId), false, "the To picker drops a seat whose identity is signed out for good");
  await openSettings(page); await page.locator("#advanced-room-tools > summary").click();
  await page.locator("#human-advanced").check(); await closeSettings(page);
  await ensurePeopleOpen(page);
  const row = page.locator(`#presence-list .presence-member[data-member-record-id="${gone.identityId}"]`);
  await row.waitFor();
  assert.match(await row.innerText(), /Signed out for good/);
  await openMemberProfile(page, gone.identityId);
  assert.equal(await row.locator("[data-member-remove]").count(), 1, "Remove stays available");
  assert.equal(await row.locator("[data-member-pause]:visible").count(), 0, "Pause has nothing to pause");
  const keptRow = page.locator(`#presence-list .presence-member[data-member-record-id="${kept.identityId}"]`);
  assert.doesNotMatch(await keptRow.innerText(), /Signed out for good/);
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "light" : null);
  const remove = row.locator("[data-member-remove]");
  await remove.press("Enter");
  await openMemberProfile(page, gone.identityId);
  await row.getByRole("button", { name: "Confirm remove", exact: true }).waitFor();
  await row.locator("[data-member-remove-cancel]").press("Enter");
  await openMemberProfile(page, gone.identityId);
  await row.getByRole("button", { name: "Remove", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "phone viewport has no horizontal overflow");
  if (process.env.ROOM_TEST_SCREENSHOT_DIR) {
    mkdirSync(process.env.ROOM_TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ROOM_TEST_SCREENSHOT_DIR, `identity-revoked-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
});
