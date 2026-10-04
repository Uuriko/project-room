// NR-B: the action dialog's async exact-text load must not leave the focused
// review-notes textarea clipped by the dialog's bottom edge at 320x900.
// Regression: without the post-load focus re-assert in loadActionText, a slow
// exact-text response shifts layout after the browser's focus scroll already
// ran, and the textarea (plus its focus outline) ends up below the visible
// edge of the dialog.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t) {
  const f = createAcceptanceFixture();
  const workItemId = "nrb-focus-scroll";
  const body = "A quiet room\n\nCafe - one clear next step.\n\nThe streaming serializer pages through the event cursor in 64KB chunks. Ordering holds across chunk boundaries, including boundaries inside multi-event transaction envelopes, verified on the 42MB fixture history. The terminal checksum record covers the full byte range and matches the admission policy digest.\n";
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send(T.WORK_PROPOSED, { workItemId, title: "A quiet room", definitionOfDone: "Short text with one next step.", mode: "read",
    accountableMemberId: "owner", ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const posted = send(T.MESSAGE_POSTED, { messageId: "nrb-draft", workItemId, packetId: "nrb-packet", basisRevision: 1, body });
  mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "nrb-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: item().receipt?.eventId ?? null, producerId: "owner",
    summary: "A quiet room, streamed and checksummed.", nextAction: "Wire the checksum into admission." });
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, origin, browser, workItemId, body };
}

for (const theme of ["light", "dark"]) {
  test(`action dialog: slow exact-text load keeps the focused notes textarea fully visible at 320x900 (${theme})`, { timeout: 90000 }, async t => {
    const { f, origin, browser, workItemId, body } = await setup(t);
    const ctx = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(15000);
    // Force the NR-B layout shift: exact text lands well after the keyboard flow.
    await page.route("**/work-result?**", async route => {
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto(origin);
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });
    await page.evaluate(th => document.documentElement.setAttribute("data-theme", th), theme);
    const decide = page.locator(`button[data-action="decide"][data-work-id="${workItemId}"]`);
    await decide.waitFor({ state: "visible" });
    await decide.click();
    await page.locator("#action-dialog").waitFor({ state: "visible" });
    // Fast keyboard user: verdict via keyboard, Tab to notes, fill — before text lands.
    const sel = page.locator('#action-fields select[name="decision"]');
    await sel.focus();
    await sel.selectOption("approved");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "reason", "Tab lands on the notes textarea");
    await page.locator('#action-fields textarea[name="reason"]').fill("Approved. Streaming matches the agreed design.");
    // Let the delayed exact text land and shift layout, then measure.
    await page.waitForFunction(b => document.querySelector("#action-text-body").textContent === b, body);
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const dlg = document.querySelector("#action-dialog");
      const ta = dlg.querySelector('textarea[name="reason"]');
      const dr = dlg.getBoundingClientRect();
      const tr = ta.getBoundingClientRect();
      const outline = parseFloat(getComputedStyle(ta).outlineWidth) || 0;
      return {
        clipPx: tr.bottom - (dr.bottom - 1),
        outlineClipPx: (tr.bottom + outline) - (dr.bottom - 1),
        focused: document.activeElement === ta,
      };
    });
    assert.equal(m.focused, true, "notes textarea still focused after async load");
    assert.ok(m.clipPx <= 0, `textarea bottom clipped by ${m.clipPx.toFixed(2)}px`);
    assert.ok(m.outlineClipPx <= 0, `focus outline clipped by ${m.outlineClipPx.toFixed(2)}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
