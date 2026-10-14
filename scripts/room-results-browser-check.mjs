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

async function setup(t, { mobile = false, guest = false, theme = "dark", expectedWrites = 0, privateResult = false } = {}) {
  const f = createResultsFixture();
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
  await f.capture(mobile ? "touch-reader" : "desktop-reader");
  await p.keyboard.press("Escape");
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
  assert.equal(await p.locator("#results-panel > summary").evaluate(node => node === document.activeElement), true);
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
  const discuss = p.getByRole("button", { name: "Discuss result", exact: true });
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

test("a withdrawn result loses its discussion action without disturbing a draft", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p;
  await p.locator("#message-input").fill("Keep this thought");
  await f.open(); await f.read(); await f.ready();
  await p.locator("#result-discuss").waitFor({ state: "visible" });
  const messageId = f.state().workItems["native-result"].receipt.nativeText.messageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.state().messages.find(message => message.id === messageId).revision ?? 0 });
  await p.locator("#result-discuss").waitFor({ state: "hidden" });
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#message-input").inputValue(), "Keep this thought");
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
  await f.read(); await f.ready(); await p.locator("#result-discuss").click();
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
  await f.open(); await f.read(); await f.ready(); await p.locator("#result-discuss").click();
  await openComposerOptions(p); await p.locator("#message-to-select").selectOption("guest");
  await p.locator("#message-input").fill("Private follow-up for the guest");
  await p.locator("#thread-back").click();
  await clickChrome(p, "#room-actions-open"); await p.locator('[data-room-action="results"]').click();
  await f.read(); await f.ready(); await p.locator("#result-discuss").click();
  assert.equal(await p.locator("#message-input").inputValue(), "Private follow-up for the guest");
  assert.equal(await p.locator("#message-to-select").inputValue(), "guest", "public result navigation does not change an authored audience");
});

for (const mobile of [false, true]) test(`inline result leaves conversation usable: ${mobile ? "phone light" : "desktop dark"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile, theme: mobile ? "light" : "dark" }), p = f.p;
  await f.open(); await f.row("native-result").locator("[data-result-work]").click();
  const card = p.locator('[data-work-record-id="native-result"]');
  await card.locator("[data-read-result]").click(); await f.ready();
  assert.equal(await card.locator("#result-dialog").count(), 1);
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
