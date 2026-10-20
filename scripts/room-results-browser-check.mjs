import { openComposerOptions } from "./room-chrome.mjs";
import { clickChrome, ensureSidebarOpen, messageAction } from "./room-chrome.mjs";
// Simulated people, real local browser. Fictional rooms; no outside services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { textVersion } from "../server/text-results.mjs";
import { createResultsFixture } from "./results-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, { mobile = false, guest = false, theme = "dark", expectedWrites = 0, privateResult = false, olderResult = false } = {}) {
  const f = createResultsFixture();
  if (olderResult) {
    const now = f.store.now; let offset = 0;
    f.store.now = () => now() + offset;
    for (let i = 0; i < 130; i++) {
      offset += 2500;
      f.send("owner", T.MESSAGE_POSTED, { messageId: `later-${i}`, body: `Later conversation ${i}` });
    }
  }
  if (privateResult) {
    f.send("owner", T.WORK_PROPOSED, { workItemId: "private-result", title: "Private notes", definitionOfDone: "Private result",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false, mode: "read" });
    f.change("private-result", T.WORK_ACCEPTED, {}, "owner");
    const posted = f.send("owner", T.MESSAGE_POSTED, { messageId: "private-result-text", workItemId: "private-result", toMemberId: "guest", body: f.body });
    f.change("private-result", T.WORK_COMPLETED, { summary: "Private result", nextAction: "Read", producerId: "owner",
      evidenceKind: "room_text", previousCompletionEventId: null, evidenceMessageId: "private-result-text", evidenceMessageEventId: posted.event.id,
      evidenceVersion: textVersion(f.body) }, "owner");
  }
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  p.setDefaultTimeout(8000);
  await p.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  const errors = [], outside = [], writes = [];
  p.on("pageerror", error => errors.push(error.message));
  await p.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await p.goto(origin); await signInFixture(p, f.keys[guest ? "guest" : "owner"]);
  await p.locator("#main").waitFor({ state: "visible" });
  p.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/rooms/") && !new URL(request.url()).pathname.endsWith("/typing")) writes.push(request.url()); });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.equal(writes.length, expectedWrites); });
  const row = id => p.locator(`#room-results-list [data-result-work-id="${id}"]`);
  const open = async () => { await clickChrome(p, "#topbar-settings"); await p.locator("#results-panel > summary").click(); };
  const read = () => row(privateResult ? "private-result" : "native-result").locator("[data-read-result]").click();
  const ready = () => p.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  const capture = async name => {
    mkdirSync("test-results/room-results-20260908", { recursive: true });
    await p.screenshot({ path: `test-results/room-results-20260908/${name}.png` });
  };
  return { ...f, p, row, open, read, ready, capture };
}

for (const mobile of [false, true]) test(`results ${mobile ? "touch" : "desktop"}: find, read and return without losing conversation`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile }), p = f.p;
  await p.locator("#message-input").fill("Keep my next thought.");
  const scroll = await p.locator("#message-list").evaluate(node => { node.scrollTop = 0; return node.scrollTop; });
  await f.open();
  assert.equal(await p.locator("#settings-dialog").isVisible(), true);
  assert.equal(await p.locator("#room-results-list .result-row").count(), 2);
  assert.match(await f.row("native-result").textContent(), /Completed/);
  assert.match(await f.row("approved-result").textContent(), /Approved.*External evidence/);
  assert.equal(await f.row("pending-result").count(), 0);
  const approvedRel = await f.row("approved-result").locator("a").getAttribute("rel");
  assert.match(approvedRel, /(^|\s)noreferrer(\s|$)/);
  assert.match(approvedRel, /(^|\s)noopener(\s|$)/);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "touch-list" : "desktop-list");
  await f.read(); await f.ready();
  assert.equal(await f.row("native-result").locator("#result-dialog").count(), 1, "exact result expands inside its selected row");
  assert.equal(await p.locator("#result-dialog").getAttribute("role"), "region");
  assert.equal(await p.locator("dialog:modal").count(), 1, "reading adds no second modal over Results");
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  assert.equal(await p.locator("#close-result").textContent(), "Back to results");
  assert.equal(await p.locator("#result-discuss").textContent(), "Reply");
  assert.equal(await f.row("approved-result").isVisible(), false, "reading focuses on the selected result");
  await f.capture(mobile ? "touch-reader" : "desktop-reader");
  await p.keyboard.press("Escape");
  assert.equal(await f.row("approved-result").isVisible(), true, "Back restores the result list");
  assert.equal(await f.row("native-result").locator("[data-read-result]").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.locator("#message-input").inputValue(), "Keep my next thought.");
  assert.equal(await p.locator("#message-list").evaluate(node => node.scrollTop), scroll);
  await f.row("native-result").locator("[data-result-work]").click();
  assert.equal(await p.locator("#settings-dialog").isVisible(), false);
  assert.equal(await p.locator('[data-work-record-id="native-result"] .work-details').evaluate(node => node.open), true);
  await clickChrome(p, "#room-actions-open"); await p.locator('[data-room-action="results"]').click();
  assert.equal(await p.locator("#settings-dialog").isVisible(), true);
  assert.equal(await p.locator("#results-panel").evaluate(node => node.open), true);
});

test("results update after review and reopening; a pinned open reader becomes earlier, not a replacement", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  f.review("pending-result"); await f.row("pending-result").waitFor();
  await f.read(); await f.ready(); f.reopen("native-result");
  await p.waitForFunction(() => document.querySelector("#result-status").textContent.startsWith("Earlier result"));
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  assert.equal(await f.row("native-result").count(), 0);
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#room-results-list").evaluate(node => node === document.activeElement), true);
  f.reopen("pending-result"); f.reopen("approved-result");
  await p.locator("#room-results-list .empty-note").waitFor();
  assert.match(await p.locator("#room-results-list").textContent(), /No completed results yet/);
});

test("result read failure preserves the list and allows a deliberate retry", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  await p.route("**/work-result?**", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await f.read(); await p.waitForFunction(() => document.querySelector("#result-status").textContent.includes("unavailable"));
  assert.equal(await p.locator("#result-body").textContent(), "");
  assert.equal(await p.locator("#result-discuss").isVisible(), false);
  await p.locator("#close-result").click(); await p.unroute("**/work-result?**");
  await f.read(); await f.ready();
});

test("late result reads cannot restore content after sign-out, and the Results view resets", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  await p.route("**/work-result?**", async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await f.read(); await began;
  await p.locator("#signout-button").evaluate(node => node.click());
  await p.locator("#auth-panel").waitFor(); release();
  assert.equal(await p.locator("#result-body").textContent(), "");
  assert.equal(await p.locator("#room-results-list").textContent(), "");
  assert.equal(await p.locator("#settings-dialog").isVisible(), false);
  await p.unroute("**/work-result?**", { behavior: "wait" });
  assert.equal(await p.locator("#result-dialog").isVisible(), false);
  assert.equal(await p.locator("#result-discuss").isVisible(), false);
});

for (const theme of ["dark", "light"]) for (const guest of [false, true]) test(`discuss exact result preserves drafts and authorship: ${theme} ${guest ? "guest phone" : "owner desktop"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { guest, mobile: guest, theme, expectedWrites: 1 }), p = f.p;
  const before = structuredClone(f.state().workItems["native-result"]);
  const resultId = before.receipt.nativeText.messageId;
  const input = p.locator("#message-input");
  await input.fill("Keep my channel draft");
  await f.open(); await f.read(); await f.ready();
  const discuss = p.locator("#result-dialog").getByRole("button", { name: "Reply", exact: true });
  await discuss.focus(); await p.keyboard.press("Enter");
  assert.equal(await p.locator("#result-dialog").isVisible(), false);
  assert.equal(await p.locator("#settings-dialog").isVisible(), false);
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await input.inputValue(), "");
  await input.fill("Keep my result follow-up");
  await p.locator("#thread-back").click();
  assert.equal(await input.inputValue(), "Keep my channel draft");
  await clickChrome(p, "#room-actions-open");
  await p.locator('[data-room-action="results"]').click();
  await f.read(); await f.ready(); await discuss.click();
  assert.equal(await input.inputValue(), "Keep my result follow-up");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(`discuss-${theme}-${guest ? "phone" : "desktop"}`);
  await p.locator('#message-form button[type="submit"]').click();
  await p.waitForFunction(() => !document.querySelector("#message-input").value);
  const posted = f.state().messages.filter(message => message.body === "Keep my result follow-up");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].authorId, guest ? "guest" : "owner");
  assert.equal(posted[0].replyToId, resultId, "the exact result, not another version, owns the reply context");
  assert.equal(posted[0].toMemberId, null, "discussion stays public");
  assert.deepEqual(f.state().workItems["native-result"], before, "discussion does not reopen, approve or reassign work");
  await p.locator("#thread-back").click();
  assert.equal(await input.inputValue(), "Keep my channel draft");
});

test("guest Results remain useful with large text and no creation controls", { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile: true, guest: true }), p = f.p;
  await p.evaluate(() => document.documentElement.style.fontSize = "200%");
  await f.open();
  assert.equal(await p.locator("#new-work-button").isVisible(), false);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.read(); await f.ready();
  assert.equal(await p.locator("#result-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await f.capture("large-text");
});

for (const theme of ["dark", "light"]) for (const mobile of [false, true]) test(`a withdrawn result clears its reader: ${theme} ${mobile ? "phone" : "desktop"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { theme, mobile }), p = f.p;
  await p.locator("#message-input").fill("Keep this thought");
  await f.open(); await f.read(); await f.ready();
  await p.locator("#result-discuss").waitFor({ state: "visible" });
  const messageId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.state().messages.find(message => message.id === messageId).revision ?? 0 });
  await p.locator("#result-discuss").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#result-body").textContent(), "", "withdrawal clears already loaded text");
  assert.equal(await p.locator("#result-body").isHidden(), true);
  assert.match(await p.locator("#result-status").textContent(), /Text withdrawn/);
  assert.equal(await p.locator("#result-copy-text").isHidden(), true);
  assert.equal(await p.locator("#result-download").isHidden(), true);
  await f.capture(`withdrawn-${theme}-${mobile ? "phone" : "desktop"}`);
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#message-input").inputValue(), "Keep this thought");
});

test("a delayed result response cannot restore withdrawn text", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  await p.route("**/work-result?**", async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await f.read(); await began;
  const messageId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.state().messages.find(message => message.id === messageId).revision ?? 0 });
  // Wait for the live deletion before releasing the older exact-text response.
  await p.waitForFunction(id => document.querySelector(`[data-message-record-id="${id}"]`)?.textContent.includes("deleted"), messageId);
  release();
  await p.locator("#result-status").filter({ hasText: "Text withdrawn" }).waitFor();
  assert.equal(await p.locator("#result-body").textContent(), "");
  assert.equal(await p.locator("#result-copy-text").isHidden(), true);
  assert.equal(await p.locator("#result-discuss").isHidden(), true);
});

test("returning from a result preserves an uncertain send's exact target and retry", { timeout: 30000 }, async t => {
  const f = await setup(t, { expectedWrites: 2 }), p = f.p;
  const resultId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_POSTED, { messageId: "result-peer-reply", body: "Which part needs another look?", replyToId: resultId });
  await f.open(); await f.read(); await f.ready(); await p.locator("#result-discuss").click();
  await messageAction(p, "result-peer-reply", "reply");
  await openComposerOptions(p); await p.locator("#message-to-select").selectOption("guest");
  await p.locator("#message-input").fill("Please expand the second point");
  const attempts = [];
  await p.route("**/rooms/commons/commands", route => {
    attempts.push(route.request().postDataJSON());
    return attempts.length === 1 ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) : route.continue();
  });
  const send = p.locator('#message-form button[type="submit"]');
  await send.click();
  await p.locator("#composer-status").filter({ hasText: "Draft kept" }).waitFor();
  await clickChrome(p, "#room-actions-open"); await p.locator('[data-room-action="results"]').click();
  await f.read(); await f.ready();
  assert.equal(await p.locator("#result-discuss").isDisabled(), true, "an uncertain send owns the existing reply target");
  await p.locator("#close-result").click(); await p.locator("#settings-close").click();
  assert.equal(await p.locator("#message-input").inputValue(), "Please expand the second point");
  await send.click(); await p.waitForFunction(() => !document.querySelector("#message-input").value);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0], "same command and reply target are retried");
  assert.equal(attempts[1].data.replyToId, "result-peer-reply");
  assert.equal(attempts[1].data.toMemberId, "guest", "an uncertain private send never becomes public");
  assert.equal(f.state().messages.filter(message => message.body === "Please expand the second point").length, 1);
});

test("creating new work from the composer requires explicit confirmed submission", { timeout: 30000 }, async t => {
  const f = await setup(t, { expectedWrites: 1 }), p = f.p;
  assert.equal(await p.locator("#new-work-button").getAttribute("aria-label"), "New work");
  await openComposerOptions(p); await p.locator("#new-work-button").click(); await p.locator("#cancel-work-button").click();
  assert.equal(await p.locator("#work-dialog").isVisible(), false);
  await openComposerOptions(p); await p.locator("#new-work-button").click();
  await p.locator("#work-title-input").fill("Follow up on the result");
  await p.locator("#work-done-input").fill("One clear next action.");
  await p.locator("#work-options > summary").click();
  await p.locator("#assignee-select").selectOption("producer");
  await p.locator("#require-verification").check();
  await p.locator("#verifier-select").selectOption("reviewer");
  await p.locator("#create-work-button").click();
  await p.locator("#work-dialog").waitFor({ state: "hidden" });
  await p.locator('#message-list [data-work-timeline]').first().waitFor();
  assert.ok(Object.values(f.state().workItems).some(item => item.title === "Follow up on the result" && item.state === "proposed"));
});

test("creating work without choosing a verifier responds instead of silently doing nothing", { timeout: 30000 }, async t => {
  const f = await setup(t, { expectedWrites: 1 }), p = f.p;
  await openComposerOptions(p); await p.locator("#new-work-button").click();
  await p.locator("#work-title-input").fill("Follow up without a verifier");
  await p.locator("#work-done-input").fill("One clear next action.");
  await p.locator("#assignee-select").selectOption("producer");
  // Verification is required by default and the verifier select starts empty.
  // The happy-path test above always selects a verifier first, which is why
  // it never hit this trap: Create used to swallow the click with no request
  // and no surfaced error.
  assert.equal(await p.locator("#require-verification").isChecked(), true);
  assert.equal(await p.locator("#verifier-select").inputValue(), "");
  assert.equal(await p.locator("#work-options").evaluate(node => node.open), false);
  await p.locator("#create-work-button").click();
  // The dialog must respond: still open, Options expanded so the requirement
  // is visible, the verifier select focused, and a plain hint naming what is
  // missing. Nothing is created and no write is made.
  assert.equal(await p.locator("#work-dialog").isVisible(), true);
  assert.equal(await p.locator("#work-options").evaluate(node => node.open), true);
  assert.equal(await p.locator("#verifier-select").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.locator("#verifier-hint").isVisible(), true);
  assert.match(await p.locator("#verifier-hint").textContent(), /Choose who verifies this work/);
  assert.equal(Object.values(f.state().workItems).some(item => item.title === "Follow up without a verifier"), false);
  // Choosing a verifier clears the hint and Create succeeds.
  await p.locator("#verifier-select").selectOption("reviewer");
  assert.equal(await p.locator("#verifier-hint").isVisible(), false);
  await p.locator("#create-work-button").click();
  await p.locator("#work-dialog").waitFor({ state: "hidden" });
  assert.ok(Object.values(f.state().workItems).some(item => item.title === "Follow up without a verifier" && item.state === "proposed"));
});

for (const mobile of [false, true]) test(`automatic Results shortcut ${mobile ? "phone" : "desktop"}: appears for useful results and preserves settings`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile }), p = f.p;
  await p.locator("#message-input").fill("My unfinished thought");
  await ensureSidebarOpen(p);
  await p.locator("#room-results-open").click();
  assert.equal(await p.locator("#results-panel").isVisible(), true);
  assert.equal(await p.locator("#room-about").isVisible(), false);
  await f.capture(mobile ? "direct-phone" : "direct-desktop");
  await f.read(); await f.ready();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  assert.equal(await p.evaluate(() => document.activeElement.id), "room-results-open");
  assert.equal(await p.locator("#message-input").inputValue(), "My unfinished thought");
  await clickChrome(p, "#topbar-settings");
  assert.equal(await p.locator("#room-about").isVisible(), true);
  assert.equal(await p.locator("#settings-title").textContent(), "Settings");
  await p.locator("#settings-close").click();
  f.reopen("native-result"); f.reopen("approved-result");
  await p.locator("#room-results-open").waitFor({ state: "hidden" });
});

for (const guest of [false, true]) test(`private result continuation keeps its audience: ${guest ? "recipient phone light" : "author desktop dark"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { privateResult: true, guest, mobile: guest, theme: guest ? "light" : "dark" }), p = f.p;
  await p.locator("#message-input").fill("Keep my existing draft");
  await f.open(); await f.read(); await f.ready();
  const before = structuredClone(f.state().workItems["private-result"]);
  const discuss = p.locator("#result-discuss");
  assert.equal(await discuss.isVisible(), false, "private text stays readable without an unsafe public reply shortcut");
  await discuss.evaluate(node => node.click());
  assert.equal(await p.locator("#result-dialog").isVisible(), true, "retained control cannot bypass the audience guard");
  await f.capture(guest ? "private-result-phone-light" : "private-result-desktop-dark");
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#message-input").inputValue(), "Keep my existing draft");
  assert.deepEqual(f.state().workItems["private-result"], before);
});

for (const mobile of [false, true]) test(`public result preserves an authored private draft: ${mobile ? "phone light" : "desktop dark"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile, theme: mobile ? "light" : "dark" }), p = f.p;
  const resultId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_POSTED, { messageId: "private-draft-thread", body: "Discuss the result here", replyToId: resultId });
  await f.open(); await f.read(); await f.ready(); await p.locator("#result-discuss").click();
  await openComposerOptions(p); await p.locator("#message-to-select").selectOption("guest");
  await p.locator("#message-input").fill("Private follow-up for the guest");
  await p.locator("#thread-back").click();
  await clickChrome(p, "#room-actions-open"); await p.locator('[data-room-action="results"]').click();
  await f.read(); await f.ready(); await p.locator("#result-discuss").click();
  assert.equal(await p.locator("#result-dialog").isVisible(), true, "protected destination draft refuses the handoff");
  await p.locator("#close-result").click(); await p.locator("#settings-close").click();
  await p.locator(`[data-message-record-id="${resultId}"] [data-message-action="thread"]`).click();
  assert.equal(await p.locator("#message-input").inputValue(), "Private follow-up for the guest");
  assert.equal(await p.locator("#message-to-select").inputValue(), "guest", "public result navigation does not change an authored audience");
});

for (const mobile of [false, true]) test(`inline result leaves conversation usable: ${mobile ? "phone light" : "desktop dark"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile, theme: mobile ? "light" : "dark" }), p = f.p;
  await f.open(); await f.row("native-result").locator("[data-result-work]").click();
  const card = p.locator('[data-work-record-id="native-result"]');
  await card.locator("[data-read-result]").click(); await f.ready();
  assert.equal(await card.locator("#result-dialog").count(), 1);
  assert.equal(await card.locator(".work-card-header").innerText(), "Completed", "completion is stated once, without a second DONE badge");
  assert.equal(await card.locator('[data-portable-mode="result"]').count(), 0, "external AI return has one entry inside Use my AI, not a competing card action");
  assert.equal(await card.locator(".work-details").evaluate(node => node.open), false, "reading collapses secondary work controls");
  assert.equal(await p.locator("dialog:modal").count(), 0);
  assert.equal(await p.locator("#result-title").evaluate(node => { const box = node.getBoundingClientRect(); return node === document.activeElement && box.top >= 0 && box.bottom <= innerHeight; }), true, "opening starts at the result heading");
  await f.capture(mobile ? "inline-result-initial-phone-light" : "inline-result-initial-desktop-dark");
  await p.locator("#message-input").fill("My next thought while reading");
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  const receipt = structuredClone(f.state().workItems["native-result"].receipt);
  await p.locator("#close-result").focus();
  f.reopen("native-result");
  await p.waitForFunction(() => document.querySelector("#result-status").textContent.startsWith("Earlier result"));
  assert.equal(await card.locator("#result-body").textContent(), f.body, "rerender keeps the inspected version inline");
  assert.equal(await p.locator("#close-result").evaluate(node => node === document.activeElement), true);
  assert.deepEqual(f.state().workItems["native-result"].receipt, receipt);
  await f.capture(mobile ? "inline-result-phone-light" : "inline-result-desktop-dark");
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("#result-dialog").isVisible(), false);
  assert.equal(await card.locator(".work-details").evaluate(node => node.open), true, "closing restores the original details and action");
  assert.equal(await card.locator("[data-read-result]").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.locator("#message-input").inputValue(), "My next thought while reading");
});

test("inline private result across persisted wake and revoked session", { timeout: 30000 }, async t => {
  const f = await setup(t, { privateResult: true }), p = f.p;
  await f.open(); await f.row("private-result").locator("[data-result-work]").click();
  const card = p.locator('[data-work-record-id="private-result"]');
  await card.locator("[data-read-result]").click(); await f.ready();
  await p.locator("#message-input").fill("Unsent thought survives wake");
  const wake = async () => {
    const restored = p.waitForResponse(response => new URL(response.url()).pathname === "/api/session");
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    return (await restored).status();
  };
  assert.equal(await wake(), 200);
  await p.locator("#main").waitFor({ state: "visible" });
  assert.equal(await p.locator("#message-input").inputValue(), "Unsent thought survives wake");
  // The same authorized viewer may keep the inspected text; reopen to refresh read ownership.
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#result-body").textContent(), "");
  await card.locator("[data-read-result]").click(); await f.ready();
  assert.equal(await p.locator("#result-discuss").isVisible(), false);
  const cookie = (await p.context().cookies()).find(value => value.name.endsWith("room_session"));
  assert.ok(cookie);
  await p.context().addCookies([{ ...cookie, value: "revoked-session-token" }]);
  assert.equal(await wake(), 401);
  await p.waitForFunction(() => document.querySelector("#main").hidden);
  assert.equal(await p.locator("#result-dialog").isVisible(), false);
  assert.equal(await p.locator("#result-body").textContent(), "", "revocation removes retained private exact text");
});

test("combined journey: sign in, read inline, continue once, reconnect with draft intact", { timeout: 30000 }, async t => {
  const f = await setup(t, { expectedWrites: 1 }), p = f.p;
  await f.open(); await f.row("native-result").locator("[data-result-work]").click();
  await p.locator('[data-work-record-id="native-result"] [data-read-result]').click(); await f.ready();
  assert.equal(await p.locator("dialog:modal").count(), 0);
  await p.locator("#result-discuss").click();
  await p.locator("#message-input").fill("Continue from this exact result");
  await p.locator('#message-form button[type="submit"]').click();
  await p.waitForFunction(() => !document.querySelector("#message-input").value);
  const sent = f.state().messages.filter(message => message.body === "Continue from this exact result");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].replyToId, "continuation retains the result discussion target");
  assert.equal(sent[0].toMemberId ?? null, null);
  await p.locator("#message-input").fill("Unsent next thought");
  const restored = p.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.ok());
  await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await restored;
  await p.waitForFunction(() => document.querySelector("#message-input").value === "Unsent next thought");
  assert.equal(f.state().messages.filter(message => message.body === "Continue from this exact result").length, 1);
  assert.equal(await p.locator("#main").isVisible(), true);
});

// A deterministic stdio MCP peer qualifies transport, not a model/provider.
test("saved scoped channel: human assignment to inline result, continuation and restart", { timeout: 60000 }, async t => {
  const { channelJourneyFixture, channelPeer } = await import("./channel-journey-fixture.mjs");
  const f = await channelJourneyFixture(t), browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const started = performance.now(), traffic = []; let clicks = 0;
  f.server.on("request", (request, response) => {
    const row = { method: request.method, path: request.url.split("?")[0], start: performance.now() }; traffic.push(row);
    response.once("finish", () => { row.status = response.statusCode; row.elapsedMs = Math.round(performance.now() - row.start); });
  });
  const p = await browser.newPage(); p.setDefaultTimeout(10000);
  await p.exposeFunction("recordTransportJourneyClick", () => { clicks++; });
  await p.addInitScript(() => document.addEventListener("click", () => { void window.recordTransportJourneyClick(); }));
  const errors = []; p.on("pageerror", error => errors.push(error.message));
  await p.goto(f.origin); await signInFixture(p, f.ownerKey);
  await f.connectAgent();
  await p.locator(`[data-member-record-id="${f.connection.memberId}"]`).waitFor({ state: "attached" });
  await openComposerOptions(p); await p.locator("#new-work-button").click();
  await p.locator("#work-title-input").fill("Transport result");
  await p.locator("#work-done-input").fill("Return one exact local transport result");
  await p.locator("#work-options > summary").click();
  await p.locator("#assignee-select").selectOption(f.connection.memberId);
  await p.locator("#work-mode-select").selectOption("read");
  await p.locator("#require-verification").uncheck();
  await p.locator("#require-decision").uncheck();
  await p.locator("#create-work-button").click();
  await p.locator("#work-dialog").waitFor({ state: "hidden" });
  const first = channelPeer(t, f); await first.initialize(); first.send({ method: "notifications/initialized" });
  await first.wait(frame => frame.method === "notifications/claude/channel");
  const call = async (peer, name, args = {}) => {
    const frame = await peer.rpc("tools/call", { name, arguments: args });
    assert.equal(frame.error, undefined, `${name}: protocol refusal`);
    assert.notEqual(frame.result?.isError, true, `${name}: ${JSON.stringify(frame.result)}`);
    return frame.result.structuredContent;
  };
  const listed = await call(first, "room_list_work"), task = listed.work.find(item => item.title === "Transport result");
  assert.ok(task);
  let context = await call(first, "room_read_work", { workItemId: task.id });
  await call(first, "room_accept_work", { requestId: "transport-accept", workItemId: task.id, expectedRevision: context.work.revision });
  context = await call(first, "room_read_work", { workItemId: task.id });
  const body = `Deterministic transport result: ${context.work.definitionOfDone}`;
  const draftArgs = { requestId: "transport-result", workItemId: task.id, packetId: "transport-packet", basisRevision: context.work.revision, body };
  const draft = await call(first, "room_post_draft", draftArgs);
  const completion = { requestId: "transport-complete", workItemId: task.id, expectedRevision: context.work.revision,
    summary: "Local transport result", nextAction: "Read and continue", evidenceMessageId: draft.messageId,
    evidenceMessageEventId: draft.eventId, evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: f.connection.memberId };
  const completed = await call(first, "room_submit_text_result", completion);
  const card = p.locator(`[data-work-record-id="${task.id}"]`);
  await card.locator("[data-read-result]").click();
  await p.waitForFunction(text => document.querySelector("#result-body").textContent === text, body);
  assert.equal(await card.locator("#result-dialog").count(), 1);
  assert.equal(await card.locator(".work-card-header").innerText(), "Completed", "completion is stated once, without a second DONE badge");
  assert.equal(await card.locator('[data-portable-mode="result"]').count(), 0, "external AI return has one entry inside Use my AI, not a competing card action");
  assert.equal(await card.locator(".work-details").evaluate(node => node.open), false, "reading collapses secondary work controls");
  await p.locator("#result-discuss").click();
  await p.locator("#message-input").fill("Continue this transport result");
  await p.locator('#message-form button[type="submit"]').click();
  await p.waitForFunction(() => !document.querySelector("#message-input").value);
  await p.locator("#message-input").fill("Keep my unsent follow-up");
  await first.stop();
  const second = channelPeer(t, f); await second.initialize(); second.send({ method: "notifications/initialized" });
  const continuation = f.store.room("commons").state.messages.find(message => message.body === "Continue this transport result");
  assert.ok(continuation);
  const resumedNotice = await second.wait(frame => frame.method === "notifications/claude/channel" && frame.params.content.includes(continuation.id));
  assert.ok(resumedNotice.params.meta.signal_id, "restart delivers the actual human continuation wake");
  const replay = await call(second, "room_post_draft", draftArgs);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.messageId, draft.messageId);
  const completedAgain = await call(second, "room_submit_text_result", completion);
  assert.equal(completedAgain.duplicate, true);
  assert.equal(completedAgain.eventId, completed.eventId, "completion replay confirms the same persisted result");
  const reread = await call(second, "room_read_work", { workItemId: task.id, includeDiscussion: true, includeResult: true });
  assert.ok(JSON.stringify(reread).includes("Continue this transport result"), "fresh process reads human continuation itself");
  const replyArgs = { requestId: "transport-continuation-reply", replyToId: continuation.id, body: "Continuation received by the restarted transport peer" };
  const reply = await call(second, "room_reply", replyArgs);
  assert.equal(reply.status, "recorded");
  const signalId = resumedNotice.params.meta.signal_id;
  const ack = await call(second, "room_acknowledge_wake", { signalIds: [signalId] });
  assert.deepEqual(ack.acknowledged, [signalId], "ack follows the confirmed continuation reply");
  const repeatedReply = await call(second, "room_reply", replyArgs);
  assert.equal(repeatedReply.duplicate, true);
  assert.equal(f.store.room("commons").state.messages.filter(message => message.body === replyArgs.body).length, 1);
  await p.locator("#message-list").getByText(replyArgs.body, { exact: true }).waitFor();
  assert.equal(f.store.room("commons").state.messages.filter(message => message.body === body).length, 1);
  assert.equal(await p.locator("#message-input").inputValue(), "Keep my unsent follow-up");
  assert.deepEqual(errors, []);
  console.log("LOCAL_TRANSPORT_JOURNEY " + JSON.stringify({ elapsedMs: Math.round(performance.now() - started), clicks,
    requests: traffic.length, finishedRequests: traffic.filter(row => row.status).length,
    requestsByMethod: Object.fromEntries([...new Set(traffic.map(row => row.method))].map(method => [method, traffic.filter(row => row.method === method).length])),
    scope: "local sign-in through saved scoped channel, deterministic MCP result, restart, continuation reply/ack; no external model or human think time" }));
});

for (const mobile of [false, true]) test(`older result resolves its reply conversation: ${mobile ? "phone" : "desktop"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { olderResult: true, mobile }), p = f.p;
  await f.open(); await f.read(); await f.ready();
  await p.locator("#result-discuss").click();
  await p.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#message-input").evaluate(node => node === document.activeElement), true);
  assert.match(await p.locator("#reply-context").textContent(), /Café|One useful result/);
});

test("stalled clipboard recovers without losing the result or download", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open(); await f.read(); await f.ready();
  await p.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise(() => {}) } }));
  await p.locator("#result-copy-text").click();
  await p.locator("#result-use-status").filter({ hasText: "Could not copy" }).waitFor();
  assert.equal(await p.locator("#result-copy-text").isDisabled(), false);
  assert.equal(await p.locator("#result-download").isVisible(), true);
  assert.equal(await p.locator("#result-body").textContent(), f.body);
});

for (const delayed of [false, true]) test(`withdrawing prior version clears comparison: ${delayed ? "delayed response" : "already rendered"}`, { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p;
  const previous = structuredClone(f.state().workItems["native-result"].receipt);
  f.reopen("native-result");
  f.change("native-result", T.WORK_STARTED, { resolvedBlocker: "Ready to revise" });
  const body = "Replacement result without the old note.";
  const posted = f.send("producer", T.MESSAGE_POSTED, { messageId: "replacement-audit", workItemId: "native-result", body });
  f.change("native-result", T.WORK_COMPLETED, { summary: "Replacement", nextAction: "Read", producerId: "producer", evidenceKind: "room_text",
    previousCompletionEventId: previous.eventId, evidenceMessageId: "replacement-audit", evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion(body) });
  let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  if (delayed) await p.route("**/work-result?**", async route => {
    if (new URL(route.request().url()).searchParams.get("completionEventId") !== previous.eventId) return route.continue();
    const response = await route.fetch(); began(); await gate; await route.fulfill({ response });
  });
  await f.open(); await f.read();
  if (delayed) await started;
  else await p.locator("#result-diff").filter({ hasText: "One useful result" }).waitFor();
  const messageId = previous.nativeText.messageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.state().messages.find(message => message.id === messageId).revision ?? 0 });
  await p.waitForFunction(id => document.querySelector(`[data-message-record-id="${id}"]`)?.textContent.includes("deleted"), messageId);
  release();
  await p.locator("#result-diff").filter({ hasText: "A version was withdrawn" }).waitFor();
  await f.capture(delayed ? "withdrawn-comparison-delayed" : "withdrawn-comparison");
  assert.equal((await p.locator("#result-diff").textContent()).includes("One useful result"), false, "withdrawn previous text must leave comparison too");
});

test("withdrawal keeps keyboard focus inside the reader", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open(); await f.read(); await f.ready();
  await p.locator("#result-copy-text").focus();
  const messageId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.state().messages.find(message => message.id === messageId).revision ?? 0 });
  await p.locator("#result-copy-text").waitFor({ state: "hidden" });
  const focus = await p.evaluate(() => ({ id: document.activeElement.id, tag: document.activeElement.tagName,
    visible: Boolean(document.activeElement.getClientRects().length), reader: document.querySelector("#result-dialog").contains(document.activeElement) }));
  assert.equal(focus.reader && focus.visible, true, JSON.stringify(focus));
});
