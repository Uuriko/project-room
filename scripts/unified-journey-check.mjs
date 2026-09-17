// Combined local UI/API journey. Every identity is a synthetic test participant.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("unified guest entry, account-bound draft recovery, catch-up and agent handoff share one room", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const owner = await ownerContext.newPage(), guest = await guestContext.newPage();
  const errors = [];
  owner.on("pageerror", e => errors.push(e.message)); guest.on("pageerror", e => errors.push(e.message));
  await owner.goto(origin);
  await owner.locator("#access-key").fill(fixture.keys.owner);
  await owner.getByRole("button", { name: "Enter room", exact: true }).click();
  await owner.locator("#main").waitFor({ state: "visible" });

  await guest.goto(`${origin}/#join/${fixture.links.valid}`);
  await guest.locator("#join-link-name").fill("Unified test guest");
  await guest.locator("#join-link-submit").click();
  await guest.locator("#join-link-dialog").waitFor({ state: "hidden" });
  await guest.locator("#main").waitFor({ state: "visible" });
  assert.equal(await guest.locator("#new-work-button").isDisabled(), true);
  await guest.locator("#composer-options > summary").click();
  await guest.locator("#remember-drafts").check();
  await guest.locator("#message-input").fill("My optional recovered guest draft");
  guest.once("dialog", d => d.accept());
  await guest.reload();
  await guest.locator("#main").waitFor({ state: "visible" });
  await guest.waitForFunction(() => document.querySelector("#message-input").value === "My optional recovered guest draft");
  await guest.locator('#message-form button[type="submit"]').click();
  await owner.getByText("My optional recovered guest draft", { exact: true }).waitFor();

  // The documented client and browser consume the same persisted work, not a parallel agent store.
  const agent = role => new RoomAgentClient({ origin, roomId: "commons", token: fixture.keys[role] });
  const producer = agent("producer"), reviewer = agent("reviewer");
  const item = () => fixture.store.snapshot(fixture.keys.owner, "commons").state.workItems["test-handoff"];
  const mutate = (client, type, data = {}) => client.command({ id: crypto.randomUUID(), type,
    data: { workItemId: "test-handoff", expectedRevision: item().revision, ...data } });
  await mutate(producer, T.WORK_ACCEPTED);
  await mutate(producer, T.WORK_STARTED);
  await mutate(producer, T.WORK_COMPLETED, { summary: "Owner: Room owner. Synthetic agenda.", evidenceVersion: "unified-inline-v1",
    evidenceUrl: "https://example.invalid/unified-test", producerId: "producer", nextAction: "Review this synthetic inline result." });
  await mutate(reviewer, T.VERIFICATION_RECORDED, { result: "pass", completionEventId: item().receipt.eventId,
    evidenceVersion: item().receipt.evidenceVersion, summary: "Synthetic reviewer checks this exact version; no independent operator claim." });
  const card = owner.locator('[data-work-record-id="test-handoff"]');
  await card.locator('[data-next-step="decide"]').waitFor();
  assert.equal(await card.locator(".work-next-step").count(), 1);
  assert.equal(await card.locator(".work-next").count(), 0);
  assert.equal((await agent("owner").orient()).work.find(w => w.id === "test-handoff").next.action, "decide");
  await owner.locator("#return-brief-panel > summary").click();
  await owner.locator("#rb-attention-list").getByText(/Test: prepare an agenda/).waitFor();
  assert.equal((await agent("owner").returnBrief()).current.needsAttention.some(w => w.workItemId === "test-handoff" && w.step === "decide"), true);

  mkdirSync("test-results", { recursive: true });
  // Capture at the top so sticky controls retain their real viewport positions.
  await owner.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await guest.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await owner.screenshot({ path: "test-results/unified-desktop.png", fullPage: true });
  await guest.screenshot({ path: "test-results/unified-guest-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
});
