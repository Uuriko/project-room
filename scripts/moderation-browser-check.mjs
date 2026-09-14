// Simulated human journey against disposable first-party data, not human research.
// Issue #6 E4: a member reports a message to the room owner and mutes an author for
// themselves; the owner alone sees the report list with the reporter's name.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const errors = [];
  t.after(() => assert.deepEqual(errors, []));
  // Each member signs in from its own browser context: the room session cookie is per origin.
  const signIn = async key => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" }), page = await context.newPage();
    page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.locator("#access-key").fill(key);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  const post = (actor, messageId, body) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });
  const reports = () => f.store.moderation.list(f.keys.owner, "commons").reports;
  return { ...f, signIn, post, reports, guestState: () => f.store.room("commons").state.members.guest };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`moderation ${label}: a member reports a message to the owner, mutes and unmutes an author for themselves`, { timeout: 90000 }, async t => {
    const f = await setup(t, viewport);
    f.post("producer", "mod-target", "Synthetic message the guest will report and then mute.");
    const page = await f.signIn(f.keys.guest);
    const target = page.locator('#message-list li[data-key="mod-target"]');
    await target.locator(".message-body").waitFor({ state: "visible" });
    assert.equal(await page.locator("#reports-section").isHidden(), true, "a non-owner never sees the report list");
    // Report: a short reason goes to the owner only; the room sees nothing.
    await target.locator('[data-message-action="report"]').click();
    await page.locator("#report-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#report-source").textContent(), /^Message from Test producer: Synthetic message/);
    await page.locator("#report-reason-input").fill("Off-topic and repeated.");
    await page.locator('#report-form button[type="submit"]').click();
    await page.locator("#report-dialog").waitFor({ state: "hidden" });
    await page.locator("#status").filter({ hasText: "Report sent to the room owner. Only the owner sees it." }).waitFor({ state: "visible" });
    const recorded = f.reports();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].reporterId, "guest"); assert.equal(recorded[0].messageId, "mod-target"); assert.equal(recorded[0].reason, "Off-topic and repeated.");
    assert.equal(f.store.room("commons").state.eventLog.length, 0, "projection carries no report; no room event was appended");
    const sequenceBefore = f.store.room("commons").sequence;
    // Reporting again is a no-op receipt, not a second report.
    await target.locator('[data-message-action="report"]').click();
    await page.locator("#report-reason-input").fill("Still off-topic.");
    await page.locator('#report-form button[type="submit"]').click();
    await page.locator("#report-dialog").waitFor({ state: "hidden" });
    await page.locator("#status").filter({ hasText: "You already reported this message" }).waitFor({ state: "visible" });
    assert.equal(f.reports().length, 1); assert.equal(f.store.room("commons").sequence, sequenceBefore, "reports append no room events");
    // Mute from the message: the author's messages collapse for this viewer only.
    await target.locator('[data-message-action="mute"]').click();
    await target.locator(".message-muted").waitFor({ state: "visible" });
    assert.equal(await target.locator(".message-muted").textContent(), "Hidden: you muted Test producer.");
    assert.deepEqual(f.guestState().mutedMemberIds, ["producer"]);
    assert.equal(await target.locator(".reaction").count(), 0, "no reactions on a muted message");
    assert.equal(await target.locator('[data-message-action="report"]').count(), 0, "report is offered on visible messages only");
    f.post("producer", "mod-second", "A later message from the muted author.");
    const second = page.locator('#message-list li[data-key="mod-second"]');
    await second.locator(".message-muted").waitFor({ state: "visible" });
    assert.equal(await page.locator('#message-list li[data-key="test-welcome"] .message-body').textContent(), "Disposable test room. Try a reply and a reaction; no real conversation is affected.", "other authors stay visible");
    const railToggle = page.locator('#presence-list [data-mute-member="producer"]');
    assert.equal(await railToggle.getAttribute("aria-pressed"), "true");
    assert.equal(await railToggle.textContent(), "Unmute Test producer");
    assert.equal(await page.locator('#presence-list [data-mute-member="owner"]').count(), 0, "the owner is never mutable");
    assert.equal(await page.locator('#presence-list [data-mute-member="guest"]').count(), 0, "you are never mutable");
    // Unmute from the message: reversible, and every message from the author returns.
    await second.locator('[data-message-action="unmute"]').click();
    await second.locator(".message-muted").waitFor({ state: "hidden" });
    assert.equal(await second.locator(".message-body").textContent(), "A later message from the muted author.");
    assert.equal(await target.locator(".message-body").textContent(), "Synthetic message the guest will report and then mute.");
    assert.equal(f.guestState().mutedMemberIds, undefined);
    // Mute from the people rail works the same way, through the disclosed capabilities block.
    await page.locator("#people-panel").evaluate(el => { el.open = true; });
    await page.locator('#presence-list [data-focus-key="member-capabilities:producer"]').click();
    await railToggle.click();
    await target.locator(".message-muted").waitFor({ state: "visible" });
    assert.equal(await railToggle.textContent(), "Unmute Test producer");
    await railToggle.click();
    await target.locator(".message-muted").waitFor({ state: "hidden" });
    assert.equal(f.guestState().mutedMemberIds, undefined);
    assert.equal(f.guestState().revision, f.store.room("commons").state.members.guest.revision, "a mute never moves member authority");
  });
}

test("moderation owner view: only the owner lists reports, with the reporter's name and the message", { timeout: 90000 }, async t => {
  const f = await setup(t);
  f.post("producer", "mod-target", "Synthetic message that gets reported.");
  f.store.moderation.report(f.keys.guest, "commons", { messageId: "mod-target", reason: "Off-topic and repeated." });
  const page = await f.signIn(f.keys.owner);
  await page.locator("#record-panel").evaluate(el => { el.open = true; });
  const section = page.locator("#reports-section");
  await section.waitFor({ state: "visible" });
  await section.locator("summary").click();
  const rows = page.locator("#report-list li[data-report-id]");
  await rows.first().waitFor({ state: "visible" });
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /Off-topic and repeated\.\s*reported by Test guest \(guest\)/);
  assert.match(await rows.first().textContent(), /Test producer \(producer\): Synthetic message that gets reported\./);
  assert.equal(await page.locator("#report-count").textContent(), "1");
  // A new report appends no room event; the owner asks again.
  f.store.moderation.report(f.keys.reviewer, "commons", { messageId: "test-request", reason: "Second synthetic report." });
  await page.locator("#report-refresh").click();
  await page.waitForFunction(() => document.querySelectorAll("#report-list li[data-report-id]").length === 2);
  assert.match(await page.locator("#report-list").textContent(), /Second synthetic report\.\s*reported by Test reviewer \(reviewer\)/);
  // Another member, even the reporter, gets no report list at all.
  const guest = await f.signIn(f.keys.guest);
  assert.equal(await guest.locator("#reports-section").isHidden(), true);
  assert.equal(await guest.locator("#report-list li").count(), 0);
});
