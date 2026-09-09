// Simulated human journeys against disposable first-party data, not human research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
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
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args), json = response.json.bind(response);
      response.json = async () => { try { return await json(); } finally { if (response.headers.has("x-test-held")) window.oldWorkRead = true; } };
      return response;
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const login = async (key = f.keys.owner) => {
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.locator("#access-key").fill(key);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
  };
  await login();
  const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  const form = page.locator("#new-work-form"), title = page.locator("#work-title-input"), done = page.locator("#work-done-input");
  const open = async (id = "test-handoff") => {
    const card = page.locator(`[data-work-record-id="${id}"]`);
    await card.waitFor();
    if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
    await card.locator("[data-reuse-work]").click();
    await form.waitFor({ state: "visible" });
  };
  const people = async () => { await page.locator("#assignee-select").selectOption("producer"); await page.locator("#verifier-select").selectOption("reviewer"); };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/reuse-${name}.png`, fullPage: true }); };
  return { ...f, page, errors, login, snapshot, send, form, title, done, open, people, capture };
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`reuse ${name}: definition-only preview, fresh proposal, stable drafts and keyboard focus`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    const sourceId = "finished-write", sourceTitle = "Repeat a useful weekly summary\n" + "A".repeat(110), criteria = "Check sources and name an owner.\n" + "Long acceptance criteria. ".repeat(18);
    f.send(T.WORK_PROPOSED, { workItemId: sourceId, title: sourceTitle, definitionOfDone: criteria, accountableMemberId: "owner", mode: "write", sourceMessageId: "test-request", independentVerificationRequired: false, ownerDecisionRequired: false });
    const mutate = (type, data = {}) => f.send(type, { workItemId: sourceId, expectedRevision: f.snapshot().state.workItems[sourceId].revision, ...data });
    mutate(T.WORK_ACCEPTED);
    mutate(T.CLAIM_ACQUIRED, { repository: "fixture/reuse", ref: "test", paths: ["summary.md"], expiresAt: new Date(Date.now() + 600000).toISOString() });
    mutate(T.WORK_COMPLETED, { summary: "Synthetic prior outcome", evidenceUrl: "https://example.invalid/summary", evidenceVersion: "v1", producerId: "owner", nextAction: "Read the summary" });
    const before = f.snapshot(), card = page.locator(`[data-work-record-id="${sourceId}"]`);
    await card.waitFor(); assert.equal(await card.locator("[data-reuse-work]").isVisible(), false);
    await f.open(sourceId);
    assert.equal(await f.title.inputValue(), sourceTitle); assert.equal(await f.done.inputValue(), criteria);
    assert.equal(await f.title.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#assignee-select").inputValue(), ""); assert.equal(await page.locator("#verifier-select").inputValue(), "");
    assert.equal(await page.locator("#work-mode-select").inputValue(), "read");
    assert.equal(await page.locator("#require-verification").isChecked(), true); assert.equal(await page.locator("#require-decision").isChecked(), true);
    assert.equal(await page.locator("#work-options").evaluate(node => node.open), false);
    assert.equal(await page.locator("#source-message-id").inputValue(), "");
    assert.equal(await page.locator("#source-context").isVisible(), false);
    assert.deepEqual(f.snapshot(), before, "opening is not a mutation or read acknowledgement");
    await f.form.locator('button[type="submit"]').click();
    assert.equal(await page.locator("#assignee-select").evaluate(node => document.activeElement === node), true);
    await f.title.fill("A new weekly summary"); await f.done.fill("Edited criteria kept through live updates."); await f.people();
    await f.title.focus(); await f.title.evaluate(node => node.setSelectionRange(2, 5));
    // A second entrypoint cannot replace a current draft.
    await page.locator('[data-reuse-work="test-handoff"]').evaluate(node => node.click());
    assert.equal(await f.title.inputValue(), "A new weekly summary");
    f.send(T.MESSAGE_POSTED, { body: "Synthetic live update during draft" });
    await page.getByText("Synthetic live update during draft", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await f.done.inputValue(), "Edited criteria kept through live updates.");
    assert.deepEqual(await f.title.evaluate(node => ({ focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { focused: true, start: 2, end: 5 });
    if (name === "mobile") {
      const size = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), size * 2);
      await page.locator("#work-options > summary").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await page.locator("#work-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    }
    await f.capture(`${name}-preview`);
    if (name === "mobile") {
      await f.title.scrollIntoViewIfNeeded(); await page.screenshot({ path: "test-results/reuse-mobile-large-text-top.png" });
      await f.form.locator('button[type="submit"]').scrollIntoViewIfNeeded(); await page.screenshot({ path: "test-results/reuse-mobile-large-text-controls.png" });
    }
    // Rerender the actual source while the dialog is open; restore the new button.
    mutate(T.WORK_BLOCKED, { reason: "A new source finding", nextAction: "Review it" });
    await card.locator('[data-next-step="revise"]').waitFor({ state: "attached" });
    await page.keyboard.press("Escape"); await f.form.waitFor({ state: "hidden" });
    await page.waitForFunction(id => document.activeElement?.dataset.reuseWork === id, sourceId);
    assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.locator("#work-list").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(Object.keys(f.snapshot().state.workItems).length, Object.keys(before.state.workItems).length);
    if (name === "mobile") await page.evaluate(() => document.documentElement.style.fontSize = "");
    await page.locator("#new-work-button").click();
    assert.equal(await f.title.inputValue(), ""); assert.equal(await f.done.inputValue(), "");
    assert.equal(await page.locator("#work-reuse-hint").isVisible(), false);
    await page.keyboard.press("Escape");
    const sourceBeforeCreate = structuredClone(f.snapshot().state.workItems[sourceId]);
    await f.open(sourceId); await f.people();
    await f.form.locator('button[type="submit"]').click(); await f.form.waitFor({ state: "hidden" });
    const after = f.snapshot(), fresh = Object.values(after.state.workItems).find(work => !Object.hasOwn(before.state.workItems, work.id));
    assert.equal(fresh.title, sourceTitle); assert.equal(fresh.definitionOfDone, criteria);
    assert.equal(fresh.state, "proposed"); assert.equal(fresh.revision, 0); assert.equal(fresh.mode, "read");
    assert.equal(fresh.independentVerificationRequired, true); assert.equal(fresh.ownerDecisionRequired, true);
    for (const key of ["sourceMessageId", "claim", "receipt", "verification", "decision", "blocker"]) assert.equal(fresh[key], null);
    assert.deepEqual(after.state.workItems[sourceId], sourceBeforeCreate); assert.equal(after.cursor, before.cursor);
    await f.capture(`${name}-created`);
    assert.deepEqual(f.errors, []);
  });
}

for (const outcome of ["committed-lost", "uncommitted-lost", "server-failure", "malformed-receipt", "wrong-receipt"]) {
  test(`reuse creation: ${outcome} keeps an exact explicit original retry`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f;
    await f.open(); await f.people(); const before = f.snapshot(), attempts = []; let first = true;
    await page.route("**/commands", async route => {
      attempts.push(route.request().postDataJSON());
      if (!first) return route.continue(); first = false;
      if (outcome === "uncommitted-lost") return route.abort("failed");
      const response = await route.fetch();
      if (outcome === "committed-lost") return route.abort("failed");
      if (outcome === "server-failure") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporary", message: "Temporary service interruption" } }) });
      const receipt = await response.json();
      if (outcome === "wrong-receipt") receipt.event.actorId = "other";
      return route.fulfill({ status: 200, contentType: "application/json", body: outcome === "malformed-receipt" ? "{" : JSON.stringify(receipt) });
    });
    await f.form.locator('button[type="submit"]').click();
    await page.locator("#retry-work-button").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "retry-work-button");
    assert.equal(await f.title.isDisabled(), true); assert.equal(await f.done.isDisabled(), true);
    assert.equal(await page.locator("#assignee-select").isDisabled(), true);
    assert.equal(await f.form.locator('button[type="submit"]').isVisible(), false);
    assert.equal(await page.locator("#cancel-work-button").textContent(), "Close");
    if (outcome === "committed-lost") {
      f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "reviewer", expectedMemberRevision: 0, permissions: [], active: false });
      await f.capture("unconfirmed");
    }
    await page.locator("#retry-work-button").click(); await f.form.waitFor({ state: "hidden" });
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]);
    const after = f.snapshot();
    assert.equal(Object.keys(after.state.workItems).length, Object.keys(before.state.workItems).length + 1);
    assert.equal(after.state.workItems[attempts[0].data.workItemId].state, "proposed");
    assert.equal(after.cursor, before.cursor); assert.deepEqual(f.errors, []);
  });
}

test("known first refusal allows edits; closing an uncertain form is not cancellation", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.people();
  let first = true; const attempts = [];
  await page.route("**/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (!first) return route.continue(); first = false;
    return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "command_rejected", message: "Please correct the definition" } }) });
  });
  await f.form.locator('button[type="submit"]').click(); await page.locator("#new-work-status").waitFor({ state: "visible" });
  assert.equal(await f.title.isDisabled(), false); assert.equal(await page.locator("#retry-work-button").isVisible(), false);
  await f.title.fill("Corrected definition");
  await f.form.locator('button[type="submit"]').click(); await f.form.waitFor({ state: "hidden" });
  assert.equal(attempts[0].data.workItemId, attempts[1].data.workItemId); assert.notEqual(attempts[0].id, attempts[1].id);
  await page.unroute("**/commands");
  await f.open(); await f.people();
  await page.route("**/commands", async route => { await route.fetch(); await route.abort("failed"); });
  await f.form.locator('button[type="submit"]').click(); await page.locator("#retry-work-button").waitFor({ state: "visible" });
  await page.locator("#cancel-work-button").click(); await f.form.waitFor({ state: "hidden" });
  assert.match(await page.locator("#status").textContent(), /may already be saved/);
  assert.deepEqual(f.errors, []);
});

test("large Unicode proposal is a correctable refusal, not an uncertain retry", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.people();
  await f.title.fill("週".repeat(4096)); await f.done.fill("議".repeat(4096));
  assert.equal(await f.form.evaluate(node => node.checkValidity()), true);
  const response = page.waitForResponse(reply => reply.url().endsWith("/commands"));
  await f.form.locator('button[type="submit"]').click(); assert.equal((await response).status(), 413);
  await page.locator("#new-work-status").waitFor({ state: "visible" });
  assert.equal(await f.title.isDisabled(), false); assert.equal(await page.locator("#retry-work-button").isVisible(), false);
  assert.equal(await f.title.inputValue(), "週".repeat(4096));
  await f.title.fill("A shorter agenda"); await f.done.fill("Three useful questions");
  await f.form.locator('button[type="submit"]').click(); await f.form.waitFor({ state: "hidden" });
  assert.equal(Object.values(f.snapshot().state.workItems).filter(work => work.title === "A shorter agenda").length, 1);
  assert.deepEqual(f.errors, []);
});

test("uncommitted original retry rejection unlocks correction without creating another work identity", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.people();
  const attempts = []; let first = true;
  await page.route("**/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (first) { first = false; return route.abort("failed"); }
    return route.continue();
  });
  await f.form.locator('button[type="submit"]').click(); await page.locator("#retry-work-button").waitFor({ state: "visible" });
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "reviewer", expectedMemberRevision: 0, permissions: [], active: false });
  await page.locator("#retry-work-button").click(); await f.form.locator('button[type="submit"]').waitFor({ state: "visible" });
  assert.equal(await f.title.isDisabled(), false);
  assert.equal(await page.locator("#verifier-select").evaluate(node => node.checkValidity()), false);
  await page.locator("#verifier-select").selectOption("owner"); await f.title.fill("Corrected after original refusal");
  await f.form.locator('button[type="submit"]').click(); await f.form.waitFor({ state: "hidden" });
  assert.deepEqual(attempts[0], attempts[1]); assert.notEqual(attempts[1].id, attempts[2].id);
  assert.equal(attempts[0].data.workItemId, attempts[2].data.workItemId);
  assert.equal(f.snapshot().state.workItems[attempts[0].data.workItemId].title, "Corrected after original refusal");
  assert.deepEqual(f.errors, []);
});

test("reuse keyboard cycle and CR line endings stay usable without changing the original", { timeout: 30000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 }), { page } = f;
  f.send(T.WORK_PROPOSED, { workItemId: "line-endings", title: "Weekly\r\nagenda\rreview", definitionOfDone: "First\r\nsecond\rthird", accountableMemberId: "owner" });
  const original = structuredClone(f.snapshot().state.workItems["line-endings"]);
  await f.open("line-endings");
  assert.equal(await f.title.inputValue(), "Weekly\nagenda\nreview"); assert.equal(await f.done.inputValue(), "First\nsecond\nthird");
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await f.form.locator('button[type="submit"]').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press("Tab");
  assert.equal(await f.title.evaluate(node => document.activeElement === node), true);
  for (const id of ["work-done-input", "assignee-select", "verifier-select"]) {
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.id), id);
  }
  await page.keyboard.press("Tab"); assert.equal(await page.locator("#work-options > summary").evaluate(node => document.activeElement === node), true);
  await page.keyboard.press("Enter");
  for (const id of ["work-mode-select", "require-verification", "require-decision", "cancel-work-button"]) {
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.id), id);
  }
  await page.keyboard.press("Escape"); await f.form.waitFor({ state: "hidden" });
  assert.deepEqual(f.snapshot().state.workItems["line-endings"], original);
  assert.deepEqual(f.errors, []);
});

for (const outcome of ["success", "failure"]) {
  test(`reuse late ${outcome} cannot affect a replacement session's new draft`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f;
    let arrived, release; const held = new Promise(resolve => arrived = resolve);
    await page.route("**/commands", async route => {
      const response = await route.fetch();
      await new Promise(resolve => { release = resolve; arrived(); });
      if (outcome === "success") await route.fulfill({ response, headers: { ...response.headers(), "x-test-held": "work" } });
      else await route.fulfill({ status: 401, contentType: "application/json", headers: { "x-test-held": "work" }, body: JSON.stringify({ error: { message: "Obsolete work failure" } }) });
    });
    await f.open(); await f.people(); await f.form.locator('button[type="submit"]').click(); await held;
    f.keys.owner = f.store.issueAccessKey("commons", "owner"); await f.login();
    await page.locator("#new-work-button").click(); await f.title.fill("Replacement session draft"); await f.done.fill("Current criteria");
    release(); await page.waitForFunction(() => window.oldWorkRead);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await f.title.inputValue(), "Replacement session draft"); assert.equal(await f.done.inputValue(), "Current criteria");
    assert.equal(await f.title.isDisabled(), false); assert.equal(await f.form.isVisible(), true);
    assert.equal(await page.locator("#work-reuse-hint").isVisible(), false);
    assert.equal(await page.locator("#new-work-status").textContent(), ""); assert.equal(await page.locator("#retry-work-button").isVisible(), false);
    assert.deepEqual(f.errors, []);
  });
}
