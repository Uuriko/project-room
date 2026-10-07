// Simulated human journeys against disposable first-party data, not human research.
// C2: the read-only "what this agent can access" preview on a work card.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { enableHumanAdvanced, openSettings, closeSettings } from "./room-chrome.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { signInFixtureInPlace } from "./in-place-fixture-signin.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";

async function setup(t, { pending = 0, width = 1440 } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  const access = new AccessRequests(f.store);
  const addRequest = index => {
    const name = `Paging applicant ${String(index).padStart(3, "0")}`;
    const identity = f.store.identities.create(name);
    return access.request("commons", { identityId: identity.identityId, displayName: name, requestedPermissions: [], requestId: `paging-${index}` });
  };
  for (let index = 1; index <= pending; index++) addRequest(index);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  return { ...f, page, errors, send, access, addRequest };
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
  const signEvidence = makeTestSigner(f.store);
  f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "test-handoff", expectedRevision: revision(), summary: "Synthetic evidence", evidenceUrl: "https://example.invalid/synthetic", evidenceVersion: "v1", producerId: "producer", nextAction: "Review exact version", signedEvidence: signEvidence() } });
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


for (const pending of [26, 60]) test(`owner attention pages ${pending} pending requests without losing the total`, { timeout: 60000 }, async t => {
  const f = await setup(t, { pending, width: pending === 26 ? 390 : 1440 }), { page } = f;
  const rows = page.locator("#attention-list > li"), next = page.locator("#attention-next"), previous = page.locator("#attention-previous");
  await rows.first().waitFor();
  assert.equal(await page.locator("#attention-count").textContent(), String(pending), "badge reports the full queue, not just its first page");
  assert.equal(await rows.count(), 25, "the first page is bounded while count remains global");
  assert.match(await page.locator("#attention-range").textContent(), new RegExp(`Showing 1[–-]25 of ${pending}`));
  assert.equal(await previous.isDisabled(), true);
  const first = await rows.locator(".attention-title").allTextContents();
  const seen = new Set(first);
  const sequence = f.store.room("commons").sequence;
  let offset = 0;
  while (offset + 25 < pending) {
    await next.click(); offset += 25;
    await page.waitForFunction(start => document.querySelector("#attention-range").textContent.includes(`Showing ${start}`), offset + 1);
    for (const title of await rows.locator(".attention-title").allTextContents()) { assert.equal(seen.has(title), false); seen.add(title); }
    assert.equal(await page.locator("#attention-count").textContent(), String(pending));
  }
  assert.equal(seen.size, pending, "every pending applicant is reachable");
  assert.equal(await next.isDisabled(), true);
  assert.equal(await previous.evaluate(node => node === document.activeElement), true, "last page moves keyboard focus to enabled Previous");
  if (pending === 26) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    mkdirSync("test-results", { recursive: true });
    await page.locator("#attention-pages").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/attention-pages-mobile.png" });
  }
  assert.equal(f.store.room("commons").sequence, sequence, "paging commits no room event");
  while (offset > 0) {
    await previous.click(); offset -= 25;
    await page.waitForFunction(start => document.querySelector("#attention-range").textContent.includes(`Showing ${start}`), offset + 1);
  }
  assert.deepEqual(await rows.locator(".attention-title").allTextContents(), first);
  await next.click();
  await page.waitForFunction(() => document.querySelector("#attention-range").textContent.includes("Showing 26"));
  await rows.first().getByRole("button", { name: "Deny", exact: true }).click();
  await page.waitForFunction(total => document.querySelector("#attention-count").textContent === String(total), pending - 1);
  assert.match(await page.locator("#attention-range").textContent(), new RegExp(`Showing 1[–-]25 of ${pending - 1}`));
  assert.equal(await previous.isDisabled(), true, "a decision returns to refreshed first page");
  if (pending === 60) {
    await next.click();
    await page.waitForFunction(() => document.querySelector("#attention-range").textContent.includes("Showing 26"));
    f.addRequest(61);
    await next.click();
    await page.getByText("The list changed. Showing the first page.", { exact: true }).waitFor();
    assert.equal(await page.locator("#attention-range").textContent(), "Showing 1–25 of 60");
    assert.equal(await rows.count(), 25, "changed queue replaces rather than appends a page");
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.evaluate(node => node === document.activeElement), true);
  }
  assert.deepEqual(f.errors, []);
});


test("late owner attention page cannot return after signing in as a different member", { timeout: 30000 }, async t => {
  const f = await setup(t, { pending: 26 }), { page } = f;
  await page.locator("#attention-list > li").first().waitFor();
  let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { captured = resolve; });
  t.after(() => release());
  await page.route("**/needs-attention?**", async route => {
    const response = await route.fetch(); captured(); await gate;
    await route.fulfill({ response });
  });
  await page.locator("#attention-next").click(); await held;
  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixtureInPlace(page, f.store, f.keys.guest);
  await page.locator("#main").waitFor({ state: "visible" });
  const delivered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/needs-attention") && new URL(response.url()).searchParams.has("cursor"));
  release(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#attention-list > li").count(), 0);
  assert.equal(await page.locator("#attention-count").textContent(), "");
  assert.equal(await page.locator("#attention-next").isVisible(), false);
  assert.equal(await page.getByText(/Paging applicant/).count(), 0, "previous owner's applicants never appear for the guest");
  assert.deepEqual(f.errors, []);
});


test("human attention hides shadow diagnostics until Advanced and reviews the actual receipt work", { timeout: 60000 }, async t => {
  const f = await setup(t, { pending: 1 }), { page } = f;
  f.store.jevShadow.record({ gate: "receipt", roomId: "commons", subject: "test-handoff", path: "work-claim:done", score: 0.1, decision: "escalate", escalate: true });
  await page.locator("#attention-refresh").click();
  await page.waitForFunction(() => document.querySelector("#attention-status").textContent === "");
  assert.equal(await page.locator(".attention-jev_escalation").count(), 0, "default human view has no shadow measurement");
  assert.equal(await page.locator("#attention-count").textContent(), "1", "the genuine pending request remains actionable");
  await enableHumanAdvanced(page);
  const shadow = page.locator(".attention-jev_escalation");
  await shadow.waitFor();
  const review = shadow.getByRole("link", { name: "Review" });
  assert.equal(await review.getAttribute("href"), "#pr-record/work/test-handoff", "receipt journal ID is not a work ID");
  await review.click();
  await page.waitForFunction(() => location.hash === "#pr-record/work/test-handoff");
  await page.locator('[data-work-record-id="test-handoff"]').waitFor();
  await openSettings(page, "advanced-room-tools");
  await page.locator("#human-advanced").uncheck();
  await closeSettings(page);
  await page.waitForFunction(() => document.querySelectorAll(".attention-jev_escalation").length === 0);
  await page.locator('.attention-access_request .attention-decide[data-action-index="0"]').click();
  await page.locator("#needs-attention").waitFor({ state: "hidden" });
  assert.equal(f.store.jevShadow.list({ roomId: "commons", escalate: true }).length, 1, "measurement retained for diagnostics after real request approval");
  assert.deepEqual(f.errors, []);
});
