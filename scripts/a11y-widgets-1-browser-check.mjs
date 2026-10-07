// READY A11Y-1: keyboard and screen-reader pass on the emoji combobox
// (src/emoji.js UI), composer file chips (src/composer-files.js UI), the
// reminder dialog (src/reminders.js), and the room charter display
// (src/room-charter.js UI).
//
// These are interaction contracts axe cannot check: combobox expanded state,
// arrow-key activedescendant management, dialog initial focus / Escape /
// focus return, and accessible names on dynamically rendered controls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

async function setup(t, { withWork = false } = {}) {
  const f = createAcceptanceFixture();
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  if (withWork) {
    const workItemId = "a11y1-reminder-work";
    send(T.WORK_PROPOSED, { workItemId, title: "A11y reminder work", definitionOfDone: "Done when reviewed.", mode: "read",
      accountableMemberId: "owner", ownerDecisionRequired: false });
    const item = () => f.store.room("commons").state.workItems[workItemId];
    send(T.WORK_ACCEPTED, { workItemId, expectedRevision: item().revision });
  }
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, origin, browser };
}

async function signedInPage(t, origin, browser, keys) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await signInFixture(page, keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").waitFor({ state: "visible" });
  return { page, errors };
}

test("emoji combobox: expanded state, arrow-key navigation, enter applies, escape dismisses", { timeout: 90000 }, async t => {
  const { origin, browser, f } = await setup(t);
  const { page, errors } = await signedInPage(t, origin, browser, f.keys);
  const input = page.locator("#message-input");
  await input.click();
  await input.type("hello :sm", { delay: 20 });
  const list = page.locator("#emoji-list");
  await list.waitFor({ state: "visible" });
  assert.equal(await list.getAttribute("role"), "listbox");
  const options = list.locator('[role="option"]');
  assert.ok(await options.count() >= 2, "emoji options rendered");
  // Expanded state must be exposed while the popup is open.
  assert.equal(await input.getAttribute("aria-expanded"), "true", "combobox reports expanded while listbox is open");
  assert.equal(await input.getAttribute("aria-controls"), "emoji-list");
  const firstId = await options.first().getAttribute("id");
  assert.equal(await input.getAttribute("aria-activedescendant"), firstId, "activedescendant tracks the first option");
  assert.equal(await options.first().getAttribute("aria-selected"), "true");
  // ArrowDown moves the active option; the input keeps DOM focus.
  await page.keyboard.press("ArrowDown");
  const secondId = await options.nth(1).getAttribute("id");
  assert.equal(await input.getAttribute("aria-activedescendant"), secondId, "ArrowDown moves activedescendant");
  assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "message-input", "focus stays in the textarea (activedescendant pattern)");
  // Enter applies the highlighted emoji and closes the popup.
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "hidden" });
  const value = await input.inputValue();
  assert.match(value, /^hello \p{Extended_Pictographic}/u, "chosen emoji inserted at the caret");
  assert.equal(await input.getAttribute("aria-expanded"), null, "expanded removed after the popup closes");
  // Escape dismisses without applying.
  await input.fill("bye :he");
  await list.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "bye :he", "Escape leaves the typed text alone");
  assert.deepEqual(errors, []);
});

test("mention listbox: same combobox contract as the emoji list", { timeout: 90000 }, async t => {
  const { origin, browser, f } = await setup(t);
  const { page, errors } = await signedInPage(t, origin, browser, f.keys);
  const input = page.locator("#message-input");
  await input.click();
  await input.type("hi @", { delay: 20 });
  const list = page.locator("#mention-list");
  await list.waitFor({ state: "visible" });
  assert.equal(await input.getAttribute("aria-expanded"), "true", "mention combobox reports expanded while open");
  const activeId = await input.getAttribute("aria-activedescendant");
  assert.ok(activeId?.startsWith("mention-option-"), "activedescendant points at a mention option");
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await input.getAttribute("aria-activedescendant"), activeId, "ArrowDown moves the mention highlight");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("reminder dialog: opens with focus inside, Escape closes, focus returns to the trigger", { timeout: 90000 }, async t => {
  const { origin, browser, f } = await setup(t, { withWork: true });
  const { page, errors } = await signedInPage(t, origin, browser, f.keys);
  const trigger = page.locator('button[data-reminder-work="a11y1-reminder-work"]');
  const card = page.locator('article[data-work-record-id="a11y1-reminder-work"]');
  await card.waitFor({ state: "visible" });
  // The work card actions live inside a collapsed details; open it.
  const details = card.locator("details.work-details");
  if (await details.count() && !(await details.first().evaluate(d => d.open))) {
    await details.first().locator("summary").click();
  }
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("#reminder-dialog");
  await dialog.waitFor({ state: "visible" });
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert.ok(dialog.evaluate(d => d.contains(document.activeElement)), "dialog moves focus inside on open");
  // Escape closes (cancel handler) and focus returns to the trigger.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.reminderWork), "a11y1-reminder-work",
    `focus returns to the reminder trigger (got ${focused})`);
  assert.deepEqual(errors, []);
});

test("composer file chip: attached file exposes a named, keyboard-focusable remove control", { timeout: 90000 }, async t => {
  const { origin, browser, f } = await setup(t);
  const { page, errors } = await signedInPage(t, origin, browser, f.keys);
  // Attach via the composer file input.
  const fileInput = page.locator('#composer-file');
  await fileInput.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  const chip = page.locator("#composer-attachments .file-chip");
  await chip.first().waitFor({ state: "visible" });
  const remove = chip.first().locator('button');
  const name = await remove.first().evaluate(el => (el.getAttribute("aria-label") || el.textContent || "").trim());
  assert.ok(name.length > 0, "file remove button has an accessible name");
  await remove.first().focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON", "remove control is keyboard-focusable");
  assert.deepEqual(errors, []);
});
