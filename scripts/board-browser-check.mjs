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
});

function seedClaim(store, item) {
  store.workClaims.set("commons", {
    files: [], dependsOn: [], reviews: [], tags: [], blobs: [], attestations: [],
    owner: null, history: [{ at: item.updatedAt, agentId: "owner", action: "created", note: null }],
    ...item
  });
}

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
