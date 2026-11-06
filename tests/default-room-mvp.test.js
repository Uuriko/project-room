/* global document */
// Default room MVP: single-feature modules (reminders, device pairing, human
// push) stay off the room-entry path and load on their first trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "../scripts/auth-signin.mjs";
import { openConversationWork, openCatchUp, closeCatchUp, clickChrome } from "../scripts/room-chrome.mjs";

const DEFERRED = ["/src/reminders.js", "/src/pairing-ui.js", "/src/human-push.js"];
const DEFERRED_READS = ["/api/rooms/commons/reminders", "/api/rooms/commons/human-push"];

async function harness(t, width = 390) {
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], paths = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => paths.push(new URL(request.url()).pathname));
  await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  return { f, page, errors, paths };
}
const count = (paths, path) => paths.filter(p => p === path).length;
async function remindButton(page) {
  const card = await openConversationWork(page, "test-handoff");
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  return card.getByRole("button", { name: "Remind me", exact: true });
}

for (const width of [390, 1280]) test(`room entry at ${width}px does not load reminders, pairing or push`, { timeout: 60000 }, async t => {
  const { page, errors, paths } = await harness(t, width);
  await page.reload(); await page.locator("#main").waitFor({ state: "visible" }); await page.waitForTimeout(1200);
  for (const path of [...DEFERRED, ...DEFERRED_READS]) assert.equal(count(paths, path), 0, `${path} stays off room entry`);
  // Review and revocation paths are still live on entry.
  assert.ok(paths.includes("/api/rooms/commons/stream"), "the live stream (revocation, review state) stays eager");
  await openCatchUp(page);
  for (let i = 0; i < 50 && !paths.includes("/api/rooms/commons/reminders"); i++) await page.waitForTimeout(100);
  assert.equal(count(paths, "/src/reminders.js"), 1);
  assert.ok(paths.includes("/api/rooms/commons/reminders"));
  assert.deepEqual(errors, []);
});

test("the first Remind me click is replayed after load; a double click opens once", { timeout: 60000 }, async t => {
  const { page, errors, paths } = await harness(t);
  const button = await remindButton(page);
  await button.dblclick();
  await page.locator("#reminder-dialog[open]").waitFor();
  await page.locator('#reminder-form[aria-busy="false"]').waitFor();
  assert.equal(count(paths, "/src/reminders.js"), 1, "one import for repeated clicks");
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 1);
  await page.keyboard.press("Escape");
  await page.locator("#reminder-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("a failed import reports once and the next click retries", { timeout: 60000 }, async t => {
  const { page, errors } = await harness(t);
  let fail = true;
  await page.route("**/src/reminders.js*", route => fail ? route.abort("failed") : route.continue());
  const button = await remindButton(page);
  await button.click();
  await page.locator("#status", { hasText: "Could not load reminders. Try again." }).waitFor();
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 0);
  assert.equal(await button.getAttribute("aria-busy"), null, "the trigger is not left busy");
  fail = false;
  await button.click();
  await page.locator("#reminder-dialog[open]").waitFor();
  assert.deepEqual(errors, []);
});

test("Escape during the load drops the replay and keeps focus on the trigger", { timeout: 60000 }, async t => {
  const { page, errors } = await harness(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/src/reminders.js*", async route => { await gate; await route.continue(); });
  const button = await remindButton(page);
  await button.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  release();
  await page.waitForFunction(() => !document.querySelector("[data-reminder-work][aria-busy]"));
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 0, "Escape cancels the held open");
  assert.equal(await button.evaluate(node => node === document.activeElement), true);
  await button.click();
  await page.locator("#reminder-dialog[open]").waitFor();
  assert.deepEqual(errors, []);
});

test("a warm reopen reads conversations once, not once per paint", { timeout: 60000 }, async t => {
  const { page, errors, paths } = await harness(t);
  await page.waitForTimeout(500);
  paths.length = 0;
  await page.reload(); await page.locator("#main").waitFor({ state: "visible" });
  for (let i = 0; i < 30 && !paths.includes("/api/rooms/commons/conversations"); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1000);
  assert.equal(count(paths, "/api/rooms/commons/conversations"), 1, "the warm boot paint waits for the live snapshot");
  assert.deepEqual(errors, []);
});

// --- CURE-SPEC-5492 §4.1 regression tests (T1–T3, T5–T7; T4 lives in
// tests/pairing-ui.test.js). Harness patterns proven by wave-1100 cohort-05
// lanes 01/02 at base 1a8834ed: the agent-kind session is minted via
// f.store.createJoinSession("commons", "producer") + room_session cookie
// (signInFixture refuses agent access keys by design, so the spec's
// "sign in with f.keys.producer" setup is realised this way), and
// Notification.permission is stubbed "granted" via grantPermissions +
// addInitScript before any page script runs.
async function grantedHarness(t, { agent = false } = {}) {
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], paths = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => paths.push(new URL(request.url()).pathname));
  await context.grantPermissions(["notifications"], { origin });
  await page.addInitScript(value => {
    try { Object.defineProperty(globalThis.Notification, "permission", { get: () => value, configurable: true }); } catch {}
  }, "granted");
  await page.goto(origin);
  let session;
  if (agent) {
    const joined = f.store.createJoinSession("commons", "producer");
    await context.addCookies([{ name: "room_session", value: joined.token, url: origin }]);
    session = await (await context.request.get(`${origin}/api/session`)).json();
    await page.goto(`${origin}/?room=commons`);
  } else {
    session = await signInFixture(page, f.keys.owner);
  }
  await page.locator("#main").waitFor({ state: "visible" });
  // Measured entry: clear sign-in traffic, reload, #main visible + 1200 ms
  // (the same settle as the existing entry tests and spec §4.1 T1).
  paths.length = 0;
  await page.reload(); await page.locator("#main").waitFor({ state: "visible" }); await page.waitForTimeout(1200);
  return { f, page, errors, paths, session };
}

async function openPairingDialog(page, paths) {
  if (!(await page.locator("#invite-navigation").evaluate(node => node.open))) await page.locator("#invite-navigation > summary").click();
  await clickChrome(page, "#connect-agent-button");
  await page.locator("#agent-connect-dialog").waitFor({ state: "visible" });
  for (let i = 0; i < 50 && !paths.includes("/src/pairing-ui.js"); i++) await page.waitForTimeout(100);
}

async function signOut(page) {
  if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click();
  await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
}

test("agent-kind session with notification permission granted does not load human-push at entry", { timeout: 120000 }, async t => {
  const { page, errors, paths, session } = await grantedHarness(t, { agent: true });
  assert.equal(session?.member?.kind, "agent", "producer session must be agent-kind");
  assert.equal(await page.evaluate(() => globalThis.Notification?.permission), "granted");
  assert.equal(count(paths, "/src/human-push.js"), 0, "human-push module stays unfetched for an agent-kind session");
  assert.equal(count(paths, "/api/rooms/commons/human-push"), 0);
  assert.deepEqual(errors, []);
});

test("owner session with notification permission granted still loads human-push once at entry", { timeout: 120000 }, async t => {
  const { page, errors, paths, session } = await grantedHarness(t, { agent: false });
  assert.equal(session?.member?.kind, "human", "owner session must be human-kind");
  assert.equal(await page.evaluate(() => globalThis.Notification?.permission), "granted");
  assert.equal(count(paths, "/src/human-push.js"), 1, "owner+granted positive control fetches human-push exactly once");
  assert.deepEqual(errors, []);
});

test("agent-kind session opening catch-up loads reminders but not human-push", { timeout: 120000 }, async t => {
  const { page, errors, paths, session } = await grantedHarness(t, { agent: true });
  assert.equal(session?.member?.kind, "agent", "producer session must be agent-kind");
  await openCatchUp(page);
  for (let i = 0; i < 50 && !paths.includes("/api/rooms/commons/reminders"); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  assert.equal(count(paths, "/src/reminders.js"), 1, "catch-up loads reminders exactly once");
  assert.ok(paths.includes("/api/rooms/commons/reminders"), "the reminders read arrives");
  assert.equal(count(paths, "/src/human-push.js"), 0, "catch-up must not fetch human-push for an agent-kind session");
  assert.deepEqual(errors, []);
});

test("leaving a room resets all three on-demand features", { timeout: 120000 }, async t => {
  const { f, page, errors, paths } = await harness(t, 1280);
  // Room 1: pairing loads via its trigger; seed the pair-row DOM state
  // refresh() leaves behind (a real pair row needs an external agent import;
  // the assertion under test is the access-end reset, not row creation).
  await openPairingDialog(page, paths);
  assert.ok(paths.includes("/src/pairing-ui.js"), "pairing module loaded via its trigger");
  await page.evaluate(() => {
    const item = document.createElement("li");
    item.textContent = "Stale Pair (seeded row)";
    document.querySelector("#agent-pair-list").replaceChildren(item);
    document.querySelector("#agent-pairs").hidden = false;
  });
  assert.equal(await page.locator("#agent-pair-list > li").count(), 1, "seeded pair row present before leaving");
  await page.evaluate(() => document.querySelector("#agent-connect-dialog")?.close());
  // Catch-up loads reminders and human push in room 1.
  await openCatchUp(page);
  for (let i = 0; i < 50 && !paths.includes("/api/rooms/commons/reminders"); i++) await page.waitForTimeout(100);
  for (let i = 0; i < 50 && !paths.includes("/src/human-push.js"); i++) await page.waitForTimeout(100);
  assert.equal(count(paths, "/src/reminders.js"), 1);
  assert.equal(count(paths, "/src/human-push.js"), 1);
  await closeCatchUp(page);
  // Leave the room (access end), then assert no view state survives.
  await signOut(page);
  const afterEnd = await page.evaluate(() => ({
    rows: document.querySelector("#agent-pair-list").childElementCount,
    sectionHidden: document.querySelector("#agent-pairs").hidden,
    pushButtonHidden: document.querySelector("#human-push-button").hidden,
    pushNoteHidden: document.querySelector("#human-push-note").hidden,
    pushPrefsHidden: document.querySelector("#human-push-prefs").hidden
  }));
  assert.equal(afterEnd.rows, 0, "#agent-pair-list is emptied when access ends");
  assert.equal(afterEnd.sectionHidden, true, "#agent-pairs is hidden when access ends");
  assert.equal(afterEnd.pushButtonHidden, true, "#human-push-button is hidden when access ends");
  assert.equal(afterEnd.pushNoteHidden, true, "#human-push-note is hidden when access ends");
  assert.equal(afterEnd.pushPrefsHidden, true, "#human-push-prefs is hidden when access ends");
  // Enter a room again: no deferred module fires before its own trigger.
  const beforeReentry = { pairing: count(paths, "/src/pairing-ui.js"), push: count(paths, "/src/human-push.js") };
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForTimeout(1200);
  assert.equal(count(paths, "/src/pairing-ui.js") - beforeReentry.pairing, 0, "pairing is not fetched on the second entry before its trigger");
  assert.equal(count(paths, "/src/human-push.js") - beforeReentry.push, 0, "human-push is not fetched on the second entry before its trigger");
  const afterReentry = await page.evaluate(() => ({
    rows: document.querySelector("#agent-pair-list").childElementCount,
    sectionHidden: document.querySelector("#agent-pairs").hidden
  }));
  assert.equal(afterReentry.rows, 0, "#agent-pair-list stays empty on re-entry");
  assert.equal(afterReentry.sectionHidden, true, "#agent-pairs stays hidden on re-entry");
  assert.deepEqual(errors, []);
});

test("a pairing import in flight at room reset does not install into the next room", { timeout: 120000 }, async t => {
  const { f, page, errors } = await harness(t, 1280);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let markHit; const hit = new Promise(resolve => { markHit = resolve; });
  await page.route("**/src/pairing-ui.js*", async route => { markHit(); await gate; await route.continue(); });
  // Trigger the pairing load, then end access before the import lands
  // (route-delay pattern from the reminders Escape test above).
  if (!(await page.locator("#invite-navigation").evaluate(node => node.open))) await page.locator("#invite-navigation > summary").click();
  await clickChrome(page, "#connect-agent-button");
  await page.locator("#agent-connect-dialog").waitFor({ state: "visible" });
  await hit;
  await page.evaluate(() => document.querySelector("#agent-connect-dialog")?.close());
  await signOut(page);
  release();
  await page.waitForTimeout(500);
  // Next room: the late import must not have installed into it.
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForTimeout(1200);
  const afterReentry = await page.evaluate(() => ({
    rows: document.querySelector("#agent-pair-list").childElementCount,
    sectionHidden: document.querySelector("#agent-pairs").hidden
  }));
  assert.equal(afterReentry.rows, 0, "the pair list remains empty in the next room");
  assert.equal(afterReentry.sectionHidden, true, "#agent-pairs stays hidden in the next room");
  const status = await page.locator("#status").textContent().catch(() => "");
  assert.ok(!String(status ?? "").includes("Could not load device pairing"), "no pairing load failure notice appears");
  assert.deepEqual(errors, []);
});

test("guard: onAccessEnded resets pairing and human-push; human-push fetch has one gated call site", { timeout: 60000 }, async () => {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const blockStart = source.indexOf("onAccessEnded() {");
  assert.ok(blockStart >= 0, "onAccessEnded block exists");
  const block = source.slice(blockStart, source.indexOf("resetAttention();", blockStart));
  assert.ok(block.includes("pairingFeature.reset()"), "onAccessEnded calls pairingFeature.reset()");
  assert.ok(block.includes("humanPushFeature.reset()"), "onAccessEnded calls humanPushFeature.reset()");
  assert.equal(source.split('"./human-push.js"').length - 1, 1, "exactly one dynamic-import specifier for ./human-push.js");
  const ensureSites = [...source.matchAll(/humanPushFeature\.ensure\(\)/g)].map(match => match.index);
  assert.equal(ensureSites.length, 1, "humanPushFeature.ensure() has exactly one call site");
  const gateStart = source.indexOf("function loadHumanPushIfNeeded()");
  const gateEnd = source.indexOf("async function loadNotifications()", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "loadHumanPushIfNeeded exists");
  assert.ok(ensureSites[0] > gateStart && ensureSites[0] < gateEnd, "the only ensure() call site is inside loadHumanPushIfNeeded()");
});
