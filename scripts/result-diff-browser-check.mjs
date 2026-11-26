// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import { openCatchUp, openWorkFromSearch, clickWorkAction } from "./room-chrome.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { textVersion } from "../server/text-results.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { exactResultHref } from "../src/record-link.js";
import { workspaceArtifactLink } from "../src/workspace-artifact-link.js";


const retainedBody = "Result A\nKeep this line\nMissing named owner\n".repeat(35);

async function setup(t, width, { retained = false, credentialReadBurst, firstDirectTo, firstBody, firstCredit, approveBoth = false } = {}) {
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
  if (approveBoth) send("guest", T.MESSAGE_POSTED, { messageId: "start-history", body: "Ready to review" });
  send("owner", T.WORK_PROPOSED, { workItemId: "revision-journey", title: "Revise a short result", definitionOfDone: "Name the owner", mode: "read", accountableMemberId: "producer", verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  lifecycle("revision-journey");
  send("owner", T.WORK_PROPOSED, { workItemId: "calm-result", title: "A first result", ...(approveBoth ? { ownerDecisionRequired: true, humanDecisionMakerId: "owner" } : {}), definitionOfDone: "One version", mode: "read", accountableMemberId: "producer", verifierMemberId: "human-checker", independentVerificationRequired: true });
  lifecycle("calm-result");
  completeWithText("calm-result", "Only version of this result");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = typeof firstBody === "function" ? firstBody(origin) : firstBody;
  const first = completeWithText("revision-journey", body ?? (retained ? retainedBody : "Result A\nKeep this line\nMissing named owner"), firstDirectTo, firstCredit);
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  async function login(actor, destination = origin) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(destination); await signInFixture(page, f.keys[actor]);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  }
  const mutate = (type, data) => send("producer", type, { workItemId: "revision-journey", expectedRevision: item("revision-journey").revision, ...data });
  t.after(() => assert.deepEqual(errors, []));
  return { ...f, get store() { return f.store; }, origin, restart, item: () => item("revision-journey"), first, login, mutate, send, complete: body => completeWithText("revision-journey", body) };
}
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
    await diff.getByText("- Result A", { exact: true }).waitFor();
    assert.match(await diff.innerText(), /Name the owner in the final line/);
    assert.doesNotMatch(await diff.innerText(), /Requested change:/);
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
    await owner.locator("#result-work-next").getByText("Accepted", { exact: true }).waitFor();
    assert.equal(await owner.locator("#result-work-next-label").textContent(), "Decision");
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


test("the ordinary reader keeps the governing verdict on the retained version", { timeout: 30000 }, async t => {
  const f = await setup(t, 1440, { retained: true }), page = await f.login("owner");
  await openResult(page);
  await page.locator("#result-body").evaluate(body => {
    const range = document.createRange();
    range.setStart(body.firstChild, 0); range.setEnd(body.firstChild, 8);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  const check = (receipt, result) => f.send("human-checker", T.VERIFICATION_RECORDED, {
    workItemId: f.item().id, expectedRevision: f.item().revision, completionEventId: receipt.event.id,
    evidenceVersion: receipt.event.data.evidenceVersion, result, summary: "Checked this revision",
    ...(result === "fail" && { nextAction: "Correct the wording." })
  });
  check(f.first, "fail");
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Corrected the wording." });
  f.mutate(T.WORK_STARTED, {});
  const second = f.complete(retainedBody);
  check(second, "pass");
  await page.locator("#result-current-version").waitFor();
  await page.locator("#result-verdict").getByText("Verification · Failed", { exact: true }).waitFor();
  assert.equal(await page.locator("#result-body").textContent(), retainedBody);
  assert.equal(await page.evaluate(() => getSelection().toString()), "Result A");
  await page.locator("#result-current-version").click();
  await page.getByText("Verification · Passed", { exact: true }).waitFor();
});

test("a withdrawal clears the retained passage while its replacement refresh is pending", { timeout: 30000 }, async t => {
  const f = await setup(t, 1440, { retained: true }), page = await f.login("owner");
  await openResult(page);
  let captured, release;
  const held = new Promise(resolve => { captured = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/work-result?**", async route => {
    if (new URL(route.request().url()).searchParams.get("completionEventId") !== f.first.event.id) return route.continue();
    const response = await route.fetch();
    captured(); await gate;
    await route.fulfill({ response });
  });
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Revise" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Revised" });
  f.mutate(T.WORK_STARTED, {});
  f.complete("Updated result");
  await held;
  const messageId = f.first.event.data.evidenceMessageId;
  const message = f.store.room("commons").state.messages.find(item => item.id === messageId);
  f.send("producer", T.MESSAGE_DELETED, { messageId, expectedMessageRevision: message.revision ?? 0 });
  await page.locator("#result-body").waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await page.locator("#result-body").textContent(), "");
  const delivered = page.waitForResponse(response => new URL(response.url()).searchParams.get("completionEventId") === f.first.event.id);
  release(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#result-body").textContent(), "");
  assert.equal(await page.locator("#result-copy-link").isVisible(), false);
});

test("returning from the first submission compares all changes across two revisions", { timeout: 30000 }, async t => {
  const f = await setup(t, 390, { firstBody: "Owner: undecided" });
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Name the owner" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Named the owner" });
  f.mutate(T.WORK_STARTED, {});
  const second = f.complete("Owner: Maya");
  f.send("human-checker", T.VERIFICATION_RECORDED, { workItemId: f.item().id,
    expectedRevision: f.item().revision, completionEventId: second.event.id, evidenceVersion: second.event.data.evidenceVersion,
    result: "fail", summary: "Confirm the owner", nextAction: "Check with Maya" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Maya confirmed" });
  f.mutate(T.WORK_STARTED, {});
  f.complete("Owner: Maya");
  await f.restart();
  const firstUrl = f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id;
  const page = await f.login("human-checker", firstUrl);
  const next = page.getByRole("link", { name: "Open current result" });
  const currentUrl = await next.getAttribute("href");
  await next.click();
  for (const id of ["result-diff", "action-result-diff"]) {
    const diff = page.locator("#" + id);
    await diff.getByText("- Owner: undecided", { exact: true }).waitFor();
    assert.match(await diff.textContent(), /\+ Owner: Maya/);
    assert.equal(new URL(await diff.getByRole("link").getAttribute("href"), f.origin).hash, new URL(firstUrl).hash);
    assert.match(await diff.textContent(), /Changes since the result you opened/);
    if (id === "result-diff") await page.locator("#result-work-action").click();
    else assert.match(await diff.textContent(), /Check with Maya/);
  }
  const fresh = await f.login("human-checker", currentUrl);
  await fresh.locator("#result-diff").getByText(/No text changes from the previous version/).waitFor();
  await page.locator("#cancel-action").click();
  await page.route("**/work-result?**", route =>
    new URL(route.request().url()).searchParams.get("completionEventId") === f.first.event.id
      ? route.fulfill({ status: 404, json: { error: "Result unavailable" } }) : route.continue());
  await page.locator("#result-work-action").click();
  const limited = page.locator("#action-result-diff");
  await limited.getByText(/earlier version could not be loaded/).waitFor();
  assert.match(await limited.textContent(), /Check with Maya/);
  assert.doesNotMatch(await limited.textContent(), /Owner: undecided/);
  const sourceId = second.event.data.evidenceMessageId;
  const source = f.store.room("commons").state.messages.find(message => message.id === sourceId);
  f.send("producer", T.MESSAGE_DELETED, { messageId: sourceId, expectedMessageRevision: source.revision ?? 0 });
  await limited.getByText(/Check with Maya/).waitFor({ state: "hidden" });
  assert.doesNotMatch(await limited.textContent(), /Check with Maya/);
  await page.locator("#cancel-action").click();
  await page.unroute("**/work-result?**");
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Name the backup owner" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Named the backup" });
  f.mutate(T.WORK_STARTED, {});
  f.complete("Owner: Maya, backup: Lee");
  await page.getByRole("link", { name: "Open current result" }).waitFor();
  await page.locator("#result-diff").getByText("- Owner: undecided", { exact: true }).waitFor();
});

test("a passage reply identifies the reviewed submission when two receipts cite one message", { timeout: 30000 }, async t => {
  const f = await setup(t, 390);
  const original = f.first.event.data;
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Confirm who owns this" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Confirmed" });
  f.mutate(T.WORK_STARTED, {});
  const second = f.mutate(T.WORK_COMPLETED, { ...original, expectedRevision: f.item().revision,
    previousCompletionEventId: f.first.event.id });
  const url = id => f.origin + "/?room=commons#pr-record/result/revision-journey/" + id;
  const page = await f.login("human-checker", url(f.first.event.id));
  await page.locator("#result-body").getByText(/Result A/).waitFor();
  await page.locator("#result-body").evaluate(body => {
    const range = document.createRange();
    range.setStart(body.firstChild, 0); range.setEnd(body.firstChild, 8);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator("#result-discuss").click();
  const draft = page.locator("#message-input");
  const feedback = await draft.inputValue();
  assert.ok(feedback.includes(url(f.first.event.id)), "the editable feedback names the selected completion");
  assert.ok(!feedback.includes(url(second.event.id)));
  await draft.fill(feedback + "Please revisit this wording.");
  await page.locator("#message-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#message-input").value === "");
  const reply = f.store.room("commons").state.messages.find(message => message.body?.includes("Please revisit this wording."));
  assert.equal(reply.replyToId, original.evidenceMessageId);
  const pointer = reply.body.split("\n").find(line => line.startsWith(f.origin));
  const publishedLink = page.locator('a[href="' + pointer + '"]').first();
  await publishedLink.waitFor();
  const recipient = await f.login("owner", await publishedLink.getAttribute("href"));
  await recipient.locator("#result-body").getByText(/Result A/).waitFor();
  assert.match(await recipient.locator("#result-status").textContent(), /Earlier result/);
  assert.equal(await recipient.locator("#result-current-version").getAttribute("href"), url(second.event.id));
});

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

test("late previous-result read cannot repopulate a different review after cancellation", { timeout: 30000 }, async t => {
  const f = await setup(t, 1440);
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Revise" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Revised" });
  f.mutate(T.WORK_STARTED, {});
  f.complete("Result B\nKeep this line\nOwner: Maya");
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
  await held;
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

for (const audience of ["public", "private"]) {
  test(`a submitted file change follows the exact ${audience} evidence audience`, { timeout: 45000 }, async t => {
    const patch = "diff --git a/brief.md b/brief.md\n--- a/brief.md\n+++ b/brief.md\n@@ -1 +1 @@\n-old\n+submitted\n";
    const id = "f".repeat(32), head = "c".repeat(40), digest = createHash("sha256").update(patch).digest("hex");
    const href = origin => origin + "/?room=commons#pr-workspace/" + [id, 1, "changes", digest, "producer", head, "brief.md"].join("/");
    const text = origin => [href(origin), href(origin).replace("/?", "/other?"), href(origin).replace("commons#", "other#")].join("\n");
    const f = await setup(t, 390, { firstBody: text, ...(audience === "private" && { firstDirectTo: "human-checker" }) });
    const publish = async (expectedRevision, patch) => {
      const res = await fetch(f.origin + "/api/rooms/commons/workspace-previews", {
        method: "POST", headers: { Authorization: "Bearer " + f.keys.producer, "Content-Type": "application/json" },
        body: JSON.stringify({ id, expectedRevision, patch, base: "b".repeat(40), head, title: "Brief", html: "<p>Brief</p>" })
      });
      assert.ok(res.ok, await res.text());
    };
    await publish(0, patch);
    const evidence = f.first.event.data.evidenceMessageId;
    if (audience === "public") {
      for (const author of ["owner", "guest", "producer", "human-checker"]) {
        for (let i = 0; i < 26; i++) f.send(author, T.MESSAGE_POSTED, { body: `Later conversation ${i}` });
      }
    }
    const reviewer = await f.login("human-checker", f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id);
    const body = reviewer.locator("#result-body");
    const link = body.getByRole("link", { name: href(f.origin), exact: true });
    await link.waitFor();
    assert.equal(await body.textContent(), text(f.origin));
    assert.equal(await body.locator("a").count(), 1);
    const evidenceRead = audience === "public" && reviewer.waitForResponse(response => {
      const url = new URL(response.url());
      return response.ok() && url.pathname.endsWith("/conversation") && url.searchParams.get("messageId") === evidence;
    });
    await link.click();
    if (evidenceRead) await evidenceRead;
    await reviewer.locator("[data-workspace-primary]").getByText("+submitted", { exact: true }).waitFor();
    await reviewer.goBack();
    await link.waitFor();
    await publish(1, patch.replace("+submitted", "+replacement"));
    await link.click();
    await reviewer.getByText("This preview revision changed.", { exact: true }).waitFor();
    assert.equal(await reviewer.getByRole("button", { name: "Open current revision" }).isVisible(), true);
    if (audience === "private") {
      assert.equal(await reviewer.locator("[data-discussion-link]").getAttribute("href"), null);
      const nonparty = await f.login("owner", f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id);
      await nonparty.getByText("Ask the sender to share the intended result version somewhere you can read it.", { exact: true }).waitFor();
      assert.equal(await nonparty.locator("#result-body a").count(), 0);
      return;
    }
    const discussion = reviewer.getByRole("link", { name: "Open original discussion" });
    if (process.env.ROOM_TEST_CAPTURE) await reviewer.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, "cold-file-preview.png") });
    await discussion.waitFor({ timeout: 2000 });
    assert.equal(new URL(await discussion.getAttribute("href")).hash, "#pr-record/message/" + evidence);
    assert.equal(await reviewer.getByRole("button", { name: "Add to thread draft" }).count(), 0);
    await discussion.press("Enter");
    await reviewer.waitForFunction(id => document.activeElement?.dataset?.messageRecordId === id, evidence);
    assert.equal(await reviewer.locator("#room-project-workspace").isVisible(), false);
    assert.equal(reviewer.context().pages().length, 1);
    if (process.env.ROOM_TEST_CAPTURE) await reviewer.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, "cold-file-return.png") });

    const exact = f.origin + "/?room=commons#pr-record/result/revision-journey/" + f.first.event.id;
    const leaving = await f.login("human-checker", exact);
    const selectedSource = url => url.pathname.endsWith("/conversation") && url.searchParams.get("messageId") === evidence;
    const held = Promise.withResolvers(), released = Promise.withResolvers();
    await leaving.route(selectedSource, async route => {
      held.resolve();
      await released.promise;
      await route.continue();
    });
    try {
      await leaving.locator("#result-body").getByRole("link", { name: href(f.origin), exact: true }).press("Enter");
      await held.promise;
      await leaving.locator("#topbar-updates").click();
      await leaving.locator("#result-dialog").waitFor({ state: "hidden" });
      const response = leaving.waitForResponse(response => selectedSource(new URL(response.url())));
      released.resolve();
      await response;
      await leaving.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await leaving.locator("#room-project-workspace").isVisible(), false);
      assert.equal(await leaving.locator("#updates-dialog").isVisible(), true);
    } finally {
      released.resolve();
    }

    const returning = await f.login("human-checker", exact);
    await returning.locator("#result-body").getByRole("link", { name: href(f.origin), exact: true }).press("Enter");
    const original = returning.getByRole("link", { name: "Open original discussion" });
    await original.waitFor();
    f.send("producer", T.MESSAGE_DELETED, { messageId: evidence, expectedMessageRevision: 0 });
    await original.waitFor({ state: "hidden" });
    assert.equal(await returning.locator("[data-discussion-link]").getAttribute("href"), null);
  });
}

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

test("catch-up labels each review with its visible work and preserves withheld history", async t => {
  const f = await setup(t, 390, { approveBoth: true });
  f.store.markCaughtUp(f.keys.owner, "commons", f.store.headSequence("commons"));
  const decisions = [];
  for (const workItemId of ["revision-journey", "calm-result"]) {
    const work = () => f.store.room("commons").state.workItems[workItemId];
    const basis = () => ({ workItemId, expectedRevision: work().revision,
      completionEventId: work().receipt.eventId, evidenceVersion: work().receipt.evidenceVersion });
    const review = f.send("human-checker", T.VERIFICATION_RECORDED, {
      ...basis(), result: "pass", summary: "Checked the revision",
    });
    const reason = f.send("owner", T.MESSAGE_POSTED, { messageId: "reason-" + workItemId, body: "Approved the revision." });
    const decision = f.send("owner", T.OWNER_DECISION_RECORDED, {
      ...basis(), decision: "approved", reason: "Approved the revision.", sourceMessageId: reason.event.data.messageId,
    });
    decisions.push({ workItemId, title: work().title, reviewId: review.event.id, decisionId: decision.event.id });
  }
  const page = await f.login("guest");
  await openCatchUp(page);
  const row = id => page.locator(`[data-brief-key="history:${id}"]`);
  async function checkRows(privateFirst) {
    await page.waitForFunction(() => Boolean(document.querySelector("#rb-ack-button").dataset.horizon));
    while (!await row(decisions[1].decisionId).count() && await page.locator("#rb-more-button").isVisible()) {
      await page.locator("#rb-more-button").click();
      await page.waitForFunction(() => document.querySelector("#return-brief-panel").getAttribute("aria-busy") === "false");
    }
    for (const { workItemId, title, reviewId, decisionId } of decisions) {
      const masked = privateFirst && workItemId === "revision-journey";
      assert.equal(await row(reviewId).locator(".rb-detail").textContent(), masked ? "pass" : title + " · pass · Checked the revision");
      assert.equal(await row(decisionId).locator(".rb-detail").textContent(), masked ? "approved" : title + " · approved");
      assert.equal(await row(decisionId).getAttribute("data-open-work"), workItemId);
    }
  }
  await checkRows(false);
  f.store.dmConsents.request("commons", "owner", "producer", "fixture");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  f.send("owner", T.MESSAGE_POSTED, { messageId: "private-review", toMemberId: "producer",
    workItemId: "revision-journey", requestKind: "reply", body: "Continue in private" });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/return-brief"));
  await page.locator("#rb-refresh-button").click();
  await refreshed;
  await page.waitForFunction(() => document.querySelector("#return-brief-panel").getAttribute("aria-busy") === "false");
  await checkRows(true);

  // The owner can read both work cards, but both proposals predate this marker.
  const owner = await f.login("owner");
  await openCatchUp(owner);
  for (const { workItemId, decisionId } of decisions) {
    const historical = owner.locator(`[data-brief-key="history:${decisionId}"]`);
    assert.equal(await historical.locator(".rb-detail").textContent(), workItemId + " · approved");
    assert.equal(await historical.getAttribute("data-open-work"), workItemId);
  }
});

test("phone assignment opens both exact inputs and returns to the draft", { timeout: 30000 }, async t => {
  const f = await setup(t, 390, { firstDirectTo: "human-checker" });
  const file = "docs/release.md", head = "c".repeat(40);
  const patch = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+Maya owns the release\n`;
  const published = await fetch(`${f.origin}/api/rooms/commons/workspace-previews`, {
    method: "POST", headers: { Authorization: "Bearer " + f.keys.producer, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "f".repeat(32), expectedRevision: 0, patch, base: "b".repeat(40), head,
      title: "Release instructions", recipientId: "human-checker", html: "<p>Release instructions</p>" })
  });
  assert.equal(published.status, 200);
  const fileLink = workspaceArtifactLink(f.origin, "commons", await published.json(), "changes", file);
  const resultLink = exactResultHref({ roomId: "commons", workItemId: "revision-journey", completionEventId: f.first.event.id }, new URL(f.origin));
  const assignment = "cross-check-instructions", source = "compare-two-inputs";
  f.send("owner", T.MESSAGE_POSTED, { messageId: source, body: `Check the proposed change against the submitted instructions.\n${fileLink}\n${resultLink}` });
  f.send("owner", T.WORK_PROPOSED, { workItemId: assignment, title: "Cross-check release instructions",
    definitionOfDone: "Check the exact changes and instructions", accountableMemberId: "human-checker", mode: "read", sourceMessageId: source });
  const assignmentUrl = `${f.origin}/?room=commons#pr-record/work/${assignment}`;
  const page = await f.login("human-checker", assignmentUrl);
  const assignmentSource = page.locator(`[data-work-record-id="${assignment}"] [data-open-message="${source}"]`);
  await assignmentSource.press("Enter");
  const message = page.locator(`[data-message-record-id="${source}"]`);
  await message.getByRole("button", { name: "Reply", exact: true }).press("Enter");
  const input = page.locator("#message-input"), draft = "Check Maya’s name before sending.";
  await input.fill(draft);
  await input.evaluate(el => el.setSelectionRange(6, 10));
  const sourceUrl = page.url();
  const capture = name => process.env.ROOM_TEST_CAPTURE && page.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, name + ".png") });
  await capture("assignment-source");
  const documentLink = message.locator(`a[href="${resultLink}"]`);
  const fileAnchor = message.locator(`a[href="${fileLink}"]`);
  const result = page.locator("#result-body").getByText(/Missing named owner/);
  const activated = Promise.race([
    page.context().waitForEvent("page", { timeout: 5000 }).then(() => "new tab"),
    result.waitFor({ timeout: 5000 }).then(() => "same tab"),
  ]);
  await documentLink.press("Enter");
  assert.equal(await activated, "same tab");
  await capture("pinned-document");
  const opener = await documentLink.elementHandle();
  f.send("owner", T.MESSAGE_EDITED, { messageId: source, expectedMessageRevision: 0,
    body: `Check the corrected instructions against the change.\n${fileLink}\n${resultLink}` });
  await page.waitForFunction(el => !el.isConnected, opener);
  await page.locator("#work-navigation-return").press("Enter");
  await documentLink.waitFor();
  assert.equal(page.url(), sourceUrl);
  assert.equal(await input.inputValue(), draft);
  assert.equal(await documentLink.evaluate(el => el === document.activeElement), true);
  assert.equal(await documentLink.textContent(), "Open submitted result");
  assert.equal(await fileAnchor.textContent(), "Open changes for docs/release.md");
  assert.deepEqual(await input.evaluate(el => [el.selectionStart, el.selectionEnd]), [6, 10]);
  await capture("returned-draft");
  for (const locator of [documentLink, fileAnchor]) {
    const native = await locator.evaluate(link => {
      let observed = false;
      document.addEventListener("click", event => {
        observed = !event.defaultPrevented;
        event.preventDefault();
      }, { once: true });
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
      return observed && link.target === "_blank";
    });
    assert.equal(native, true);
  }
  const workspace = page.getByRole("dialog", { name: "Workspace" });
  await fileAnchor.press("Enter");
  const exactLine = workspace.getByText("+Maya owns the release", { exact: true });
  await exactLine.waitFor();
  await capture("pinned-file");
  const firstView = await exactLine.boundingBox();
  assert.ok(firstView && firstView.y + firstView.height <= page.viewportSize().height, "the selected short diff is in the first viewport");
  await page.keyboard.press("Tab");
  assert.equal(await workspace.getByRole("tab", { name: "Changes" }).evaluate(el => el === document.activeElement), true);
  assert.equal(await workspace.locator("[data-workspace-primary] pre").evaluate(diff => {
    const browse = document.querySelector("#room-project-workspace [data-preview-refresh]");
    const copy = document.querySelector("#room-project-workspace [data-workspace-link]");
    return Boolean(diff.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(diff.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true);
  await page.keyboard.press("Escape");
  await workspace.waitFor({ state: "hidden" });
  assert.equal(await fileAnchor.evaluate(el => el === document.activeElement), true);
  await page.waitForFunction(() => {
    const layout = document.querySelector("#room-project-workspace .workspace-previews-layout");
    return !layout.hasAttribute("data-file-first") && layout.firstElementChild?.hasAttribute("data-workspace-inventory");
  });
  assert.equal(await input.inputValue(), draft);
  assert.equal(page.context().pages().length, 1);
  const requested = Promise.withResolvers(), releaseRead = Promise.withResolvers(), releaseInventory = Promise.withResolvers();
  t.after(() => { releaseRead.resolve(); releaseInventory.resolve(); });
  const isWorkspace = url => url.pathname.endsWith("/workspace-previews");
  const isLinkedFile = url => isWorkspace(url) && url.searchParams.get("view") === "file";
  const isInventory = url => isWorkspace(url) && !url.searchParams.has("id");
  let inventoryReads = 0;
  await page.route(isInventory, async route => {
    if (++inventoryReads === 1) return route.continue();
    await releaseInventory.promise;
    try { await route.continue(); }
    catch (error) { if (!/Route is already handled/.test(error.message)) throw error; }
  });
  await page.route(isLinkedFile, async route => {
    requested.resolve();
    await releaseRead.promise;
    await route.continue();
  });
  const failedRead = page.waitForResponse(response => isLinkedFile(new URL(response.url())));
  void failedRead.catch(() => {});
  await fileAnchor.press("Enter");
  await requested.promise;
  const copy = workspace.getByRole("button", { name: "Copy artifact link" });
  await copy.focus();
  const replaced = await fetch(`${f.origin}/api/rooms/commons/workspace-previews`, {
    method: "POST", headers: { Authorization: "Bearer " + f.keys.producer, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "f".repeat(32), expectedRevision: 1,
      patch: patch.replace("+Maya owns the release", "+Different version"), base: "b".repeat(40),
      head: "d".repeat(40), title: "Release instructions", recipientId: "human-checker", html: "<p>Replacement</p>" })
  });
  assert.equal(replaced.status, 200);
  releaseRead.resolve();
  assert.equal((await failedRead).status(), 409);
  const original = workspace.getByRole("link", { name: "Open original discussion" });
  await original.waitFor();
  await page.unroute(isLinkedFile);
  assert.equal(await workspace.getByText(/\+(Maya owns the release|Different version)/).count(), 0);
  assert.equal(await copy.count(), 0);
  assert.equal(await workspace.getByRole("button", { name: "Open current revision" }).count(), 0);
  assert.equal(await workspace.getByRole("button", { name: "Close", exact: true }).evaluate(el => el === document.activeElement), true);
  await capture("stale-file");
  await original.press("Enter");
  await workspace.waitFor({ state: "hidden" });
  releaseInventory.resolve();
  await page.unroute(isInventory);
  assert.equal(await input.inputValue(), draft);
  f.send("owner", T.MESSAGE_EDITED, { messageId: source, expectedMessageRevision: 1,
    body: `Check both references.\n${fileLink}\n${resultLink}\n${resultLink}` });
  const lastDocumentLink = message.locator(`a[href="${resultLink}"]`).nth(1);
  await lastDocumentLink.press("Enter");
  await result.waitFor();
  const lastOpener = await lastDocumentLink.elementHandle();
  f.send("owner", T.MESSAGE_EDITED, { messageId: source, expectedMessageRevision: 2,
    body: `Here are both references.\n${fileLink}\n${resultLink}\n${resultLink}` });
  await page.waitForFunction(el => !el.isConnected, lastOpener);
  await page.goBack();
  await page.waitForFunction(href => document.activeElement?.href === href
    && document.activeElement?.dataset.focusKey?.endsWith(":2"), resultLink);
  await page.locator("#work-navigation-return").press("Enter");
  await assignmentSource.waitFor();
  assert.equal(page.url(), assignmentUrl);
});

for (const anchor of ["root", "reply"]) {
  test(`replaced Workspace link in a ${anchor} returns to the same discussion draft`, { timeout: 30000 }, async t => {
    const f = await setup(t, 390);
    const id = "f".repeat(32), head = "c".repeat(40);
    const patch = "diff --git a/brief.md b/brief.md\n--- a/brief.md\n+++ b/brief.md\n@@ -1 +1 @@\n-old\n+published\n";
    const digest = createHash("sha256").update(patch).digest("hex");
    const href = f.origin + "/?room=commons#pr-workspace/" + [id, 1, "changes", digest, "producer", head, "brief.md"].join("/");
    const root = "workspace-original", reply = "workspace-reply";
    const source = anchor === "root" ? root : reply;
    f.send("producer", T.MESSAGE_POSTED, { messageId: root, body: "Original discussion" + (source === root ? "\n" + href : "") });
    f.send("producer", T.MESSAGE_POSTED, { messageId: reply, replyToId: root, body: "Exact version" + (source === reply ? "\n" + href : "") });
    const publish = async (expectedRevision, value) => {
      const response = await fetch(f.origin + "/api/rooms/commons/workspace-previews", {
        method: "POST", headers: { Authorization: "Bearer " + f.keys.producer, "Content-Type": "application/json" },
        body: JSON.stringify({ id, expectedRevision, patch: value, base: "b".repeat(40), head, title: "Brief", html: "<p>Brief</p>" })
      });
      assert.ok(response.ok, await response.text());
    };
    await publish(0, patch);
    await publish(1, patch.replace("+published", "+replaced"));
    const page = await f.login("human-checker");
    const message = id => page.locator(`[data-message-record-id="${id}"]`);
    const input = page.locator("#message-input");
    const draft = "Unsent note on the exact discussion.";
    await message(root).locator('[data-message-action="thread"]').click();
    await message(reply).locator('[data-message-action="reply"]').click();
    await input.fill(draft);
    if (source === root) await page.locator("#thread-back").click();
    await message(source).getByRole("link", { name: href, exact: true }).click();
    const dialog = page.locator("#room-project-workspace"), link = dialog.getByRole("link", { name: "Open original discussion" });
    await link.waitFor();
    assert.equal(new URL(await link.getAttribute("href")).hash, "#pr-record/message/" + source);
    assert.equal(await dialog.getByRole("button", { name: "Add to thread draft" }).count(), 0);
    const returned = Promise.race([
      page.context().waitForEvent("page").then(() => "new tab"),
      dialog.waitFor({ state: "hidden" }).then(() => "same tab"),
    ]);
    if (process.env.ROOM_TEST_CAPTURE) await page.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, `discussion-${anchor}.png`) });
    await link.press("Enter");
    assert.equal(await returned, "same tab");
    await page.waitForFunction(expected => document.activeElement?.dataset.messageRecordId === expected, source);
    assert.equal(await input.inputValue(), draft);
    assert.match(await page.locator("#reply-context").textContent(), /Exact version/);
    assert.equal(page.context().pages().length, 1);
    assert.equal(await page.locator("#thread-back").isVisible(), true);
    assert.equal(await page.locator("#work-navigation-return").isVisible(), false);
    if (process.env.ROOM_TEST_CAPTURE) await page.screenshot({ path: join(process.env.ROOM_TEST_CAPTURE, `returned-${anchor}.png`) });
    assert.equal(f.store.snapshot(f.keys.owner, "commons").state.messages.some(entry => entry.body === draft), false);
    if (source === reply) {
      await message(reply).getByRole("link", { name: href, exact: true }).click();
      await link.waitFor();
      f.send("producer", T.MESSAGE_DELETED, { messageId: reply, expectedMessageRevision: 0 });
      await link.waitFor({ state: "hidden" });
      assert.equal(await dialog.locator("[data-discussion-link]").getAttribute("href"), null);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await input.inputValue(), draft);
    }
  });
}
