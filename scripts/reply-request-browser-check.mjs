import { openComposerOptions, openConversation } from "./room-chrome.mjs";
// Synthetic human journeys against a disposable real service, not participant research.
import { revealRecord } from "./reveal-record.mjs";
import { join } from "node:path";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { hostReplyBody } from "../client/host-result.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { workThreadHref } from "../src/workflow.js";
import { exactResultHref } from "../src/record-link.js";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t, viewport = { width: 1280, height: 900 }) {
  const fixture = createAcceptanceFixture({ dmConsent: true }), errors = [];
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  async function login(who, { roomId = null, key = fixture.keys[who] } = {}) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
    const destination = new URL(`http://127.0.0.1:${server.address().port}`);
    if (roomId) destination.searchParams.set("room", roomId);
    await page.goto(destination.href);
    await signInFixture(page, key);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  }
  const send = (who, type, data) => fixture.store.command(fixture.keys[who], "commons", { id: crypto.randomUUID(), type, data });
  const request = (id, toMemberId = "guest") => send("owner", "message.posted", { messageId: id, body: `Question ${id}?`, toMemberId, requestKind: "reply" });
  return { ...fixture, origin: `http://127.0.0.1:${server.address().port}`, login, errors, send, request, state: () => fixture.store.room("commons").state };
}
const record = revealRecord;
const input = page => page.locator("#message-input");
const idle = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled);
const failed = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
const saved = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#request-mode-bar").hidden);
async function mode(page, id, kind) {
  await (await record(page, id)).locator(`[data-message-action="request-${kind}"]`).click();
  await page.waitForFunction(() => !document.querySelector("#request-mode-bar").hidden && !document.querySelector("#message-input").disabled);
  assert.equal(await page.locator("#composer-status").textContent(), "");
}

for (const width of [1280, 390, 320]) test(`request journey at ${width}px: request, clarify and answer stay in chat without closing work`, { timeout: 60000 }, async t => {
  const f = await setup(t, { width, height: 900 }), owner = await f.login("owner"), guest = await f.login("guest");
  await openConversation(owner);
  await openConversation(guest);
  const before = structuredClone(f.state().workItems);
  await input(owner).fill("Keep my ordinary draft");
  await openComposerOptions(owner); await owner.locator("#request-reply").click();
  await input(owner).fill("Which agenda should we use?");
  await owner.locator("#message-to-select").selectOption("guest");
  await input(owner).press("Enter"); await saved(owner);
  assert.equal(await input(owner).inputValue(), "Keep my ordinary draft");
  const id = Object.keys(f.state().replyRequests)[0];
  assert.equal(f.state().replyRequests[id].recipientId, "guest");
  const clarify = (await record(guest, id)).getByRole("button", { name: "Clarify", exact: true });
  assert.equal(await clarify.getAttribute("title"), "Reply without closing this request");
  assert.equal(await (await record(owner, id)).getByRole("button", { name: "Reply", exact: true }).count(), 1);
  await clarify.focus(); await guest.keyboard.press("Enter");
  await input(guest).fill("Should it include the review?"); await input(guest).press("Enter");
  await guest.waitForFunction(() => !document.querySelector("#message-input").disabled && !document.querySelector("#message-input").value);
  assert.equal(f.state().replyRequests[id].status, "open");
  const clarification = f.state().messages.find(message => message.body === "Should it include the review?");
  assert.equal(await (await record(guest, clarification.id)).getByRole("button", { name: "Reply", exact: true }).count(), 1);
  await (await record(guest, id)).getByRole("button", { name: "Answer request", exact: true }).click();
  await guest.getByRole("button", { name: "Send answer", exact: true }).waitFor();
  await idle(guest);
  assert.equal(await guest.locator("#request-refresh").isVisible(), false, "unchanged context needs no refresh control");
  assert.equal(await guest.locator("#ask-room").isVisible(), false, "private request mode does not offer a public assistant action");
  if (width <= 390) {
    const geometry = await guest.evaluate(() => {
      const bar = document.querySelector('#request-mode-bar').getBoundingClientRect();
      const exit = document.querySelector('#request-exit').getBoundingClientRect();
      const assistant = document.querySelector('#room-assistant').getBoundingClientRect();
      return { barHeight: bar.height, exitHeight: exit.height, assistantHeight: assistant.height, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.ok(geometry.barHeight < 100, JSON.stringify(geometry));
    assert.ok(geometry.exitHeight >= 44, "request exit keeps a touch-sized target");
    assert.ok(geometry.assistantHeight <= 48, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false);
  }
  await input(guest).fill("Use the short agenda, including the review.");
  await guest.screenshot({ path: `test-results/request-answer-${width}.png`, fullPage: true });
  await input(guest).press("Shift+Enter");
  assert.match(await input(guest).inputValue(), /\n$/);
  await input(guest).press("Enter"); await saved(guest);
  // #4260 (7e6f5f96c) removed the separate assistant action; collaboration uses visible mentions and ordinary replies.
  assert.equal(await guest.locator("#ask-room").count(), 0, "no separate assistant action returns after the answer");
  assert.equal(f.state().replyRequests[id].status, "answered");
  assert.deepEqual(f.state().workItems, before);
  await (await record(owner, id)).locator(".request-state").filter({ hasText: "Answered" }).waitFor();
  assert.deepEqual(f.errors, []);
});

test("stale answer keeps text, explicit refresh updates context, decline and cancellation are distinct", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 });
  f.request("first"); f.request("second"); f.request("third");
  const guest = await f.login("guest"), owner = await f.login("owner");
  await mode(guest, "first", "answered"); await input(guest).fill("A considered answer");
  f.send("owner", "message.posted", { messageId: "new-context", body: "Also consider the new deadline.", replyToId: "first" });
  await guest.waitForFunction(() => document.querySelector("#request-mode-label").textContent.includes("Context changed"));
  await input(guest).press("Enter"); await failed(guest);
  assert.equal(await input(guest).inputValue(), "A considered answer");
  assert.equal(await input(guest).evaluate(el => el.readOnly), false);
  await guest.locator("#request-refresh").click(); await idle(guest);
  assert.equal(await input(guest).inputValue(), "A considered answer");
  await input(guest).press("Enter"); await saved(guest);
  assert.equal(f.state().replyRequests.first.status, "answered");
  await guest.locator("#thread-back").click();
  await mode(guest, "second", "declined"); await input(guest).fill("I do not have the relevant context.");
  await guest.screenshot({ path: "test-results/request-decline-mobile.png", fullPage: true });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await guest.locator('#message-form button[type="submit"]').click(); await saved(guest);
  assert.equal(f.state().replyRequests.second.status, "declined");
  await mode(owner, "third", "cancelled"); await input(owner).fill("No longer needed.");
  await owner.locator('#message-form button[type="submit"]').click(); await saved(owner);
  assert.equal(f.state().replyRequests.third.status, "cancelled");
  assert.equal(f.state().replyRequests.third.reason, "No longer needed.");
  assert.equal(f.state().messages.some(message => message.body === "No longer needed."), false);
  assert.deepEqual(f.errors, []);
});

test("lost committed answer remains exact and read-only across reload, then retries once", { timeout: 60000 }, async t => {
  const f = await setup(t); f.request("retry");
  const page = await f.login("guest");
  await mode(page, "retry", "answered"); await input(page).fill("One answer only.");
  const commands = []; let lose = true;
  await page.route("**/api/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await input(page).press("Enter"); await failed(page);
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  assert.equal(await page.locator("#request-refresh").isVisible(), false);
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await page.locator("#main").waitFor({ state: "visible" }); await idle(page);
  assert.equal(await input(page).inputValue(), "One answer only.");
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  await page.getByRole("button", { name: "Retry original", exact: true }).click(); await saved(page);
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
  assert.equal(f.state().messages.filter(message => message.body === "One answer only.").length, 1);
  assert.deepEqual(f.errors, []);
});

test("unconfirmed receipt locks the exact request; ordinary drafts remain separate", { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("owner");
  await openConversation(page);
  await input(page).fill("Ordinary draft"); await openComposerOptions(page); await page.locator("#request-reply").click();
  await input(page).fill("An explicit question"); await page.locator("#message-to-select").selectOption("guest");
  let alter = true; const commands = [];
  await page.route("**/api/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    if (alter) {
      alter = false; const response = await route.fetch(), receipt = await response.json();
      receipt.event.data.body = "A different answer";
      await route.fulfill({ response, json: receipt });
    } else await route.continue();
  });
  await input(page).press("Enter"); await failed(page);
  assert.match(await page.locator("#composer-status").textContent(), /Save not confirmed/);
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  await page.locator("#request-exit").click(); assert.equal(await input(page).inputValue(), "Ordinary draft");
  await openComposerOptions(page); await page.locator("#request-reply").click();
  assert.equal(await input(page).inputValue(), "An explicit question");
  await page.getByRole("button", { name: "Retry original", exact: true }).click(); await saved(page);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(Object.keys(f.state().replyRequests).length, 1);
  assert.equal(await input(page).inputValue(), "Ordinary draft"); assert.deepEqual(f.errors, []);
});


test("original conversation shows host progress and recovery without changing the request", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 }), requestMessageId = "host-visible";
  f.request(requestMessageId, "producer");
  const request = f.state().replyRequests[requestMessageId];
  const input = { requestMessageId, attemptId: "visible-host", action: "claim",
    expectedRequestRevision: request.revision, contextEventId: request.contextEventId };
  f.store.requestRuns.apply(f.keys.producer, "commons", input);
  f.send("producer", "reply_request.progressed", { requestMessageId, expectedRequestRevision: request.revision, progress: "acknowledged" });
  const owner = await f.login("owner"), row = (await record(owner, requestMessageId));
  const status = row.locator("[data-request-run]");
  const shots = process.env.ROOM_REQUEST_STATUS_CAPTURE;
  await owner.waitForFunction(id => Boolean(document.querySelector(`[data-request-run="${id}"]`)?.textContent), requestMessageId);
  if (shots) await row.screenshot({ path: join(shots, "reserved.png") });
  assert.equal(await status.textContent(), "Attempt reserved");
  f.send("producer", "reply_request.progressed", { requestMessageId, expectedRequestRevision: request.revision, progress: "working" });
  await row.getByText("Start previously reported", { exact: true }).waitFor();
  if (shots) await row.screenshot({ path: join(shots, "reported.png") });
  assert.equal(f.state().replyRequests[requestMessageId].revision, request.revision);
  const clarification = f.send("owner", "message.posted", { messageId: "host-visible-clarification",
    replyToId: requestMessageId, toMemberId: "producer", body: "Please include the date in the release note." });
  await (await record(owner, "host-visible-clarification")).waitFor();
  assert.equal(await status.textContent(), "Start previously reported");
  assert.equal(f.state().replyRequests[requestMessageId].contextEventId, clarification.event.id);
  f.store.requestRuns.apply(f.keys.producer, "commons", { ...input, action: "needs_attention" });
  // The operational poll does not require a new room event or a page reload.
  await owner.waitForFunction(id => document.querySelector(`[data-request-run="${id}"]`)?.textContent.includes("Host needs attention"), requestMessageId, { timeout: 15000 });
  assert.equal(await row.locator('[data-message-action="request-cancelled"]').count(), 1);
  f.send("producer", "message.posted", {
    messageId: "host-visible-answer", replyToId: requestMessageId, responseToRequestId: requestMessageId,
    toMemberId: "owner", body: "The release note is ready for review.", responseOutcome: "answered",
    expectedRequestRevision: request.revision, contextEventId: clarification.event.id,
    contextSequence: clarification.sequence, workItemId: null,
  });
  await row.getByText("Answered", { exact: true }).waitFor();
  assert.equal(await status.textContent(), "");
  assert.deepEqual(f.errors, []);
});

test("current room shows a durable start report without polling host attempts", { timeout: 30000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 });
  const roomId = "normalized-request-status", worker = "reviewer";
  const colleague = event({ roomId, actorId: "owner", type: "member.added",
    data: { memberId: "colleague", displayName: "Colleague", kind: "human", permissions: [] } });
  const member = event({ roomId, actorId: "owner", type: "member.added",
    data: { memberId: worker, displayName: "Reviewer", kind: "agent", permissions: [], accountableHumanId: "colleague" } });
  f.store.initialize([...initialRoom(roomId), colleague, member], { representation: "normalized-current-v1" });
  const ownerKey = f.store.issueAccessKey(roomId, "owner"), agentKey = f.store.issueAccessKey(roomId, worker);
  const colleagueKey = f.store.issueAccessKey(roomId, "colleague");
  f.store.command(ownerKey, roomId, { id: "document-ask", type: "message.posted",
    data: { messageId: "document-ask", body: "Check the release notes.", toMemberId: worker, requestKind: "reply" } });
  const owner = await f.login("owner", { roomId, key: ownerKey });
  const row = await record(owner, "document-ask");
  await row.getByText("Execution status unavailable", { exact: true }).waitFor();
  f.store.command(agentKey, roomId, { id: "document-start", type: "reply_request.progressed",
    data: { requestMessageId: "document-ask", expectedRequestRevision: 0, progress: "working" } });
  await row.getByText("Start previously reported", { exact: true }).waitFor();
  assert.equal(await row.getByText("Answered", { exact: true }).count(), 0);
  const colleaguePage = await f.login("colleague", { roomId, key: colleagueKey });
  assert.throws(() => f.store.replyRequests.selected(colleagueKey, roomId, "document-ask"),
    { code: "reply_request_not_found" }, "owning the recipient does not make the human a request party");
  assert.equal(await colleaguePage.locator('[data-message-record-id="document-ask"]').count(), 0);
  assert.equal(await colleaguePage.locator('[data-request-run="document-ask"]').count(), 0);
  assert.deepEqual(f.errors, []);
});


for (const representation of [null, "normalized-current-v1"]) {
  test(`shared private work link keeps the recipient’s access and status on ${representation ?? "legacy"}`, { timeout: 30000 }, async t => {
    const f = await setup(t, { width: 390, height: 844 });
    const roomId = "handoff-room", workItemId = "document-handoff";
    const participant = (memberId, kind, permissions = [], accountableHumanId) => event({
      roomId, actorId: "owner", type: "member.added", data: { memberId, displayName: memberId, kind, permissions,
        ...(accountableHumanId ? { accountableHumanId } : {}) },
    });
    f.store.initialize([...initialRoom(roomId), participant("colleague", "human"), participant("reader", "human", ["verify"]),
      participant("writer", "agent", ["accept_work", "complete_work"], "colleague")], { representation });
    const keys = Object.fromEntries(["owner", "colleague", "reader", "writer"].map(member => [member, f.store.issueAccessKey(roomId, member)]));
    const command = (actor, type, data) => f.store.command(keys[actor], roomId, { id: crypto.randomUUID(), type, data });
    command("owner", "message.posted", { messageId: "private-brief", body: "Private source marker", toMemberId: "writer" });
    command("owner", "work.proposed", { workItemId, title: "Check the release note", definitionOfDone: "Confirm the date", mode: "read",
      sourceMessageId: "private-brief", accountableMemberId: "writer", verifierMemberId: "reader", independentVerificationRequired: true });
    command("owner", "message.posted", { messageId: "agent-only-ask", body: "Private request marker", toMemberId: "writer", workItemId, requestKind: "reply" });
    const openLink = async who => {
      const page = await f.login(who, { roomId, key: keys[who] });
      const target = new URL(page.url());
      target.hash = workThreadHref(workItemId);
      await page.goto(target.href);
      return page;
    };
    const outsider = await openLink("colleague"), notice = outsider.locator("#status[role=alert]");
    await notice.waitFor();
    const shots = process.env.ROOM_WORK_LINK_CAPTURE;
    if (shots) await outsider.screenshot({ path: join(shots, `${representation ?? "legacy"}-denied.png`) });
    assert.equal(await notice.locator(".status-text").textContent(), "Work unavailable. Ask the sender for a reference you can open.");
    assert.equal(await outsider.locator(`[data-work-record-id="${workItemId}"]`).count(), 0);
    assert.throws(() => f.store.workContext(keys.colleague, roomId, workItemId), { code: "work_private" });

    const reviewer = await openLink("reader"), card = reviewer.locator(`[data-work-record-id="${workItemId}"]`);
    await card.locator(".state").getByText("Awaiting acceptance", { exact: true }).waitFor();
    const sourceHint = card.getByText(/Source unavailable\. Ask the teammate/);
    if (shots) await reviewer.screenshot({ path: join(shots, `${representation ?? "legacy"}-source.png`) });
    await sourceHint.waitFor();
    assert.equal(await card.getByRole("link", { name: "From this conversation" }).count(), 0);
    assert.doesNotMatch(await card.innerText(), /Private source marker|Private request marker/);
    assert.throws(() => f.store.replyRequests.selected(keys.reader, roomId, "agent-only-ask"), { code: "reply_request_not_found" });
    let now = Date.now();
    f.store.now = () => now;
    const newerMessages = representation ? 12 : 102;
    for (let i = 0; i < newerMessages; i++) {
      now += 2100;
      command("owner", "message.posted", { messageId: `newer-${i}`, body: `Later update ${i}` });
    }
    const owner = await openLink("owner"), ownerCard = owner.locator(`[data-work-record-id="${workItemId}"]`);
    const snapshot = await owner.context().request.get(`${f.origin}/api/rooms/${roomId}?messages=recent`);
    assert.equal(snapshot.status(), 200);
    assert.equal((await snapshot.json()).state.messages.some(message => message.id === "private-brief"), false);
    const openSource = ownerCard.getByRole("link", { name: "From this conversation", exact: true });
    assert.equal(f.store.workContext(keys.owner, roomId, workItemId).accessSummary.conversation.sourceAvailability, "available");
    await openSource.press("Enter");
    await owner.locator('[data-message-record-id="private-brief"]').getByText("Private source marker", { exact: true }).waitFor();
    await owner.locator("#work-navigation-return").press("Enter");
    await openSource.waitFor();
    now += 2100;
    command("owner", "message.deleted", { messageId: "private-brief", expectedMessageRevision: 0 });
    await ownerCard.getByText(/Source unavailable\. Ask the teammate/).waitFor();
    assert.equal(await openSource.count(), 0);

    const transition = (type, data = {}) => command("writer", type, { workItemId,
      expectedRevision: f.store.workContext(keys.writer, roomId, workItemId).work.revision, ...data });
    transition("work.accepted");
    await card.locator(".state").getByText("Accepted", { exact: true }).waitFor();
    transition("work.started");
    await card.locator(".state").getByText("Working · reported", { exact: true }).waitFor();
    const body = "Private final document marker";
    const post = command("writer", "message.posted", { messageId: "private-result", workItemId, body, toMemberId: "owner" });
    const completion = transition("work.completed", { summary: "Date confirmed", nextAction: "Review the saved note", producerId: "writer",
      evidenceKind: "room_text", evidenceMessageId: "private-result", evidenceMessageEventId: post.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: null });
    await card.locator(".state").getByText("Awaiting verification", { exact: true }).waitFor();
    assert.doesNotMatch(await card.innerText(), /Private final document marker/);
    if (shots) await reviewer.screenshot({ path: join(shots, `${representation ?? "legacy"}-review.png`) });
    const exactResult = exactResultHref({ roomId, workItemId, completionEventId: completion.event.id }, new URL(reviewer.url()));
    const deniedResult = reviewer.waitForResponse(response => new URL(response.url()).pathname.endsWith("/work-result"));
    await reviewer.goto(exactResult);
    const response = await deniedResult;
    assert.equal(response.status(), 422);
    assert.equal((await response.json()).error.code, "result_unavailable");
    await reviewer.getByText("Ask the sender to share the intended result version somewhere you can read it.", { exact: true }).waitFor();
    assert.equal(await reviewer.locator("#result-body").textContent(), "");

    assert.deepEqual(f.errors, []);
  });
}

for (const width of [1280, 390]) test(`coding result stays readable and escaped at ${width}px`, { timeout: 60000 }, async t => {
  const f = await setup(t, { width, height: 900 });
  f.request("inspect-code", "producer");
  const body = hostReplyBody({ body: "Fixed the parser.", codeResult: {
    repositoryUrl: "https://example.com/repo", baseRevision: "a".repeat(40),
    patch: "diff --git a/parser.js b/parser.js\n--- a/parser.js\n+++ b/parser.js\n@@ -1 +1 @@\n-before\n+<img src=x onerror=alert(1)>\n",
    files: ["parser.js"], checks: [{ command: "node --test", outcome: "passed" }]
  } });
  f.send("producer", "message.posted", { messageId: "inspect-result", replyToId: "inspect-code", toMemberId: "owner", body });
  const owner = await f.login("owner");
  await (await record(owner, "inspect-code")).locator('[data-message-action="reply"]').click();
  const content = (await record(owner, "inspect-result")).locator(".message-body");
  await content.waitFor();
  await content.locator('.message-expansion > summary').click();
  await content.locator('.message-full').waitFor({ state: 'visible' });
  assert.equal(await content.locator('.message-full').textContent(), body, "expanded code result preserves exact original bytes");
  assert.match(await (await record(owner, "inspect-result")).locator(".audience-chip").textContent(), /private/);
  assert.equal(await content.locator("img").count(), 0);
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.errors, []);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`follow-up preserves drafts and retries one new request at ${viewport.width}px`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), first = f.request("follow-original");
    f.send("guest", "message.posted", { messageId: "follow-answer", body: "The working first version", responseToRequestId: "follow-original",
      expectedRequestRevision: 0, responseOutcome: "answered", contextEventId: first.event.id, contextSequence: first.sequence,
      replyToId: "follow-original", toMemberId: "owner", workItemId: null });
    const page = await f.login("owner");
    await record(page, "follow-original"); // the ordinary draft belongs to the direct conversation
    await input(page).fill("Keep my normal draft");
    await mode(page, "follow-original", "follow-up");
    assert.equal(await page.locator("#message-to-select").inputValue(), "guest");
    assert.equal(await page.locator("#message-to-select").isDisabled(), true);
    assert.match(await page.locator("#request-mode-label").textContent(), /Earlier exchange included/);
    assert.match(await page.locator("#thread-context").textContent(), /includes private messages/);
    assert.equal(await page.locator("#composer-options").evaluate(node => node.open), false, "secondary composer options start closed");
    assert.doesNotMatch(await page.locator("#message-form").innerText(), /Visible to everyone here/);
    assert.equal(await (await record(page, "follow-answer")).locator('[data-message-action="request-follow-up"]').evaluate(el => getComputedStyle(el).opacity), "1");
    await input(page).fill("Add keyboard support");
    await page.screenshot({ path: `test-results/request-follow-up-${viewport.width}.png`, fullPage: true });
    await page.locator("#request-exit").click();
    await mode(page, "follow-answer", "follow-up");
    assert.equal(await input(page).inputValue(), "Add keyboard support");
    const commands = []; let lose = true;
    await page.route("**/api/rooms/commons/commands", async route => {
      commands.push(route.request().postDataJSON());
      if (lose) { lose = false; await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.locator('#message-form button[type="submit"]').click(); await failed(page);
    assert.equal(await input(page).evaluate(el => el.readOnly), true);
    page.once("dialog", dialog => dialog.accept()); await page.reload();
    await page.locator("#main").waitFor({ state: "visible" }); await idle(page);
    assert.equal(await input(page).inputValue(), "Add keyboard support");
    await page.locator('#message-form button[type="submit"]').click(); await saved(page);
    assert.deepEqual(commands[0], commands[1]);
    assert.equal(Object.keys(f.state().replyRequests).length, 2);
    const posted = f.state().messages.find(message => message.body === "Add keyboard support");
    assert.equal(posted.replyToId, "follow-answer"); assert.equal(posted.toMemberId, "guest");
    assert.equal(f.state().replyRequests["follow-original"].status, "answered");
    await page.locator("#thread-back").click();
    assert.equal(await input(page).inputValue(), "Keep my normal draft");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(f.errors, []);
  });
}


test("host answer survives closing the requester and returning in an independent browser session", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 });
  const owner = await f.login("owner");
  await openConversation(owner);
  await openComposerOptions(owner); await owner.locator("#request-reply").click();
  await input(owner).fill("Summarize the local reference task.");
  await owner.locator("#message-to-select").selectOption("producer");
  await input(owner).press("Enter"); await saved(owner);
  const id = Object.keys(f.state().replyRequests)[0];
  assert.ok(id);
  // The real runner, journal and HTTP delivery are exercised. Model/tool output
  // is deterministic here; native broker execution has its own acceptance suite.
  const db = openRequestJournal(join(f.directory, "return-host.sqlite"));
  t.after(() => db.close());
  let executions = 0;
  const args = { connection: { version: 1, origin: f.origin, roomId: "commons", memberId: "producer", token: f.keys.producer },
    requestMessageId: id, db, execute: async prepared => {
      executions++;
      assert.equal(prepared.request.id, id);
      return { body: "Reference task complete. One shared answer survives return." };
    } };
  const result = await runRequestOnce(args);
  assert.equal(result.status, "delivered");
  const answer = f.state().messages.find(message => message.id === f.state().replyRequests[id].responseMessageId);
  assert.ok(answer);
  await (await record(owner, id)).locator('[data-message-action="reply"]').click();
  await (await record(owner, answer.id)).waitFor();
  await owner.context().close();
  const returning = await f.login("owner");
  await (await record(returning, id)).locator('[data-message-action="reply"]').click();
  await (await record(returning, answer.id)).waitFor();
  assert.match(await (await record(returning, answer.id)).textContent(), /One shared answer survives return/);
  assert.equal(f.state().replyRequests[id].status, "answered");
  const retry = await runRequestOnce(args);
  assert.equal(retry.hostExecuted, false);
  assert.equal(executions, 1);
  assert.equal(f.state().messages.filter(message => message.id === answer.id).length, 1);
  assert.deepEqual(f.errors, []);
});

test("restored cancellation draft does not submit by keyboard after another session closes the request", { timeout: 60000 }, async t => {
  const f = await setup(t); f.request("cancel-history");
  const first = await f.login("owner"), second = await f.login("owner");
  await mode(first, "cancel-history", "cancelled");
  await input(first).fill("My unsent cancellation reason");
  await first.goto(`${f.origin}/privacy`);
  await mode(second, "cancel-history", "cancelled");
  await input(second).fill("The winning cancellation reason");
  await input(second).press("Enter"); await saved(second);
  await first.goBack(); await first.locator("#main").waitFor({ state: "visible" });
  await first.goForward(); await first.goBack();
  await first.locator("#main").waitFor({ state: "visible" }); await idle(first);
  await first.waitForFunction(() => document.querySelector('#message-form button[type=submit]').disabled
    && document.querySelector('#request-mode-label').textContent.includes('Context changed'));
  assert.equal(await input(first).inputValue(), "My unsent cancellation reason");
  const commands = [];
  await first.route("**/api/rooms/commons/commands", async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
  await input(first).press("Enter");
  // Allow the event/HTTP path to settle: this must be no command, not a server refusal.
  await first.waitForTimeout(300);
  assert.equal(commands.length, 0, "a disabled terminal cancellation cannot be submitted with Enter");
  assert.equal(await input(first).inputValue(), "My unsent cancellation reason");
  assert.equal(f.state().replyRequests['cancel-history'].reason, "The winning cancellation reason");
  assert.deepEqual(f.errors, []);
});

for (const scenario of ["unsent", "uncertain", "refused"]) test(`current Room handles an ${scenario} assignment reference after reload`, { timeout: 30000 }, async t => {
  const uncertain = scenario === "uncertain";
  const f = await setup(t, { width: 390, height: 844 });
  const roomId = "private-reference-room", workItemId = "private-document-review", sourceMessageId = "private-source-assignment";
  const worker = event({ roomId, actorId: "owner", type: "member.added", data: {
    memberId: "coworker", displayName: "Coworker", kind: "human", permissions: ["accept_work"],
  } });
  f.store.initialize([...initialRoom(roomId), worker], { representation: "normalized-current-v1" });
  const owner = f.store.issueAccessKey(roomId, "owner"), coworker = f.store.issueAccessKey(roomId, "coworker");
  const send = (type, data) => f.store.command(owner, roomId, { id: crypto.randomUUID(), type, data });
  send("message.posted", { messageId: sourceMessageId, body: "Review https://docs.example.test/assignment", toMemberId: "coworker" });
  send("work.proposed", { workItemId, title: "Read the private brief", definitionOfDone: "Confirm the date",
    sourceMessageId, accountableMemberId: "coworker", mode: "read" });
  const page = await f.login("coworker", { roomId, key: coworker });
  const workUrl = new URL(workThreadHref(workItemId), f.origin);
  workUrl.searchParams.set("room", roomId);
  await page.goto(workUrl.href);
  await page.locator(`[data-work-record-id="${workItemId}"] [data-open-message="${sourceMessageId}"]`).press("Enter");
  await page.getByRole("button", { name: "Ask for an accessible reference", exact: true }).press("Enter");
  const draft = "Please share an approved copy of the brief.";
  await input(page).fill(draft);
  const requests = () => f.store.db.prepare(
    "SELECT record_key FROM current_room_records WHERE room_id = ? AND domain = 'replyRequests' AND json_extract(payload, '$.workItemId') = ?"
  ).all(roomId, workItemId);
  const attempts = [];
  await page.route(`**/api/rooms/${roomId}/commands`, async route => {
    const command = route.request().postDataJSON();
    if (command.type !== "message.posted" || command.data?.requestKind !== "reply") return route.continue();
    attempts.push(command);
    if (!uncertain || attempts.length > 1) return route.continue();
    const committed = await route.fetch();
    assert.ok(committed.ok());
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "storage_unavailable", message: "Retry the original" } }) });
  });
  if (uncertain) {
    await input(page).press("Enter");
    await failed(page);
    assert.equal(requests().length, 1);
  }

  let releaseRead;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const selectedRead = url => url.pathname === `/api/rooms/${roomId}/work-context` && url.searchParams.get("workItemId") === workItemId;
  await page.route(selectedRead, async route => {
    await held;
    if (scenario !== "refused") return route.continue();
    await route.fulfill({ status: 403, contentType: "application/json",
      body: JSON.stringify({ error: { code: "work_private", message: "Work unavailable" } }) });
  });
  try {
    await page.evaluate(url => history.replaceState(null, "", url), workUrl.href);
    const started = page.waitForRequest(request => selectedRead(new URL(request.url())), { timeout: 5000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await started;
    assert.equal(await page.locator("#request-mode-bar").isVisible(), false);
    assert.equal(await input(page).inputValue(), "");
    assert.equal(attempts.length, uncertain ? 1 : 0);
  } finally { releaseRead(); }
  if (scenario === "refused") {
    await page.getByText("Work unavailable. Ask the sender for a reference you can open.", { exact: true }).waitFor();
    assert.equal(await page.locator("#request-mode-bar").isVisible(), false);
    assert.equal(await input(page).inputValue(), "");
    assert.equal(requests().length, 0);
    assert.equal(attempts.length, 0);
    // A later explicit read can recover the draft for the same authorized seat.
    await page.unroute(selectedRead);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page.waitForFunction(text => document.querySelector("#message-input").value === text, draft, { timeout: 3000 });
  assert.equal(await page.locator("#message-to-select").inputValue(), "owner");
  assert.equal(await input(page).getAttribute("readonly") !== null, uncertain);
  assert.equal(await page.locator("#message-to-select").isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (process.env.ROOM_TEST_CAPTURE) await page.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, `cold-reference-${scenario}.png`) });
  await input(page).press("Enter");
  await saved(page);
  assert.equal(requests().length, 1);
  assert.equal(attempts.length, uncertain ? 2 : 1);
  if (uncertain) assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual(f.errors, []);
});
