// Slice C (QA5 UI/UX + a11y): user-testing for the newly merged UI work.
// Covers the render paths the unit tests don't reach:
//   - S1 (#1456): the viewer-aware empty-board copy is wired through boardHtml
//     (the pure emptyBoardCopy function has its own unit test; this guards the
//     call site that passes canWrite/signedIn).
//   - S3 (#1456): the New-item form's Note field is label-associated and the
//     note reaches the created claim end to end (the F-parity-1 regression).
//   - D-c (#1459): the client-side boot() fail path shows the error screen
//     with the back-to-sign-in fallback for a malformed invite code.
//   - 320px viewport: no horizontal overflow on the main page or board dialog.
//   - Coarse pointers: the 44px touch-target floor holds on board controls.
// Real browser + disposable loopback server; no external identity.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { enableHumanAdvanced } from "./room-chrome.mjs";

async function boot(t, { viewport = { width: 1280, height: 800 }, coarse = false } = {}) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, hasTouch: coarse, isMobile: coarse });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  return { fixture, origin, page };
}

async function openBoard(page) {
  await page.locator("#main").waitFor({ state: "visible" });
  await enableHumanAdvanced(page);
  // Below 940px the sidebar (which holds the Board button) sits behind the
  // sidebar toggle by design; open it first when the toggle is the visible one.
  const toggle = page.locator("#sidebar-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.locator("#tasks-board-open").click();
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".live-chip").waitFor();
}

// S1: the empty-board copy a non-writer sees must be their actual options,
// not the writer's "Claim work here" line with no form and no next step.
test("board empty state shows the ask-owner copy to a signed-in non-writer", { timeout: 90000 }, async t => {
  const { fixture, origin, page } = await boot(t);
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "member.added",
    data: { memberId: "reader", displayName: "Reader", kind: "human", permissions: [] }
  });
  const reader = fixture.store.issueAccessKey("commons", "reader");
  await page.goto(origin);
  await signInFixture(page, reader);
  await openBoard(page);
  const copy = await page.locator(".board-empty").textContent();
  assert.match(copy, /ask the room owner for access/, "non-writer copy names the next step");
  assert.doesNotMatch(copy, /Claim work here/, "non-writer never sees the writer line");
  assert.equal(await page.locator("#board-new-item").count(), 0, "no new-item form for non-writers");
});

// Control: a writer on an empty board sees the claim line and the form.
test("board empty state shows the claim copy and form to a writer", { timeout: 90000 }, async t => {
  const { fixture, origin, page } = await boot(t);
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await openBoard(page);
  const copy = await page.locator(".board-empty").textContent();
  assert.match(copy, /Claim work here/, "writer sees the claim line");
  assert.equal(await page.locator("#board-new-item").count(), 1, "writer gets the new-item form");
});

// S3: the Note field is a real labeled control and its value lands on the claim.
test("new-item note field is labeled and reaches the created claim", { timeout: 90000 }, async t => {
  const { fixture, origin, page } = await boot(t);
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  let releaseRead, reachedRead;
  const heldRead = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { reachedRead = resolve; });
  await page.route("**/work-claims/status", async route => {
    const response = await route.fetch(); reachedRead(); await heldRead;
    await route.fulfill({ response });
  });
  t.after(() => releaseRead());
  await openBoard(page); await readStarted;
  const noteInput = page.locator('#board-new-item input[name="note"]');
  assert.equal(await noteInput.count(), 1, "note input exists");
  const label = await page.locator('#board-new-item label:has(input[name="note"])').textContent();
  assert.match(label, /Note/, "note input is label-associated");
  await page.locator('#board-new-item input[name="title"]').fill("Slice C probe claim");
  await noteInput.fill("context for whoever picks this up");
  assert.equal(await page.locator('#board-new-item input[name="title"]').inputValue(), "Slice C probe claim", "title remains while entering the optional note");
  await noteInput.press("Home"); await noteInput.press("Shift+ArrowRight");
  const settledRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/work-claims/status"));
  releaseRead(); await settledRead;
  // A fresh board paint must complete before checking the retained values.
  await page.waitForFunction(() => document.querySelector("#work-board .live-chip")?.textContent === "Deploy status unknown");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.querySelector('#board-new-item input[name="note"]') === document.activeElement), true, "refresh keeps the active draft field focused");
  assert.deepEqual(await noteInput.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 1], "refresh preserves the selection");
  assert.equal(await page.locator('#board-new-item input[name="title"]').inputValue(), "Slice C probe claim", "late board data cannot erase the entered title");
  assert.equal(await noteInput.inputValue(), "context for whoever picks this up", "late board data cannot erase the note");
  const submitted = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/rooms/commons/work-claims");
  await page.locator('#board-new-item button[type="submit"]').click();
  const response = await submitted;
  assert.equal(response.status(), 201, "the actual form request creates a claim");
  const receipt = await response.json();
  const claim = fixture.store.workClaims.get("commons", receipt.id);
  assert.equal(claim?.title, "Slice C probe claim", "the submitted claim is durable, not just optimistic UI");
  await page.locator("article h4", { hasText: "Slice C probe claim" }).waitFor();
  // The create note is stored on the "created" history stamp (server/work-claims.mjs).
  const created = (claim.history ?? []).find(entry => entry.action === "created");
  assert.equal(created?.note, "context for whoever picks this up", "note survived the form wiring");
  assert.equal(await page.locator('#board-new-item input[name="title"]').inputValue(), "", "a confirmed unchanged submission clears its draft");
  assert.equal(await noteInput.inputValue(), "");

  for (const next of [
    { title: "Keep my next idea", note: "Written while confirmation was pending" },
    { title: "", note: "" }
  ]) {
    let releaseReceipt, reachedReceipt;
    const receiptHeld = new Promise(resolve => { releaseReceipt = resolve; });
    const receiptStarted = new Promise(resolve => { reachedReceipt = resolve; });
    t.after(() => releaseReceipt());
    await page.route("**/work-claims", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); reachedReceipt(); await receiptHeld;
      await route.fulfill({ response });
    });
    const title = next.title ? "Second submitted item" : "Third submitted item";
    await page.locator('#board-new-item input[name="title"]').fill(title);
    const second = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/work-claims"));
    await page.locator('#board-new-item button[type="submit"]').click(); await receiptStarted;
    await page.locator('#board-new-item input[name="title"]').fill(next.title);
    await noteInput.fill(next.note);
    releaseReceipt(); assert.equal((await second).status(), 201);
    await page.locator("article h4", { hasText: title }).waitFor();
    assert.equal(await page.locator('#board-new-item input[name="title"]').inputValue(), next.title, "an older receipt cannot change newer editing");
    assert.equal(await noteInput.inputValue(), next.note);
    assert.equal(await page.evaluate(() => document.querySelector('#board-new-item input[name="note"]') === document.activeElement), true, "confirmation does not steal focus, including after clearing every field");
    await page.unroute("**/work-claims");
  }
  let releaseRefresh, reachedRefresh;
  const refreshHeld = new Promise(resolve => { releaseRefresh = resolve; });
  const refreshStarted = new Promise(resolve => { reachedRefresh = resolve; });
  t.after(() => releaseRefresh());
  await page.unroute("**/work-claims/status");
  await page.route("**/work-claims/status", async route => {
    const response = await route.fetch(); reachedRefresh(); await refreshHeld;
    await route.fulfill({ response });
  });
  await page.locator('#board-new-item input[name="title"]').fill("Fourth submitted item");
  await page.locator('#board-new-item button[type="submit"]').click(); await refreshStarted;
  assert.equal(await page.locator('#board-new-item input[name="title"]').inputValue(), "", "acknowledged unchanged draft resets before the follow-up read");
  await noteInput.fill("Started after the successful receipt");
  releaseRefresh();
  await page.locator("article h4", { hasText: "Fourth submitted item" }).waitFor();
  assert.equal(await noteInput.inputValue(), "Started after the successful receipt");
  assert.equal(await page.evaluate(() => document.querySelector('#board-new-item input[name="note"]') === document.activeElement), true, "editing after acknowledgment also keeps focus through refresh");
});

// D-c: a malformed invite code renders the error screen with the sign-in
// fallback — the client boot() fail path, not just the server markup.
test("malformed invite code shows the error screen with the sign-in fallback", { timeout: 60000 }, async t => {
  const { origin, page } = await boot(t);
  await page.goto(`${origin}/join/!!!`);
  const error = page.locator("#join-error");
  await error.waitFor({ state: "visible" });
  assert.match(await page.locator("#join-error-title").textContent(), /No invite found/);
  const home = page.locator("#join-home-link");
  assert.equal(await home.count(), 1, "back-to-sign-in link is present");
  assert.ok(await home.isVisible(), "back-to-sign-in link is visible");
  await home.click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Log in", exact: true }).isVisible(), true, "recovery reaches a usable sign-in");
});

// 320px: no horizontal overflow on the main page or the board dialog.
test("320px viewport has no horizontal overflow on the main page or board", { timeout: 90000 }, async t => {
  const { fixture, origin, page } = await boot(t, { viewport: { width: 320, height: 900 } });
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const mainOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(mainOverflow <= 1, `main page overflows by ${mainOverflow}px at 320px`);
  await openBoard(page);
  const dialogOverflow = await page.evaluate(() => {
    const dialog = document.querySelector("#board-dialog");
    return dialog.scrollWidth - dialog.clientWidth;
  });
  assert.ok(dialogOverflow <= 1, `board dialog overflows by ${dialogOverflow}px at 320px`);
});

// Coarse pointers: the 44px touch-target floor holds on board controls.
test("coarse pointer keeps 44px touch targets on board controls", { timeout: 90000 }, async t => {
  const { fixture, origin, page } = await boot(t, { viewport: { width: 390, height: 844 }, coarse: true });
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  // At 390px the sidebar toggle is the visible board entry point (the sidebar
  // sits behind it below 940px); it carries the icon-button coarse rule.
  const toggleBox = await page.locator("#sidebar-toggle").boundingBox();
  assert.ok(toggleBox.width >= 44 && toggleBox.height >= 44,
    `sidebar toggle is ${toggleBox.width}x${toggleBox.height}px on coarse pointer`);
  await openBoard(page);
  const openBox = await page.locator("#tasks-board-open").boundingBox();
  assert.ok(openBox.height >= 44, `board open button is ${openBox.height}px tall on coarse pointer`);
  const submitBox = await page.locator('#board-new-item button[type="submit"]').boundingBox();
  assert.ok(submitBox.height >= 44, `new-item submit is ${submitBox.height}px tall on coarse pointer`);
  const noteBox = await page.locator('#board-new-item input[name="note"]').boundingBox();
  assert.ok(noteBox.height >= 44, `note input is ${noteBox.height}px tall on coarse pointer`);
});
