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
  // Human-experience sessions keep the Tasks nav (Board / New work) behind
  // the member's Advanced opt-in: src/human-experience.css hides
  // #tasks-destination until body.human-advanced. This check timing out on
  // the hidden button was #3842 — the entry point moved, the board did not.
  // Take the member's actual path (Settings → Advanced), the way the
  // sibling checks do (room-chrome.mjs enableHumanAdvanced).
  if (!(await page.locator("#tasks-board-open").isVisible())) {
    await page.locator("#human-advanced").waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
    if (await page.locator("#human-advanced").count()) await enableHumanAdvanced(page);
  }
  // Below 940px the sidebar (which holds the Board button) sits behind the
  // sidebar toggle by design; open it first when the toggle is the visible one.
  const toggle = page.locator("#sidebar-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.locator("#tasks-board-open").click();
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".live-chip").waitFor();
}

// The board re-renders once its data lands after opening, and that render
// REPLACES the #board-new-item form node — silently dropping anything
// already typed into the old node. Filling immediately after openBoard()
// races that replacement: the click then submits the replacement EMPTY
// form (the required title blocks it) and no claim is ever created. That
// race failed this check's S3 leg on its first hosted run (REV-4525).
// Form-node stability alone does not prove the render has happened —
// under load the first node can sit stable for seconds while the read
// is still in flight — so the settled state is keyed on the load itself:
// while the board's first read is in flight it paints .board-skeleton,
// and the completion paint that removes the skeleton is the render that
// settles the board (src/board-ui.js boardHtml: skeleton only while
// loading; later paints need a new work-claim event). The wait resolves
// only once the skeleton is gone AND the identical form node has then
// survived a 750 ms stability window, and it keeps waiting through any
// further replacement. No fixed delays: both legs observe DOM state.
async function settledBoardForm(page) {
  await page.waitForFunction(() => {
    if (document.querySelector(".board-skeleton")) {
      window.__qa5SettledForm = null;
      return false;
    }
    const form = document.querySelector("#board-new-item");
    if (!form) {
      window.__qa5SettledForm = null;
      return false;
    }
    if (window.__qa5SettledForm !== form) {
      window.__qa5SettledForm = form;
      window.__qa5SettledFormSince = Date.now();
      return false;
    }
    return Date.now() - window.__qa5SettledFormSince >= 750;
  }, null, { timeout: 15000 });
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
  // Fill only the settled form (see settledBoardForm): a fill that lands
  // on the pre-render node is wiped by the replacement and the submit
  // below would send the empty form. The read-backs pin the values on the
  // live node immediately before submitting, so any residual swap fails
  // here, at the fill, instead of surfacing as a silent 30 s API poll.
  await settledBoardForm(page);
  const titleInput = page.locator('#board-new-item input[name="title"]');
  await titleInput.fill("Slice C probe claim");
  await noteInput.fill("context for whoever picks this up");
  assert.equal(await titleInput.inputValue(), "Slice C probe claim", "title is on the live form");
  assert.equal(await noteInput.inputValue(), "context for whoever picks this up", "note is on the live form");
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
// The code travels as a claimed code: /join/<segment> is a claim the
// server preview judges (#3267), and a wrong-format code lands here on
// the error screen. A segment outside the token shape altogether
// ("/join/!!!") is by design "no code claimed" and gets the entry form
// instead (#1608), so it no longer exercises this path.
test("malformed invite code shows the error screen with the sign-in fallback", { timeout: 60000 }, async t => {
  const { origin, page } = await boot(t);
  await page.goto(`${origin}/join/RM-BOGUS123`);
  const error = page.locator("#join-error");
  await error.waitFor({ state: "visible" });
  assert.match(await page.locator("#join-error-title").textContent(), /Invite not found/);
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
  // Same post-open repaint as S3 races these reads: a boundingBox taken
  // while the completion paint swaps the form node resolves against the
  // detached node and comes back null. Measure only the settled board.
  await settledBoardForm(page);
  const openBox = await page.locator("#tasks-board-open").boundingBox();
  assert.ok(openBox.height >= 44, `board open button is ${openBox.height}px tall on coarse pointer`);
  const submitBox = await page.locator('#board-new-item button[type="submit"]').boundingBox();
  assert.ok(submitBox.height >= 44, `new-item submit is ${submitBox.height}px tall on coarse pointer`);
  const noteBox = await page.locator('#board-new-item input[name="note"]').boundingBox();
  assert.ok(noteBox.height >= 44, `note input is ${noteBox.height}px tall on coarse pointer`);
});
