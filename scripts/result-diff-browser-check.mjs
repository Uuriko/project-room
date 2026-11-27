// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import { openConversation, openWorkFromSearch, clickWorkAction } from "./room-chrome.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { textVersion } from "../server/text-results.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exactResultHref } from "../src/record-link.js";
import { linkWithProof } from "../tests/helpers/link-with-proof.mjs";


const retainedBody = "Result A\nKeep this line\nMissing named owner\n".repeat(35);

async function setup(t, width, { retained = false, credentialReadBurst, firstDirectTo, firstBody, firstCredit, browserType = chromium } = {}) {
  const f = createAcceptanceFixture();
  const makeServer = () => createRoomServer({ store: f.store, streamInterval: 60, credentialReadBurst });
  let server = makeServer(), browser;
  async function stopServer() {
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close();
  }
  async function restart() {
    const { port } = server.address();
    await stopServer();
    f.store = new RoomStore(join(f.directory, "room.sqlite"));
    server = makeServer();
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  }
  t.after(async () => {
    await browser?.close();
    await stopServer();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const item = id => f.store.room("commons").state.workItems[id];
  const completeWithText = (workItemId, body, toMemberId, credit = { producerId: "producer" }) => {
    const posted = send("producer", T.MESSAGE_POSTED, { messageId: randomUUID(), workItemId, body, ...(toMemberId ? { toMemberId } : {}) });
    return send("producer", T.WORK_COMPLETED, { workItemId, expectedRevision: item(workItemId).revision,
      evidenceKind: "room_text", evidenceMessageId: posted.event.data.messageId, evidenceMessageEventId: posted.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: item(workItemId).receipt?.eventId ?? null,
      ...credit, summary: "An exact room result", nextAction: "Review the stored text" });
  };
  const lifecycle = workItemId => {
    send("producer", T.WORK_ACCEPTED, { workItemId, expectedRevision: item(workItemId).revision });
    send("producer", T.WORK_STARTED, { workItemId, expectedRevision: item(workItemId).revision });
  };

  send("owner", T.MEMBER_ADDED, { memberId: "human-checker", displayName: "Test checker", kind: "human", permissions: ["verify"] });
  f.keys["human-checker"] = f.store.issueAccessKey("commons", "human-checker");
  send("owner", T.WORK_PROPOSED, { workItemId: "revision-journey", title: "Revise a short result", definitionOfDone: "Name the owner", mode: "read", accountableMemberId: "producer", verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  lifecycle("revision-journey");
  send("owner", T.WORK_PROPOSED, { workItemId: "calm-result", title: "A first result", definitionOfDone: "One version", mode: "read", accountableMemberId: "producer", verifierMemberId: "human-checker", independentVerificationRequired: true });
  lifecycle("calm-result");
  completeWithText("calm-result", "Only version of this result");
  const first = completeWithText("revision-journey", firstBody ?? (retained ? retainedBody : "Result A\nKeep this line\nMissing named owner"), firstDirectTo, firstCredit);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await browserType.launch({ headless: true, ...(browserType === chromium && process.env.ROOM_TEST_CHROMIUM_PATH
    ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  async function newPage() {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    return page;
  }
  async function login(actor, destination = origin) {
    const page = await newPage();
    await page.goto(destination); await signInFixture(page, f.keys[actor]);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  }
  const mutate = (type, data) => send("producer", type, { workItemId: "revision-journey", expectedRevision: item("revision-journey").revision, ...data });
  t.after(() => assert.deepEqual(errors, []));
  return { ...f, get store() { return f.store; }, origin, restart, item: () => item("revision-journey"), first, newPage, login, mutate, send, complete: body => completeWithText("revision-journey", body) };
}
for (const browserType of [chromium, webkit]) test(`a coworker can open the linked exact result from a different Room (${browserType.name()})`, { timeout: 30000 }, async t => {
  const f = await setup(t, 390, { browserType });
  const destinationRoom = "linked-review-room", reviewer = "different-reviewer";
  const accountId = "cross-room-reviewer-account";
  f.send("owner", T.MEMBER_ADDED, { memberId: "current-reader", displayName: "Current reader", kind: "human", permissions: [] });
  f.store.createAccount(accountId);
  f.store.completeOnboarding(accountId);
  f.store.bindHumanAccount("commons", "current-reader", accountId);
  f.store.initialize(initialRoom(destinationRoom, "publisher"));
  const publisher = f.store.issueAccessKey(destinationRoom, "publisher");
  const send = (key, type, data) =>
    f.store.command(key, destinationRoom, { id: randomUUID(), type, data });
  send(publisher, T.MEMBER_ADDED, { memberId: reviewer, displayName: "Independent reviewer", kind: "human", permissions: ["verify"] });
  f.store.bindHumanAccount(destinationRoom, reviewer, accountId);
  const reviewerKey = f.store.issueAccessKey(destinationRoom, reviewer);
  const workItemId = "linked-checklist";
  send(publisher, T.WORK_PROPOSED, { workItemId, title: "Check a different repository", definitionOfDone: "Name a release owner",
    accountableMemberId: "publisher", verifierMemberId: reviewer, independentVerificationRequired: true, mode: "read" });
  send(publisher, T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
  send(publisher, T.WORK_STARTED, { workItemId, expectedRevision: 1 });
  const complete = (body, expectedRevision, previousCompletionEventId = null) => {
    const entry = send(publisher, T.MESSAGE_POSTED, { messageId: randomUUID(), workItemId, body });
    return send(publisher, T.WORK_COMPLETED, { workItemId, expectedRevision, evidenceKind: "room_text",
      evidenceMessageId: entry.event.data.messageId, evidenceMessageEventId: entry.event.id, evidenceVersion: textVersion(body),
      previousCompletionEventId, producerId: "publisher", summary: "Review this exact checklist", nextAction: "Verify the owner" });
  };
  const first = complete("Release owner missing", 2);
  send(reviewerKey, T.VERIFICATION_RECORDED, { workItemId, expectedRevision: 3, completionEventId: first.event.id,
    evidenceVersion: first.event.data.evidenceVersion, result: "fail", summary: "Add the release owner", nextAction: "Revise" });
  send(publisher, T.WORK_BLOCKER_RESOLVED, { workItemId, expectedRevision: 4, resolution: "Added the owner" });
  send(publisher, T.WORK_STARTED, { workItemId, expectedRevision: 5 });
  const result = complete("Release owner: Maya", 6, first.event.id);
  const href = exactResultHref({ roomId: destinationRoom, workItemId, completionEventId: result.event.id }, new URL(f.origin));
  const openCurrentRoom = async (account, name) => {
    const readerPage = await f.newPage();
    await readerPage.goto(f.origin + "/?account=1");
    await signInFixture(readerPage, f.store.issueAccountAccessKey(account));
    await readerPage.locator('[data-account-room="commons"]').click();
    await readerPage.waitForFunction(label => new URL(location.href).searchParams.get("room") === "commons" &&
      document.querySelector("#identity-label")?.textContent === label, name);
    return readerPage;
  };
  const followInCurrentTab = (readerPage, target = href) => readerPage.evaluate(url => {
    history.pushState(null, "", url);
    dispatchEvent(new HashChangeEvent("hashchange"));
  }, target);
  const page = await openCurrentRoom(accountId, "Current reader");
  await openConversation(page);
  const draft = "Keep this until I choose to leave.";
  await page.locator("#message-input").fill(draft);
  const reads = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/work-result")) reads.push(request.url());
  });
  await followInCurrentTab(page);
  if (process.env.ROOM_CROSS_RESULT_CAPTURE) await page.screenshot({
    path: process.env.ROOM_CROSS_RESULT_CAPTURE + "-" + browserType.name() + ".png"
  });
  const open = page.getByRole("button", { name: "Open linked result", exact: true });
  const decline = page.waitForEvent("dialog").then(dialog => dialog.dismiss());
  await open.press("Enter");
  await decline;
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  assert.deepEqual(reads, [], "a pasted selector cannot read another Room before the switch");

  const confirmed = Promise.withResolvers(), release = Promise.withResolvers();
  const accountRoute = "**/api/account-session";
  const holdConfirmation = async route => {
    const response = await route.fetch();
    confirmed.resolve();
    await release.promise;
    await route.fulfill({ response });
  };
  await page.route(accountRoute, holdConfirmation, { times: 1 });
  await Promise.all([page.waitForEvent("dialog").then(dialog => dialog.accept()), open.press("Enter")]);
  await confirmed.promise;
  await followInCurrentTab(page, exactResultHref({
    roomId: destinationRoom, workItemId, completionEventId: first.event.id
  }, new URL(f.origin)));
  const accountCompletion = page.waitForResponse(response => new URL(response.url()).pathname === "/api/account-session");
  release.resolve();
  await (await accountCompletion).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(new URL(page.url()).searchParams.get("room"), "commons", "a superseded result cannot complete the earlier switch");
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  assert.deepEqual(reads, []);

  await followInCurrentTab(page);
  const accept = page.waitForEvent("dialog").then(dialog => dialog.accept());
  await open.press("Enter");
  await accept;
  await page.locator("#result-body").getByText("Release owner: Maya", { exact: true }).waitFor();
  assert.equal(page.url(), href);
  assert.equal(await page.locator("#identity-label").textContent(), "Independent reviewer");
  await page.getByRole("button", { name: "Record independent check", exact: true }).waitFor();
  assert.ok(reads.length > 0);
  assert.equal(new URL(reads[0]).searchParams.get("completionEventId"), result.event.id);
  assert.ok(reads.every(read => new URL(read).pathname === `/api/rooms/${destinationRoom}/work-result`));
  const previousReads = () => reads.filter(read => new URL(read).searchParams.get("completionEventId") === first.event.id);
  const comparison = page.locator("#result-diff .result-comparison");
  assert.equal(await comparison.evaluate(detail => detail.open), false);
  assert.equal(previousReads().length, 0, "cross-Room review opens only the current result");
  await comparison.locator("summary").press("Enter");
  await comparison.getByText("- Release owner missing", { exact: true }).waitFor();
  assert.equal(previousReads().length, 1, "explicit comparison reads the previous pinned completion once");
  if (process.env.ROOM_CROSS_RESULT_CAPTURE) await page.screenshot({
    path: process.env.ROOM_CROSS_RESULT_CAPTURE + "-result-" + browserType.name() + ".png"
  });

  const outsiderId = "other-reviewer-account";
  f.send("owner", T.MEMBER_ADDED, { memberId: "other-reader", displayName: "Other reader", kind: "human", permissions: [] });
  f.store.createAccount(outsiderId);
  f.store.completeOnboarding(outsiderId);
  f.store.bindHumanAccount("commons", "other-reader", outsiderId);
  const outsider = await openCurrentRoom(outsiderId, "Other reader");
  const outsideReads = [];
  outsider.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/work-result")) outsideReads.push(request.url());
  });
  await followInCurrentTab(outsider);
  const refused = outsider.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/session" && url.searchParams.get("room") === destinationRoom;
  });
  await outsider.getByRole("button", { name: "Open linked result", exact: true }).press("Enter");
  assert.equal((await refused).status(), 403);
  await outsider.locator("#account-rooms-panel").waitFor({ state: "visible" });
  assert.equal(await outsider.locator("#result-body").textContent(), "");
  assert.deepEqual(outsideReads, []);

  const agent = f.store.identities.create("Independent repository reader");
  linkWithProof(f.store, publisher, destinationRoom, agent, { permissions: ["accept_work"] });
  const response = await fetch(f.origin + "/mcp", { method: "POST", headers: {
    Authorization: "Bearer " + agent.secret, "Content-Type": "application/json"
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "room_read_result", arguments: { roomId: destinationRoom, workItemId, completionEventId: result.event.id }
  } }) });
  const selection = (await response.json()).result?.structuredContent;
  assert.equal(selection?.result?.receipt?.eventId, result.event.id);
  assert.equal(selection.result.text.body, "Release owner: Maya");
  assert.equal(selection.current.next.action, "verify");
});

const card = page => page.locator('[data-work-record-id="revision-journey"]');
async function openResult(page) {
  await openWorkFromSearch(page, "revision-journey", "Revise a short result");
  await card(page).locator("[data-read-result]").click();
  await page.locator("#result-body").getByText(/Result [AB]/).waitFor();
}
async function review(page, result, summary) {
  await page.locator('#action-fields [name="result"]').selectOption(result);
  await page.locator('#action-fields [name="summary"]').fill(summary);
  await page.locator('#action-form button[type="submit"]').click();
  await page.locator("#action-dialog").waitFor({ state: "hidden" });
}

for (const width of [1440, 390]) {
  test(`result revision journey ${width}px: review correction, compare resubmission and return`, { timeout: 60000 }, async t => {
    const f = await setup(t, width), reviewer = await f.login("human-checker");
    await clickWorkAction(await openWorkFromSearch(reviewer, "revision-journey", "Revise a short result"), "verify");
    await reviewer.locator("#action-text-body").getByText(/Result A/).waitFor();
    assert.equal(await reviewer.locator("#action-result-diff").isVisible(), false, "first result has no comparison");
    await review(reviewer, "fail", "Name the owner in the final line");
    assert.equal(f.item().verification.result, "fail");
    const firstReview = structuredClone(f.item().verification);
    f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Added a named owner" });
    f.mutate(T.WORK_STARTED, {});
    const reference = "https://artifacts.example.invalid/releases/" + "b58f4d1a".repeat(24);
    const revisedBody = "Result B\nKeep this line\nOwner: Maya" + (width === 390 ? "\n" + reference : "");
    const second = f.complete(revisedBody);
    assert.equal(f.item().receipt.nativeText.previousCompletionEventId, f.first.event.id);
    assert.notEqual(f.item().verification?.completionEventId, second.event.id, "A review must not apply to B");
    await clickWorkAction(await openWorkFromSearch(reviewer, "revision-journey", "Revise a short result"), "verify");
    await reviewer.locator("#action-text-body").getByText(/Result B/).waitFor();
    const diff = reviewer.locator("#action-result-diff");
    await diff.waitFor({ state: "visible" });
    assert.match(await diff.innerText(), /Name the owner in the final line/);
    assert.doesNotMatch(await diff.innerText(), /Requested change:/);
    assert.equal(await diff.locator(".result-diff").count(), 0);
    await diff.locator("summary").press("Enter");
    await diff.getByText("- Result A", { exact: true }).waitFor();
    assert.match(await diff.innerText(), /- Result A/);
    assert.match(await diff.innerText(), /\+ Result B/);
    assert.match(await diff.innerText(), /- Missing named owner/);
    assert.match(await diff.innerText(), /\+ Owner: Maya/);
    assert.doesNotMatch(await diff.innerText(), /No newline at end of file|Final line break/);
    if (width === 390) {
      assert.ok((await diff.innerText()).includes(reference), "the exact reference remains in the rendered comparison");
      const { viewport, content } = await diff.locator(".result-diff").evaluate(element =>
        ({ viewport: element.clientWidth, content: element.scrollWidth }));
      assert.ok(content <= viewport, `the changed reference must fit without sideways scrolling (${content} > ${viewport})`);
    }
    assert.match(await diff.innerText(), /never carries over/);
    assert.equal(await reviewer.locator("#action-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await reviewer.screenshot({ path: `test-results/result-review-${width}.png`, fullPage: true });
    await review(reviewer, "pass", "Checked the named owner in result B");
    assert.equal(f.item().verification.completionEventId, second.event.id);
    assert.equal(f.item().decision, null, "independent review does not approve work");
    assert.equal(firstReview.completionEventId, f.first.event.id);
    assert.equal(await reviewer.locator("#action-result-diff").textContent(), "", "closing review clears comparison bytes");
    const owner = await f.login("owner");
    await owner.locator("#topbar-updates").click();
    const update = owner.locator('#updates-dialog .updates-row').filter({ hasText: "Revise a short result" });
    const open = update.getByRole("button", { name: "Open Revise a short result", exact: true });
    await open.waitFor();
    await owner.waitForFunction(() => document.querySelector(".attention-decision[data-duplicate-update]"));
    assert.equal(await owner.locator(".attention-decision[data-duplicate-update]").isVisible(), false);
    await open.click();
    await owner.locator("#result-correction-summary").filter({ hasText: "Name the owner in the final line" }).waitFor();
    assert.equal(await owner.locator("#result-work-criteria").textContent(), "Name the owner");
    assert.equal(await owner.locator("#result-work-verification").textContent(), "Checked the named owner in result B");
    await owner.locator("#result-work-action").press("Enter");
    await owner.locator("#action-result-diff summary").press("Enter");
    await owner.locator("#action-result-diff").getByText(/Resubmitted result/).waitFor();
    assert.match(await owner.locator("#action-text-body").textContent(), /Result B/);
    await owner.locator('#action-fields [name="decision"]').selectOption("approved");
    await owner.locator('#action-fields [name="reason"]').fill("Named owner checked in result B");
    assert.equal(await owner.locator('#action-fields [name="sourceMessageId"]').count(),0);
    await owner.locator('#action-form button[type="submit"]').click();
    await owner.locator("#action-dialog").waitFor({ state: "hidden" });
    assert.equal(f.store.room("commons").state.messages.find(m=>m.id===f.item().decision.sourceMessageId).body,"Named owner checked in result B");
    assert.equal(f.item().decision.decision, "approved");
    assert.equal(f.item().decision.completionEventId, second.event.id);
    // Pin the slow ordering: the previous version's read lands after the current
    // text, as it did on CI, so this journey cannot pass only on a fast runner.
    await reviewer.route(url => new URL(url).searchParams.get("completionEventId") === f.first.event.id,
      async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
    await reviewer.reload(); await reviewer.locator("#main").waitFor({ state: "visible" });
    await openResult(reviewer);
    assert.equal(await reviewer.locator("#result-body").textContent(), revisedBody);
    // The comparison is a second, independent read of the previous version that
    // lands after #result-body; wait for its bytes instead of reading the box the
    // moment the current text appears (that race failed CI at both widths).
    await reviewer.locator("#result-diff summary").press("Enter");
    await reviewer.locator("#result-diff").getByText(/- Result A/).waitFor();
    assert.match(await reviewer.locator("#result-diff").innerText(), /- Result A/);
    await reviewer.locator("#close-result").click();
    assert.equal(await card(reviewer).locator("[data-read-result]").evaluate(node => node === document.activeElement), true);
    await openWorkFromSearch(reviewer, "calm-result", "A first result");
    await reviewer.locator('[data-work-record-id="calm-result"] [data-read-result]').click();
    await reviewer.waitForFunction(() => document.activeElement?.dataset.messageRecordId && document.activeElement.textContent.includes("Only version of this result"));
    assert.equal(await reviewer.locator("#result-dialog").isVisible(), false, "first short result opens in the conversation");
    assert.equal(await reviewer.locator("#result-diff").isVisible(), false, "different work's first result cannot retain B comparison");
    assert.equal(await reviewer.locator("#result-diff").textContent(), "");
  });

  test(`retained result ${width}px: reopening labels earlier text and preserves focus`, { timeout: 30000 }, async t => {
    const f = await setup(t, width, { retained: true }), page = await f.login("owner");
    await openResult(page);
    assert.doesNotMatch(await page.locator("#result-status").textContent(), /Earlier result/, "completed work awaiting review is still current");
    assert.equal(await page.locator("#result-diff").isVisible(), false);
    f.mutate(T.WORK_BLOCKED, { reason: "Reopened for correction", nextAction: "Name the owner" });
    await card(page).getByText(/Reopened for correction/).waitFor({ state: "attached" });
    assert.match(await page.locator("#result-status").textContent(), /Earlier result/);
    assert.equal(await page.locator("#result-body").textContent(), retainedBody);
    await page.locator("#close-result").click();
    assert.equal(await card(page).locator("[data-read-result]").evaluate(node => node === document.activeElement), true);
    await page.reload(); await page.locator("#main").waitFor({ state: "visible" });
    await openResult(page);
    assert.match(await page.locator("#result-status").textContent(), /Earlier result/);
    assert.equal(await page.locator("#result-body").textContent(), retainedBody);
  });
}


test("a returning reviewer can finish the correction from the original link after a cold restart", { timeout: 30000 }, async t => {
  const f = await setup(t, 390);
  const original = f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id;
  const reviewer = await f.login("human-checker", original);
  await reviewer.locator("#result-work-action").click();
  await review(reviewer, "fail", "Put the owner beside the deadline.");
  await reviewer.context().close();

  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Updated the final line." });
  f.mutate(T.WORK_STARTED, {});
  const second = f.complete("Result B\nOwner: Maya · Friday");
  await f.restart();

  const returning = await f.login("human-checker", original);
  await returning.getByText("Verification · Failed", { exact: true }).waitFor();
  assert.equal(await returning.locator("#result-work-action").isVisible(), false);
  const current = returning.getByRole("link", { name: "Open current result" });
  const currentUrl = await current.getAttribute("href");
  await current.click();
  await returning.locator("#result-correction-summary").getByText("Put the owner beside the deadline.").waitFor();
  assert.equal(await returning.locator("#result-body").textContent(), "Result B\nOwner: Maya · Friday");
  await returning.locator("#result-work-action").click();
  await returning.locator("#action-result-diff summary").press("Enter");
  await returning.locator("#action-result-diff").getByText("+ Owner: Maya · Friday", { exact: true }).waitFor();
  await review(returning, "pass", "Checked Maya against the Friday deadline.");
  assert.equal(f.item().verification.completionEventId, second.event.id);
  assert.equal(f.item().verificationHistory.find(v => v.completionEventId === f.first.event.id)?.result, "fail");
  const owner = await f.login("owner", currentUrl);
  await owner.getByText("Verification · Passed", { exact: true }).waitFor();
  await owner.locator("#result-work-action").click();
  await owner.locator('#action-fields [name="decision"]').selectOption("approved");
  await owner.locator('#action-fields [name="reason"]').fill("The revised result names the owner.");
  await owner.locator('#action-form button[type="submit"]').click();
  await owner.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().decision.completionEventId, second.event.id);
  assert.equal(f.item().decision.decision, "approved");
});

for (const withdraw of [false, true]) test(`late previous-result read respects ${withdraw ? "withdrawal" : "review cancellation"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, 1440);
  f.send("human-checker", T.VERIFICATION_RECORDED, { workItemId: f.item().id,
    expectedRevision: f.item().revision, completionEventId: f.first.event.id, evidenceVersion: f.first.event.data.evidenceVersion,
    result: "fail", summary: "Name the owner before approval." });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Revised" });
  f.mutate(T.WORK_STARTED, {});
  const revisedBody = "Result B\nKeep this line\nOwner: Maya";
  const revised = f.complete(revisedBody);
  const page = await f.login("human-checker");
  let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { captured = resolve; });
  t.after(() => release());
  await page.route("**/work-result?**", async route => {
    if (new URL(route.request().url()).searchParams.get("completionEventId") !== f.first.event.id) return route.continue();
    const response = await route.fetch(); captured(); await gate;
    await route.fulfill({ response });
  });
  await clickWorkAction(await openWorkFromSearch(page, "revision-journey", "Revise a short result"), "verify");
  const comparison = page.locator("#action-result-diff");
  await comparison.getByText("Name the owner before approval.", { exact: false }).waitFor();
  await comparison.locator("summary").press("Enter");
  await held;
  if (withdraw) {
    const messageId = f.first.event.data.evidenceMessageId;
    const source = f.store.room("commons").state.messages.find(message => message.id === messageId);
    f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: source.revision ?? 0 });
    await comparison.locator(".result-correction").waitFor({ state: "hidden" });
    release();
    await comparison.getByText("A version was withdrawn", { exact: false }).waitFor();
    assert.equal(await comparison.getByRole("link").count(), 0);
    assert.doesNotMatch(await comparison.textContent(), /Result A|Name the owner before approval/);
    assert.equal(await page.locator("#action-text-body").textContent(), revisedBody);
    await review(page, "pass", "Checked the owner on the current result.");
    assert.equal(f.item().verification.completionEventId, revised.event.id);
    return;
  }
  await page.locator("#cancel-action").click();
  await clickWorkAction(await openWorkFromSearch(page, "calm-result", "A first result"), "verify");
  await page.locator("#action-text-body").getByText("Only version of this result", { exact: true }).waitFor();
  const delivered = page.waitForResponse(response => new URL(response.url()).searchParams.get("completionEventId") === f.first.event.id);
  release(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#action-result-diff").isVisible(), false);
  assert.equal(await page.locator("#action-result-diff").textContent(), "");
  assert.equal(await page.locator("#action-text-body").textContent(), "Only version of this result");
  assert.equal(f.item().verification, null, "reading and cancellation record no review");
});

test("the verdict links exact candidate release checks without claiming missing stages passed", { timeout: 30000 }, async t => {
  // Three receipt popups each bootstrap a fresh Room view on the same credential.
  const f = await setup(t, 390, { credentialReadBurst: 600 });
  const candidateRevision = "a".repeat(40);
  f.mutate(T.WORK_BLOCKED, { reason: "Select exact release", nextAction: "Resubmit" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Candidate pinned" });
  f.mutate(T.WORK_STARTED, {});
  const completed = f.complete(`Candidate revision: ${candidateRevision}\nResult B`);
  const receipt = f.item().receipt;
  f.send("human-checker", T.VERIFICATION_RECORDED, { workItemId: "revision-journey",
    expectedRevision: f.item().revision, completionEventId: completed.event.id, evidenceVersion: receipt.evidenceVersion,
    result: "pass", summary: "Archive scope only" });
  const evidenceDigest = "sha256:" + "1".repeat(64), evidenceMessageId = "release-checks-build-receipt";
  f.send("producer", T.MESSAGE_POSTED, { workItemId: "revision-journey", replyToId: receipt.nativeText.messageId, messageId: evidenceMessageId,
    body: `room-release-receipt/1 build ${completed.event.id} ${candidateRevision} ${evidenceDigest}\nSigned archive manifest verified` });
  const report = { completionEventId: completed.event.id, evidenceVersion: receipt.evidenceVersion, candidateRevision,
    smokeTest: { accountableMemberId: "producer", verifierMemberId: "human-checker", criteria: "Open the shared preview as a teammate." },
    checks: { build: { candidateRevision, status: "passed", summary: "Signed archive verified", evidenceDigest, evidenceMessageId } } };
  const note = f.send("producer", T.MESSAGE_POSTED, { workItemId: "revision-journey", replyToId: receipt.nativeText.messageId,
    messageId: "release-checks-evidence", body: "room-release-checks/1\n" + JSON.stringify(report) });
  const page = await f.login("owner");
  await openResult(page);
  await page.locator("#result-outcome").getByText("Verify the deployment.", { exact: true }).waitFor();
  const link = page.getByRole("link", { name: "Release checks", exact: true });
  await link.waitFor();
  await link.press("Enter");
  assert.match(await page.locator("#result-release-candidate").textContent(), new RegExp(candidateRevision));
  assert.match(await page.locator("#result-release-stages").innerText(), /Build · Passed/);
  assert.match(await page.locator("#result-release-stages").innerText(), /Browser · Pending/);
  assert.match(await page.locator("#result-release-stages").innerText(), /Deploy · Pending/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator("#result-release-title").evaluate(node => document.activeElement === node), true);
  const source = page.getByRole("link", { name: "Open recorded evidence" });
  assert.equal(await source.getAttribute("href"), "#pr-record/message/" + note.event.data.messageId);
  const receiptLink = page.getByRole("link", { name: "Open Build receipt" });
  await receiptLink.click();
  await page.locator("#result-dialog").waitFor({ state: "hidden" });
  assert.match(page.url(), /#pr-record\/message\/release-checks-build-receipt$/);
  await page.getByText(/Signed archive manifest verified/).first().waitFor();

  // The initial missing-stage assertions above hold until two real receipts arrive.
  const additionalChecks = {};
  for (const [stage, digit] of [["browser", "2"], ["deploy", "3"]]) {
    const evidenceDigest = "sha256:" + digit.repeat(64), evidenceMessageId = `release-checks-${stage}-receipt`;
    const summary = `${stage} evidence checked`;
    f.send("owner", T.MESSAGE_POSTED, { workItemId: "revision-journey", replyToId: receipt.nativeText.messageId,
      messageId: evidenceMessageId, body: `room-release-receipt/1 ${stage} ${completed.event.id} ${candidateRevision} ${evidenceDigest}\n${summary}` });
    additionalChecks[stage] = { candidateRevision, status: "passed", summary, evidenceDigest, evidenceMessageId };
  }
  f.send("owner", T.MESSAGE_POSTED, { workItemId: "revision-journey", replyToId: receipt.nativeText.messageId,
    messageId: "release-checks-complete", body: "room-release-checks/1\n" + JSON.stringify({ ...report, checks: additionalChecks }) });
  const messageId = "release-verification-update";
  f.send("producer", T.MESSAGE_POSTED, { workItemId: "revision-journey", messageId,
    body: "@owner Installed evidence is ready to inspect" });
  await page.locator("#topbar-updates").click();
  await page.getByRole("button", { name: /Open .*Installed evidence is ready to inspect/ }).click();
  const message = page.locator(`[data-message-record-id="${messageId}"]`);
  await message.waitFor();
  assert.equal(new URL(page.url()).hash, "#pr-record/message/" + messageId);
  await message.getByRole("link", { name: "Revise a short result", exact: true }).click();
  assert.equal(f.store.workResult(f.keys.owner, "commons", "revision-journey").workThread.outcome?.remaining, "confirm_smoke_handoff");
  await page.locator("#result-outcome").getByText("Confirm the smoke test assignment.", { exact: true }).waitFor();
  const stages = page.locator("#result-release-stages summary");
  await stages.first().waitFor();
  assert.equal(page.viewportSize().width, 390);
  assert.equal(new URL(page.url()).hash, "#pr-record/work/revision-journey");
  assert.equal(await page.locator("#result-verdict").innerText(), "Verification · Passed");
  assert.equal(await page.locator("#result-work-verification").innerText(), "Archive scope only");
  const candidate = await page.locator("#result-release-candidate").innerText();
  assert.equal(candidate, "Candidate " + candidateRevision);
  const labels = await stages.allInnerTexts();
  assert.deepEqual(labels, ["Build · Passed", "Browser · Passed", "Deploy · Passed"]);
  const destinations = [];
  for (const stage of ["Build", "Browser", "Deploy"]) {
    await stages.filter({ hasText: stage + " · Passed" }).click();
    const link = page.getByRole("link", { name: `Open ${stage} receipt`, exact: true });
    const targetId = `release-checks-${stage.toLowerCase()}-receipt`;
    assert.equal(await link.getAttribute("href"), "#pr-record/message/" + targetId);
    const [opened] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
    try {
      const target = opened.locator(`[data-message-record-id="${targetId}"]`);
      await target.waitFor();
      const currentHref = new URL(opened.url()).hash;
      assert.equal(currentHref, "#pr-record/message/" + targetId);
      assert.ok((await target.innerText()).includes(`room-release-receipt/1 ${stage.toLowerCase()} ${completed.event.id} ${candidateRevision}`));
      destinations.push(currentHref);
    } finally { await opened.close(); }
  }
  await page.goBack();
  await message.waitFor();
  assert.equal(new URL(page.url()).hash, "#pr-record/message/" + messageId);

  f.send("owner", T.WORK_PROPOSED, { workItemId: "pending-update", title: "Pending evidence",
    definitionOfDone: "Deliver a checked result", mode: "read", accountableMemberId: "producer" });
  f.send("producer", T.MESSAGE_POSTED, { messageId: "unfinished-update", workItemId: "pending-update",
    body: "@owner Evidence is still in progress" });
  await page.locator("#topbar-updates").click();
  await page.getByRole("button", { name: /Open .*Evidence is still in progress/ }).click();
  await page.locator('[data-message-record-id="unfinished-update"]').getByRole("link", { name: "Pending evidence" }).click();
  await page.locator('[data-work-record-id="pending-update"]').waitFor();
  assert.equal(await page.locator("#result-dialog").isVisible(), false);

  // A fresh conversation permalink points to the identical message, without an Updates origin.
  const conversation = await page.context().newPage();
  await conversation.goto(new URL(page.url()).origin + "/?room=commons#pr-record/message/" + messageId);
  await conversation.locator(`[data-message-record-id="${messageId}"]`).getByRole("link", { name: "Revise a short result", exact: true }).click();
  await card(conversation).waitFor();
  assert.equal(await card(conversation).locator("[data-read-result]").isVisible(), true);
  assert.equal(await conversation.locator("#result-dialog").isVisible(), false);
  t.diagnostic(JSON.stringify({ viewport: 390, tapsFromUpdates: 2, candidate, verdict: "Verification · Passed",
    labels, openedReceiptTargets: destinations, ordinaryConversation: "work card with View result" }));

  const acceptance = f.send("owner", T.MESSAGE_POSTED, {
    workItemId: "revision-journey", messageId: "accept-exact-release", body: "Accepted the three receipts for this exact release.",
  });
  f.send("owner", T.OWNER_DECISION_RECORDED, {
    workItemId: "revision-journey", expectedRevision: f.item().revision, completionEventId: completed.event.id,
    evidenceVersion: receipt.evidenceVersion, decision: "approved", reason: "All three candidate checks passed",
    sourceMessageId: acceptance.event.data.messageId,
  });
  const updatesBeforeSmoke = await fetch(new URL("/api/rooms/commons/updates?state=all", page.url()), {
    headers: { authorization: "Bearer " + f.keys.owner },
  });
  assert.equal((await updatesBeforeSmoke.json()).items.some(item => item.kind === "release_accepted"), false);
  const { releaseSmokeWorkId } = await import("../server/release-smoke.mjs");
  const smokeId = releaseSmokeWorkId("revision-journey", completed.event.id, candidateRevision);
  f.send("owner", T.WORK_PROPOSED, { workItemId: smokeId, title: "Run post-deploy smoke test",
    definitionOfDone: report.smokeTest.criteria, mode: "read", accountableMemberId: "producer",
    verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: false,
    sourceMessageId: additionalChecks.deploy.evidenceMessageId });
  f.send("producer", T.WORK_ACCEPTED, { workItemId: smokeId, expectedRevision: 0 });
  f.send("producer", T.WORK_STARTED, { workItemId: smokeId, expectedRevision: 1 });
  const smokeText = f.send("producer", T.MESSAGE_POSTED, { workItemId: smokeId, messageId: "shared-preview-verified",
    body: "Opened the exact shared preview in the teammate's session." });
  const smokeVersion = textVersion(smokeText.event.data.body);
  const smoke = f.send("producer", T.WORK_COMPLETED, { workItemId: smokeId, expectedRevision: 2, evidenceKind: "room_text",
    evidenceMessageId: smokeText.event.data.messageId, evidenceMessageEventId: smokeText.event.id, evidenceVersion: smokeVersion,
    previousCompletionEventId: null, producerId: "producer", summary: smokeText.event.data.body, nextAction: "Review preview smoke" });
  f.send("human-checker", T.VERIFICATION_RECORDED, { workItemId: smokeId, expectedRevision: 3,
    completionEventId: smoke.event.id, evidenceVersion: smokeVersion, result: "pass", summary: "Cross-account preview verified" });
  for (const viewport of [390, 1280]) {
    const updates = await f.login("owner");
    await updates.setViewportSize({ width: viewport, height: 900 });
    await updates.locator("#topbar-updates").click();
    await updates.locator("[data-update-filter=all]").click();
    await updates.waitForFunction(() => document.querySelector("[data-update-filter=all]")?.getAttribute("aria-selected") === "true"
      && document.querySelector("#updates-status")?.textContent === "");
    const openRelease = updates.getByRole("button", { name: "Open Accepted release: Revise a short result", exact: true });
    assert.equal(await openRelease.count(), 1, "Updates All must show the accepted release on its first page");
    const exactRead = updates.waitForResponse(response => {
      const url = new URL(response.url());
      return response.ok() && url.pathname.endsWith("/work-result")
        && url.searchParams.get("workItemId") === "revision-journey"
        && url.searchParams.get("completionEventId") === completed.event.id;
    });
    await openRelease.click();
    await exactRead;
    await updates.locator("#result-release-stages summary").first().waitFor();
    assert.equal(new URL(updates.url()).hash, "#pr-record/work/revision-journey");
    assert.equal(await updates.locator("#result-verdict").innerText(), "Verification · Passed");
    await updates.locator("#result-outcome").getByText("Outcome accepted.", { exact: true }).waitFor();
    assert.equal(await updates.locator("#result-release-candidate").innerText(), candidate);
    assert.deepEqual(await updates.locator("#result-release-stages summary").allInnerTexts(), labels);
    t.diagnostic(JSON.stringify({ viewport, route: "Accepted release in Updates All", actionsFromDefaultUpdates: 2,
      exactCompletion: completed.event.id, candidate: candidateRevision, labels }));
  }
});

test("shared result links keep identical old and new text bound to different verdicts", { timeout: 45000 }, async t => {
  const revision = "a".repeat(40);
  const source = `https://github.com/room-fixtures/pinned-result/blob/${revision}`;
  const verdictSource = source + "/src/result-reader.js#L401-L411";
  const regressionSource = source + "/scripts/pin.mjs#L10-L20";
  const body = [
    "Result A",
    "Verdict binding: " + verdictSource,
    "Regression: " + regressionSource,
    "Literal moving link: https://github.com/Uuriko/project-room/blob/main/src/result-reader.js",
    `Literal unsupported host: https://example.test/room-fixtures/pinned-result/blob/${revision}/src/result-reader.js`,
    "Literal noncanonical link: " + source + "/../../../../main/src/result-reader.js",
    "Literal comma path: " + source + "/docs/a,b.md",
    "Literal semicolon path: " + source + "/docs/a;b.md",
    "Literal closing parenthesis path: " + source + "/docs/a)b.md"
  ].join("\n");
  const f = await setup(t, 1440, { firstBody: body, firstCredit: { producerId: null, externalProducer: "Design agent" } });
  const check = (receipt, result) => f.send("human-checker", T.VERIFICATION_RECORDED, {
    workItemId: f.item().id, expectedRevision: f.item().revision, completionEventId: receipt.event.id,
    evidenceVersion: receipt.event.data.evidenceVersion, result, summary: "Checked the exact revision",
    ...(result === "fail" ? { nextAction: "Use the same text with the correct evidence." } : {})
  });
  check(f.first, "fail");
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Rechecked the evidence." });
  f.mutate(T.WORK_STARTED, {});
  const second = f.complete(body);
  const checker = await f.login("human-checker");
  await clickWorkAction(await openWorkFromSearch(checker, "revision-journey", "Revise a short result"), "verify");
  await checker.locator("#action-result-diff").getByText(/Requested change: Use the same text with the correct evidence/).waitFor();
  await checker.close();
  check(second, "pass");
  const sender = await f.login("owner");
  await openResult(sender);
  await sender.locator("#result-correction-summary").getByText(/Requested change: Use the same text with the correct evidence/).waitFor();
  await sender.evaluate(() => {
    const noisy = new URL(location.href);
    noisy.searchParams.set("unrelated", "discard");
    history.replaceState(history.state, "", noisy.href);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async value => { window.sharedLink = value; }
    } });
  });
  await sender.locator("#result-options > summary").click();
  await sender.getByRole("button", { name: "Copy result link", exact: true }).click();
  await sender.getByText("Result link copied.", { exact: true }).waitFor();
  const current = await sender.evaluate(() => window.sharedLink);
  const expected = completion => f.origin + "/?room=commons#pr-record/result/revision-journey/" + completion;
  assert.equal(current, expected(second.event.id));
  await sender.locator("#result-diff summary").press("Enter");
  const earlier = await sender.getByRole("link", { name: "Open earlier result" }).getAttribute("href");
  assert.equal(earlier, expected(f.first.event.id));

  const receiver = await f.login("human-checker", earlier);
  await receiver.getByText("Verification · Failed", { exact: true }).waitFor();
  assert.match(await receiver.locator("#result-status").textContent(), /^Earlier result/);
  assert.equal(await receiver.locator("#result-body").textContent(), body);
  assert.match(await receiver.locator("#result-status").textContent(), /Credited to Design agent/);
  assert.equal(await receiver.locator("#result-work-action").isVisible(), false);
  const newer = receiver.getByRole("link", { name: "Open current result" });
  assert.equal(await newer.getAttribute("href"), current);
  await newer.click();
  await receiver.getByText("Verification · Passed", { exact: true }).waitFor();
  assert.equal(await newer.count(), 0);
  assert.doesNotMatch(await receiver.locator("#result-status").textContent(), /Credited to/);
  assert.doesNotMatch(await receiver.locator("#result-status").textContent(), /^Earlier result/);
  assert.equal(await receiver.locator("#result-body").textContent(), body);
  assert.deepEqual(await receiver.locator("#result-body a").evaluateAll(links => links.map(link => link.href)),
    [verdictSource, regressionSource]);
  const requests = [];
  await receiver.context().route("https://github.com/room-fixtures/pinned-result/**", async route => {
    requests.push(route.request().url());
    await route.fulfill({ body: "Pinned public source destination" });
  });
  await receiver.reload();
  await receiver.getByText("Verification · Passed", { exact: true }).waitFor();
  assert.deepEqual(requests, [], "initial exact result read fetches no public source");
  const [target] = await Promise.all([
    receiver.waitForEvent("popup"),
    receiver.locator("#result-body").getByRole("link", { name: regressionSource, exact: true }).click(),
  ]);
  await target.waitForLoadState();
  assert.equal(target.url(), regressionSource);
  await target.close();
  assert.equal(requests.length, 1);

  await receiver.goto(expected("missing-completion"));
  await receiver.getByText("Ask the sender to copy the link to the intended result version again.", { exact: true }).waitFor();
  assert.equal(await receiver.locator("#result-retry").isVisible(), false);
  assert.equal(await receiver.locator("#result-body").textContent(), "");
  assert.equal(await receiver.locator("#result-title").textContent(), "Result");

  await receiver.goto(f.origin + "/?room=commons");
  await openResult(receiver);
  assert.equal(await receiver.locator("#result-body").textContent(), body);
  const reads = [];
  receiver.on("request", request => {
    if (request.url().includes("/work-result?")) reads.push(request.url());
  });
  await receiver.evaluate(href => {
    history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, earlier.replace("room=commons", "room=commons&room=commons"));
  await receiver.getByText("This result link is invalid. Ask the sender to copy the result link again.", { exact: true }).waitFor();
  assert.deepEqual(reads, []);
  assert.equal(await receiver.locator("#result-body").textContent(), "");
  await receiver.evaluate(href => {
    history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, earlier.replace("room=commons", "room=other-room"));
  await receiver.getByText("That link belongs to another room. Open that room first.", { exact: true }).waitFor();
  assert.deepEqual(reads, []);
  assert.equal(await receiver.locator("#result-body").textContent(), "");

  const messageId = f.first.event.data.evidenceMessageId;
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: f.store.room("commons").state.messages.find(message => message.id === messageId).revision ?? 0 });
  await sender.locator("#result-correction").waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await sender.locator("#result-correction-summary").textContent(), "");
  await receiver.goto(earlier);
  await receiver.getByText(/Text withdrawn by/).waitFor();
  assert.doesNotMatch(await receiver.locator("#result-status").textContent(), /Design agent/);
  assert.equal(await receiver.locator("#result-body").textContent(), "");
  assert.equal(await receiver.locator("#result-copy-link").isVisible(), false);
  assert.equal(await receiver.locator("#result-current-version").getAttribute("href"), null);
});

test("an exact result link refuses a nonparty without falling forward", { timeout: 30000 }, async t => {
  const f = await setup(t, 1440, { firstDirectTo: "human-checker" });
  const target = f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id;
  const party = await f.login("human-checker");
  await party.goto(target);
  await party.locator("#result-body").getByText(/Result A/).waitFor();

  const nonparty = await f.login("owner");
  await nonparty.goto(target);
  await nonparty.getByText("Ask the sender to share the intended result version somewhere you can read it.", { exact: true }).waitFor();
  assert.equal(await nonparty.locator("#result-retry").isVisible(), false);
  assert.equal(await nonparty.locator("#result-body").textContent(), "");
  assert.equal(await nonparty.locator("#result-title").textContent(), "Result");
  assert.equal(await nonparty.locator("#result-copy-link").isVisible(), false);
  assert.equal(await nonparty.locator("#result-current-version").getAttribute("href"), null);
  assert.equal(await nonparty.locator("#result-work-action").isVisible(), false);

  f.send("owner", T.MESSAGE_POSTED, { messageId: "private-review", workItemId: "revision-journey",
    toMemberId: "producer", requestKind: "reply", body: "Private review question" });
  const guest = await f.login("guest");
  const denied = guest.waitForResponse(response => new URL(response.url()).pathname.endsWith("/work-result"));
  await guest.goto(target);
  assert.equal((await denied).status(), 403);
  await guest.getByText("Ask the sender to share the intended result version somewhere you can read it.", { exact: true }).waitFor();
  assert.equal(await guest.locator("#result-retry").isVisible(), false);
  assert.equal(await guest.locator("#result-body").textContent(), "");
});
