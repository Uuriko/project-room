// Simulated human journeys. Clipboard outcomes are controlled; no user text or
// system clipboard is read/written and no live service is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture(), snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  const mutate = (actor, type, data = {}) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data: { workItemId: "test-handoff", expectedRevision: snapshot().state.workItems["test-handoff"].revision, ...data } });
  mutate("producer", T.WORK_ACCEPTED);
  mutate("producer", T.WORK_COMPLETED, { summary: "An agenda naming the owner and the next discussion.\nReview dates before using it.", evidenceUrl: "https://example.invalid/private?token=not-for-export", evidenceVersion: "private-version", producerId: "producer", nextAction: "Review exact evidence" });
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await context.newPage(), errors = [], outbound = [], posts = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outbound.push(route.request().url()); return route.abort(); }
    if (route.request().method() !== "GET") posts.push(route.request().url());
    return route.continue();
  });
  await page.addInitScript(() => {
    window.copyCalls = []; window.copyBehavior = "resolve";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText(text) {
      window.copyCalls.push(text);
      if (window.copyBehavior === "reject") return Promise.reject(Error("Synthetic clipboard refusal"));
      if (window.copyBehavior === "hold") return new Promise((resolve, reject) => { window.finishCopy = resolve; window.failCopy = reject; });
      return Promise.resolve();
    } } });
  });
  await page.goto(origin);
  const login = async () => { await page.locator("#auth-panel").waitFor({ state: "visible" }); await page.locator("#access-key").fill(f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor({ state: "visible" }); };
  await login(); posts.length = 0;
  const card = page.locator('[data-work-record-id="test-handoff"]'), dialog = page.locator("#result-copy-dialog"), input = page.locator("#result-copy-preview"), copy = page.locator("#result-copy-button");
  const open = async () => {
    await card.waitFor();
    if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
    await card.locator("[data-copy-result]").click(); await dialog.waitFor({ state: "visible" });
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/result-copy-${name}.png` }); };
  return { ...f, page, context, snapshot, mutate, login, card, dialog, input, copy, open, capture, errors, outbound, posts };
}

for (const mobile of [false, true]) test(`result copy ${mobile ? "mobile" : "desktop"}: preview/redaction, exact copy, no publication and accessible editing`, { timeout: 45000 }, async t => {
  const f = await setup(t, mobile), { page } = f, before = f.snapshot();
  const storage = () => page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const stored = await storage();
  assert.equal(await f.card.locator("[data-copy-result]").isVisible(), false);
  await f.open(); const seed = await f.input.inputValue();
  assert.equal(seed, `${before.state.workItems["test-handoff"].title}\n\nReported result\n${before.state.workItems["test-handoff"].receipt.summary}`);
  for (const privateText of [f.keys.owner, "private-version", "not-for-export", "ROOM-RETURN", "Please prepare an agenda", "Approved", "Verified"]) assert.equal(seed.includes(privateText), false);
  assert.equal(await f.input.evaluate(node => document.activeElement === node), true);
  const text = "Shareable agenda 🌱\n\nReported result\nOwner named; next discussion planned.\n<script>window.bad = true</script>";
  await f.input.fill(text); await f.input.press("End"); await f.input.press("Enter");
  assert.equal(await f.input.inputValue(), text + "\n");
  assert.deepEqual(await page.evaluate(() => window.copyCalls), []);
  await f.copy.click(); await page.getByText("Copied. Paste where you choose.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.copyCalls), [text + "\n"]);
  assert.equal(await page.evaluate(() => window.bad), undefined);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(await storage(), stored); assert.deepEqual(f.posts, []); assert.deepEqual(f.outbound, []);
  await f.input.fill("   "); assert.equal(await f.copy.isDisabled(), true); await f.input.fill(text);
  if (mobile) {
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
    const textSize = await f.input.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await f.input.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), textSize * 2);
    await f.input.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await f.dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await f.capture("mobile-large-text-top");
    await f.copy.scrollIntoViewIfNeeded(); await f.capture("mobile-large-text-controls");
    assert.ok((await f.copy.boundingBox()).height >= 44); assert.ok((await page.locator("#result-copy-close").boundingBox()).height >= 44);
  } else await f.capture("desktop-preview");
  await f.copy.focus(); await page.keyboard.press("Tab");
  assert.equal(await page.locator("#result-copy-close").evaluate(node => document.activeElement === node), true);
  await page.keyboard.press("Shift+Tab"); assert.equal(await f.copy.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press("Escape"); await f.dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.dataset.copyResult === "test-handoff");
  await f.open(); assert.equal(await f.input.inputValue(), text);
  assert.deepEqual(f.errors, []);
});

test("result copy: source changes preserve edits/focus and require an older copy or explicit fresh replacement", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  await f.open(); await f.input.fill("My redacted summary"); await f.input.evaluate(node => node.setSelectionRange(3, 8));
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Unrelated synthetic activity" } });
  await page.getByText("Unrelated synthetic activity", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await f.copy.textContent(), "Copy");
  f.mutate("producer", T.WORK_BLOCKED, { reason: "A correction is needed", nextAction: "Rework" });
  await page.getByRole("button", { name: "Copy older draft", exact: true }).waitFor();
  assert.equal(await f.input.inputValue(), "My redacted summary");
  assert.deepEqual(await f.input.evaluate(node => ({ focus: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { focus: true, start: 3, end: 8 });
  await f.copy.click(); assert.deepEqual(await page.evaluate(() => window.copyCalls), ["My redacted summary"]);
  await f.capture("older-draft");
  page.once("dialog", dialog => dialog.dismiss()); await page.locator("#result-copy-fresh").click(); assert.equal(await f.input.inputValue(), "My redacted summary");
  f.mutate("producer", T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" });
  f.mutate("producer", T.WORK_COMPLETED, { summary: "A revised result", evidenceUrl: "https://example.invalid/revised", evidenceVersion: "v2", producerId: "producer", nextAction: "Review" });
  await f.card.getByText("A revised result", { exact: true }).waitFor({ state: "attached" });
  page.once("dialog", dialog => dialog.accept()); await page.locator("#result-copy-fresh").click();
  assert.equal(await f.input.inputValue(), "Test: prepare an agenda\n\nReported result\nA revised result"); assert.equal(await f.copy.textContent(), "Copy");
  await page.keyboard.press("Escape"); await page.waitForFunction(() => document.activeElement?.dataset.copyResult === "test-handoff");
  assert.deepEqual(f.errors, []);
});

test("result copy: clipboard refusal preserves editable text and selects only while focus is owned", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.input.fill("Reviewed copy");
  await page.evaluate(() => window.copyBehavior = "reject"); await f.copy.click();
  await page.getByText("Select the text and copy it manually.", { exact: true }).waitFor();
  assert.deepEqual(await f.input.evaluate(node => ({ focus: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { focus: true, start: 0, end: 13 });
  assert.equal(await f.input.isEditable(), true); await f.capture("clipboard-refused");
  await page.evaluate(() => window.copyBehavior = "hold"); await f.copy.click(); await page.locator("#result-copy-close").focus();
  await page.evaluate(() => window.failCopy(Error("Synthetic refusal")));
  await page.waitForFunction(() => !document.querySelector("#result-copy-button").disabled);
  assert.equal(await page.locator("#result-copy-close").evaluate(node => document.activeElement === node), true);
  assert.deepEqual(f.errors, []);
});

for (const outcome of ["finishCopy", "failCopy"]) test(`result copy: late ${outcome} is fenced across close/reopen and only one copy can be pending`, { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.input.fill("Old preview");
  await page.evaluate(() => window.copyBehavior = "hold"); await f.copy.click();
  assert.equal(await f.input.isEditable(), false); await page.keyboard.press("Escape"); await f.open();
  assert.equal(await f.copy.isDisabled(), true); assert.equal(await f.input.isEditable(), false);
  assert.equal(await page.locator("#result-copy-wait").isVisible(), true);
  await f.copy.evaluate(node => node.click()); assert.equal(await page.evaluate(() => window.copyCalls.length), 1);
  await page.evaluate(name => window[name](Error("Synthetic late outcome")), outcome);
  await page.waitForFunction(() => !document.querySelector("#result-copy-button").disabled);
  assert.equal(await page.locator("#result-copy-wait").isVisible(), false);
  assert.equal(await page.locator("#result-copy-status").textContent(), "");
  assert.equal(await f.input.evaluate(node => document.activeElement === node), true);
  await f.input.fill("New preview"); await page.evaluate(() => window.copyBehavior = "resolve"); await f.copy.click();
  assert.deepEqual(await page.evaluate(() => window.copyCalls), ["Old preview", "New preview"]);
  assert.deepEqual(f.errors, []);
});

test("result copy: source changes and A/B/A edits suppress held feedback without overwriting the draft", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.input.fill("A"); await page.evaluate(() => window.copyBehavior = "hold"); await f.copy.click();
  await f.input.evaluate(node => { for (const value of ["B", "A"]) { node.value = value; node.dispatchEvent(new Event("input")); } });
  f.mutate("producer", T.WORK_BLOCKED, { reason: "Recheck", nextAction: "Rework" });
  await page.getByRole("button", { name: "Copy older draft", exact: true }).waitFor();
  await page.evaluate(() => window.finishCopy()); await page.waitForFunction(() => !document.querySelector("#result-copy-button").disabled);
  assert.equal(await page.locator("#result-copy-status").textContent(), ""); assert.equal(await f.input.inputValue(), "A");
  assert.deepEqual(f.errors, []);
});

test("result copy: Add-result drafts are independent and observed access loss clears export drafts during a copy", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await page.keyboard.press("Escape");
  await f.card.locator('[data-portable-mode="result"]').click(); await page.locator("#portable-result").fill("Unsent external proposal"); await page.keyboard.press("Escape");
  await f.open(); await f.input.fill("Private export draft");
  await f.card.locator("[data-copy-result]").evaluate(node => node.click()); assert.equal(await f.input.inputValue(), "Private export draft");
  await page.keyboard.press("Escape");
  await f.card.locator('[data-portable-mode="result"]').click(); assert.equal(await page.locator("#portable-result").inputValue(), "Unsent external proposal"); await page.keyboard.press("Escape");
  await f.open(); await page.evaluate(() => window.copyBehavior = "hold"); await f.copy.click();
  // Rotate the same member's credential: the service ends the old browser session.
  f.keys.owner = f.store.issueAccessKey("commons", "owner");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await f.dialog.isVisible(), false); assert.equal(await f.input.inputValue(), "");
  await f.login(); await f.open(); assert.equal(await f.input.inputValue().then(text => text.includes("Private export draft")), false);
  assert.equal(await f.copy.isDisabled(), true);
  await page.evaluate(() => window.finishCopy()); await page.waitForFunction(() => !document.querySelector("#result-copy-button").disabled);
  assert.equal(await page.locator("#result-copy-status").textContent(), "");
  assert.deepEqual(f.errors, []);
});

test("result copy: unavailable clipboard, closed-draft sign-out warning and reload clearing", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.input.fill("Keep this temporary edit");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await f.copy.click(); await page.getByText("Select the text and copy it manually.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  let warnings = 0;
  page.once("dialog", dialog => { warnings++; assert.match(dialog.message(), /clear unsent drafts/); return dialog.dismiss(); });
  await page.locator("#signout-button").click(); assert.equal(warnings, 1);
  await f.open(); assert.equal(await f.input.inputValue(), "Keep this temporary edit");
  await page.keyboard.press("Escape");
  page.once("dialog", dialog => dialog.accept()); await page.locator("#signout-button").click(); await page.locator("#auth-panel").waitFor({ state: "visible" });
  await f.login(); await f.open(); assert.equal((await f.input.inputValue()).includes("temporary edit"), false);
  await f.input.fill("Reload clears this edit"); await page.keyboard.press("Escape");
  await page.reload(); await page.locator("#main").waitFor({ state: "visible" }); await f.open();
  assert.equal((await f.input.inputValue()).includes("Reload clears"), false); assert.deepEqual(f.errors, []);
});

test("result copy: superseded work retains reported history and close can focus its collapsed work card", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f; await f.open(); await f.input.fill("Old result copy");
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "replacement", title: "Replacement", definitionOfDone: "New work", accountableMemberId: "owner", mode: "read" } });
  f.mutate("owner", T.WORK_SUPERSEDED, { supersededByWorkItemId: "replacement", reason: "New direction" });
  await page.getByRole("button", { name: "Copy older draft", exact: true }).waitFor();
  assert.equal(await f.input.inputValue(), "Old result copy");
  assert.ok(f.snapshot().state.workItems["test-handoff"].receipt, "superseding preserves historical evidence");
  page.once("dialog", dialog => dialog.accept()); await page.locator("#result-copy-fresh").click();
  await f.dialog.locator("summary").click(); assert.match(await page.locator("#result-copy-source").textContent(), /Replaced/);
  await f.card.locator(".work-details").evaluate(node => node.open = false);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.dataset.workRecordId === "test-handoff"); assert.deepEqual(f.errors, []);
});
