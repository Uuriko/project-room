// Deep-link reveal vs the background fill (bug sweep 2026-10-16,
// CLIENT-CORE Finding 2, issue #3884): a cold load at a message link
// older than the first window (newest 100) used to drop the reveal —
// revealLocationHash ran once, on the windowed snapshot, and nothing
// re-ran it when the fill brought the message in. The client now pends
// the reveal and fires it on the first snapshot that holds the target,
// exactly once, unless the user takes over first (another navigation,
// a thread/channel switch, or a reader scroll). Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

// 130 messages: the first snapshot windows the newest 100, so seed-10
// sits in the omitted segment only the background fill delivers, while
// seed-120 is inside the first window.
const TOTAL = 130;
const OLD_ID = "seed-10";
const RECENT_ID = "seed-120";

async function seed(store, keys) {
  const actors = [keys.owner, keys.guest, keys.producer].filter(Boolean);
  for (let n = 1; n <= TOTAL; n++) {
    const command = { id: randomUUID(), type: "message.posted",
      data: { messageId: `seed-${n}`, body: `seed message number ${n}` } };
    for (let attempt = 0; ; attempt++) {
      try { store.command(actors[n % actors.length], "commons", command); break; }
      catch (error) {
        if (error.status !== 429 || attempt > 60) throw error;
        await new Promise(resolve => setTimeout(resolve, (error.retryAfterMs ?? 100) + 60));
      }
    }
  }
}

// gateFill holds every /conversation page (the backfill's only path)
// until releaseFill() runs, so a test can act while the fill is
// provably still in flight instead of racing its 250 ms head start.
async function setup(t, { gateFill = false } = {}) {
  const f = createAcceptanceFixture({ managedProducer: false });
  await seed(f.store, f.keys);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(30000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  let releaseFill = () => {};
  if (gateFill) {
    const gate = new Promise(resolve => { releaseFill = resolve; });
    await page.route(url => url.pathname.endsWith("/conversation"), async route => { await gate; await route.continue(); });
  }
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, []); });
  return { ...f, page, origin, releaseFill };
}

async function openDeepLink({ page, keys, origin }, hash) {
  await page.goto(`${origin}/${hash}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
}

const focusedId = page => page.evaluate(() => document.activeElement?.dataset?.messageRecordId ?? null);
const rowPresent = (page, id) => page.locator(`[data-message-record-id="${id}"]`).count().then(count => count > 0);

test("cold-load deep link to a pre-window message reveals it when the fill lands", { timeout: 240000 }, async t => {
  const ctx = await setup(t);
  await openDeepLink(ctx, `#pr-record/message/${OLD_ID}`);
  await ctx.page.waitForFunction(id => document.activeElement?.dataset?.messageRecordId === id, OLD_ID, { timeout: 20000 });
  assert.equal(await focusedId(ctx.page), OLD_ID);
});

test("legacy #message- link to a pre-window message reveals it when the fill lands", { timeout: 240000 }, async t => {
  const ctx = await setup(t);
  await openDeepLink(ctx, `#message-${OLD_ID}`);
  await ctx.page.waitForFunction(id => document.activeElement?.dataset?.messageRecordId === id, OLD_ID, { timeout: 20000 });
  assert.equal(await focusedId(ctx.page), OLD_ID);
});

test("a reader scroll before the fill lands cancels the pending reveal", { timeout: 240000 }, async t => {
  const ctx = await setup(t, { gateFill: true });
  const { page } = ctx;
  await openDeepLink(ctx, `#pr-record/message/${OLD_ID}`);
  assert.equal(await rowPresent(page, OLD_ID), false, "target still behind the gated fill");
  const list = page.locator("#message-list");
  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 800);
  ctx.releaseFill();
  await page.waitForFunction(id => Boolean(document.querySelector(`[data-message-record-id="${id}"]`)), OLD_ID, { timeout: 20000 });
  await page.waitForTimeout(1000);
  assert.notEqual(await focusedId(page), OLD_ID, "the late reveal must not steal the view after a reader scroll");
});

test("navigating to another message before the fill lands cancels the pending reveal", { timeout: 240000 }, async t => {
  const ctx = await setup(t, { gateFill: true });
  const { page } = ctx;
  await openDeepLink(ctx, `#pr-record/message/${OLD_ID}`);
  assert.equal(await rowPresent(page, OLD_ID), false, "target still behind the gated fill");
  await page.evaluate(id => {
    const a = document.createElement("a");
    a.href = `#pr-record/message/${id}`; a.dataset.openMessage = id; a.textContent = "newer message";
    document.querySelector("#main").append(a); a.click();
  }, RECENT_ID);
  await page.waitForFunction(id => document.activeElement?.dataset?.messageRecordId === id, RECENT_ID, { timeout: 10000 });
  ctx.releaseFill();
  await page.waitForFunction(id => Boolean(document.querySelector(`[data-message-record-id="${id}"]`)), OLD_ID, { timeout: 20000 });
  await page.waitForTimeout(1000);
  assert.equal(await focusedId(page), RECENT_ID, "focus stays on the message the user chose");
});

test("a deep link inside the first window reveals immediately, before the fill", { timeout: 240000 }, async t => {
  const ctx = await setup(t, { gateFill: true });
  const { page } = ctx;
  await openDeepLink(ctx, `#pr-record/message/${RECENT_ID}`);
  await page.waitForFunction(id => document.activeElement?.dataset?.messageRecordId === id, RECENT_ID, { timeout: 10000 });
  assert.equal(await rowPresent(page, OLD_ID), false, "fill still gated: the reveal did not wait for it");
  ctx.releaseFill();
  await page.waitForFunction(id => Boolean(document.querySelector(`[data-message-record-id="${id}"]`)), OLD_ID, { timeout: 20000 });
  await page.waitForTimeout(1000);
  assert.equal(await focusedId(page), RECENT_ID, "no second reveal moves focus after the fill");
});
