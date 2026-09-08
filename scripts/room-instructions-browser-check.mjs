// Synthetic human journeys, not a human usability or retention study.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { CHARTER_TYPE } from "../src/room-charter.js";

async function setup(t, { mobile = false, seeded = false, actor = "owner", noStream = false } = {}) {
  const f = createAcceptanceFixture();
  const change = purpose => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: CHARTER_TYPE, data: {
    expectedRevision: f.store.room("commons").state.room.charter?.revision ?? 0, purpose, outputs: "A short agenda", boundaries: "Synthetic room only", escalation: "Ask the owner" } });
  if (seeded) change("Original purpose");
  const server = createRoomServer({ store: f.store, streamInterval: 40 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  page.setDefaultTimeout(7000); const errors = [], outside = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin !== origin) { outside.push(url.href); return route.abort(); } if (noStream && url.pathname.endsWith("/stream")) return route.abort(); return route.continue(); });
  await page.goto(origin); await page.locator("#access-key").fill(f.keys[actor]); await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor({ state: "visible" });
  const open = async () => { await page.locator("#room-about").evaluate(el => { el.open = true; }); await page.locator("#room-instructions-open").click(); };
  const edit = async () => { await open(); if (await page.locator("#room-instructions-edit").isVisible()) await page.locator("#room-instructions-edit").click(); };
  const field = name => page.locator(`#room-instructions-form [name='${name}']`);
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/room-instructions-${name}.png` }); };
  const ready = async () => page.waitForFunction(() => !document.querySelector("#room-instructions-save").disabled);
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, origin, open, edit, field, capture, change, ready,
    save: page.locator("#room-instructions-save"), close: page.locator("#room-instructions-close"), dialog: page.locator("#room-instructions-dialog"),
    current: () => f.store.room("commons").state.room.charter };
}

for (const mobile of [false, true]) test(`room instructions ${mobile ? "mobile" : "desktop"}: owner saves exact text, reviews history and deliberately clears`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); await f.edit();
  await f.field("purpose").fill("A useful room 🪷\nOne next step."); await f.field("boundaries").fill("No external actions.");
  assert.equal(await f.dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.capture(mobile ? "mobile" : "desktop"); await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(f.current().purpose, "A useful room 🪷\nOne next step."); assert.equal(f.current().revision, 1);
  await f.open(); assert.equal(await f.page.locator("#room-instructions-view").textContent(), "PurposeA useful room 🪷\nOne next step.BoundariesNo external actions.");
  await f.page.locator("#room-instructions-previous").click(); await f.page.getByText("Not set", { exact: true }).waitFor();
  await f.page.locator("#room-instructions-refresh").click(); await f.page.waitForFunction(() => document.querySelector("#room-instructions-version").textContent.startsWith("Version 1"));
  await f.page.locator("#room-instructions-edit").click(); for (const key of ["purpose", "outputs", "boundaries", "escalation"]) await f.field(key).fill("");
  f.page.once("dialog", d => d.accept()); await f.save.click(); await f.dialog.waitFor({ state: "hidden" }); assert.equal(f.current().revision, 2); assert.equal(f.current().purpose, null);
  assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, 0);
});

test("unknown committed charter retains exact retry through close, later update and size/rate refusals", { timeout: 25000 }, async t => {
  const f = await setup(t), attempts = []; await f.edit(); await f.field("purpose").fill("First draft");
  await f.page.route("**/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); return route.abort(); }
    if (attempts.length <= 3) return route.fulfill({ status: attempts.length === 2 ? 413 : 429, json: { error: { code: attempts.length === 2 ? "too_large" : "rate_limited", message: "Synthetic refusal" } } });
    return route.continue();
  });
  await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  await f.close.click(); f.change("A newer saved version");
  let warning; f.page.once("dialog", async d => { warning = d.message(); await d.dismiss(); }); await f.page.locator("#signout-button").click(); assert.match(warning, /may already be saved/);
  await f.open(); assert.equal(await f.field("purpose").isDisabled(), true);
  for (let i = 0; i < 3; i++) { await f.save.click(); if (i < 2) await f.ready(); }
  await f.dialog.waitFor({ state: "hidden" }); assert.equal(attempts.length, 4); for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
  assert.equal(f.current().revision, 2); assert.equal(f.current().purpose, "A newer saved version");
});

test("uncommitted unknown retry resolves stale without live updates and keeps both drafts visible", { timeout: 25000 }, async t => {
  const f = await setup(t, { seeded: true, noStream: true }), attempts = []; await f.edit(); await f.field("purpose").fill("My retained draft");
  await f.page.route("**/commands", route => { attempts.push(route.request().postDataJSON()); return attempts.length === 1 ? route.abort() : route.continue(); });
  await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  f.change("Another editor's version"); await f.save.click(); await f.page.locator("#room-instructions-refresh").waitFor({ state: "visible" });
  assert.deepEqual(attempts[0], attempts[1]); await f.page.locator("#room-instructions-refresh").click();
  await f.page.locator("#room-instructions-latest").waitFor({ state: "visible" }); assert.equal(await f.field("purpose").inputValue(), "My retained draft");
  assert.match(await f.page.locator("#room-instructions-comparison").textContent(), /Another editor's version/); await f.capture("conflict");
  await f.page.locator("#instructions-keep-draft").click(); await f.ready(); await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(attempts[2].data.expectedRevision, 2); assert.notEqual(attempts[2].id, attempts[0].id); assert.equal(f.current().purpose, "My retained draft"); assert.equal(f.current().revision, 3);
});

test("nonowner instructions are selectable text; keyboard and 200 percent text work", { timeout: 20000 }, async t => {
  const f = await setup(t, { mobile: true, seeded: true, actor: "guest" });
  await f.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await f.open();
  assert.equal(await f.page.locator("#room-instructions-edit").isVisible(), false); assert.equal(await f.page.locator("#room-instructions-form").isVisible(), false);
  assert.equal(await f.page.locator("#room-instructions-view p").first().evaluate(el => getComputedStyle(el).fontSize), "32px");
  assert.equal(await f.dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true); await f.capture("large-text-bottom");
  await f.dialog.evaluate(el => { el.scrollTop = 0; }); await f.capture("large-text");
  await f.close.focus(); await f.page.keyboard.press("Tab"); assert.equal(await f.page.locator("#room-instructions-previous").evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press("Shift+Tab"); assert.equal(await f.close.evaluate(el => el === document.activeElement), true);
  await f.page.keyboard.press("Escape"); await f.dialog.waitFor({ state: "hidden" }); assert.equal(await f.page.locator("#room-instructions-open").evaluate(el => el === document.activeElement), true);
});

test("charter read session revocation clears text and ignores a late response", { timeout: 20000 }, async t => {
  const f = await setup(t, { seeded: true, actor: "guest" }); await f.open(); let release, fetched;
  const gate = new Promise(resolve => { release = resolve; }); const observed = new Promise(resolve => { fetched = resolve; });
  await f.page.route("**/charter?revision=0", async route => { const result = await route.fetch(); fetched(); await gate; await route.fulfill({ response: result }); });
  await f.page.locator("#room-instructions-previous").click(); await observed;
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed", data: { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false } });
  await f.page.locator("#auth-panel").waitFor({ state: "visible" }); release();
  await f.page.waitForLoadState("domcontentloaded"); assert.equal(await f.dialog.isVisible(), false); assert.equal(await f.page.locator("#room-instructions-view").textContent(), "");
});

test("malformed success stays unknown; an initial definitive size refusal allows editing", { timeout: 20000 }, async t => {
  const f = await setup(t); await f.edit(); await f.field("purpose").fill("Unsent"); let attempt = 0;
  await f.page.route("**/commands", async route => {
    attempt++;
    if (attempt === 1) return route.fulfill({ status: 413, json: { error: { code: "too_large", message: "Use less text" } } });
    if (attempt === 2) return route.fulfill({ status: 200, json: { sequence: 1, duplicate: false, event: {} } });
    return route.continue();
  });
  await f.save.click(); await f.page.getByText("Use less text", { exact: true }).waitFor(); assert.equal(await f.field("purpose").isEnabled(), true);
  await f.field("purpose").fill("Revised draft"); await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" }); assert.equal(f.current().revision, 1); assert.equal(f.current().purpose, "Revised draft");
});
