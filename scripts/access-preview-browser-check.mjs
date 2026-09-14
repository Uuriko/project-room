// Simulated human journeys against disposable first-party data, not human research.
// C2: the read-only "what this agent can access" preview on a work card.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  return { ...f, page, errors, send };
}

test("access preview: a work card shows exactly what an agent can read before a run, and opening it starts nothing", { timeout: 60000 }, async t => {
  const f = await setup(t), { page, send } = f;
  // A quoted @mention replying to the source and an inbox-style excerpt import must add nothing to the preview.
  send(T.MESSAGE_POSTED, { messageId: "quoted-mention", replyToId: "test-request", body: "@Test producer please take this: QUOTED-MENTION-SENTINEL" });
  f.store.command(f.keys.owner, "commons", { id: "inbox-" + "b".repeat(24), type: T.MESSAGE_POSTED, data: { messageId: "excerpt-import", body: "IMPORTED-EXCERPT-SENTINEL" } });
  const card = page.locator('[data-work-record-id="test-handoff"]');
  await card.waitFor();
  await page.locator("#message-list").getByText("IMPORTED-EXCERPT-SENTINEL").waitFor();
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  const button = card.getByRole("button", { name: "What this agent can access" });
  await button.waitFor();
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  assert.equal(await card.locator("[data-access-panel]").count(), 0, "nothing is fetched or shown until asked");
  const sequenceBefore = f.store.snapshot(f.keys.owner, "commons").sequence;
  await button.click();
  const panel = card.locator('[data-access-panel="test-handoff"]');
  await panel.waitFor();
  assert.equal(await panel.getAttribute("role"), "region");
  await card.getByRole("button", { name: "What this agent can access" }).evaluate(node => node.getAttribute("aria-expanded")).then(value => assert.equal(value, "true"));
  const text = await panel.textContent();
  assert.match(text, /Only the one linked source message test-request by Test guest \(guest\)/);
  assert.match(text, /Not its thread, replies, @mentions or imported channel excerpts/);
  assert.match(text, /No linked evidence yet/);
  assert.match(text, /Runtime unknown · Attempts unknown · Concurrent sessions unknown · Spend cap unknown · Reported spend unknown · attempts so far 0\. Unknown is not unlimited/);
  assert.match(text, /Test producer \(agent\) · on this task/);
  assert.match(text, /This is not a task-level grant/);
  assert.equal(await panel.locator("[data-access-omitted]").textContent(), "other work, other messages, event history, prior receipts and checks, private reminders, read marker");
  for (const leak of ["SENTINEL", "quoted-mention", "excerpt-import", "Disposable test room"]) assert.equal(text.includes(leak), false, leak);
  assert.equal(f.store.snapshot(f.keys.owner, "commons").sequence, sequenceBefore, "a preview read commits no event");
  await page.waitForFunction(() => document.activeElement?.dataset.accessPreview === "test-handoff");
  // A live room update re-renders the card; the open preview survives until the reader closes it.
  send(T.MESSAGE_POSTED, { body: "Unrelated activity re-renders the room." });
  await page.locator("#message-list").getByText("Unrelated activity re-renders the room.").waitFor();
  assert.equal(await card.locator('[data-access-panel="test-handoff"]').count(), 1);
  await card.getByRole("button", { name: "What this agent can access" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-access-panel="test-handoff"]'));
  assert.equal(await card.getByRole("button", { name: "What this agent can access" }).getAttribute("aria-expanded"), "false");
  // Evidence and budget come from the current records once they exist.
  const revision = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["test-handoff"].revision;
  f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: "test-handoff", expectedRevision: revision() } });
  f.store.mutateWorkSession(f.keys.producer, "commons", { requestId: crypto.randomUUID(), workItemId: "test-handoff", expectedRevision: revision(), action: "set_status", status: "processing", budget: { maxSpendCents: 500 } });
  f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: T.WORK_STARTED, data: { workItemId: "test-handoff", expectedRevision: revision() } });
  f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "test-handoff", expectedRevision: revision(), summary: "Synthetic evidence", evidenceUrl: "https://example.invalid/synthetic", evidenceVersion: "v1", producerId: "producer", nextAction: "Review exact version" } });
  await card.locator(".work-details > summary").filter({ hasText: "Evidence & details" }).waitFor();
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  await card.getByRole("button", { name: "What this agent can access" }).click();
  const refreshed = card.locator('[data-access-panel="test-handoff"]');
  await refreshed.waitFor();
  const later = await refreshed.textContent();
  assert.match(later, /receipt · version v1 · https:\/\/example\.invalid\/synthetic/);
  assert.match(later, /References only; nothing is retrieved or verified/);
  assert.match(later, /Spend cap \$5\.00 · Reported spend unknown · attempts so far 1/);
  mkdirSync("test-results", { recursive: true });
  await refreshed.scrollIntoViewIfNeeded();
  await refreshed.screenshot({ path: "test-results/access-preview-panel.png" });
  assert.deepEqual(f.errors, []);
});
