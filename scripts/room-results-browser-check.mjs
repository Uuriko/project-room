// Simulated people, real local browser. Fictional rooms; no outside services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createResultsFixture } from "./results-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t, { mobile = false, guest = false, expectedWrites = 0 } = {}) {
  const f = createResultsFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  p.setDefaultTimeout(8000);
  const errors = [], outside = [], writes = [];
  p.on("pageerror", error => errors.push(error.message));
  await p.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await p.goto(origin); await p.locator("#access-key").fill(f.keys[guest ? "guest" : "owner"]);
  await p.locator('#auth-form button[type="submit"]').click(); await p.locator("#main").waitFor({ state: "visible" });
  p.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/rooms/")) writes.push(request.url()); });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.equal(writes.length, expectedWrites); });
  const row = id => p.locator(`#room-results-list [data-result-work-id="${id}"]`);
  const open = () => p.locator("#work-view-results").click();
  const read = () => row("native-result").locator("[data-read-result]").click();
  const ready = () => p.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  const capture = async name => {
    mkdirSync("test-results/room-results-20260908", { recursive: true });
    await p.screenshot({ path: `test-results/room-results-20260908/${name}.png` });
  };
  return { ...f, p, row, open, read, ready, capture };
}

for (const mobile of [false, true]) test(`results ${mobile ? "touch" : "desktop"}: find, read and return without losing conversation`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile }), p = f.p;
  await p.locator("#message-input").fill("Keep my next thought.");
  const scroll = await p.locator("#message-list").evaluate(node => { node.scrollTop = 0; return node.scrollTop; });
  await f.open();
  assert.equal(await p.locator("#work-list").isVisible(), false);
  assert.equal(await p.locator("#room-results-list .result-row").count(), 2);
  assert.match(await f.row("native-result").textContent(), /Completed/);
  assert.match(await f.row("approved-result").textContent(), /Approved.*External evidence/);
  assert.equal(await f.row("pending-result").count(), 0);
  assert.equal(await f.row("approved-result").locator("a").getAttribute("rel"), "noreferrer");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "touch-list" : "desktop-list");
  await f.read(); await f.ready();
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  await f.capture(mobile ? "touch-reader" : "desktop-reader");
  await p.keyboard.press("Escape");
  assert.equal(await f.row("native-result").locator("[data-read-result]").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.locator("#message-input").inputValue(), "Keep my next thought.");
  assert.equal(await p.locator("#message-list").evaluate(node => node.scrollTop), scroll);
  await f.row("native-result").locator("[data-result-work]").click();
  assert.equal(await p.locator("#work-list").isVisible(), true);
  assert.equal(await p.locator('[data-work-record-id="native-result"] .work-details').evaluate(node => node.open), true);
  await p.locator("#room-actions-open").click(); await p.locator('[data-room-action="results"]').click();
  assert.equal(await p.locator("#work-view-results").getAttribute("aria-pressed"), "true");
});

test("results update after review and reopening; a pinned open reader becomes earlier, not a replacement", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  f.review("pending-result"); await f.row("pending-result").waitFor();
  await f.read(); await f.ready(); f.reopen("native-result");
  await p.waitForFunction(() => document.querySelector("#result-status").textContent.startsWith("Earlier result"));
  assert.equal(await p.locator("#result-body").textContent(), f.body);
  assert.equal(await f.row("native-result").count(), 0);
  await p.locator("#close-result").click();
  assert.equal(await p.locator("#work-view-results").evaluate(node => node === document.activeElement), true);
  f.reopen("pending-result"); f.reopen("approved-result");
  await p.locator("#room-results-list .empty-note").waitFor();
  assert.equal(await p.locator("#room-results-list").textContent(), "Completed results appear here.");
});

test("result read failure preserves the list and allows a deliberate retry", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  await p.route("**/work-result?**", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await f.read(); await p.waitForFunction(() => document.querySelector("#result-status").textContent.includes("unavailable"));
  assert.equal(await p.locator("#result-body").textContent(), "");
  await p.locator("#close-result").click(); await p.unroute("**/work-result?**");
  await f.read(); await f.ready();
});

test("late result reads cannot restore content after sign-out, and the Results view resets", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.p; await f.open();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  await p.route("**/work-result?**", async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await f.read(); await began;
  await p.locator("#signout-button").evaluate(node => node.click());
  await p.locator("#auth-panel").waitFor(); release();
  assert.equal(await p.locator("#result-body").textContent(), "");
  assert.equal(await p.locator("#room-results-list").textContent(), "");
  assert.equal(await p.locator("#work-view-work").getAttribute("aria-pressed"), "true");
  await p.unroute("**/work-result?**", { behavior: "wait" });
  assert.equal(await p.locator("#result-dialog").isVisible(), false);
});

test("guest Results remain useful with large text and no creation controls", { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile: true, guest: true }), p = f.p;
  await p.evaluate(() => document.documentElement.style.fontSize = "200%");
  await f.open();
  assert.equal(await p.locator("#new-work-button").isVisible(), false);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.read(); await f.ready();
  assert.equal(await p.locator("#result-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await f.capture("large-text");
});

test("creating new work from Results returns to Work only after explicit confirmed submission", { timeout: 30000 }, async t => {
  const f = await setup(t, { expectedWrites: 1 }), p = f.p; await f.open();
  assert.equal(await p.locator("#new-work-button").textContent(), "New work");
  await p.locator("#new-work-button").click(); await p.locator("#cancel-work-button").click();
  assert.equal(await p.locator("#work-view-results").getAttribute("aria-pressed"), "true");
  await p.locator("#new-work-button").click();
  await p.locator("#work-title-input").fill("Follow up on the result");
  await p.locator("#work-done-input").fill("One clear next action.");
  await p.locator("#assignee-select").selectOption("producer");
  await p.locator("#verifier-select").selectOption("reviewer");
  await p.locator("#new-work-form button[type=submit]").click();
  await p.locator("#work-dialog").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#work-view-work").getAttribute("aria-pressed"), "true");
  assert.equal(await p.locator("#work-list").isVisible(), true);
  assert.ok(Object.values(f.state().workItems).some(item => item.title === "Follow up on the result" && item.state === "proposed"));
});
