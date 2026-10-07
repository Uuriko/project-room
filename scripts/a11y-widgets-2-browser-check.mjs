// READY A11Y-2: keyboard and screen-reader pass on the room instructions
// dialog (src/room-instructions.js), the reply-request controls
// (src/reply-requests.js UI), and the help-offer work-card actions
// (src/help-offers.js UI). src/share-invite-code.js is pure parsing logic
// with no UI of its own; its consumer (share-links.js) is outside this
// claim's files.
//
// Interaction contracts axe cannot check: dialog initial focus, Tab
// containment, Escape dismissal, focus return to the trigger, and the
// accessible names / live-region announcements of request/offer controls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { chromiumLaunchOptions } from "./a11y-axe-helper.mjs";
import { openSettings } from "./room-chrome.mjs";

async function setup(t, seed) {
  const f = createAcceptanceFixture();
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  if (seed) seed({ f, send });
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, origin, browser };
}

async function signedInPage(t, origin, browser, key) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await signInFixture(page, key);
  await page.locator("#main").waitFor({ state: "visible" });
  return { page, errors };
}

// Tab through the open dialog; every stop must stay inside it.
async function tabCycleStaysInDialog(page, dialogSelector, stops = 40) {
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName);
    if (tag === "BODY") return { escaped: true, at: i };
    const inside = await page.evaluate(sel => {
      const d = document.querySelector(sel);
      return d ? d.contains(document.activeElement) : false;
    }, dialogSelector);
    if (!inside) return { escaped: true, at: i };
  }
  return { escaped: false, at: stops };
}

test("room instructions dialog: initial focus, Tab containment, Escape, focus return", { timeout: 120000 }, async t => {
  const { origin, browser, f } = await setup(t);
  const { page, errors } = await signedInPage(t, origin, browser, f.keys.owner);
  // The instructions entry point lives in Settings → About this room.
  await openSettings(page, "room-about");
  const open = page.locator("#room-instructions-open");
  await open.waitFor({ state: "visible" });
  await open.click();
  const dialog = page.locator("#room-instructions-dialog");
  await dialog.waitFor({ state: "visible" });
  // No instructions yet: the dialog auto-enters edit mode and focuses the first field.
  const initial = await page.evaluate(() => document.activeElement?.getAttribute("name") || document.activeElement?.id);
  assert.equal(initial, "purpose", `edit mode focuses the Purpose field (got ${initial})`);
  const cycle = await tabCycleStaysInDialog(page, "#room-instructions-dialog");
  assert.equal(cycle.escaped, false, `Tab escaped the dialog after ${cycle.at} stops`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "room-instructions-open",
    "Escape returns focus to the dialog trigger");
  assert.deepEqual(errors, []);
});

test("room instructions dialog: charter content renders as headings, not div soup", { timeout: 120000 }, async t => {
  const { origin, browser, f } = await setup(t, ({ send }) => {
    send(T.ROOM_CHARTER_UPDATED, {
      expectedRevision: 0, purpose: "Coordinate the swarm.", outputs: "Shipped work.", boundaries: "No prod deploys.", escalation: "Ask Jill.",
    });
  });
  const { page, errors } = await signedInPage(t, origin, browser, f.keys.owner);
  await openSettings(page, "room-about");
  const open = page.locator("#room-instructions-open");
  await open.waitFor({ state: "visible" });
  await open.click();
  const dialog = page.locator("#room-instructions-dialog");
  await dialog.waitFor({ state: "visible" });
  const headings = await dialog.locator("#room-instructions-view h3").allTextContents();
  assert.deepEqual(headings, ["Purpose", "Expected output", "Boundaries", "When to ask for help"],
    "charter fields render as real headings in field order");
  assert.deepEqual(errors, []);
});

test("reply request: recipient gets labeled keyboard-reachable answer/decline controls and a live status", { timeout: 120000 }, async t => {
  const { origin, browser, f } = await setup(t, ({ f, send }) => {
    const members = f.store.room("commons").state.members;
    // Guest is a human member whose access key signs in through the normal session API.
    const recipient = Object.values(members).find(m => m.id === "guest");
    assert.ok(recipient?.active, "fixture has an active guest member");
    send(T.MESSAGE_POSTED, { messageId: "a11y2-req-1", body: "Please review the plan.", requestKind: "reply", toMemberId: recipient.id }, "owner");
  });
  // Sign in as the guest: the request targets them.
  const { page, errors } = await signedInPage(t, origin, browser, f.keys.guest);
  await page.locator("#message-list").waitFor({ state: "visible" });
  const answer = page.locator('button[data-message-action="request-answered"]').first();
  const decline = page.locator('button[data-message-action="request-declined"]').first();
  await answer.waitFor({ state: "visible" });
  assert.equal((await answer.textContent()).trim(), "Answer request");
  assert.equal((await decline.textContent()).trim(), "Decline");
  // Keyboard reachability: tab to the Answer control from the message list.
  await page.locator("#message-list").focus();
  let found = false;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const action = await page.evaluate(() => document.activeElement?.dataset?.messageAction);
    if (action === "request-answered") { found = true; break; }
  }
  assert.ok(found, "Answer request is reachable by Tab from the message list");
  // The request status is announced through a live region.
  const status = page.locator('[data-request-run="a11y2-req-1"]');
  assert.equal(await status.getAttribute("role"), "status", "request run label is a live region");
  assert.deepEqual(errors, []);
});

test("help offer actions: offer controls carry accessible names", { timeout: 120000 }, async t => {
  const { origin, browser, f } = await setup(t, ({ f, send }) => {
    const workItemId = "a11y2-help-work";
    send(T.WORK_PROPOSED, { workItemId, title: "Help wanted work", definitionOfDone: "Done.", mode: "read",
      accountableMemberId: "owner", ownerDecisionRequired: false });
    const item = () => f.store.room("commons").state.workItems[workItemId];
    send(T.WORK_ACCEPTED, { workItemId, expectedRevision: item().revision });
  });
  const { page, errors } = await signedInPage(t, origin, browser, f.keys.owner);
  const card = page.locator('article[data-work-record-id="a11y2-help-work"]');
  await card.waitFor({ state: "visible" });
  // Every button on the work card must expose an accessible name.
  const unnamed = await card.evaluate(node => [...node.querySelectorAll("button")]
    .filter(b => b.offsetParent !== null)
    .map(b => ({ text: (b.textContent || "").trim(), label: b.getAttribute("aria-label") }))
    .filter(b => !b.text && !b.label));
  assert.deepEqual(unnamed, [], "all visible work-card buttons have accessible names");
  assert.deepEqual(errors, []);
});
