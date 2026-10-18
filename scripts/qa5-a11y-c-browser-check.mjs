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
  await openBoard(page);
  const noteInput = page.locator('#board-new-item input[name="note"]');
  assert.equal(await noteInput.count(), 1, "note input exists");
  const label = await page.locator('#board-new-item label:has(input[name="note"])').textContent();
  assert.match(label, /Note/, "note input is label-associated");
  await page.locator('#board-new-item input[name="title"]').fill("Slice C probe claim");
  await noteInput.fill("context for whoever picks this up");
  await page.locator('#board-new-item button[type="submit"]').click();
  // Poll the API for the created claim directly: the board's status line is
  // best-effort UI, the claim record is the S3 contract.
  let claim = null;
  for (let i = 0; i < 60 && !claim; i += 1) {
    const res = await page.request.get(`${origin}/api/rooms/commons/work-claims?limit=50`);
    const body = await res.json();
    claim = (body.claims ?? []).find(c => c.title === "Slice C probe claim");
    if (!claim) await page.waitForTimeout(500);
  }
  assert.ok(claim, "claim was created through the form");
  // The create note is stored on the "created" history stamp (server/work-claims.mjs).
  const created = (claim.history ?? []).find(entry => entry.action === "created");
  assert.equal(created?.note, "context for whoever picks this up", "note survived the form wiring");
});

// D-c: a malformed invite code renders the error screen with the sign-in
// fallback — the client boot() fail path, not just the server markup.
test("malformed invite code shows the error screen with the sign-in fallback", { timeout: 60000 }, async t => {
  const { origin, page } = await boot(t);
  await page.goto(`${origin}/join/!!!`);
  const error = page.locator("#join-error");
  await error.waitFor({ state: "visible" });
  assert.match(await page.locator("#join-error-title").textContent(), /Invite link problem/);
  const home = page.locator("#join-home-link");
  assert.equal(await home.count(), 1, "back-to-sign-in link is present");
  assert.ok(await home.isVisible(), "back-to-sign-in link is visible");
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
