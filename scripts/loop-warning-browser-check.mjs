// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

// Coordination-loop signals are derived at read time and surface as a pause
// hint on the work card - never a block, write or dispatch. This journey seeds
// one item with duplicate drafts, one with an acknowledgement chain and one
// clean item, then checks what the owner actually sees.
test("loop warning: duplicate drafts and acknowledgement chains pause-hint on the work card", { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const command = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const post = (actor, messageId, body, extra = {}) => command(actor, T.MESSAGE_POSTED, { messageId, body, ...extra });
  command("owner", T.WORK_PROPOSED, { workItemId: "loop-talk", title: "Test: settle the venue question", definitionOfDone: "A decision is recorded in the work item.", accountableMemberId: "producer", mode: "read" });
  command("owner", T.WORK_PROPOSED, { workItemId: "loop-clean", title: "Test: ordinary converging work", definitionOfDone: "A draft is posted once.", accountableMemberId: "producer", mode: "read" });
  // Two identical drafts on one item: the conversation is producing, not converging.
  const draftBody = "Agenda: owner is Test owner; reviewer checks the exact submitted version.";
  post("producer", "loop-draft-a", draftBody, { workItemId: "test-handoff", packetId: randomUUID(), basisRevision: 0, allowOlderBasis: true });
  post("guest", "loop-draft-b", draftBody, { workItemId: "test-handoff", packetId: randomUUID(), basisRevision: 0, allowOlderBasis: true });
  // A short strictly-alternating tail with no draft or result: an acknowledgement chain.
  post("guest", "loop-ack-1", "Settled?", { workItemId: "loop-talk" });
  post("producer", "loop-ack-2", "Yes.", { workItemId: "loop-talk" });
  post("guest", "loop-ack-3", "Sure?", { workItemId: "loop-talk" });
  post("producer", "loop-ack-4", "Sure.", { workItemId: "loop-talk" });
  post("guest", "loop-clean-note", "One ordinary update on otherwise calm work.", { workItemId: "loop-clean" });
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
  await page.goto(origin); await fillAccessKey(page, f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const duplicates = page.locator('[data-work-record-id="test-handoff"] .loop-warning');
  await duplicates.waitFor({ state: "visible" });
  assert.equal(await duplicates.getAttribute("data-loop-kind"), "duplicate_proposals");
  assert.match(await duplicates.innerText(), /2 identical drafts/);
  assert.match(await duplicates.innerText(), /Pause automatic drafting/);
  const chain = page.locator('[data-work-record-id="loop-talk"] .loop-warning');
  await chain.waitFor({ state: "visible" });
  assert.equal(await chain.getAttribute("data-loop-kind"), "ack_chain");
  assert.match(await chain.innerText(), /alternating between the same two members/);
  // Calm work carries no pause hint; the hint never blocks the work's actions.
  assert.equal(await page.locator('[data-work-record-id="loop-clean"] .loop-warning').count(), 0);
  const flagged = page.locator('[data-work-record-id="test-handoff"]');
  if (!await flagged.locator(".work-details").evaluate(node => node.open)) await flagged.locator(".work-details > summary").click();
  assert.equal(await flagged.getByRole("button", { name: "Use my AI", exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
});
