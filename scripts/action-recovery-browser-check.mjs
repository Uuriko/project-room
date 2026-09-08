// Simulated human flows in disposable loopback rooms. No external work or evidence is fetched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { verificationSatisfied } from "../src/workflow.js";

async function setup(t, { action = "complete", mobile = false, live = true } = {}) {
  const f = createAcceptanceFixture(), workId = "action-recovery";
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "human-reviewer", displayName: "Test reviewer", kind: "human", permissions: ["verify"] });
  f.keys["human-reviewer"] = f.store.issueAccessKey("commons", "human-reviewer");
  send(T.WORK_PROPOSED, { workItemId: workId, title: "Synthetic room result", definitionOfDone: "A versioned result with a clear next step.",
    accountableMemberId: "owner", independentVerificationRequired: true, verifierMemberId: "human-reviewer", ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: action === "claim" ? "write" : "read" });
  const snapshot = () => f.store.snapshot(f.keys.owner, "commons"), item = () => snapshot().state.workItems[workId];
  const mutate = (type, data = {}, actor = "owner") => send(type, { workItemId: workId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const evidence = () => ({ completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion });
  const complete = (version = "v1", producerId = "owner") => mutate(T.WORK_COMPLETED, { summary: `Synthetic result ${version}`, evidenceUrl: `https://example.invalid/result/${version}`, evidenceVersion: version, producerId, nextAction: "Review this version" });
  if (["verify", "decide"].includes(action)) complete();
  if (action === "decide") mutate(T.VERIFICATION_RECORDED, { ...evidence(), result: "pass", summary: "Checked v1" }, "human-reviewer");
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
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
  await page.addInitScript(live => {
    if (!live) window.EventSource = undefined;
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args), json = response.json.bind(response);
      response.json = async () => { try { return await json(); } finally { if (response.headers.has("x-test-held")) window.oldActionRead = true; } };
      return response;
    };
  }, live);
  await page.goto(origin);
  const login = async (role = "owner") => {
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.locator("#access-key").fill(f.keys[role]); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
  };
  await login(action === "verify" ? "human-reviewer" : "owner");
  const card = page.locator(`[data-work-record-id="${workId}"]`), dialog = page.locator("#action-dialog"), form = page.locator("#action-form"), save = form.locator("button[type=submit]");
  const input = name => page.locator(`#action-fields [name='${name}']`);
  const open = async (selected = action) => { await card.locator(`[data-action='${selected}']`).click(); await dialog.waitFor({ state: "visible" }); };
  const fill = async () => {
    const values = action === "complete" ? { producerId: "owner", summary: "Synthetic result with café and 🪷", evidenceUrl: "https://example.invalid/result", evidenceVersion: "v1", nextAction: "Review the exact result" }
      : action === "claim" ? { repository: "test/project", ref: "synthetic", paths: "src/app.js\ntest/**", expiresAt: new Date(Date.now() + 3600000).toISOString() }
        : action === "verify" ? { result: "pass", summary: "Checked this exact result" } : { decision: "approved", reason: "Accept this exact result" };
    for (const [name, value] of Object.entries(values)) {
      if (["producerId", "result", "decision"].includes(name)) await input(name).selectOption(value); else await input(name).fill(value);
    }
  };
  const unknown = async () => {
    await page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
    assert.equal(await save.textContent(), "Retry original save"); assert.equal(await save.isEnabled(), true);
    assert.equal(await page.locator("#action-fields input:enabled,#action-fields textarea:enabled,#action-fields select:enabled").count(), 0);
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/action-recovery-${name}.png` }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, login, send, snapshot, item, mutate, complete, evidence, card, dialog, form, save, input, open, fill, unknown, capture };
}

for (const outcome of ["committed-empty", "uncommitted-empty", "committed-lost", "uncommitted-lost", "wrong-actor", "wrong-payload", "wrong-operation", "malformed-json"]) {
  test(`work action ${outcome}: close and resume keep the exact result command`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f, before = f.snapshot().sequence, attempts = [];
    await f.open(); await f.fill();
    await page.route("**/commands", async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      if (outcome === "uncommitted-empty") return route.fulfill({ status: 200, json: {} });
      if (outcome === "uncommitted-lost") return route.abort("failed");
      const response = await route.fetch(), receipt = await response.json();
      if (outcome === "committed-empty") return route.fulfill({ status: 200, json: {} });
      if (outcome === "committed-lost") return route.abort("failed");
      if (outcome === "malformed-json") return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      if (outcome === "wrong-actor") receipt.event.actorId = "guest";
      if (outcome === "wrong-payload") receipt.event.data.summary = "Another result";
      if (outcome === "wrong-operation") receipt.event.idempotencyKey = "0".repeat(64);
      return route.fulfill({ status: 200, json: receipt });
    });
    await f.save.click(); await f.unknown();
    assert.doesNotMatch(await page.locator("#status").textContent(), /Record saved/);
    await page.locator("#cancel-action").click(); await f.dialog.waitFor({ state: "hidden" });
    await page.locator("#resume-action").waitFor({ state: "visible" });
    // A different available action must resume, never replace, the pending completion.
    await f.open("block"); assert.equal(await page.locator("#action-title").textContent(), "Post actual evidence");
    await f.unknown(); assert.equal(await f.input("summary").inputValue(), attempts[0].data.summary);
    await f.input("summary").evaluate(node => { node.value = "Changed DOM cannot replace a pending save"; });
    await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
    assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.snapshot().sequence, before + 1);
    assert.equal(f.item().receipt.summary, attempts[0].data.summary); assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
    assert.equal(await page.locator("#resume-action").isVisible(), false);
    assert.equal(f.snapshot().cursor, 0);
  });
}

test("unknown claim retries preserve ordered paths and stay locked through size and rate refusals", { timeout: 30000 }, async t => {
  const f = await setup(t, { action: "claim" }), { page } = f, attempts = [];
  await f.open(); await f.fill();
  await page.route("**/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); return route.abort("failed"); }
    if (attempts.length === 2) return route.fulfill({ status: 413, json: { error: { code: "too_large", message: "Synthetic size refusal" } } });
    if (attempts.length === 3) return route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "Synthetic rate refusal" } } });
    return route.continue();
  });
  for (let i = 0; i < 3; i++) { await f.save.click(); await f.unknown(); }
  await page.locator("#cancel-action").click(); await page.locator("#resume-action").click();
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(attempts.length, 4); for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
  assert.deepEqual(f.item().claim.paths, ["src/app.js", "test/**"]); assert.equal(f.item().revision, 2);
});

for (const lost of [false, true]) test(`${lost ? "Unknown" : "First"} invalid scope unlocks after a definitive refusal`, { timeout: 30000 }, async t => {
  const f = await setup(t, { action: "claim" }), { page } = f, attempts = [];
  await f.open(); await f.fill(); await f.input("paths").fill("src/*.js");
  await page.route("**/commands", route => {
    attempts.push(route.request().postDataJSON());
    return lost && attempts.length === 1 ? route.abort("failed") : route.continue();
  });
  await f.save.click(); if (lost) { await f.unknown(); await f.save.click(); }
  await page.waitForFunction(() => !document.querySelector("#action-fields [name=paths]").disabled);
  assert.equal(await f.save.textContent(), "Save record"); assert.match(await page.locator("#action-error").textContent(), /explicit relative paths/);
  await f.input("paths").fill("src/app.js"); await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  if (lost) assert.deepEqual(attempts[0], attempts[1]); assert.notEqual(attempts.at(-2).id, attempts.at(-1).id);
  assert.deepEqual(f.item().claim.paths, ["src/app.js"]);
});

test("closed unknown save warns on leave and sign-out without deleting a declined retry", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  await f.open(); await f.fill(); await page.route("**/commands", route => route.abort("failed"));
  await f.save.click(); await f.unknown(); await page.locator("#cancel-action").click();
  assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  let warning;
  page.once("dialog", async dialog => { warning = dialog.message(); await dialog.dismiss(); });
  await page.locator("#signout-button").click(); assert.match(warning, /pending retry.*may already be saved/);
  assert.equal(await page.locator("#main").isVisible(), true); await page.locator("#resume-action").click(); await f.unknown();
});

test("a competing reservation resolves an uncommitted retry without overwriting either scope", { timeout: 30000 }, async t => {
  const f = await setup(t, { action: "claim" }), { page } = f, attempts = [];
  await f.open(); await f.fill();
  await page.route("**/commands", route => { attempts.push(route.request().postDataJSON()); return attempts.length === 1 ? route.abort("failed") : route.continue(); });
  await f.save.click(); await f.unknown();
  f.send(T.WORK_PROPOSED, { workItemId: "competing", title: "Another synthetic task", definitionOfDone: "Separate files", accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false, mode: "write" });
  f.send(T.WORK_ACCEPTED, { workItemId: "competing", expectedRevision: 0 });
  f.send(T.CLAIM_ACQUIRED, { ...attempts[0].data, workItemId: "competing", expectedRevision: 1 });
  await f.save.click(); await page.waitForFunction(() => !document.querySelector("#action-fields [name=paths]").disabled);
  assert.match(await page.locator("#action-error").textContent(), /Scope is reserved/);
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.item().claim, null);
  await f.input("paths").fill("docs/result.md"); await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.notEqual(attempts[1].id, attempts[2].id); assert.deepEqual(f.item().claim.paths, ["docs/result.md"]);
  assert.deepEqual(f.snapshot().state.workItems.competing.claim.paths, ["src/app.js", "test/**"]);
});

test("a valid action receipt remains saved when its follow-up snapshot fails", { timeout: 30000 }, async t => {
  const f = await setup(t, { live: false }), { page } = f; let failSnapshot = false;
  await page.route("**/api/rooms/commons", route => failSnapshot ? route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Synthetic snapshot unavailable" } } }) : route.continue());
  await page.route("**/commands", async route => { const response = await route.fetch(); failSnapshot = true; return route.fulfill({ response }); });
  await f.open(); await f.fill(); await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  await page.getByText("Record saved.", { exact: true }).waitFor(); assert.equal(f.item().state, "completed");
  assert.equal(await page.locator("#resume-action").isVisible(), false);
  failSnapshot = false; await page.locator("#refresh-button").click(); await f.card.getByText("Awaiting verification", { exact: true }).waitFor();
});

test("stale refusal with no live updates provides an owned refresh before rebasing", { timeout: 30000 }, async t => {
  const f = await setup(t, { live: false }), { page } = f, attempts = [];
  await f.open(); await f.fill(); f.mutate(T.WORK_STARTED);
  await page.route("**/commands", route => { attempts.push(route.request().postDataJSON()); return route.continue(); });
  await f.save.click(); await page.locator("#refresh-action").waitFor({ state: "visible" });
  assert.equal(await f.save.isDisabled(), true); assert.equal(attempts.length, 1);
  await page.locator("#refresh-action").click(); await f.save.waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#action-form button[type=submit]").disabled);
  assert.match(await page.locator("#action-context").textContent(), /revision 2/); assert.equal(await f.input("summary").inputValue(), attempts[0].data.summary);
  assert.equal(attempts.length, 1, "refresh reads but does not resubmit");
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.notEqual(attempts[0].id, attempts[1].id); assert.equal(attempts[1].data.expectedRevision, 2);
});

test("a failed explicit refresh keeps old evidence and notes until a later successful read", { timeout: 30000 }, async t => {
  const f = await setup(t, { action: "verify", live: false }), { page } = f, old = f.evidence(); let fail = true;
  await f.open(); await f.fill();
  f.mutate(T.WORK_BLOCKED, { reason: "Revision needed", nextAction: "Rework" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" }); f.complete("v2", null);
  await f.save.click(); await page.locator("#refresh-action").waitFor({ state: "visible" });
  await page.route("**/api/rooms/commons", route => fail ? route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Synthetic read failure" } } }) : route.continue());
  await page.locator("#refresh-action").click(); await page.getByText("Could not load current work. Try again.", { exact: true }).waitFor();
  assert.match(await page.locator("#action-context").textContent(), /evidence v1/); assert.equal(await f.input("result").inputValue(), "pass");
  assert.equal(await f.input("summary").inputValue(), "Checked this exact result"); assert.equal(await f.save.isDisabled(), true);
  fail = false; await page.locator("#refresh-action").click(); await page.waitForFunction(() => document.querySelector("#action-context").textContent.includes("evidence v2"));
  assert.equal(await f.input("result").inputValue(), ""); assert.notEqual(f.evidence().completionEventId, old.completionEventId);
  assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
});

test("late explicit review refresh cannot expose a previous session's result link or notes", { timeout: 30000 }, async t => {
  const f = await setup(t, { action: "verify" }), { page } = f; let arrived, release;
  await f.open(); await f.fill();
  f.mutate(T.WORK_BLOCKED, { reason: "Revision needed", nextAction: "Rework" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" }); f.complete("v2");
  await page.locator("#refresh-action").waitFor({ state: "visible" });
  const held = new Promise(resolve => arrived = resolve);
  await page.route("**/api/rooms/commons", async route => {
    const response = await route.fetch();
    await new Promise(resolve => { release = resolve; arrived(); });
    return route.fulfill({ response, headers: { ...response.headers(), "x-test-held": "refresh" } });
  });
  await page.locator("#refresh-action").click(); await held;
  f.keys["human-reviewer"] = f.store.issueAccessKey("commons", "human-reviewer");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#action-evidence").getAttribute("href"), null);
  await page.unroute("**/api/rooms/commons"); await f.login("owner"); await f.open("block"); await f.input("reason").fill("New session notes");
  release(); await page.waitForFunction(() => window.oldActionRead); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await f.input("reason").inputValue(), "New session notes"); assert.equal(await f.input("reason").evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator("#action-evidence").getAttribute("href"), null); assert.equal(await page.locator("#action-error").textContent(), "");
});

for (const action of ["verify", "decide"]) {
  test(`stale ${action} keeps notes but requires an explicit new verdict for the new result`, { timeout: 30000 }, async t => {
    const f = await setup(t, { action }), { page } = f, previous = f.evidence(), verdict = action === "verify" ? "result" : "decision", notes = action === "verify" ? "summary" : "reason";
    await f.open(); await f.fill(); const note = await f.input(notes).inputValue();
    f.mutate(T.WORK_BLOCKED, { reason: "Synthetic rework", nextAction: "Revise" });
    f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready for next version" });
    f.complete("v2", action === "verify" ? null : "owner");
    if (action === "decide") f.mutate(T.VERIFICATION_RECORDED, { ...f.evidence(), result: "pass", summary: "Checked v2" }, "human-reviewer");
    await page.locator("#refresh-action").waitFor({ state: "visible" }); assert.equal(await f.save.isDisabled(), true);
    assert.match(await page.locator("#action-context").textContent(), /evidence v1/);
    assert.equal(await page.locator("#action-evidence").getAttribute("href"), "https://example.invalid/result/v1");
    await page.locator("#refresh-action").click();
    await page.waitForFunction(() => document.querySelector("#action-context").textContent.includes("evidence v2"));
    assert.equal(await f.input(verdict).inputValue(), ""); assert.equal(await f.input(notes).inputValue(), note);
    assert.equal(await page.locator("#action-evidence").getAttribute("href"), "https://example.invalid/result/v2");
    if (action === "verify") {
      assert.equal(await page.locator("#action-title").textContent(), "Record an evidence check");
      assert.match(await page.locator("#verification-boundary").textContent(), /unknown.*cannot satisfy independent verification/);
    }
    let command;
    await page.route("**/commands", route => { command = route.request().postDataJSON(); return route.continue(); });
    await f.input(verdict).selectOption(action === "verify" ? "pass" : "approved");
    await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
    assert.equal(command.data.completionEventId, f.item().receipt.eventId); assert.notEqual(command.data.completionEventId, previous.completionEventId);
    assert.equal(command.data.evidenceVersion, "v2");
    if (action === "verify") { assert.equal(verificationSatisfied(f.item()), false); assert.equal(f.item().decision, null); }
  });
}

for (const outcome of ["success", "failure"]) {
  test(`late action ${outcome} cannot alter a replacement session's form or focus`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page } = f; let arrived, release;
    const held = new Promise(resolve => arrived = resolve);
    await page.route("**/commands", async route => {
      const response = await route.fetch();
      await new Promise(resolve => { release = resolve; arrived(); });
      if (outcome === "success") await route.fulfill({ response, headers: { ...response.headers(), "x-test-held": "action" } });
      else await route.fulfill({ status: 401, headers: { "x-test-held": "action" }, json: { error: { code: "unauthenticated", message: "Obsolete action failure" } } });
    });
    await f.open(); await f.fill(); await f.save.click(); await held;
    f.keys.owner = f.store.issueAccessKey("commons", "owner"); await f.login(); await f.open("block");
    await f.input("reason").fill("Replacement session notes");
    release(); await page.waitForFunction(() => window.oldActionRead); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await f.dialog.isVisible(), true); assert.equal(await f.input("reason").inputValue(), "Replacement session notes");
    assert.equal(await f.input("reason").evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#action-error").textContent(), ""); assert.equal(await page.locator("#resume-action").isVisible(), false);
    assert.doesNotMatch(await page.locator("#status").textContent(), /Record saved|Obsolete/);
  });
}

for (const mobile of [false, true]) {
  test(`pending action ${mobile ? "mobile large text" : "desktop keyboard"} stays operable`, { timeout: 30000 }, async t => {
    const f = await setup(t, { mobile }), { page } = f;
    await f.open(); await f.fill(); await page.route("**/commands", route => route.abort("failed")); await f.save.click(); await f.unknown();
    if (mobile) await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await f.dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await f.save.focus(); await page.keyboard.press("Tab"); assert.equal(await page.locator("#cancel-action").evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Shift+Tab"); assert.equal(await f.save.evaluate(node => document.activeElement === node), true);
    await f.save.scrollIntoViewIfNeeded(); await f.capture(mobile ? "mobile-large-retry" : "desktop-retry");
    await page.keyboard.press("Escape"); await f.dialog.waitFor({ state: "hidden" }); await page.locator("#resume-action").click(); await f.unknown();
  });
}
