// Tasks › Board: claim actions, linked work and return journeys, 390px, and axe.
// The room page and the work-claim HTTP API are the boundary. No test doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";

const shots = "/opt/cursor/artifacts/screenshots";

function github() {
  const body = JSON.stringify({ sha: "c".repeat(40) });
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body)
  });
}

async function post(page, origin, path, data, status = 200) {
  const session = await page.request.get(`${origin}/api/session`);
  assert.equal(session.ok(), true);
  const { csrf } = await session.json();
  const response = await page.request.post(`${origin}/api/rooms/commons${path}`, {
    headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data
  });
  assert.equal(response.status(), status, await response.text());
}

async function axe(page) {
  const result = await new AxeBuilder({ page })
    .include("#board-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter(item => item.impact === "serious" || item.impact === "critical");
  assert.deepEqual(serious.map(item => `${item.impact} ${item.id}`), []);
}

test("board columns, keyboard claim, linked work returns, chat line, 390px, and axe", { timeout: 120000 }, async t => {
  mkdirSync(shots, { recursive: true });
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#tasks-board-open").click();
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".board-empty").waitFor();
  assert.equal(await page.locator(".board-empty").innerText(), "Claim work here so people and agents don't collide.");
  assert.equal(await page.locator("#board-new-item").count(), 1);
  assert.match(await page.locator(".live-chip").innerText(), /Deploy status unknown|Live matches main|Live is behind main/);
  await page.locator("#board-new-item [name=title]").fill("Fix login copy");
  await page.locator("#board-new-item [name=files]").fill("src/board-ui.js");
  await page.locator("#board-new-item button[type=submit]").click();
  await page.locator("article h4", { hasText: "Fix login copy" }).waitFor();
  assert.equal(await page.locator("#board-status").innerText(), "Opened 'Fix login copy'");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("article")?.querySelector("h4")?.textContent), "Fix login copy");
  await page.screenshot({ path: `${shots}/board-before.png` });
  await page.screenshot({ path: "test-results/board-before.png" });
  await page.locator("#board-close").click();

  await post(page, origin, "/work-claims", { id: "notes", title: "Write the notes" }, 201);
  await post(page, origin, "/work-claims", {
    id: "copy", title: "Write the copy", files: ["src/board-ui.js", "src/board.css", "docs/WORK-CLAIMS.md"]
  }, 201);
  await post(page, origin, "/work-claims/copy/claim", {});
  await post(page, origin, "/work-claims", {
    id: "reviewpr", title: "Review the pull", pullRequest: "https://github.com/Uuriko/project-room/pull/1303"
  }, 201);
  await post(page, origin, "/work-claims/reviewpr/claim", {});
  await post(page, origin, "/work-claims", { id: "stuck", title: "Stuck on a check" }, 201);
  await post(page, origin, "/work-claims/stuck/claim", {});
  await post(page, origin, "/work-claims/stuck/update", { state: "blocked" });
  await post(page, origin, "/work-claims", { id: "shipped", title: "Shipped the notes" }, 201);
  await post(page, origin, "/work-claims/shipped/claim", {});
  await post(page, origin, "/work-claims/shipped/update", { state: "in_progress" });
  await post(page, origin, "/work-claims/shipped/update", { state: "done" });
  await post(page, origin, "/work-claims", { id: "waiting", title: "After the copy", dependsOn: ["copy"] }, 201);

  const copyLine = page.locator("[data-claim-update='copy']");
  await copyLine.waitFor();
  assert.equal(await copyLine.count(), 1);
  assert.match(await copyLine.innerText(), /claimed Write the copy · 3 files · lease \d+h/);

  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").waitFor();
  await page.keyboard.type("board");
  await page.keyboard.press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator("article[data-claim-id='notes']").waitFor();
  const card = (name, id) => page.locator(`[aria-labelledby='board-col-${name}'] > article[data-claim-id='${id}']`);
  assert.equal(await card("ready", "notes").count(), 1);
  assert.equal(await card("ready", "waiting").count(), 0);
  assert.equal(await card("claimed", "copy").count(), 1);
  assert.equal(await card("blocked", "stuck").count(), 1);
  assert.equal(await card("review", "reviewpr").count(), 1);
  assert.match(await card("review", "reviewpr").innerText(), /PR #1303/);
  assert.equal(await card("landed", "shipped").count(), 1);
  assert.equal(await page.locator("#board-close-stale").count(), 1);

  for (let step = 0; step < 40; step += 1) {
    if (await page.evaluate(() => document.activeElement?.dataset?.claimAction === "claim" && document.activeElement?.dataset?.claimId === "notes")) break;
    await page.keyboard.press("Tab");
  }
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.claimId), "notes");
  await page.keyboard.press("Enter");
  await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='notes']").waitFor();
  assert.equal(await page.locator("[aria-labelledby='board-col-ready'] article[data-claim-id='notes']").count(), 0);
  assert.equal(await page.locator("#board-status").innerText(), "Claimed 'Write the notes'");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("article")?.dataset.claimId), "notes");
  const follow = async (id, action, status) => {
    await page.locator(`article[data-claim-id='${id}'] [data-claim-action='${action}']`).click();
    await page.waitForFunction(expected => document.querySelector("#board-status")?.textContent === expected, status);
    assert.equal(await page.evaluate(claimId => document.activeElement?.closest("article")?.dataset.claimId, id), id);
  };
  await follow("notes", "renew", "Renewed 'Write the notes'");
  await follow("notes", "progress", "Marked 'Write the notes' in progress");
  await follow("notes", "done", "Done 'Write the notes'");
  assert.equal(await page.locator("article[data-claim-id='notes'] .claim-lease").count(), 0);
  await follow("copy", "release", "Released 'Write the copy'");
  await page.screenshot({ path: `${shots}/board-after.png` });
  await page.screenshot({ path: `${shots}/board-1280.png` });
  await page.screenshot({ path: "test-results/board-after.png" });
  await axe(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#board-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: `${shots}/board-after-390.png` });
  await page.screenshot({ path: "test-results/board-after-390.png" });
  await axe(page);

  await page.locator("#board-close").click();
  const workId = "board:canonical", claimId = "board-linked";
  const propose = (id, title) => fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "work.proposed",
    data: { workItemId: id, title, definitionOfDone: "Open the existing work without changing it.",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false }
  });
  propose(workId, "Canonical work behind the Board card");
  propose(claimId, "Different work with the claim's ID");
  propose("board-coincidence", "Unlinked work with a coincidentally equal ID");
  const updatedAt = new Date().toISOString();
  // REST creation does not accept workItemId. These persisted legacy rows
  // exercise the real list response, including absent and unresolved links.
  for (const item of [
    { id: claimId, title: "Z linked Board card", workItemId: workId },
    { id: "board-null", title: "Legacy card without a work link", workItemId: null },
    { id: "board-dangling", title: "Legacy card with a missing target", workItemId: "board:missing" },
    { id: "board-coincidence", title: "Legacy card whose ID matches work", workItemId: null },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `board-context-${index}`, title: `Navigation context ${index}` }))
  ]) seedClaim(fixture.store, { state: "unclaimed", updatedAt, ...item });
  // A normal claim event makes the already-open client refresh its Board list.
  await post(page, origin, "/work-claims", { id: "board-refresh", title: "Navigation refresh" }, 201);
  await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
    fixture.store.room("commons").sequence);
  const navigationState = () => {
    const room = fixture.store.room("commons");
    return {
      sequence: room.sequence,
      workItems: structuredClone(room.state.workItems),
      events: fixture.store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all("commons"),
      claims: fixture.store.db.prepare("SELECT claim_id, item_json, updated_at FROM work_claims WHERE room_id=? ORDER BY claim_id").all("commons")
    };
  };
  const beforeNavigation = navigationState();
  const dialog = page.locator("#board-dialog");
  const linked = page.locator(`article[data-claim-id='${claimId}'] h4 a[data-open-work]`);
  const record = page.locator(`[data-work-record-id='${workId}']`);
  const canonicalHash = `#pr-record/work/${encodeURIComponent(workId)}`;
  const assertWork = async () => {
    await record.waitFor({ state: "visible" });
    await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, workId);
    assert.equal(new URL(page.url()).hash, canonicalHash);
    assert.equal(await dialog.evaluate(node => node.open), false, "the Board no longer traps focus over work");
    assert.equal(await record.locator("h3").innerText(), "Canonical work behind the Board card");
    assert.equal(await record.locator(".work-details").evaluate(node => node.open), true);
    assert.equal(await page.locator("#work-navigation-return").innerText(), "Back to Board");
  };
  const assertBoardReturn = async (url, scrollTop) => {
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(id => document.activeElement?.closest("article")?.dataset.claimId === id, claimId);
    assert.equal(page.url(), url);
    assert.equal(await linked.evaluate(node => node === document.activeElement), true, "return restores the exact title link");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - scrollTop) <= 1, "return preserves Board scroll");
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.keyboard.press("Control+k");
    await page.locator("#room-actions-query").fill("board");
    await page.keyboard.press("Enter");
    await linked.waitFor({ state: "visible" });
    assert.equal(await linked.getAttribute("href"), canonicalHash);
    assert.equal(await linked.getAttribute("data-open-work"), workId);
    const boardUrl = page.url();
    for (const id of ["board-null", "board-dangling", "board-coincidence"]) {
      const heading = page.locator(`article[data-claim-id='${id}'] h4`);
      assert.equal(await heading.count(), 1);
      assert.equal(await heading.locator("a, [data-open-work]").count(), 0, `${id} is not a fabricated work link`);
      await heading.click();
      assert.equal(page.url(), boardUrl);
      assert.equal(await dialog.evaluate(node => node.open), true);
    }
    await page.locator("#board-close").focus();
    for (let step = 0; step < 100; step += 1) {
      if (await linked.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    assert.equal(await linked.evaluate(node => node === document.activeElement), true, `${viewport.width}px title is keyboard reachable`);
    const scrollTop = await dialog.evaluate(node => node.scrollTop);
    assert.ok(scrollTop > 0, "the return journey starts from a scrolled Board");
    await page.keyboard.press("Enter");
    await assertWork();
    await page.locator("#work-navigation-return").focus();
    await page.keyboard.press("Enter");
    await assertBoardReturn(boardUrl, scrollTop);

    await page.keyboard.press("Enter");
    await assertWork();
    await page.goBack();
    await assertBoardReturn(boardUrl, scrollTop);
    await page.goForward();
    await assertWork();
    await page.locator("#work-navigation-return").focus();
    await page.keyboard.press("Enter");
    await assertBoardReturn(boardUrl, scrollTop);
    assert.deepEqual(navigationState(), beforeNavigation, "Board/work navigation changes no Room events, work items, or claim rows");
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ path: `test-results/board-work-return-${viewport.width}.png` });
    await axe(page);
    await page.locator("#board-close").click();
  }

  // Same task, new source surface: Search -> task A -> Board -> task A.
  // The Board must close and become the return destination without pushing A twice.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSearch(page);
  await page.locator("#message-search").fill("Canonical work behind the Board card");
  await page.locator(`#search-list [data-open-work="${workId}"]`).press("Enter");
  await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, workId);
  assert.equal(await page.locator("#work-navigation-return").innerText(), "Back to conversation");
  const sameTargetHistoryLength = await page.evaluate(() => history.length);
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.keyboard.press("Enter");
  await linked.press("Enter");
  await assertWork();
  assert.equal(await page.evaluate(() => history.length), sameTargetHistoryLength);
  await page.locator("#work-navigation-return").press("Enter");
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(id => document.activeElement?.closest("article")?.dataset.claimId === id, claimId);
  assert.equal(await linked.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(navigationState(), beforeNavigation);

  // A delayed Back return belongs to one opening of the dialog. Closing or
  // cancelling it must not let that return steal focus from a later opening.
  for (const dismiss of ["Close", "Escape"]) {
    await linked.focus();
    const abandonedScroll = await dialog.evaluate(node => node.scrollTop);
    assert.ok(abandonedScroll > 0, `${dismiss}: the abandoned origin is scrolled`);
    await linked.press("Enter");
    await assertWork();
    const refreshId = `board-delayed-${dismiss.toLowerCase()}`;
    await post(page, origin, "/work-claims", { id: refreshId, title: `A delayed Board refresh after ${dismiss}` }, 201);
    await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
      fixture.store.room("commons").sequence);
    const beforeDelayedReturn = navigationState();
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const listPattern = "**/api/rooms/commons/work-claims?*";
    let captured = false;
    const holdList = async route => {
      if (captured || route.request().method() !== "GET") return route.continue();
      captured = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      arrived.resolve();
      await release.promise;
      await route.fulfill({ response });
    };
    await page.route(listPattern, holdList);
    try {
      await page.goBack();
      await arrived.promise;
      await dialog.waitFor({ state: "visible" });
      assert.equal(await page.locator(`article[data-claim-id='${refreshId}']`).count(), 0, "the actual list response is still held");
      if (dismiss === "Close") await page.locator("#board-close").click();
      else await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.locator("#tasks-board-open").click();
      await dialog.waitFor({ state: "visible" });
      await page.locator("#board-close").focus();
      const reopenedUrl = page.url();
      const reopenedScroll = await dialog.evaluate(node => node.scrollTop);
      assert.ok(Math.abs(reopenedScroll - abandonedScroll) > 1, `${dismiss}: the new opening has its own scroll position`);
      const delivered = page.waitForResponse(response => response.request().method() === "GET"
        && new URL(response.url()).pathname === "/api/rooms/commons/work-claims");
      release.resolve();
      await (await delivered).finished();
      // This new, persisted claim proves the unmodified held response painted.
      // Give its promise continuations a rendered frame before checking focus.
      await page.locator(`article[data-claim-id='${refreshId}']`).waitFor({ state: "attached" });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await dialog.evaluate(node => node.open), true);
      assert.equal(page.url(), reopenedUrl);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "board-close", `${dismiss}: an abandoned return cannot steal the new opening's focus`);
      assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - reopenedScroll) <= 1, `${dismiss}: an abandoned return cannot restore its old scroll`);
      assert.deepEqual(navigationState(), beforeDelayedReturn, `${dismiss}: returning and reopening change no Room state`);
    } finally {
      release.resolve();
      await page.unroute(listPattern, holdList);
    }
  }

  // A persisted origin may disappear while its canonical work is open.
  // The durable registry is also used by land-queue removal; there is no
  // standalone claim DELETE route. A real HTTP claim event refreshes the UI.
  const removedOriginUrl = page.url();
  await linked.press("Enter");
  await assertWork();
  fixture.store.workClaims.delete("commons", claimId);
  await post(page, origin, "/work-claims/board-refresh/claim", {});
  await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
    fixture.store.room("commons").sequence);
  await assertWork();
  const missingClaim = await page.request.get(`${origin}/api/rooms/commons/work-claims/${claimId}`);
  assert.equal(missingClaim.status(), 404, "the origin is absent from the public claim API");
  const afterOriginRemoval = navigationState();
  assert.deepEqual(afterOriginRemoval.workItems, beforeNavigation.workItems, "removing the claim leaves canonical work intact");
  const assertRemovedOriginReturn = async () => {
    await dialog.waitFor({ state: "visible" });
    // The lazy Board refreshes when reopened. Wait for actual detachment,
    // not merely a hidden dialog, before checking the final fallback focus.
    await page.locator(`article[data-claim-id='${claimId}']`).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.id === "board-close");
    assert.equal(page.url(), removedOriginUrl);
    assert.equal(await page.locator("#board-close").isVisible(), true, "the missing origin falls back to the Board close control");
    assert.equal(await page.locator("#board-close").evaluate(node => {
      const box = node.getBoundingClientRect(), board = node.closest("dialog");
      const bounds = board.getBoundingClientRect();
      const top = Math.max(0, bounds.top + board.clientTop);
      const left = Math.max(0, bounds.left + board.clientLeft);
      const bottom = Math.min(innerHeight, bounds.top + board.clientTop + board.clientHeight);
      const right = Math.min(innerWidth, bounds.left + board.clientLeft + board.clientWidth);
      return box.width > 0 && box.height > 0 && box.top >= top - 1 && box.left >= left - 1
        && box.bottom <= bottom + 1 && box.right <= right + 1;
    }), true, "fallback focus is fully visible inside the Board viewport");
    assert.equal(await page.locator(`article[data-claim-id='${claimId}']`).count(), 0, "return does not recreate the removed card");
    assert.deepEqual(navigationState(), afterOriginRemoval, "removed-origin return creates no work, events, or claim rows");
  };
  await page.locator("#work-navigation-return").press("Enter");
  await assertRemovedOriginReturn();
  await page.goForward();
  await assertWork();
  await page.goBack();
  await assertRemovedOriginReturn();
});

function seedClaim(store, item) {
  store.workClaims.set("commons", {
    files: [], dependsOn: [], reviews: [], tags: [], blobs: [], attestations: [],
    owner: null, history: [{ at: item.updatedAt, agentId: "owner", action: "created", note: null }],
    ...item
  });
}

// Rendering, dependency navigation and readiness are the UI boundary here.
// The projection matrix separately owns classification/old-completion filtering.
test("waiting prerequisites stay visible, link by keyboard, and become claimable only when ready", { timeout: 120000 }, async t => {
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const workId = "waiting:prerequisite", missingId = `unavailable-${"prerequisite-".repeat(7)}`;
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "work.proposed",
    data: { workItemId: workId, title: "Prepare the handoff", definitionOfDone: "Record the prerequisite result.",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false }
  });
  const updatedAt = new Date().toISOString();
  // Mirrored/legacy claim links are persisted through the existing registry;
  // the browser still consumes the real HTTP list response and navigation.
  for (const item of [
    { id: "prerequisite", title: "Prepare the handoff", workItemId: workId },
    { id: "dependent", title: "Continue after the handoff", dependsOn: ["old-completion", "prerequisite"],
      chain: [{ kind: "handoff", targetId: "prerequisite", at: updatedAt, actorId: "owner" }] },
    { id: "unknown", title: "Find the missing prerequisite", dependsOn: [missingId] },
    { id: "available", title: "Unrelated ready task" },
    { id: "old-completion", title: "Earlier completed prerequisite", state: "done", owner: "owner",
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }
  ]) seedClaim(fixture.store, { state: "unclaimed", updatedAt, ...item });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const snapshot = () => ({
    sequence: fixture.store.room("commons").sequence,
    workItems: structuredClone(fixture.store.room("commons").state.workItems),
    claims: fixture.store.db.prepare("SELECT claim_id, item_json, updated_at FROM work_claims WHERE room_id=? ORDER BY claim_id").all("commons")
  });
  const beforeNavigation = snapshot();
  const dialog = page.locator("#board-dialog");
  const openBoard = async () => {
    await page.keyboard.press("Control+k");
    await page.locator("#room-actions-query").waitFor({ state: "visible" });
    await page.locator("#room-actions-query").fill("board");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "visible" });
  };
  const dependent = page.locator("article[data-claim-id='dependent']");
  const unknown = page.locator("article[data-claim-id='unknown']");
  const link = dependent.locator(".claim-deps [data-open-work]");
  const boardIds = () => page.locator("#work-board article").evaluateAll(nodes => nodes.map(node => node.dataset.claimId).sort());
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await openBoard();
    await dependent.waitFor({ state: "visible" });
    assert.equal(await dependent.evaluate(node => node.parentElement.getAttribute("aria-labelledby")), "board-col-blocked");
    assert.equal(await page.locator("#board-col-blocked").innerText(), "Blocked · 2 waiting");
    assert.match(await dependent.innerText(), /Waiting for 1 prerequisite before claiming/);
    assert.match(await dependent.innerText(), /Earlier completed prerequisite.*Completed/);
    assert.match(await dependent.innerText(), /Prepare the handoff.*Unclaimed; needs an owner/);
    assert.equal(await dependent.locator("[data-claim-action='claim']").count(), 0);
    assert.match(await unknown.innerText(), /Not loaded or unavailable; status unknown/);
    assert.equal(await unknown.locator("a, [data-claim-action='claim']").count(), 0);
    assert.deepEqual(await boardIds(), ["available", "dependent", "prerequisite", "unknown"]);
    assert.equal(await link.getAttribute("href"), `#pr-record/work/${encodeURIComponent(workId)}`);
    assert.equal(await dependent.locator(".claim-chain [data-open-work]").getAttribute("href"), await link.getAttribute("href"));
    await page.locator("#board-close").focus();
    for (let step = 0; step < 80; step += 1) {
      if (await link.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    assert.equal(await link.evaluate(node => node === document.activeElement), true, `${width}px prerequisite is keyboard reachable`);
    const scrollTop = await dialog.evaluate(node => node.scrollTop);
    await page.keyboard.press("Enter");
    await page.locator(`[data-work-record-id='${workId}']`).waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate(node => node.open), false);
    await page.locator("#work-navigation-return").press("Enter");
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "claim-dependency:dependent:1");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - scrollTop) <= 1);

    // Same claim and target, different control: preserve the most recent
    // dependency/chain link and Board scroll without another history entry.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    const targetUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);
    await openBoard();
    await dialog.waitFor({ state: "visible" });
    const chainLink = dependent.locator(".claim-chain [data-open-work]");
    await chainLink.focus();
    const latestScroll = await dialog.evaluate(node => {
      const maximum = node.scrollHeight - node.clientHeight;
      node.scrollTop = node.scrollTop > maximum / 2 ? 0 : maximum;
      return node.scrollTop;
    });
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(page.url(), targetUrl);
    assert.equal(await page.evaluate(() => history.length), historyLength);
    await page.locator("#work-navigation-return").press("Enter");
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "claim-chain:dependent:0");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - latestScroll) <= 1, "same-target return keeps the latest Board scroll");
    assert.deepEqual(snapshot(), beforeNavigation, "reading and following prerequisites writes no work, claim or Room event");
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await dependent.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/board-waiting-${width}.png` });
    await axe(page);
    await page.locator("#board-close").click();
  }
  await openBoard();
  await post(page, origin, "/work-claims/prerequisite/claim", {});
  await post(page, origin, "/work-claims/prerequisite/update", { state: "in_progress" });
  await post(page, origin, "/work-claims/prerequisite/update", { state: "done" });
  await page.locator("[aria-labelledby='board-col-ready'] article[data-claim-id='dependent']").waitFor();
  assert.equal(await dependent.locator(".claim-waiting").count(), 0);
  assert.equal(await page.locator("#board-col-blocked").innerText(), "Blocked · 1 waiting");
  assert.deepEqual(await boardIds(), ["available", "dependent", "prerequisite", "unknown"]);
  const claim = dependent.locator("[data-claim-action='claim']");
  await claim.focus();
  await page.keyboard.press("Enter");
  await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='dependent']").waitFor();
  assert.equal(fixture.store.workClaims.get("commons", "dependent").owner, "owner");
  assert.equal(fixture.store.workClaims.get("commons", "unknown").owner, null);
  assert.equal(await unknown.locator("[data-claim-action='claim']").count(), 0);
});

test("first board open requests at most two list pages when most claims are old", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (let index = 0; index < 100; index += 1) seedClaim(fixture.store, { id: `open-${index}`, title: `Open ${index}`, state: "unclaimed", updatedAt: recent });
  for (let index = 0; index < 500; index += 1) seedClaim(fixture.store, { id: `old-${index}`, title: `Old ${index}`, state: "done", owner: "owner", updatedAt: old });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  let lists = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && /\/work-claims$/.test(url.pathname)) lists += 1;
  });
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#tasks-board-open").click();
  await page.locator(".board-older").waitFor();
  await page.locator("article[data-claim-id='open-0']").waitFor();
  assert.equal(lists <= 2, true, `list requests: ${lists}`);
  assert.equal(await page.locator(".board-older").innerText(), "Older landed work is in the API");
});

test("a read-only member does not see the new item form", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "member.added",
    data: { memberId: "reader", displayName: "Reader", kind: "human", permissions: [] }
  });
  const reader = fixture.store.issueAccessKey("commons", "reader");
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await signInFixture(page, reader);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#tasks-board-open").click();
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".live-chip").waitFor();
  assert.equal(await page.locator("#board-new-item").count(), 0);
});
