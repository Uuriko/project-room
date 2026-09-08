// Simulated human journeys: disposable rooms, no real users or outside requests.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, { humanWork = false, mobile = false } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  const workId = humanWork ? "human-handoff" : "test-handoff";
  if (humanWork) f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: workId, title: "Prepare a weekly agenda", definitionOfDone: "One owner and one decision.", accountableMemberId: "owner",
    independentVerificationRequired: true, verifierMemberId: "reviewer", ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read"
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args), json = response.json.bind(response);
      response.json = async () => { try { return await json(); } finally { if (response.headers.has("x-test-held")) window.oldDraftRead = true; } };
      return response;
    };
  });
  await page.goto(origin);
  const login = async (key = f.keys.owner) => {
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.locator("#access-key").fill(key); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
  };
  await login();
  const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const card = page.locator(`[data-work-record-id="${workId}"]`), input = page.locator("#portable-result"), submit = page.locator("#portable-submit"), dialog = page.locator("#portable-dialog");
  const open = async () => {
    if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
    await card.getByRole("button", { name: "Paste AI draft", exact: true }).click(); await dialog.waitFor({ state: "visible" });
  };
  const answer = (body = "Synthetic agenda: choose priorities and review blockers.") => `ROOM-RETURN ${JSON.stringify({ version: 1, roomId: "commons", workItemId: workId, packetId: "manual-packet", basisRevision: 0 })}\n\n${body}`;
  const unknown = async () => { await page.getByText("Save not confirmed. Retry the same draft.", { exact: true }).waitFor(); assert.equal(await input.getAttribute("readonly"), ""); };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/draft-return-${name}.png`, fullPage: false }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, origin, login, snapshot, send, card, input, submit, dialog, open, answer, unknown, capture };
}

for (const outcome of ["committed-empty", "uncommitted-empty", "wrong-actor", "wrong-message", "malformed-json", "first-rate-limit"]) {
  test(`draft return ${outcome}: exact retry resolves without replacing the contribution`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f, before = f.snapshot(), attempts = [];
    await f.open(); const draft = f.answer(); await f.input.fill(draft);
    await page.route("**/commands", async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      if (outcome === "first-rate-limit") return route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "Try later" } } });
      if (outcome === "uncommitted-empty") return route.fulfill({ status: 200, json: {} });
      const response = await route.fetch(), receipt = await response.json();
      if (outcome === "wrong-actor") receipt.event.actorId = "producer";
      if (outcome === "wrong-message") receipt.event.data.messageId = "not-this-draft";
      if (outcome === "committed-empty") return route.fulfill({ status: 200, json: {} });
      if (outcome === "malformed-json") return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      return route.fulfill({ status: 200, json: receipt });
    });
    await f.submit.click(); await f.unknown(); assert.equal(await f.input.inputValue(), draft);
    assert.equal(await f.submit.evaluate(node => document.activeElement === node), true, "failed button submission returns to a usable retry");
    assert.doesNotMatch(await page.locator("#status").textContent(), /Draft posted/);
    await page.locator("#portable-close").click(); await f.open(); await f.unknown();
    // Even DOM text not matching the locked command cannot generate a new attempt.
    await f.input.evaluate(node => { node.value = "Changed DOM is not a new command"; });
    await f.submit.click(); await f.dialog.waitFor({ state: "hidden" });
    assert.deepEqual(attempts[0], attempts[1]);
    const after = f.snapshot(), messages = after.state.messages.filter(message => message.proposal);
    assert.equal(messages.length, 1); assert.equal(messages[0].id, attempts[0].data.messageId);
    assert.equal(messages[0].body, attempts[0].data.body);
    assert.deepEqual(after.state.workItems, before.state.workItems); assert.equal(after.cursor, before.cursor);
    await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, messages[0].id);
  });
}

test("uncommitted return retry unlocks only after stale rejection, preserving message identity through explicit correction", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f, attempts = [];
  await f.open(); await f.input.fill(f.answer());
  await page.route("**/commands", route => {
    attempts.push(route.request().postDataJSON());
    return attempts.length === 1 ? route.abort("failed") : route.continue();
  });
  await f.submit.click(); await f.unknown();
  f.send(T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: 0 }, "producer");
  await f.submit.click(); await page.locator("#portable-older-label").waitFor({ state: "visible" });
  assert.equal(await f.input.getAttribute("readonly"), null); assert.equal(await page.locator("#portable-older").isChecked(), false);
  assert.equal(f.snapshot().state.messages.filter(message => message.proposal).length, 0);
  await f.input.fill(f.answer("Corrected synthetic draft, still based on the earlier assignment."));
  await page.locator("#portable-older").check(); await f.submit.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.deepEqual(attempts[0], attempts[1]); assert.notEqual(attempts[1].id, attempts[2].id);
  assert.equal(attempts[0].data.messageId, attempts[2].data.messageId); assert.equal(attempts[2].data.allowOlderBasis, true);
  const messages = f.snapshot().state.messages.filter(message => message.proposal);
  assert.equal(messages.length, 1); assert.equal(messages[0].proposal.submittedAtRevision, 1);
});

test("confirmed draft with failed snapshot remains saved, then becomes findable on refresh", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; let failSnapshot = false, command;
  await page.route("**/api/rooms/commons", route => failSnapshot ? route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Synthetic snapshot unavailable" } } }) : route.continue());
  await page.route("**/commands", async route => { command = route.request().postDataJSON(); failSnapshot = true; const response = await route.fetch(); return route.fulfill({ response }); });
  await f.open(); await f.input.fill(f.answer()); await f.submit.click(); await f.dialog.waitFor({ state: "hidden" });
  await page.getByText("Draft posted. Refresh to view it. Work status is unchanged.", { exact: true }).waitFor();
  assert.equal(f.snapshot().state.messages.filter(message => message.proposal).length, 1);
  assert.equal(await f.card.getByRole("link", { name: "View latest draft", exact: true }).count(), 0);
  failSnapshot = false; await page.locator("#refresh-button").click();
  await f.card.getByRole("link", { name: "View latest draft", exact: true }).click();
  await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, command.data.messageId);
  await f.open(); assert.equal(await f.input.inputValue(), "");
});

test("posted draft returns to its exact conversation record and work link preserves unrelated thread drafts", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f, before = f.snapshot();
  f.send(T.MESSAGE_POSTED, { messageId: "side-reply", body: "Another thread", replyToId: "test-welcome" });
  const welcome = page.locator('[data-message-record-id="test-welcome"]');
  await page.locator("#message-input").fill("Private root composer draft");
  await welcome.locator('[data-message-action="thread"]').click();
  await page.locator("#message-input").fill("Private unrelated thread draft");
  await f.open(); await f.input.fill(f.answer());
  // An already-open draft cannot be replaced by another opening event.
  await f.card.locator('[data-portable-work]').first().evaluate(node => node.click());
  assert.equal(await f.input.inputValue(), f.answer());
  let command;
  await page.route("**/commands", async route => {
    command = route.request().postDataJSON(); const response = await route.fetch();
    f.send(T.MESSAGE_POSTED, { messageId: "intervening-message", body: "Newer unrelated conversation" });
    return route.fulfill({ response });
  });
  await f.submit.click(); await f.dialog.waitFor({ state: "hidden" });
  const posted = page.locator(`[data-message-record-id="${command.data.messageId}"]`);
  await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, command.data.messageId);
  assert.equal(await page.locator("#message-input").inputValue(), "Private root composer draft");
  assert.equal(await posted.getByRole("button", { name: "Make this work", exact: true }).count(), 0);
  assert.equal(await welcome.getByRole("button", { name: "Make this work", exact: true }).count(), 1);
  await f.card.locator(".work-details > summary").click();
  const link = f.card.getByRole("link", { name: "View latest draft", exact: true });
  assert.equal(await link.isVisible(), true, "draft is reachable with Details closed");
  assert.equal(await link.getAttribute("data-open-message"), command.data.messageId);
  f.send(T.MESSAGE_POSTED, { messageId: "later-work-draft", workItemId: "test-handoff", packetId: "manual-packet", basisRevision: 0, body: "Another contributor’s synthetic draft." }, "guest");
  await page.waitForFunction(() => document.querySelector('[data-focus-key="work-draft:test-handoff"]')?.dataset.openMessage === "later-work-draft");
  assert.equal(await f.card.getByRole("link", { name: "View latest draft", exact: true }).count(), 1, "one link, not an accumulating feature list");
  await welcome.locator('[data-message-action="thread"]').click();
  assert.equal(await page.locator("#message-input").inputValue(), "Private unrelated thread draft");
  await link.click(); await page.waitForFunction(() => document.activeElement?.dataset.messageRecordId === "later-work-draft");
  await f.capture("work-linked-draft");
  assert.equal(f.snapshot().cursor, before.cursor); assert.deepEqual(f.snapshot().state.workItems, before.state.workItems);
});

test("mobile guest draft is discoverable by the returning accountable member without implying work completion", { timeout: 30000 }, async t => {
  const f = await setup(t, { humanWork: true, mobile: true }), { page } = f, before = f.snapshot();
  await page.locator("#signout-button").click(); await f.login(f.keys.guest);
  await f.open(); await f.input.fill(f.answer("Guest contribution: start the agenda with an owner and one decision."));
  await f.submit.click(); await f.dialog.waitFor({ state: "hidden" });
  const posted = f.snapshot().state.messages.findLast(message => message.proposal);
  assert.equal(posted.authorId, "guest"); assert.equal(posted.proposal.attribution, "manual-unverified");
  await page.locator("#signout-button").click(); await f.login(f.keys.owner);
  assert.equal(await f.card.locator(".work-details").evaluate(node => node.open), false);
  await f.card.getByRole("link", { name: "View latest draft", exact: true }).click();
  await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, posted.id);
  assert.match(await page.locator(`[data-message-record-id="${posted.id}"]`).textContent(), /Pasted draft.*authorship unverified/);
  await f.capture("mobile-accountable-return");
  assert.deepEqual(f.snapshot().state.workItems, before.state.workItems);
  assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, 0);
  assert.equal(f.store.snapshot(f.keys.guest, "commons").cursor, 0);
});

for (const outcome of ["success", "failure"]) {
  test(`late draft ${outcome} cannot alter a replacement session`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f;
    let arrived, release; const held = new Promise(resolve => arrived = resolve);
    await page.route("**/commands", async route => {
      const response = await route.fetch();
      await new Promise(resolve => { release = resolve; arrived(); });
      if (outcome === "success") await route.fulfill({ response, headers: { ...response.headers(), "x-test-held": "draft" } });
      else await route.fulfill({ status: 401, headers: { "x-test-held": "draft" }, json: { error: { code: "unauthenticated", message: "Obsolete draft failure" } } });
    });
    await f.open(); await f.input.fill(f.answer()); await f.submit.click(); await held;
    f.keys.owner = f.store.issueAccessKey("commons", "owner"); await f.login();
    await f.open(); await f.input.fill("Replacement session draft");
    release(); await page.waitForFunction(() => window.oldDraftRead);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await f.input.inputValue(), "Replacement session draft"); assert.equal(await f.input.getAttribute("readonly"), null);
    assert.equal(await f.dialog.isVisible(), true); assert.equal(await f.input.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#portable-status").textContent(), "");
    assert.doesNotMatch(await page.locator("#status").textContent(), /Draft posted|Obsolete/);
  });
}
