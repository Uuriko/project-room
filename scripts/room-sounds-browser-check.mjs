// Room sounds, the arrival pulse and the empty-room art, in a real browser.
// A fake AudioContext records scheduled cues (headless Chromium has no audio
// output to observe); everything else is the real server and client.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";

const launch = () => chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });

// Counts scheduled oscillators; a cue schedules one per partial of each tone.
const FAKE_AUDIO = () => {
  window.__oscillators = 0;
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = extra => Object.assign({ connect: next => next ?? node() }, extra);
  window.AudioContext = class {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = node(); }
    resume() { return Promise.resolve(); }
    createGain() { return node({ gain: param() }); }
    createOscillator() { window.__oscillators++; return node({ type: "", frequency: param(), start() {}, stop() {} }); }
  };
};

async function serve(t, store) {
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function page(t, origin, { motion = "no-preference", theme } = {}) {
  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: motion });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(FAKE_AUDIO);
  if (theme) await context.addInitScript(value => { try { localStorage.setItem("project-room-theme", value); } catch { /* ignore */ } }, theme);
  const p = await context.newPage(); p.setDefaultTimeout(12000);
  const errors = []; p.on("pageerror", e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  return p;
}

const shot = async (p, name) => { mkdirSync("test-results", { recursive: true }); await p.screenshot({ path: `test-results/room-sounds-${name}.png` }); };

test("empty new room shows the art with its text and actions, in both themes", { timeout: 60000 }, async t => {
  for (const theme of ["dark", "light"]) {
    const directory = mkdtempSync(join(tmpdir(), "room-art-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const origin = await serve(t, store);
    const p = await page(t, origin, { theme });
    await p.goto(origin); await signInFixture(p, store.issueAccessKey("commons", "owner")); await p.locator("#main").waitFor({ state: "visible" });
    const empty = p.locator("#message-list .empty-note.empty-room");
    await empty.waitFor();
    const art = empty.locator("svg.room-art");
    assert.equal(await art.getAttribute("aria-hidden"), "true", "decorative");
    assert.match(await empty.innerText(), /No messages yet\./);
    await empty.getByRole("button", { name: "Write the first one", exact: true }).waitFor();
    const box = await art.boundingBox();
    assert.ok(box && box.width > 80 && box.width <= 161, `art is visible and small (${box?.width})`);
    // The caret's blink runs a fixed number of times, never forever.
    assert.equal(await empty.locator(".room-art-caret").evaluate(n => getComputedStyle(n).animationIterationCount), "3");
    await shot(p, `empty-room-${theme}`);
  }
});

test("a new mention plays the for-you cue once and pulses the badge; first load is silent", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  send("guest", T.MESSAGE_POSTED, { messageId: "before", body: "@Room owner this was waiting when you arrived." });
  const origin = await serve(t, f.store);
  const p = await page(t, origin);
  await p.goto(origin); await signInFixture(p, f.keys.owner); await p.locator("#main").waitFor({ state: "visible" });
  const badge = p.locator("#topbar-catchup");
  await p.waitForFunction(() => /for you/.test(document.querySelector("#notification-count")?.textContent ?? ""));
  await p.mouse.click(5, 5); // the gesture browsers require before audio
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => window.__oscillators), 0, "the feed's first load makes no sound");
  assert.equal(await badge.evaluate(n => n.classList.contains("arrived")), false);

  send("guest", T.MESSAGE_POSTED, { messageId: "later", body: "@Room owner one more thing." });
  await p.waitForFunction(() => document.querySelector("#topbar-catchup")?.classList.contains("arrived"), null, { timeout: 15000 });
  assert.ok(await p.evaluate(() => window.__oscillators) > 0, "the for-you cue was scheduled");
  assert.equal(await badge.evaluate(n => getComputedStyle(n).animationIterationCount), "1", "the pulse runs once");
  assert.ok(await badge.isVisible(), "the pulse is on a control that is in view");
  await shot(p, "arrived");
});

test("the Sounds switch in settings turns cues off and remembers it", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.createAccount("sounds-browser", "sounds-browser-fixture");
  f.store.completeOnboarding("sounds-browser");
  f.store.accountLogins.linkPasswordMethod("sounds-browser", { email: "sounds@example.invalid", verifier: "fixture-verifier" });
  const origin = await serve(t, f.store);
  const p = await page(t, origin);
  await p.goto(origin + "/?account=1"); await signInFixture(p, f.store.issueAccountAccessKey("sounds-browser"));
  await p.locator("#inbox-panel").waitFor();
  await clickChrome(p, "#account-settings-button");
  const box = p.locator("#account-settings-body").getByRole("checkbox", { name: "Play a sound when something needs you" });
  await box.waitFor();
  assert.equal(await box.isChecked(), true, "on by default");
  await shot(p, "settings");
  await box.uncheck();
  assert.equal(await p.evaluate(() => localStorage.getItem("project-room-sounds")), "off");
  // Settings markup is rebuilt from storage each time it opens.
  await p.keyboard.press("Escape");
  await clickChrome(p, "#account-settings-button");
  assert.equal(await p.locator("#account-settings-body").getByRole("checkbox", { name: "Play a sound when something needs you" }).isChecked(), false);
  // And it reads storage, not a stale element: flip storage, reopen, follow it.
  await p.evaluate(() => localStorage.setItem("project-room-sounds", "on"));
  await p.keyboard.press("Escape");
  await clickChrome(p, "#account-settings-button");
  assert.equal(await p.locator("#account-settings-body").getByRole("checkbox", { name: "Play a sound when something needs you" }).isChecked(), true);
});
