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
  if (!await panel.evaluate(element => element.open)) await panel.locator(":scope > summary").click();
  await page.waitForFunction(() => {
    const button = document.querySelector("#rb-ack-button");
    return button && !button.disabled && /through event \d+/.test(button.textContent);
  });
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

  const ownerHorizon = Number((await page.locator("#rb-ack-button").textContent()).match(/event (\d+)/)?.[1]);
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
  await ownerTab.locator("#return-brief-panel > summary").click();
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
  const horizon = Number((await page.locator("#rb-ack-button").textContent()).match(/event (\d+)/)?.[1]);
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

test("room-level Caught up refreshes an already-open return brief", { timeout: 90000 }, async t => {
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
  send(owner, T.MESSAGE_POSTED, { messageId: "late-before-generic-ack", body: "Arrived while the brief stayed open" });
  await page.locator('[data-message-record-id="late-before-generic-ack"]').getByText("Arrived while the brief stayed open", { exact: true }).waitFor();
  const sequence = store.snapshot(owner, "commons").sequence;

  await page.locator("#caught-up-button").click();
  await page.waitForFunction(() => document.querySelector("#rb-ack-button")?.textContent === "Already caught up");
  assert.equal(store.snapshot(owner, "commons").cursor, sequence);
  assert.match(await page.locator("#rb-history-boundary").textContent(), /nothing new since your marker/);
  assert.ok(briefRequests > before, "the generic control reloads the cached brief after committing");
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

  await page.locator("#caught-up-button").click();
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
  const horizon = Number((await page.locator("#rb-ack-button").textContent()).match(/event (\d+)/)?.[1]);
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
    assert.ok(choices.includes("Alex (duplicate-a) · human"));
    assert.ok(choices.includes("Alex (duplicate-b) · human"));
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
  await page.locator("#return-brief-panel > summary").click();
  const roomLink = page.locator("#rb-history-list [data-open-room]").first();
  await roomLink.waitFor();
  assert.equal(await roomLink.getAttribute("href"), "#pr-record/room/commons");
  await roomLink.click();
  await page.waitForFunction(() => document.activeElement?.id === "room-title");
  assert.equal(await page.evaluate(() => location.hash), "#pr-record/room/commons");

  await page.locator("#signout-button").click();
  await enterRoom(page, duplicateA, "Alex (duplicate-a)");
  assert.equal(await page.locator("#identity-label").textContent(), "Alex (duplicate-a) · human");
});
