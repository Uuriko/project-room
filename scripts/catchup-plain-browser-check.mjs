// Catch up says one number and speaks plainly.
// 1. The top-bar badge counts from the same marker as the Catch up panel
//    (server catchUpCursor), so "N updates" equals "N changes since your
//    marker", before and after someone else posts. (DESIGN.md: one number,
//    one source.)
// 2. Update lines show display names and plain verbs: no event numbers, no
//    raw member ids, no internal type names. (DESIGN.md: no raw ids or
//    internal state names on human surfaces.)
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { openCatchUp, closeCatchUp } from "./room-chrome.mjs";

const badgeCount = async page => Number((/(\d+) update/.exec(await page.locator("#catchup-count").textContent()) ?? [0, 0])[1]);
const panelCount = async page => Number((/(\d+) changes? since your marker/.exec(await page.locator("#summary-grid").textContent()) ?? [0, 0])[1]);

test("Catch up: badge equals the panel, and update lines are plain", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));

  await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  const check = async label => {
    await openCatchUp(page);
    await page.waitForFunction(() => /since your marker/.test(document.querySelector("#summary-grid")?.textContent ?? ""));
    const panel = await panelCount(page);
    await closeCatchUp(page);
    assert.equal(await badgeCount(page), panel, `${label}: the badge number is the panel's number`);
    return panel;
  };
  await check("on entry");

  send("guest", T.MESSAGE_POSTED, { messageId: "plain-1", body: "Can we plan the trip here?" });
  await page.waitForFunction(() => document.querySelector("#message-list")?.textContent.includes("plan the trip"));
  const after = await check("after a guest posts");
  assert.ok(after >= 1, "the guest's message counts as an update");

  await openCatchUp(page);
  await page.evaluate(() => document.querySelectorAll("#catchup-dialog details").forEach(d => { d.open = true; }));
  const lines = await page.locator("#rb-history-list .rb-event").allTextContents();
  assert.ok(lines.length >= 1, "history lists the update");
  for (const line of lines) {
    assert.doesNotMatch(line, /#\d+/, `no event numbers: ${line}`);
    assert.doesNotMatch(line, /\((ai_|guest-|pri_|owner\b)[^)]*\)/, `no raw member ids: ${line}`);
    assert.doesNotMatch(line, /\b(message posted|member joined via invitation|referral completed)\b/, `no internal type names: ${line}`);
  }
  assert.ok(lines.some(line => /posted/.test(line) && /plan the trip/.test(line)), `the guest's message reads plainly: ${lines.join(" | ")}`);
  assert.deepEqual(errors, []);
});
