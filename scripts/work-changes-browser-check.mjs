// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// F3: a draft based on an older revision gets a "what changed" explanation -
// a derived, read-time list from the item's own revision events. A draft at
// the current revision gets no such prompt. Neither blocks any action.
test("work changes: stale-basis drafts explain what changed, current drafts stay quiet", { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const command = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const post = (actor, messageId, body, extra = {}) => command(actor, T.MESSAGE_POSTED, { messageId, body, ...extra });
  // test-handoff advances to revision 1 (accepted), then receives a draft still based on revision 0.
  command("producer", T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: 0 });
  post("producer", "stale-draft", "Agenda draft based on the original ask.", { workItemId: "test-handoff", packetId: randomUUID(), basisRevision: 0, allowOlderBasis: true });
  // Calm work: a draft at the item's current revision.
  command("owner", T.WORK_PROPOSED, { workItemId: "calm-work", title: "Test: current-basis work", definitionOfDone: "A current draft.", accountableMemberId: "producer", mode: "read" });
  post("producer", "current-draft", "Draft at the current revision.", { workItemId: "calm-work", packetId: randomUUID(), basisRevision: 0 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const card = page.locator('[data-work-record-id="test-handoff"]');
  const toggle = card.getByRole("button", { name: "What changed since revision 0", exact: true });
  await toggle.waitFor({ state: "visible" });
  // The basis is pinned on the toggle and the explanation starts hidden.
  assert.equal(await toggle.getAttribute("data-basis"), "0");
  assert.equal(await card.locator('[data-changes-list]').isVisible(), false);
  await toggle.click();
  const list = card.locator('[data-changes-list]');
  await list.waitFor({ state: "visible" });
  assert.match(await list.innerText(), /r1 Accepted · Test producer/);
  // Toggling again collapses; the card's own actions were never blocked.
  await toggle.click();
  assert.equal(await list.isVisible(), false);
  await toggle.click();
  await list.waitFor({ state: "visible" });
  // Current-basis work shows no prompt at all.
  assert.equal(await page.locator('[data-work-record-id="calm-work"] [data-work-changes]').count(), 0);
  assert.deepEqual(errors, []);
});
