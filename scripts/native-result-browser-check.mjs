// Simulated human interaction in disposable local rooms, never a user study.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome, messageAction } from "./room-chrome.mjs";

// Hosted runners stall hard enough that the page-wide 8s default kills waits
// whose product leg is ~1s on an unloaded box. Waits on an async round trip
// poll the actual state with a generous ceiling and, on timeout, fail with a
// dump of the page state that says why — never a bare locator timeout.
async function waitForState(page, description, probe, { timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await page.waitForTimeout(Math.min(interval, deadline - Date.now()));
  }
  if (await probe()) return;
  const state = await page.evaluate(() => ({
    hash: location.hash,
    accountStatus: document.querySelector("#account-status")?.textContent ?? null,
    mainHidden: document.querySelector("#main")?.hidden ?? null,
    messageInput: document.querySelector("#message-input")?.value ?? null,
  })).catch(() => null);
  throw new Error(`Timed out after ${timeout}ms waiting for ${description}. Page state: ${JSON.stringify(state)}`);
}

async function setup(t, { mobile = false, review = false, viewport = null, body = "  A quiet room\n\nCafé 🪷 — one clear next step.  \n" } = {}) {
  const f = createAcceptanceFixture(), workItemId = "native-human";
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "human-checker", displayName: "Test checker", kind: "human", permissions: ["verify"] });
  f.keys["human-checker"] = f.store.issueAccessKey("commons", "human-checker");
  send(T.WORK_PROPOSED, { workItemId, title: "A quiet room", definitionOfDone: "Short text with one next step", mode: "read", accountableMemberId: "owner",
    verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const posted = send(T.MESSAGE_POSTED, { messageId: "native-draft", workItemId, packetId: "human-packet", basisRevision: 1, body });
  let chatAt = Date.now();
  f.store.now = () => chatAt;
  for (let i = 0; i < 102; i++) { chatAt += 2000; send(T.MESSAGE_POSTED, { body: "Synthetic background activity", replyToId: "test-welcome" }); }
  const complete = () => mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "native-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: item().receipt?.eventId ?? null, producerId: "owner", summary: "A quiet room", nextAction: "Review" });
  if (review) complete();
  const server = createRoomServer({ store: f.store, streamInterval: 40 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }), isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const errors = [], outside = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(8000);
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin); await signInFixture(page, f.keys[review ? "human-checker" : "owner"]); await page.locator("#main").waitFor({ state: "visible" });
  const open = async () => {
    if (review) await page.locator(`[data-work-record-id='${workItemId}'] [data-action='verify']`).click();
    else {
      await messageAction(page, "native-draft", "result");
    }
    await page.locator("#action-dialog").waitFor({ state: "visible" });
  };
  const textReady = async () => { await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body); };
  const fill = async () => {
    if (review) { await page.locator("#action-fields [name=result]").selectOption("pass"); await page.locator("#action-fields [name=summary]").fill("Checked the stored text and next step"); }
    else { await page.locator("#action-fields [name=producerId]").selectOption("owner"); await page.locator("#action-fields [name=summary]").fill("A quiet room"); await page.locator("#action-fields [name=nextAction]").fill("Review exact text"); }
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/native-result-${name}.png` }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, workItemId, body, item, send, mutate, complete, open, fill, textReady, capture, save: page.locator("#action-form button[type=submit]") };
}

for (const mobile of [false, true]) test(`native result ${mobile ? "mobile" : "desktop"}: selected old draft becomes exact result`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-fields [name=evidenceUrl]").count(), 0);
  assert.equal(await f.page.locator("#action-title").textContent(), "Save as result");
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).whiteSpace), "pre-wrap");
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "mobile" : "desktop"); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().receipt.nativeText.messageId, "native-draft"); assert.equal(f.item().receipt.evidenceVersion, textVersion(f.body));
  assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.equal(await f.page.locator("#result-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#close-result").focus(); await f.page.keyboard.press("Tab");
  assert.equal(await f.page.locator("#result-discuss").evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press("Tab");
  assert.equal(await f.page.locator("#result-copy-text").evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press("Tab");
  assert.equal(await f.page.locator("#result-download").evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press("Tab");
  assert.equal(await f.page.locator("#result-dialog").evaluate(el => el.contains(document.activeElement)), false, "inline reading does not trap keyboard navigation");
  await f.page.keyboard.press("Shift+Tab");
  assert.equal(await f.page.locator("#result-download").evaluate(el => el === document.activeElement), true);
  f.mutate(T.WORK_BLOCKED, { reason: "Synthetic follow-up", nextAction: "Revisit later" });
  await f.page.waitForFunction(id => document.querySelector(`[data-work-record-id='${id}']`).textContent.includes("Synthetic follow-up"), f.workItemId);
  await f.page.locator("#close-result").click(); assert.equal(await f.page.locator("#result-body").textContent(), "");
  assert.equal(await f.page.locator(`[data-read-result='${f.workItemId}']`).evaluate(el => el === document.activeElement), true);
});

test("exact result copy preserves text, reports failure and ignores a late completion after closing", { timeout: 30000 }, async t => {
  const f = await setup(t); f.complete();
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.locator("#result-copy-text").waitFor({ state: "visible" });
  await f.page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.copiedResult = text; throw new Error("Permission denied"); }
    } });
  });
  await f.page.locator("#result-copy-text").click();
  await f.page.getByText("Could not copy. Retry or download the text.", { exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => window.copiedResult), f.body);
  await f.page.evaluate(() => { navigator.clipboard.writeText = text => {
    window.copiedResult = text; return new Promise(resolve => { window.finishCopy = resolve; });
  }; });
  await f.page.locator("#result-copy-text").click();
  assert.equal(await f.page.locator("#result-copy-text").isDisabled(), true);
  await f.page.locator("#close-result").click();
  await f.page.evaluate(() => window.finishCopy());
  assert.equal(await f.page.locator("#result-use-status").textContent(), "");
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.locator("#result-copy-text").waitFor({ state: "visible" });
  await f.page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedResult = text; }; });
  await f.page.locator("#result-copy-text").click();
  await f.page.getByText("Copied", { exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => window.copiedResult), f.body);
  const downloaded = f.page.waitForEvent("download");
  await f.page.locator("#result-download").click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "result.txt");
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), f.body);
});

test("native result uncertain save resumes exact text and command", { timeout: 25000 }, async t => {
  const f = await setup(t), attempts = []; await f.open(); await f.textReady(); await f.fill();
  await f.page.route("**/commands", async route => { attempts.push(route.request().postDataJSON()); if (attempts.length === 1) { await route.fetch(); return route.abort("failed"); } return route.continue(); });
  await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  await f.page.locator("#cancel-action").click(); await f.page.locator("#resume-action").click();
  assert.equal(await f.page.locator("#action-text-body").textContent(), f.body); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.item().revision, 2);
});

test("native review shows exact text and leaves human approval pending", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-evidence").isVisible(), false);
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true); await f.capture("review");
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().verification.result, "pass"); assert.equal(f.item().verification.independenceConfirmed, true); assert.equal(f.item().decision, null);
});

// NR-B reflow owner: existing 320px composer/layout tests never open the
// native reader and review form, and this file's prior review ran at 1440px.
// A dialog min-width, unbroken result token, or lost return target can break
// this task independently. Use the real local result/command routes and the
// existing fixture; no production seam, model, real device or AT claim.
for (const theme of ["dark", "light"]) test(`native result 320px ${theme}: read, review and return to the same result`, { timeout: 30000 }, async t => {
  const body = "A quiet room\n\nCheck this exact reference: " + "resultreference".repeat(12) + "\nKeep the next step with the same work.";
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 }, body });
  const { page } = f, receipt = structuredClone(f.item().receipt), reads = [], evidence = [];
  const card = page.locator(`[data-work-record-id="${f.workItemId}"]`);
  const read = card.locator("[data-read-result]"), verify = card.locator('[data-action="verify"]');
  const initialUrl = page.url();
  mkdirSync("test-results/native-reflow", { recursive: true });
  t.after(() => writeFileSync(`test-results/native-reflow/${theme}.json`, JSON.stringify({
    theme, simulatedHuman: true, realDevice: false, assistiveTechnology: false,
    workItemId: f.workItemId, completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion,
    producerId: receipt.producerId, reviewerId: "human-checker", reads, evidence,
  }, null, 2) + "\n"));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/work-result")) reads.push({ path: url.pathname, workItemId: url.searchParams.get("workItemId"), completionEventId: url.searchParams.get("completionEventId") });
  });
  await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
  // CI keeps no screenshots for a failed shard, so keep a short focus/DOM trace
  // that a failing assertion prints. It observes only; it never changes focus.
  await page.evaluate(() => {
    const trace = window.__focusTrace = [], t0 = performance.now();
    const label = node => node && node.nodeType === 1 ? `${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}${node.dataset?.readResult ? "[read-result]" : ""}` : String(node);
    const note = text => { trace.push(`${Math.round(performance.now() - t0)}ms ${text}`); if (trace.length > 40) trace.shift(); };
    for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => note(`${type} ${label(event.target)} -> ${label(event.relatedTarget)}`), true);
    for (const type of ["close", "cancel"]) document.addEventListener(type, event => note(`${type} ${label(event.target)}`), true);
    new MutationObserver(records => {
      if (records.some(record => [...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.("[data-read-result]") || node.querySelector?.("[data-read-result]")))))
        note("a [data-read-result] node was removed from #message-list");
    }).observe(document.querySelector("#message-list"), { childList: true, subtree: true });
  });
  const trace = async () => page.evaluate(() => ({ trace: window.__focusTrace, active: document.activeElement?.outerHTML.slice(0, 140),
    readerVisible: !document.querySelector("#result-dialog").hidden, hasFocus: document.hasFocus(), scrollY }));
  await page.locator("#message-input").fill("Keep this reviewer's conversation draft.");
  const measure = async (stage, panelSelector = null, textSelector = null) => {
    const value = await page.evaluate(({ panelSelector, textSelector }) => {
      const panel = panelSelector && document.querySelector(panelSelector), text = textSelector && document.querySelector(textSelector);
      const active = document.activeElement, box = active.getBoundingClientRect(), style = getComputedStyle(active);
      // A viewport-contained control can still be cut off by a scrolling
      // dialog. Measure every clipping ancestor without scrolling it for the test.
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, clippingAncestors = [];
      for (let node = active.parentElement; node; node = node.parentElement) {
        const css = getComputedStyle(node), rect = node.getBoundingClientRect();
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(css.overflowX), clipsY = /^(auto|scroll|hidden|clip)$/.test(css.overflowY);
        if (!clipsX && !clipsY) continue;
        const bounds = { left: rect.left + node.clientLeft, top: rect.top + node.clientTop,
          right: rect.left + node.clientLeft + node.clientWidth, bottom: rect.top + node.clientTop + node.clientHeight };
        if (clipsX) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (clipsY) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
        clippingAncestors.push({ id: node.id, clipsX, clipsY, ...bounds });
      }
      const x = (Math.max(clip.left, box.left) + Math.min(clip.right, box.right)) / 2;
      const y = (Math.max(clip.top, box.top) + Math.min(clip.bottom, box.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme,
        panel: panel && { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
        text: text && { scrollWidth: text.scrollWidth, clientWidth: text.clientWidth },
        focus: { id: active.id, name: active.getAttribute("name"), workItemId: active.closest("[data-work-record-id]")?.dataset.workRecordId,
          x: box.x, y: box.y, width: box.width, height: box.height, outline: style.outline, boxShadow: style.boxShadow,
          unobscured: hit === active || active.contains(hit), clip, clippingAncestors,
          fullyVisible: box.left >= clip.left - 1 && box.right <= clip.right + 1 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 } };
    }, { panelSelector, textSelector });
    evidence.push({ stage, url: page.url(), ...value });
    await page.screenshot({ path: `test-results/native-reflow/${theme}-${stage}.png` });
    assert.equal(value.width, 320, "actual layout width, not a resized screenshot");
    assert.equal(value.theme, theme);
    assert.ok(value.documentWidth <= value.width + 1, `${stage}: document reflows`);
    for (const [name, size] of [["panel", value.panel], ["text", value.text]]) if (size) {
      assert.ok(size.scrollWidth <= size.clientWidth + 1, `${stage}: ${name} needs no horizontal scrolling`);
    }
    const focus = value.focus;
    assert.ok(focus.width > 0 && focus.height > 0 && focus.x >= 0 && focus.x + focus.width <= 321, `${stage}: focus is horizontally available`);
    assert.ok(focus.y < value.height && focus.y + focus.height > 0 && focus.unobscured,
      `${stage}: focus is visible and unobscured; ${JSON.stringify({ focus, ...(await trace()) })}`);
    if (panelSelector) assert.ok(focus.y >= 0 && focus.y + focus.height <= value.height + 1, `${stage}: focused core control fits the viewport`);
  };
  const readExact = async stage => {
    await read.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
    assert.equal(await page.locator("#result-title").textContent(), "A quiet room");
    assert.match(await page.locator("#result-status").textContent(), /^Submitted by Room owner/);
    assert.equal(await page.locator("#result-title").evaluate(node => node === document.activeElement), true);
    await measure(stage, "#result-dialog", "#result-body");
    // Reading a result records the reader's basis, so the next snapshot can
    // re-render this card (it gains "What changed since revision N") and
    // replace the View result node; renderMessages then restores focus to the
    // replacement by data-focus-key. Polling a locator across that swap races
    // (it can resolve the detached node). Wait until focus settles on this
    // work's View result control for two frames, then check that control.
    const opener = await read.elementHandle();
    await page.keyboard.press("Escape"); await page.locator("#result-dialog").waitFor({ state: "hidden" });
    const settled = await page.waitForFunction(({ id, key }) => new Promise(resolve => {
      const ok = () => { const a = document.activeElement; return a?.dataset.focusKey === key && a.closest("[data-work-record-id]")?.dataset.workRecordId === id && a.isConnected; };
      if (!ok()) return resolve(false);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(ok())));
    }), { id: f.workItemId, key: `work-native-result:${f.workItemId}` }, { timeout: 5000 }).then(() => true, () => false);
    const swap = await opener.evaluate(node => ({ sameNode: node === document.activeElement, openerConnected: node.isConnected }));
    assert.ok(settled && (swap.sameNode || !swap.openerConnected),
      `reader returns to this work's result control; ${JSON.stringify({ swap, ...(await trace()) })}`);
    assert.equal(page.url(), initialUrl);
  };
  await readExact("reader-before");
  await measure("reader-return");
  await verify.focus(); await page.keyboard.press("Enter"); await f.textReady();
  const verdict = page.locator("#action-fields [name=result]"), notes = page.locator("#action-fields [name=summary]");
  await verdict.focus(); await verdict.selectOption("pass");
  await measure("review-verdict", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Tab"); assert.equal(await notes.evaluate(node => node === document.activeElement), true);
  await notes.fill("Checked this exact stored reference and next step");
  await measure("review-notes", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Tab"); assert.equal(await page.locator("#cancel-action").evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Tab"); assert.equal(await f.save.evaluate(node => node === document.activeElement), true);
  await measure("review-save", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Enter"); await page.locator("#action-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => document.activeElement?.closest("[data-work-record-id]")?.dataset.workRecordId === id, f.workItemId);
  assert.equal(f.item().verification.verifierId, "human-checker");
  assert.equal(f.item().verification.result, "pass");
  assert.equal(f.item().verification.independenceConfirmed, true);
  assert.equal(f.item().verification.completionEventId, receipt.eventId);
  assert.equal(f.item().verification.evidenceVersion, receipt.evidenceVersion);
  assert.deepEqual(f.item().receipt, receipt, "review never substitutes a result or producer");
  assert.equal(f.item().decision, null, "the owner's decision is still separate");
  await measure("review-return");
  await readExact("reader-after");
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this reviewer's conversation draft.");
  assert.ok(reads.length > 0, "the real result route was exercised");
  assert.ok(reads.every(value => value.workItemId === f.workItemId && value.completionEventId === receipt.eventId));
  // Full core-control visibility is the product requirement for this task;
  // it is stricter than WCAG 2.4.11's not-entirely-obscured minimum. Preserve
  // every journey screenshot before reporting a clipping failure.
  assert.deepEqual(evidence.filter(value => value.panel && !value.focus.fullyVisible)
    .map(value => ({ stage: value.stage, focus: value.focus })), [], "focused modal controls fit inside all clipping ancestors");
});

// Regression pin for the focus-rescue arming hole (the light journey's
// failure specimen, run 39232683831): the reader-return restore focuses the
// View result control with preventScroll while it sits below the fold, and
// the read-basis re-render then replaces that node and restores focus to the
// replacement, again with preventScroll. The renderMessages rescue that
// scrolls a displaced focused control back on screen used to be gated on
// the render-START snapshot (focusedOnScreen), so a render that started
// with the control already off screen never rescued the restored control —
// the settled UI left keyboard focus on an invisible control. This pin
// forces that start state instead of racing it: the focused control is
// scrolled below the fold with focus held, then a work mutation re-renders
// the card and replaces the control's node.
test("native result 320px: a card re-render rescues a focused View result control that starts off screen", { timeout: 30000 }, async t => {
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 } });
  const { page } = f;
  const card = page.locator(`[data-work-record-id="${f.workItemId}"]`);
  const read = card.locator("[data-read-result]");
  await read.waitFor();
  // Quiesce first: the app's initial snapshot renders can land after the
  // first focus() and drop it, and a scroll forced mid-settle is clamped by
  // the still-shifting layout. Poll until this control holds focus and its
  // geometry is unchanged across two reads before forcing the start state.
  let last = null, stable = 0;
  await waitForState(page, "the View result control to hold focus in a settled layout", async () => {
    await read.focus().catch(() => {});
    const s = await page.evaluate(() => { const a = document.activeElement, b = a?.getBoundingClientRect?.();
      return a?.dataset?.focusKey ? { y: Math.round(scrollY), top: Math.round(b.top), key: a.dataset.focusKey } : null; }).catch(() => null);
    stable = s && s.key === `work-native-result:${f.workItemId}` && last && s.y === last.y && s.top === last.top ? stable + 1 : 0;
    last = s;
    return stable >= 1;
  });
  const displaced = await page.evaluate(() => {
    const el = document.activeElement, r = el.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, scrollY + r.top - (innerHeight + 60)), behavior: "instant" });
    const now = el.getBoundingClientRect();
    return { top: Math.round(now.top), h: innerHeight, scrollY: Math.round(scrollY), focused: document.activeElement === el };
  });
  assert.ok(displaced.focused && displaced.top >= displaced.h,
    `precondition: the focused control starts off screen: ${JSON.stringify(displaced)}`);
  const before = await read.elementHandle();
  f.mutate(T.WORK_BLOCKED, { reason: "Synthetic pin update", nextAction: "Revisit later" });
  // Settle means the swap actually landed: the pre-mutation node is
  // disconnected and focus rests on a different, connected control with this
  // work's focus key. (Checking the key alone would pass on the old node
  // before the stream even delivers the mutation.)
  const settled = await page.waitForFunction(({ old, id, key }) => new Promise(resolve => {
    const ok = () => { const a = document.activeElement; return a && a !== old && !old.isConnected && a.dataset.focusKey === key
      && a.closest("[data-work-record-id]")?.dataset.workRecordId === id && a.isConnected; };
    if (!ok()) return resolve(false);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(ok())));
  }), { old: before, id: f.workItemId, key: `work-native-result:${f.workItemId}` }, { timeout: 8000 }).then(() => true, () => false);
  assert.ok(settled, "the re-render replaces the focused node and focus settles on the replacement control");
  // Assert the final resting position, not a mid-burst sample: poll until
  // the settled control is on screen and stays there across two reads.
  const measure = () => page.evaluate(() => {
    const el = document.activeElement, b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, b.left + b.width / 2)), Math.max(0, Math.min(innerHeight - 1, b.top + b.height / 2)));
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight, scrollY: Math.round(scrollY),
      unobscured: hit === el || el.contains(hit) };
  });
  let after = await measure(), resting = 0;
  await waitForState(page, "the settled focused control to rest on screen", async () => {
    after = await measure();
    resting = after.top < after.h && after.bottom > 0 && after.unobscured ? resting + 1 : 0;
    return resting >= 2;
  }, { timeout: 5000, interval: 300 }).catch(() => {});
  assert.ok(after.top < after.h && after.bottom > 0 && after.unobscured,
    `the settled focused control is on screen after the re-render: ${JSON.stringify({ displaced, after })}`);
});

test("native review refuses self-consistent text from a different pinned evidence version", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.route("**/work-result?**", async route => {
    const response = await route.fetch(), value = await response.json(); value.result.text.body = "A substituted result";
    value.result.text.byteLength = Buffer.byteLength(value.result.text.body); value.result.text.evidenceVersion = value.result.receipt.evidenceVersion = textVersion(value.result.text.body);
    return route.fulfill({ status: 200, json: value });
  });
  await f.open(); await f.page.getByText("Exact text unavailable. Review current work to try again.", { exact: true }).waitFor();
  assert.equal(await f.save.isEnabled(), false); assert.equal(await f.page.locator("#action-text-body").textContent(), ""); assert.equal(f.item().verification, null);
});

test("native draft cannot save stale work; explicit refresh keeps the selected text", { timeout: 25000 }, async t => {
  const f = await setup(t); await f.open(); await f.textReady(); await f.fill(); f.mutate(T.WORK_STARTED);
  await f.page.locator("#refresh-action").waitFor({ state: "visible" }); assert.equal(await f.save.isEnabled(), false);
  await f.page.locator("#refresh-action").click(); await f.textReady(); await f.page.waitForFunction(() => !document.querySelector("#action-form button[type=submit]").disabled);
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" }); assert.equal(f.item().receipt.nativeText.messageId, "native-draft");
});

test("native result large text and keyboard remain usable; revocation clears visible text", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await f.open(); await f.textReady();
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#cancel-action").focus(); await f.page.keyboard.press("Escape"); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body); await f.capture("large-text");
  assert.equal(await f.page.locator("#result-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "human-checker", expectedMemberRevision: 0, permissions: ["verify"], active: false });
  await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#result-body").textContent(), ""); assert.equal(await f.page.locator("#action-text-body").textContent(), "");
});

for (const mobile of [false, true]) test(`native result ${mobile ? "phone" : "desktop"}: failed read retries the pinned result in place`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); f.complete();
  const attempts = [], retry = f.page.locator("#result-retry"); let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  await f.page.route("**/work-result?**", async route => {
    attempts.push(new URL(route.request().url()).searchParams.get("completionEventId"));
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: "Synthetic unavailable" } });
    const response = await route.fetch(); began(); await gate;
    return route.fulfill({ response }).catch(() => {});
  });
  await f.page.locator("#message-input").fill("Keep my steering draft.");
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(() => document.querySelector("#result-status").textContent.includes("unavailable"));
  assert.equal(await retry.isVisible(), true, "a failed exact result can be retried inside its selected reader");
  await retry.focus(); await f.page.keyboard.press("Enter"); await started;
  assert.equal(await retry.isDisabled(), true);
  await retry.evaluate(node => node.click()); assert.equal(attempts.length, 2, "one retry read can be pending");
  // Another result arrives while the selected old read is held. Retrying must
  // retain the exact original completion and never show the replacement text.
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Revise" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" });
  const body = "Replacement result", posted = f.send(T.MESSAGE_POSTED, { messageId: "replacement-draft", workItemId: f.workItemId, packetId: "replacement", basisRevision: f.item().revision, body });
  f.mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "replacement-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: f.item().receipt.eventId, producerId: "owner", summary: "Replacement", nextAction: "Review" });
  await f.page.waitForFunction(id => document.querySelector(`[data-work-record-id="${id}"]`).textContent.includes("Replacement"), f.workItemId);
  release(); await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.match(await f.page.locator("#result-status").textContent(), /^Earlier result/);
  assert.equal(attempts[0], attempts[1]); assert.equal(await retry.isVisible(), false);
  assert.equal(await f.page.locator("#close-result").evaluate(node => node === document.activeElement), true, "hidden retry hands keyboard focus to Close");
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep my steering draft.");
  await f.capture(mobile ? "retry-phone" : "retry-desktop");
  await f.page.keyboard.press("Escape"); await f.page.locator("#result-dialog").waitFor({ state: "hidden" });
  await f.page.reload(); await f.page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep my steering draft.");
});

for (const boundary of ["close", "revoke"]) test(`native result: held retry cannot restore text after ${boundary}`, { timeout: 25000 }, async t => {
  const f = await setup(t); f.complete(); let attempts = 0, release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; }); t.after(() => release());
  await f.page.route("**/work-result?**", async route => {
    attempts++;
    if (attempts !== 2) return route.fulfill({ status: 503, json: { error: "Synthetic unavailable" } });
    const response = await route.fetch(); began(); await gate;
    return route.fulfill({ response }).catch(() => {});
  });
  const open = () => f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await open(); await f.page.locator("#result-retry").waitFor({ state: "visible" });
  await f.page.locator("#result-retry").click(); await started;
  if (boundary === "close") {
    await f.page.keyboard.press("Escape"); await f.page.locator("#result-dialog").waitFor({ state: "hidden" });
    await open(); await f.page.locator("#result-retry").waitFor({ state: "visible" });
  } else {
    f.store.issueAccessKey("commons", "owner");
    await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  }
  release(); await f.page.unroute("**/work-result?**", { behavior: "wait" });
  assert.equal(await f.page.locator("#result-body").textContent(), "");
  if (boundary === "close") {
    assert.match(await f.page.locator("#result-status").textContent(), /unavailable/);
    assert.equal(await f.page.locator("#result-retry").isEnabled(), true);
  } else assert.equal(await f.page.locator("#result-dialog").isVisible(), false);
});

// A live update that re-renders the timeline while the member's focus is on a
// work card's "View result" button must leave that button on screen.
test("native result 320px: a live update keeps the focused View result control on screen", { timeout: 30000 }, async t => {
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 } });
  const { page } = f, read = page.locator(`[data-work-record-id="${f.workItemId}"] [data-read-result]`);
  await read.waitFor();
  await read.focus();
  const where = () => page.evaluate(() => { const b = document.activeElement.getBoundingClientRect(); return { tag: document.activeElement.dataset.readResult ?? document.activeElement.tagName, top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight, scrollY: Math.round(scrollY) }; });
  const before = await where();
  for (let i = 0; i < 3; i++) { f.send(T.MESSAGE_POSTED, { body: `Live update ${i}`, replyToId: "test-welcome" }); await page.waitForTimeout(250); }
  const mid = await where();
  f.send(T.MESSAGE_POSTED, { messageId: "native-follow", workItemId: f.workItemId, packetId: "human-packet", basisRevision: f.item().revision, body: "Follow-up on the same work" });
  await page.waitForTimeout(500);
  const after = await where();
  assert.ok(after.top >= 0 && after.bottom <= after.h, `focused control on screen after live updates: ${JSON.stringify({ before, mid, after })}`);
});

// A room credential that dies while the account is still signed in used to drop
// the member to the room list with no explanation.
test("a room session that ends under a live account says so and points back to the room list", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "admin", displayName: "Test admin", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account"); f.store.completeOnboarding("admin-account"); f.store.bindHumanAccount("commons", "admin", "admin-account");
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Same stall math as the waits below: the shared sign-in helper's waits ride
  // this page default, and 8s is a stall death sentence for a ~1s leg.
  page.setDefaultTimeout(30000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}/?account=1`);
  await signInFixture(page, f.store.issueAccountAccessKey("admin-account"), { returnTo: `${origin}/?account=1` });
  await page.locator("#account-rooms-panel").waitFor();
  await clickChrome(page, "#nav-rooms");
  await page.locator('[data-account-room="commons"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("A draft that must survive.");
  let dead = false;
  await page.route(url => /\/api\/rooms\/commons(\?|$)/.test(new URL(url).pathname + new URL(url).search), route =>
    dead && route.request().method() === "GET"
      ? route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Session or key expired or revoked" } } })
      : route.continue());
  dead = true;
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Trigger a refresh", replyToId: "test-welcome" } });
  const notice = page.locator("#account-status");
  // The notice lands only after the stream-driven refresh round trip reads
  // the 401: ~1s unloaded, past the 8s default on a stalled hosted runner
  // (pure locator timeout, no assertion failure). Poll the state.
  await waitForState(page, "the ended-session notice to appear", async () => await notice.isVisible().catch(() => false));
  assert.match(await notice.textContent(), /Your session in that room ended\. Open the room again from your room list/);
  assert.equal(await page.locator("#main").isHidden(), true, "the room is closed");
  // E-H2: the credential died, the member did not leave. Reopening from the room list
  // (which ends access with no room open) must bring the unsent draft back.
  dead = false;
  await clickChrome(page, "#nav-rooms");
  await page.locator('[data-account-room="commons"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  await waitForState(page, "the unsent draft to be restored on reopen", async () => await page.evaluate(() => document.querySelector("#message-input").value === "A draft that must survive.").catch(() => false));
  assert.deepEqual(errors, []);
});

for (const responseKind of ["wrong-completion", "missing-result"]) test(`native result: ${responseKind} cannot masquerade as the selected result`, { timeout: 25000 }, async t => {
  const f = await setup(t); f.complete();
  await f.page.route("**/work-result?**", async route => {
    const response = await route.fetch(), value = await response.json();
    if (responseKind === "wrong-completion") value.result.receipt.eventId = "another-completion-with-identical-text";
    await route.fulfill({ response, json: responseKind === "missing-result" ? { ...value, result: null } : value });
  });
  await f.page.locator("#message-input").fill("Keep this draft while reviewing.");
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.locator("#result-retry").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#result-body").textContent(), "");
  assert.equal(await f.page.locator("#result-discuss").isVisible(), false);
  await f.page.unroute("**/work-result?**");
  await f.page.locator("#result-retry").click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep this draft while reviewing.");
});

test("result reply refusal keeps the reader and private destination draft intact", { timeout: 30000 }, async t => {
  const f = await setup(t); f.complete();
  await messageAction(f.page, "native-draft", "reply");
  await f.page.locator("#message-input").fill("Private feedback draft");
  await f.page.locator("#message-to-select").evaluate(el => { el.value = "human-checker"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await f.page.locator("#thread-back").click();
  await f.page.locator("#message-input").fill("Room draft");
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.locator("#result-discuss").waitFor({ state: "visible" });
  await f.page.locator("#result-discuss").click();
  assert.equal(await f.page.locator("#result-dialog").isVisible(), true, "refused handoff leaves exact result visible");
  assert.equal(await f.page.locator("#message-input").inputValue(), "Room draft", "refusal must not navigate or replace the current draft");
  await f.page.locator("#close-result").click();
  await messageAction(f.page, "native-draft", "reply");
  assert.equal(await f.page.locator("#message-input").inputValue(), "Private feedback draft");
  assert.equal(await f.page.locator("#message-to-select").inputValue(), "human-checker");
  await f.page.locator("#message-to-select").evaluate(el => { el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await f.page.locator("#thread-back").click();
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.locator("#result-discuss").waitFor({ state: "visible" });
  await f.page.locator("#result-discuss").click();
  assert.equal(await f.page.locator("#main > #result-dialog.result-docked").isVisible(), true, "accepted desktop handoff retains the pinned result beside feedback");
  assert.equal(await f.page.locator("#message-input").inputValue(), "Private feedback draft");
  assert.equal(await f.page.locator("#message-input").evaluate(el => el === document.activeElement), true);
});

test("withdrawal clears an open review and prevents approval of missing text", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true }); await f.open(); await f.textReady();
  await f.save.focus();
  f.send(T.MESSAGE_DELETED, { messageId: "native-draft", expectedMessageRevision: 0 });
  await f.page.waitForFunction(() => document.querySelector('[data-message-record-id="native-draft"]')?.textContent.includes("deleted"));
  assert.equal(await f.page.locator("#action-text-body").textContent(), "", "withdrawal clears the review copy too");
  assert.equal(await f.save.isDisabled(), true, "withdrawn text cannot be approved from an open form");
  assert.equal(await f.page.locator("#cancel-action").evaluate(node => node === document.activeElement), true);
});

test("late review text cannot restore a withdrawn result", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  await f.page.route("**/work-result?**", async route => {
    const response = await route.fetch(); began(); await gate; await route.fulfill({ response });
  });
  await f.open(); await started;
  f.send(T.MESSAGE_DELETED, { messageId: "native-draft", expectedMessageRevision: 0 });
  await f.page.waitForFunction(() => document.querySelector('[data-message-record-id="native-draft"]')?.textContent.includes("deleted"));
  release();
  await f.page.locator("#action-text-origin").filter({ hasText: "This text was withdrawn" }).waitFor();
  assert.equal(await f.page.locator("#action-text-body").textContent(), "");
  assert.equal(await f.save.isDisabled(), true);
});

// Composed from PR #4285: force offscreen focus before a node replacement.
test("native result 320px: a card re-render rescues a focused View result control that starts off screen", { timeout: 30000 }, async t => {
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 } });
  const { page } = f;
  const card = page.locator(`[data-work-record-id="${f.workItemId}"]`);
  const read = card.locator("[data-read-result]");
  await read.waitFor();
  // Quiesce first: the app's initial snapshot renders can land after the
  // first focus() and drop it, and a scroll forced mid-settle is clamped by
  // the still-shifting layout. Poll until this control holds focus and its
  // geometry is unchanged across two reads before forcing the start state.
  let last = null, stable = 0;
  await waitForState(page, "the View result control to hold focus in a settled layout", async () => {
    await read.focus().catch(() => {});
    const s = await page.evaluate(() => { const a = document.activeElement, b = a?.getBoundingClientRect?.();
      return a?.dataset?.focusKey ? { y: Math.round(scrollY), top: Math.round(b.top), key: a.dataset.focusKey } : null; }).catch(() => null);
    stable = s && s.key === `work-native-result:${f.workItemId}` && last && s.y === last.y && s.top === last.top ? stable + 1 : 0;
    last = s;
    return stable >= 1;
  });
  const displaced = await page.evaluate(() => {
    const el = document.activeElement, r = el.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, scrollY + r.top - (innerHeight + 60)), behavior: "instant" });
    const now = el.getBoundingClientRect();
    return { top: Math.round(now.top), h: innerHeight, scrollY: Math.round(scrollY), focused: document.activeElement === el };
  });
  assert.ok(displaced.focused && displaced.top >= displaced.h,
    `precondition: the focused control starts off screen: ${JSON.stringify(displaced)}`);
  const before = await read.elementHandle();
  f.mutate(T.WORK_BLOCKED, { reason: "Synthetic pin update", nextAction: "Revisit later" });
  // Settle means the swap actually landed: the pre-mutation node is
  // disconnected and focus rests on a different, connected control with this
  // work's focus key. (Checking the key alone would pass on the old node
  // before the stream even delivers the mutation.)
  const settled = await page.waitForFunction(({ old, id, key }) => new Promise(resolve => {
    const ok = () => { const a = document.activeElement; return a && a !== old && !old.isConnected && a.dataset.focusKey === key
      && a.closest("[data-work-record-id]")?.dataset.workRecordId === id && a.isConnected; };
    if (!ok()) return resolve(false);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(ok())));
  }), { old: before, id: f.workItemId, key: `work-native-result:${f.workItemId}` }, { timeout: 8000 }).then(() => true, () => false);
  assert.ok(settled, "the re-render replaces the focused node and focus settles on the replacement control");
  // Assert the final resting position, not a mid-burst sample: poll until
  // the settled control is on screen and stays there across two reads.
  const measure = () => page.evaluate(() => {
    const el = document.activeElement, b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, b.left + b.width / 2)), Math.max(0, Math.min(innerHeight - 1, b.top + b.height / 2)));
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight, scrollY: Math.round(scrollY),
      unobscured: hit === el || el.contains(hit) };
  });
  let after = await measure(), resting = 0;
  await waitForState(page, "the settled focused control to rest on screen", async () => {
    after = await measure();
    resting = after.top < after.h && after.bottom > 0 && after.unobscured ? resting + 1 : 0;
    return resting >= 2;
  }, { timeout: 5000, interval: 300 }).catch(() => {});
  assert.ok(after.top < after.h && after.bottom > 0 && after.unobscured,
    `the settled focused control is on screen after the re-render: ${JSON.stringify({ displaced, after })}`);
});
