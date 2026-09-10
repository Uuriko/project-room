// Browser regressions for session ownership, stale writes, live announcements,
// and user-controlled record identities. All state and credentials are disposable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";

const chromiumOptions = process.env.ROOM_TEST_CHROMIUM_PATH
  ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH }
  : {};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function startRoom(t, { events = initialRoom(), prepare = () => ({}) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-session-boundary-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(events);
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data) => store.command(key, "commons", {
    id: crypto.randomUUID(), type, data
  });
  const prepared = prepare({ store, owner, send }) || {};
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...chromiumOptions });
  return { browser, origin, owner, send, store, ...prepared };
}

async function enterRoom(page, accessKey, expectedIdentity) {
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector('#auth-form button[type="submit"]');
    return button && !button.disabled;
  });
  await page.locator("#access-key").fill(accessKey);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(name => document.querySelector("#identity-label")?.textContent.startsWith(name), expectedIdentity);
}

async function login(page, origin, accessKey, expectedIdentity) {
  await page.goto(origin);
  await enterRoom(page, accessKey, expectedIdentity);
}

async function openReadyBrief(page) {
  const panel = page.locator("#return-brief-panel");
  const ready = () => page.waitForFunction(() => {
    const button = document.querySelector("#rb-ack-button");
    return button && !button.disabled && /^\d+$/.test(button.dataset.horizon);
  });
  await ready(); // Let the initial snapshot's brief settle before opening it.
  if (!await panel.evaluate(element => element.open)) {
    // Opening schedules another fetch. Do not read the old button while its
    // asynchronous toggle handler is about to replace the displayed horizon.
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/return-brief")),
      panel.locator(":scope > summary").click()
    ]);
  }
  await ready();
}

test("late caught-up success and access error cannot cross an account switch", { timeout: 90000 }, async t => {
  const fixture = await startRoom(t, {
    prepare({ store, owner, send }) {
      send(owner, T.MEMBER_ADDED, {
        memberId: "maya", displayName: "Maya", kind: "human",
        permissions: ["accept_work", "complete_work", "verify"]
      });
      const maya = store.issueAccessKey("commons", "maya");
      send(owner, T.MESSAGE_POSTED, { messageId: "boundary-note", body: "A boundary note for both accounts" });
      send(owner, T.WORK_PROPOSED, {
        workItemId: "owner-return", title: "Owner return item", definitionOfDone: "Owner reviews it",
        accountableMemberId: "owner"
      });
      send(owner, T.WORK_PROPOSED, {
        workItemId: "maya-return", title: "Maya return item", definitionOfDone: "Maya reviews it",
        accountableMemberId: "maya"
      });
      return { maya };
    }
  });
  const { browser, origin, owner, maya, store } = fixture;
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  await openReadyBrief(page);
  await page.evaluate(() => {
    window.boundaryNotices = [];
    new MutationObserver(() => window.boundaryNotices.push(document.querySelector("#status").textContent))
      .observe(document.querySelector("#status"), { childList: true, characterData: true, subtree: true });
  });

  const successCaptured = deferred(), releaseSuccess = deferred(), successDelivered = deferred();
  const errorCaptured = deferred(), releaseError = deferred(), errorDelivered = deferred();
  let responseKind = "success";
  t.after(() => { releaseSuccess.resolve(); releaseError.resolve(); });
  await page.route("**/api/rooms/commons/cursor", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    if (responseKind === "success") {
      const response = await route.fetch(); // Commit for the old owner, but hold its response.
      successCaptured.resolve();
      await releaseSuccess.promise;
      await route.fulfill({ response });
      successDelivered.resolve();
      return;
    }
    errorCaptured.resolve();
    await releaseError.promise;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "access_denied", message: "Old session denied" } })
    });
    errorDelivered.resolve();
  });

  const ownerHorizon = Number(await page.locator("#rb-ack-button").getAttribute("data-horizon"));
  assert.ok(Number.isSafeInteger(ownerHorizon));
  await page.locator("#rb-ack-button").click();
  await successCaptured.promise;
  assert.equal(store.snapshot(owner, "commons").cursor, ownerHorizon, "the old account's committed marker remains its own");
  await page.locator("#signout-button").click();
  await enterRoom(page, maya, "Maya");
  await page.waitForFunction(() => document.querySelector("#rb-attention-list")?.textContent.includes("Maya return item"));
  releaseSuccess.resolve();
  await successDelivered.promise;
  await page.waitForTimeout(100);
  assert.match(await page.locator("#identity-label").textContent(), /^Maya/);
  assert.match(await page.locator("#rb-attention-list").textContent(), /Maya return item/);
  assert.doesNotMatch(await page.locator("#rb-attention-list").textContent(), /Owner return item/);
  assert.equal(store.snapshot(maya, "commons").cursor, 0, "the replacement account is not acknowledged by the old response");
  assert.equal(await page.evaluate(() => window.boundaryNotices.some(text => /caught-up position saved/.test(text))), false);

  // Repeat the boundary with a late authorization failure. It must not revoke or
  // announce into the replacement owner session.
  responseKind = "error";
  await openReadyBrief(page);
  await page.evaluate(() => { window.boundaryNotices = []; });
  await page.locator("#rb-ack-button").click();
  await errorCaptured.promise;
  await page.locator("#signout-button").click();
  await enterRoom(page, owner, "Room owner");
  releaseError.resolve();
  await errorDelivered.promise;
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#main").isVisible(), true);
  assert.match(await page.locator("#identity-label").textContent(), /^Room owner/);
  assert.equal(await page.locator("#auth-panel").isVisible(), false, "a stale 403 cannot end the next session");
  assert.equal(await page.evaluate(() => window.boundaryNotices.some(text => /Old session denied|caught-up position saved/.test(text))), false);
});

test("a shared browser cookie cannot expose another tab's return brief", { timeout: 90000 }, async t => {
  const fixture = await startRoom(t, {
    prepare({ store, owner, send }) {
      send(owner, T.MEMBER_ADDED, {
        memberId: "maya", displayName: "Maya", kind: "human",
        permissions: ["accept_work", "complete_work", "verify"]
      });
      const maya = store.issueAccessKey("commons", "maya");
      send(owner, T.WORK_PROPOSED, {
        workItemId: "owner-private-return", title: "Owner-only return item", definitionOfDone: "Owner acts",
        accountableMemberId: "owner"
      });
      send(owner, T.WORK_PROPOSED, {
        workItemId: "maya-private-return", title: "Maya-only return item", definitionOfDone: "Maya acts",
        accountableMemberId: "maya"
      });
      return { maya };
    }
  });
  const { browser, origin, owner, maya, store } = fixture;
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  const ownerTab = await context.newPage();
  await login(ownerTab, origin, owner, "Room owner");
  await ownerTab.waitForFunction(() => document.querySelector("#rb-attention-list")?.textContent.includes("Owner-only return item"));

  // A second tab creates a Maya session directly. Browser cookies are shared, while
  // the first tab still holds its original owner identity in memory.
  const secondTab = await context.newPage();
  await secondTab.goto(origin);
  await secondTab.locator("#main").waitFor({ state: "visible" });
  const switched = await secondTab.evaluate(async accessKey => {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey })
    });
    return { status: response.status, body: await response.json() };
  }, maya);
  assert.equal(switched.status, 201);
  assert.equal(switched.body.member.id, "maya");
  assert.match(store.returnBrief(maya, "commons", {}).current.needsAttention.map(item => item.action).join(" "), /Maya-only return item/);

  await ownerTab.evaluate(() => {
    window.returnBriefTexts = [];
    new MutationObserver(() => window.returnBriefTexts.push(document.querySelector("#rb-attention-list").textContent))
      .observe(document.querySelector("#rb-attention-list"), { childList: true, characterData: true, subtree: true });
  });
  if (await ownerTab.locator("#return-brief-panel").evaluate(node => node.open)) {
    await ownerTab.locator("#rb-refresh-button").click();
  } else {
    await ownerTab.locator("#return-brief-panel > summary").click();
  }
  await ownerTab.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await ownerTab.locator("#main").isVisible(), false);
  assert.equal(await ownerTab.locator("#identity-label").textContent(), "Not signed in");
  assert.equal(await ownerTab.locator("#message-list").textContent(), "");
  assert.equal(await ownerTab.locator("#work-list").textContent(), "");
  assert.equal(await ownerTab.locator("#rb-attention-list").textContent(), "");
  assert.equal(await ownerTab.evaluate(() => window.returnBriefTexts.some(text => text.includes("Maya-only return item"))), false,
    "the mismatched viewer payload is rejected before it can render");
});

test("a self-send has one live-announcement owner", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  await page.evaluate(() => {
    window.liveRegionChanges = [];
    for (const id of ["conversation-announcement", "composer-status", "status"]) {
      const node = document.querySelector(`#${id}`);
      new MutationObserver(() => window.liveRegionChanges.push({ id, text: node.textContent }))
        .observe(node, { childList: true, characterData: true, subtree: true });
    }
  });
  const body = "One self-send, one announcement";
  await page.locator("#message-input").fill(body);
  await page.locator('#message-form button[type="submit"]').click();
  await page.getByText(body, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Message saved to the room.");
  const announcements = await page.evaluate(() => window.liveRegionChanges.filter(entry =>
    entry.text === "Message saved to the room." || /new message/.test(entry.text)
  ));
  assert.deepEqual(announcements, [{ id: "status", text: "Message saved to the room." }]);
  assert.equal(await page.locator("#conversation-announcement").textContent(), "");
  assert.equal(await page.locator("#composer-status").textContent(), "");
  assert.equal(store.snapshot(owner, "commons").state.messages.filter(message => message.body === body).length, 1);
});

test("composer failures stay discussion-scoped and keyboard sends preserve user focus", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t, {
    prepare({ owner, send }) {
      send(owner, T.MESSAGE_POSTED, { messageId: "topic", body: "Composer boundary topic" });
      send(owner, T.MESSAGE_POSTED, { messageId: "reply", body: "Composer boundary reply", replyToId: "topic" });
    }
  });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");

  let phase = "fail", captured = deferred(), release = deferred();
  const commands = [];
  t.after(() => release.resolve());
  await page.route("**/api/rooms/commons/commands", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    commands.push(route.request().postDataJSON());
    if (phase === "fail") {
      captured.resolve();
      await release.promise;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "temporarily_unavailable", message: "Composer temporarily unavailable" } })
      });
      return;
    }
    if (phase === "hold-success") {
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
      return;
    }
    if (phase === "access-ended") {
      captured.resolve();
      await release.promise;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "access_revoked", message: "Access revoked" } })
      });
      return;
    }
    await route.continue();
  });

  const form = page.locator("#message-form"), input = page.locator("#message-input");
  const roomDraft = "A separate room-level draft";
  const threadDraft = "Thread draft remains private";
  await input.fill(roomDraft);
  await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
  await page.locator('[data-message-record-id="reply"] [data-message-action="reply"]').click();
  await input.fill(threadDraft);
  await input.evaluate(element => { element.focus(); element.setSelectionRange(7, 12, "backward"); });
  await input.press("Control+Enter");
  await captured.promise;
  assert.equal(await form.getAttribute("aria-busy"), "true");
  assert.equal(await input.isDisabled(), true);
  assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);

  release.resolve();
  const expectedError = "Composer temporarily unavailable. Draft kept. Send again to retry.";
  await page.waitForFunction(text => document.querySelector("#composer-status")?.textContent === text, expectedError);
  assert.equal(await form.getAttribute("aria-busy"), null);
  assert.equal(await input.isDisabled(), false);
  assert.deepEqual(await page.evaluate(() => ({
    id: document.activeElement?.id,
    value: document.querySelector("#message-input").value,
    start: document.querySelector("#message-input").selectionStart,
    end: document.querySelector("#message-input").selectionEnd,
    direction: document.querySelector("#message-input").selectionDirection
  })), { id: "message-input", value: threadDraft, start: 7, end: 12, direction: "backward" });
  assert.equal((await page.locator("#status").textContent()).includes("Draft kept"), false,
    "the composer owns the failure announcement");

  await page.locator("#thread-back").click();
  assert.equal(await input.inputValue(), roomDraft);
  assert.equal(await page.locator("#composer-status").textContent(), "");
  await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
  assert.equal(await input.inputValue(), threadDraft);
  assert.equal(await page.locator("#composer-status").textContent(), expectedError);
  await page.evaluate(() => {
    window.composerStatusMutations = 0;
    window.composerStatusObserver = new MutationObserver(records => { window.composerStatusMutations += records.length; });
    window.composerStatusObserver.observe(document.querySelector("#composer-status"), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('[data-message-record-id="reply"] [data-message-action="reply"]').click();
  await page.waitForTimeout(0);
  assert.equal(await page.evaluate(() => {
    window.composerStatusObserver.disconnect();
    return window.composerStatusMutations;
  }), 0, "reselecting a reply in the same failed thread does not re-announce an unchanged error");

  phase = "pass";
  await input.focus();
  await input.press("Control+Enter");
  await page.waitForFunction(() => document.querySelector("#message-input")?.value === "");
  assert.equal(commands.length, 2);
  assert.equal(commands[1].id, commands[0].id, "an unchanged retry keeps its idempotency identity");
  assert.equal(store.snapshot(owner, "commons").state.messages.filter(message => message.body === threadDraft).length, 1);
  assert.equal(await page.locator("#composer-status").textContent(), "");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "message-input");

  const deliberateFocusBody = "Completion must not steal deliberate focus";
  phase = "hold-success"; captured = deferred(); release = deferred();
  await input.fill(deliberateFocusBody);
  await input.focus();
  await input.press("Control+Enter");
  await captured.promise;
  await page.locator("#message-search").focus();
  release.resolve();
  await page.getByText(deliberateFocusBody, { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("#message-form")?.hasAttribute("aria-busy"));
  assert.equal(await page.evaluate(() => document.activeElement?.id), "message-search");

  phase = "pass";
  const guardedBody = "One ordinary shortcut send";
  await input.fill(guardedBody);
  await input.focus();
  const beforeGuards = commands.length;
  for (const specification of [
    { field: "isComposing", value: true },
    { field: "keyCode", value: 229 },
    { field: "repeat", value: true }
  ]) {
    const observed = await input.evaluate((element, spec) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter", ctrlKey: true, bubbles: true, cancelable: true,
        isComposing: spec.field === "isComposing", repeat: spec.field === "repeat"
      });
      if (spec.field === "keyCode") Object.defineProperty(event, "keyCode", { configurable: true, value: spec.value });
      element.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, observed: event[spec.field] };
    }, specification);
    assert.equal(observed.observed, specification.value);
    assert.equal(observed.defaultPrevented, false);
  }
  await page.waitForTimeout(75);
  assert.equal(commands.length, beforeGuards, "IME and repeated-key events do not issue commands");
  assert.equal(await input.inputValue(), guardedBody);
  const ordinary = await input.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, repeat: event.repeat, isComposing: event.isComposing, keyCode: event.keyCode };
  });
  assert.deepEqual(ordinary, { defaultPrevented: true, repeat: false, isComposing: false, keyCode: 0 });
  await page.waitForFunction(() => document.querySelector("#message-input")?.value === "");
  assert.equal(commands.length, beforeGuards + 1);
  assert.equal(store.snapshot(owner, "commons").state.messages.filter(message => message.body === guardedBody).length, 1);

  // Leave a failed room send offscreen so re-entry proves the entire discussion
  // error map was replaced, not merely that the visible status node was reset.
  phase = "fail"; captured = deferred(); release = deferred();
  await page.locator("#thread-back").click();
  await input.fill("This old-session room error must disappear");
  await input.press("Control+Enter");
  await captured.promise;
  release.resolve();
  await page.waitForFunction(text => document.querySelector("#composer-status")?.textContent === text, expectedError);
  await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
  assert.equal(await page.locator("#composer-status").textContent(), "");

  phase = "access-ended"; captured = deferred(); release = deferred();
  await input.fill("This old-session draft must disappear");
  await input.focus();
  await input.press("Control+Enter");
  await captured.promise;
  assert.equal(await form.getAttribute("aria-busy"), "true");
  await page.locator("#message-search").focus();
  release.resolve();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await form.getAttribute("aria-busy"), null);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "access-key",
    "access termination focuses authentication, never the old composer");
  await enterRoom(page, owner, "Room owner");
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.locator("#composer-status").textContent(), "");
  assert.equal(await form.getAttribute("aria-busy"), null);
  await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
  assert.equal(await input.inputValue(), "", "access loss clears an offscreen thread draft, not only the visible form");
  assert.equal(await page.locator("#composer-status").textContent(), "", "access loss clears an offscreen thread error");
  await page.locator("#thread-back").click();
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.locator("#composer-status").textContent(), "", "access loss clears an offscreen room error");
});

test("a late successful composer result cannot cross into a replacement session", { timeout: 90000 }, async t => {
  const { browser, origin, owner, maya, store } = await startRoom(t, {
    prepare({ store, owner, send }) {
      send(owner, T.MEMBER_ADDED, {
        memberId: "maya", displayName: "Maya", kind: "human",
        permissions: ["accept_work", "complete_work", "verify"]
      });
      return { maya: store.issueAccessKey("commons", "maya") };
    }
  });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");

  const captured = deferred(), release = deferred(), delivered = deferred();
  t.after(() => release.resolve());
  await page.route("**/api/rooms/commons/commands", async route => {
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });

  const oldBody = "Committed for the old session";
  const replacementDraft = "Maya's private replacement draft";
  const input = page.locator("#message-input"), form = page.locator("#message-form");
  await input.fill(oldBody);
  await input.press("Control+Enter");
  await captured.promise;
  assert.equal(await form.getAttribute("aria-busy"), "true");
  store.issueAccessKey("commons", "owner");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await enterRoom(page, maya, "Maya");
  await input.fill(replacementDraft);
  await page.locator("#message-search").focus();
  await page.evaluate(() => {
    window.replacementNotices = [];
    new MutationObserver(() => window.replacementNotices.push(document.querySelector("#status").textContent))
      .observe(document.querySelector("#status"), { childList: true, characterData: true, subtree: true });
  });

  release.resolve();
  await delivered.promise;
  await page.waitForTimeout(100);
  assert.match(await page.locator("#identity-label").textContent(), /^Maya/);
  assert.equal(await input.inputValue(), replacementDraft, "the old success cannot clear the replacement account's draft");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "message-search", "the old success cannot steal replacement focus");
  assert.equal(await page.locator("#composer-status").textContent(), "");
  assert.equal(await page.evaluate(() => window.replacementNotices.some(text => /Message saved/.test(text))), false,
    "the old success cannot announce into the replacement session");
  assert.equal(store.snapshot(maya, "commons").state.messages.filter(message => message.body === oldBody).length, 1);
});

test("a committed self-send is not re-announced as incoming after a delayed snapshot", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  let committed = false, allowSnapshot = false;
  await page.route("**/api/rooms/commons/commands", async route => {
    const response = await route.fetch();
    committed = true;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/rooms\/commons$/, async route => {
    if (!committed || allowSnapshot || route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "Snapshot temporarily unavailable" } })
    });
  });
  await page.evaluate(() => {
    window.delayedSelfAnnouncements = [];
    const node = document.querySelector("#conversation-announcement");
    new MutationObserver(() => window.delayedSelfAnnouncements.push(node.textContent))
      .observe(node, { childList: true, characterData: true, subtree: true });
  });

  const body = "Committed locally before its snapshot";
  await page.locator("#message-input").fill(body);
  await page.locator('#message-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Message saved to the room.");
  assert.equal(store.snapshot(owner, "commons").state.messages.filter(message => message.body === body).length, 1);
  allowSnapshot = true;
  await page.locator("#refresh-button").click();
  await page.locator('[data-message-record-id] p').filter({ hasText: body }).waitFor();
  assert.equal(await page.evaluate(() => window.delayedSelfAnnouncements.some(text => /new message/.test(text))), false);
  assert.equal(await page.locator("#conversation-announcement").textContent(), "");
});

test("a held return-brief acknowledgement survives close and reopen without a competing horizon", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  let briefRequests = 0;
  await page.route(/\/api\/rooms\/commons\/return-brief(?:\?|$)/, async route => {
    briefRequests++;
    await route.continue();
  });
  await login(page, origin, owner, "Room owner");
  await openReadyBrief(page);
  await page.waitForTimeout(100); // allow the toggle-triggered refresh to settle
  const before = briefRequests;
  const horizon = Number(await page.locator("#rb-ack-button").getAttribute("data-horizon"));
  const captured = deferred(), release = deferred();
  t.after(() => release.resolve());
  await page.route("**/api/rooms/commons/cursor", async route => {
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await route.fulfill({ response });
  });

  await page.locator("#rb-ack-button").click();
  await captured.promise;
  const summary = page.locator("#return-brief-panel > summary");
  await summary.click();
  await summary.click();
  await page.waitForTimeout(75);
  assert.equal(briefRequests, before, "reopening cannot supersede an acknowledgement in flight");
  release.resolve();
  await page.waitForFunction(() => document.querySelector("#rb-ack-button")?.textContent === "Already caught up");
  assert.equal(store.snapshot(owner, "commons").cursor, horizon);
  assert.ok(briefRequests > before, "the committed marker is reconciled through one fresh brief");
});

test("the sole caught-up control refreshes an open brief but preserves arrivals beyond its horizon", { timeout: 90000 }, async t => {
  const { browser, origin, owner, send, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  let briefRequests = 0;
  await page.route(/\/api\/rooms\/commons\/return-brief(?:\?|$)/, async route => {
    briefRequests++;
    await route.continue();
  });
  await login(page, origin, owner, "Room owner");
  await openReadyBrief(page);
  const before = briefRequests;
  const horizon = Number(await page.locator("#rb-ack-button").getAttribute("data-horizon"));
  send(owner, T.MESSAGE_POSTED, { messageId: "late-before-generic-ack", body: "Arrived while the brief stayed open" });
  await page.locator('[data-message-record-id="late-before-generic-ack"]').getByText("Arrived while the brief stayed open", { exact: true }).waitFor();
  const sequence = store.snapshot(owner, "commons").sequence;

  assert.equal(await page.locator("#caught-up-button").count(), 0, "there is no second acknowledgement with different semantics");
  await page.locator("#rb-ack-button").click();
  await page.waitForFunction(value => document.querySelector("#rb-ack-button")?.dataset.horizon === String(value)
    && !document.querySelector("#rb-ack-button").disabled, sequence);
  assert.equal(store.snapshot(owner, "commons").cursor, horizon);
  assert.equal(sequence, horizon + 1);
  assert.match(await page.locator("#rb-history-boundary").textContent(), /1 of 1 events/);
  assert.match(await page.locator("#rb-history-list").textContent(), /Arrived while the brief stayed open/);
  assert.ok(briefRequests > before, "the one control reloads the cached brief after committing exactly H");
});

test("a committed caught-up marker is not reported as failed when reconciliation is unavailable", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  await openReadyBrief(page);
  let failSnapshot = false;
  await page.route("**/api/rooms/commons/cursor", async route => {
    const response = await route.fetch();
    failSnapshot = true;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/rooms\/commons$/, async route => {
    if (!failSnapshot || route.request().method() !== "GET") { await route.continue(); return; }
    failSnapshot = false;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "Reconciliation unavailable" } })
    });
  });
  const sequence = store.snapshot(owner, "commons").sequence;

  await page.locator("#rb-ack-button").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("position was saved"));
  assert.equal(store.snapshot(owner, "commons").cursor, sequence);
  assert.equal(await page.locator("#rb-ack-button").isDisabled(), true);
  assert.equal(await page.locator("#rb-ack-button").textContent(), "Refresh brief before acknowledging");
  const status = await page.locator("#status").textContent();
  assert.match(status, /was saved.*could not be refreshed/);
  assert.doesNotMatch(status, /position (?:failed|was not saved)/i);
});

test("a committed brief acknowledgement invalidates its old horizon when the brief reload fails", { timeout: 90000 }, async t => {
  const { browser, origin, owner, store } = await startRoom(t);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  await openReadyBrief(page);
  const horizon = Number(await page.locator("#rb-ack-button").getAttribute("data-horizon"));
  let failBrief = false;
  await page.route("**/api/rooms/commons/cursor", async route => {
    const response = await route.fetch();
    failBrief = true;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/rooms\/commons\/return-brief(?:\?|$)/, async route => {
    if (!failBrief) { await route.continue(); return; }
    failBrief = false;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "Brief reload unavailable" } })
    });
  });

  await page.locator("#rb-ack-button").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("position was saved"));
  assert.equal(store.snapshot(owner, "commons").cursor, horizon);
  assert.equal(await page.locator("#rb-history-list").textContent(), "");
  assert.equal(await page.locator("#rb-ack-button").isDisabled(), true);
  assert.equal(await page.locator("#rb-ack-button").textContent(), "Refresh brief before acknowledging");
});

test("record identities and fragments remain collision-safe and legacy work links still resolve", { timeout: 90000 }, async t => {
  const seed = initialRoom();
  seed.push(event({
    id: "status", idempotencyKey: "seed-member-stack", roomId: "commons", actorId: "owner", type: T.MEMBER_ADDED,
    data: { memberId: "stack", displayName: "Stack", kind: "human", permissions: [] }
  }));
  for (const memberId of ["duplicate-a", "duplicate-b"]) {
    seed.push(event({
      id: `member-${memberId}`, idempotencyKey: `seed-member-${memberId}`, roomId: "commons", actorId: "owner", type: T.MEMBER_ADDED,
      data: { memberId, displayName: "Alex", kind: "human", permissions: ["accept_work", "complete_work", "verify"] }
    }));
  }
  seed.push(event({
    id: "list", idempotencyKey: "seed-message-list", roomId: "commons", actorId: "owner", type: T.MESSAGE_POSTED,
    data: { messageId: "list", body: "Message whose id collides with the static list id" }
  }));
  for (const [memberId, messageId, body] of [
    ["duplicate-a", "duplicate-a-message", "First Alex identity message"],
    ["duplicate-b", "duplicate-b-message", "Second Alex identity message"]
  ]) {
    seed.push(event({
      id: `event-${messageId}`, idempotencyKey: `seed-${messageId}`, roomId: "commons", actorId: memberId, type: T.MESSAGE_POSTED,
      data: { messageId, body }
    }));
    seed.push(event({
      id: `reaction-${memberId}`, idempotencyKey: `seed-reaction-${memberId}`, roomId: "commons", actorId: memberId, type: T.MESSAGE_REACTION_SET,
      data: { messageId: "list", reaction: "heart", active: true }
    }));
  }
  seed.push(event({
    id: "message-colon", idempotencyKey: "seed-message-colon", roomId: "commons", actorId: "owner", type: T.MESSAGE_POSTED,
    data: { messageId: "msg:colon", body: "Message with a colon id" }
  }));
  for (const [workItemId, sourceMessageId] of [["title", "msg:colon"], ["list", null], ["work-legacy", null], ["room-title", null]]) {
    seed.push(event({
      id: `work-event-${workItemId}`, idempotencyKey: `seed-work-${workItemId}`, roomId: "commons", actorId: "owner", type: T.WORK_PROPOSED,
      data: {
        workItemId,
        title: `Collision work ${workItemId}`,
        definitionOfDone: "The exact record remains addressable",
        accountableMemberId: "owner",
        ...(sourceMessageId ? { sourceMessageId } : {})
      }
    }));
  }
  seed.push(event({
    id: "work-event-duplicate-members", idempotencyKey: "seed-work-duplicate-members", roomId: "commons", actorId: "owner", type: T.WORK_PROPOSED,
    data: {
      workItemId: "duplicate-members", title: "Duplicate-name assignment", definitionOfDone: "Both stable identities stay visible",
      accountableMemberId: "duplicate-a", verifierMemberId: "duplicate-b", independentVerificationRequired: true
    }
  }));
  const { browser, origin, owner, duplicateA } = await startRoom(t, {
    events: seed,
    prepare({ store }) { return { duplicateA: store.issueAccessKey("commons", "duplicate-a") }; }
  });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" })).newPage();
  await login(page, origin, owner, "Room owner");
  await page.locator('[data-work-record-id="work-legacy"]').waitFor();

  const duplicates = await page.evaluate(() => {
    const counts = new Map();
    document.querySelectorAll("[id]").forEach(node => counts.set(node.id, (counts.get(node.id) || 0) + 1));
    return [...counts].filter(([, count]) => count > 1);
  });
  assert.deepEqual(duplicates, [], "user IDs never duplicate structural DOM IDs");
  for (const [selector, pattern] of [
    ['[data-message-record-id="list"]', /^pr-message-record-/],
    ['[data-work-record-id="title"]', /^pr-work-record-/],
    ['[data-work-record-id="list"]', /^pr-work-record-/],
    ['[data-member-record-id="stack"]', /^pr-member-record-/],
    ['[data-event-record-id="status"]', /^pr-event-record-/]
  ]) assert.match(await page.locator(selector).getAttribute("id"), pattern);

  for (const selector of ["#message-to-select", "#assignee-select", "#verifier-select"]) {
    const choices = await page.locator(`${selector} option`).allTextContents();
    assert.ok(choices.includes("Alex (duplicate-a) · Person"));
    assert.ok(choices.includes("Alex (duplicate-b) · Person"));
  }
  const duplicateWork = await page.locator('[data-work-record-id="duplicate-members"]').textContent();
  assert.match(duplicateWork, /AccountableAlex \(duplicate-a\)/);
  assert.match(duplicateWork, /VerifierAlex \(duplicate-b\)/);
  assert.match(await page.locator('[data-member-record-id="duplicate-a"]').textContent(), /Alex \(duplicate-a\)/);
  assert.match(await page.locator('[data-member-record-id="duplicate-b"]').textContent(), /Alex \(duplicate-b\)/);
  assert.match(await page.locator('[data-message-record-id="duplicate-a-message"] .message-meta').textContent(), /Alex \(duplicate-a\)/);
  assert.match(await page.locator('[data-message-record-id="duplicate-b-message"] .message-meta').textContent(), /Alex \(duplicate-b\)/);
  assert.match(await page.locator('[data-message-record-id="list"] [data-reaction="heart"]').getAttribute("title"), /Alex \(duplicate-a\).*Alex \(duplicate-b\)/);
  assert.match(await page.locator('[data-event-record-id="event-duplicate-a-message"]').textContent(), /Alex \(duplicate-a\)/);
  await page.locator("#message-search").fill("First Alex identity message");
  assert.match(await page.locator("#search-list").textContent(), /Alex \(duplicate-a\)/);
  await page.locator("#clear-search").click();
  await page.locator('[data-message-record-id="duplicate-a-message"] [data-message-action="reply"]').click();
  assert.match(await page.locator("#reply-context").textContent(), /Alex \(duplicate-a\)/);
  await page.locator("#thread-back").click();

  const colonLink = page.locator('[data-message-record-id="msg:colon"] .message-time');
  assert.equal(await colonLink.getAttribute("href"), "#pr-record/message/msg%3Acolon");
  await colonLink.click();
  await page.waitForFunction(() => document.activeElement?.dataset.messageRecordId === "msg:colon");
  assert.equal(await page.evaluate(() => location.hash), "#pr-record/message/msg%3Acolon");

  const linkedWork = page.locator('[data-message-record-id="msg:colon"] [data-open-work="title"]');
  assert.equal(await linkedWork.getAttribute("href"), "#pr-record/work/title");
  await linkedWork.click();
  await page.waitForFunction(() => document.activeElement?.dataset.workRecordId === "title");
  assert.equal(await page.evaluate(() => location.hash), "#pr-record/work/title");

  await page.goto(`${origin}/#pr-record/message/msg%3Acolon`);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.dataset.messageRecordId === "msg:colon");
  await page.evaluate(() => { location.hash = "#pr-record/member/stack"; });
  await page.waitForFunction(() => document.activeElement?.dataset.memberRecordId === "stack");
  await page.evaluate(() => { location.hash = "#pr-record/event/status"; });
  await page.waitForFunction(() => document.activeElement?.dataset.eventRecordId === "status");

  // Baseline versions emitted un-namespaced work hashes equal to the work id.
  // `#work-legacy` must therefore resolve the full id when no stripped `legacy` item exists.
  await page.evaluate(() => { location.hash = "#work-legacy"; });
  await page.waitForFunction(() => document.activeElement?.dataset.workRecordId === "work-legacy");

  // Even the old room anchor is a valid historical work id. Raw work lookup wins,
  // while newly emitted room links use the collision-free application namespace.
  await page.evaluate(() => { location.hash = "#room-title"; });
  await page.waitForFunction(() => document.activeElement?.dataset.workRecordId === "room-title");
  if (!await page.locator("#return-brief-panel").evaluate(node => node.open)) {
    await page.locator("#return-brief-panel > summary").click();
  }
  const roomLink = page.locator("#rb-history-list [data-open-room]").first();
  await page.locator("#rb-history-section > summary").click();
  await roomLink.waitFor();
  assert.equal(await roomLink.getAttribute("href"), "#pr-record/room/commons");
  await roomLink.click();
  await page.waitForFunction(() => document.activeElement?.id === "room-title");
  assert.equal(await page.evaluate(() => location.hash), "#pr-record/room/commons");

  await page.locator("#signout-button").click();
  await enterRoom(page, duplicateA, "Alex (duplicate-a)");
  assert.equal(await page.locator("#identity-label").textContent(), "Alex (duplicate-a)");
  assert.equal(await page.locator("#identity-label").getAttribute("title"), "Alex (duplicate-a) · Person");
});
