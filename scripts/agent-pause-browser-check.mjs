// C6: owner-facing Pause, Resume and Remove for agent members in the People
// panel. Pause/Resume act on the agent's wake-queue pause row through
// POST /api/rooms/:id/agent-pause; Remove sends MEMBER_ACCESS_CHANGED after a
// second confirming click (no native dialog). Real browser + local HTTP
// service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("People panel: owner pauses, resumes and removes an agent with a two-click confirm", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-pause-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "codex", displayName: "Codex", kind: "agent", permissions: ["accept_work", "complete_work"] }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] }));
  const codex = store.issueAccessKey("commons", "codex");
  store.wakeQueue.enqueue(codex, "commons", { requestId: crypto.randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: Date.now(), maxAttempts: 3 });

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  const errors = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { dialogs.push(dialog.type()); dialog.dismiss(); });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#people-panel > summary").click();
  const row = page.locator('#presence-list .presence-member[data-member-record-id="codex"]');
  const guestRow = page.locator('#presence-list .presence-member[data-member-record-id="guest"]');
  const ownerRow = page.locator('#presence-list .presence-member[data-member-record-id="owner"]');
  const pause = row.locator("[data-member-pause]"), remove = row.locator("[data-member-remove]");
  await pause.waitFor();
  assert.equal(await pause.textContent(), "Pause");
  assert.equal(await remove.textContent(), "Remove");
  assert.equal(await guestRow.locator(".member-actions").count(), 0, "humans get no agent controls");
  assert.equal(await ownerRow.locator(".member-actions").count(), 0);
  assert.equal(await row.locator(".pause-chip").count(), 0);

  // Pause: the row shows Paused, the button flips, and the queued wake is not leasable.
  await pause.click();
  await row.locator(".pause-chip").waitFor();
  assert.equal(await pause.textContent(), "Resume");
  assert.match(await page.locator("#status").textContent(), /paused: queued wakes will not start/);
  assert.ok(store.wakeQueue.pauseStatus("commons", "codex"), "pause row written through the route");
  assert.deepEqual(store.wakeQueue.due(Date.now()), [], "the due wake does not start while paused");
  mkdirSync("test-results", { recursive: true });
  await page.locator("#people-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/agent-pause-paused.png" });

  // Resume: chip gone, wake leasable again.
  await pause.click();
  await row.locator(".pause-chip").waitFor({ state: "detached" });
  assert.equal(await pause.textContent(), "Pause");
  assert.equal(store.wakeQueue.pauseStatus("commons", "codex"), null);
  assert.deepEqual(store.wakeQueue.due(Date.now()).map(w => w.queueKey), ["recipe:draft-catch-up"]);

  // Remove: first click arms, Keep disarms, second click sends MEMBER_ACCESS_CHANGED.
  await remove.click();
  assert.equal(await remove.textContent(), "Confirm remove");
  assert.equal(await remove.getAttribute("aria-pressed"), "true");
  assert.equal(store.room("commons").state.members.codex.active, true, "one click never removes");
  await row.locator("[data-member-remove-cancel]").click();
  assert.equal(await remove.textContent(), "Remove");
  assert.equal(await row.locator("[data-member-remove-cancel]").count(), 0);
  await remove.click();
  assert.equal(await remove.textContent(), "Confirm remove");
  await remove.click();
  await row.locator(".member-actions").waitFor({ state: "detached" });
  assert.equal(store.room("commons").state.members.codex.active, false, "the second click ended access");
  assert.match(await page.locator("#status").textContent(), /removed\. Room access and connections ended; context already delivered to its provider is not recalled/);
  assert.equal(await row.count(), 1, "the removed agent stays in history, without controls");
  assert.deepEqual(dialogs, [], "no native confirm dialog");
  await page.screenshot({ path: "test-results/agent-pause-removed.png" });
  assert.equal(errors.join("\n"), "");
});
