// Chat suggestions above the composer: an agent's "short or detailed?" offers
// one-tap replies, and a tap sends that reply as an ordinary message; a
// request that reads like work offers "Make this a task", which opens the
// work form from that message. Real browser + local HTTP service.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { ensureSidebarOpen } from "./room-chrome.mjs";

for (const [name, viewport] of [["desktop", { width: 1360, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`chat suggestions ${name}: tap a reply, or turn a request into a task`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const say = (key, body) => f.store.command(f.keys[key], "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: crypto.randomUUID(), body } });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
    page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });

    const box = page.locator("#chat-suggestions");
    say("producer", "I can take the README intro. Want it short or detailed?");
    await box.getByRole("button", { name: "Short", exact: true }).waitFor();
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${name}.png` });
    assert.equal(await box.getByRole("button", { name: "Detailed", exact: true }).isVisible(), true);
    await box.getByRole("button", { name: "Short", exact: true }).click();
    await page.locator("#message-list").getByText("Short", { exact: true }).waitFor();
    await box.waitFor({ state: "hidden" });
    assert.ok(JSON.stringify(f.store.snapshot(f.keys.owner, "commons").state).includes('"body":"Short"'), "the tap posted an ordinary message");

    say("producer", "Can someone check the staging deploy before Friday?");
    const task = box.getByRole("button", { name: "Make this a task", exact: true });
    await task.waitFor();
    await task.click();
    await page.locator("#new-work-form").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    say("producer", "Should we ship today?");
    await box.getByRole("button", { name: "Yes", exact: true }).waitFor();
    await box.getByRole("button", { name: "Hide suggestions" }).click();
    await box.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  });
}

for (const colorScheme of ["dark", "light"]) for (const width of [390, 1360]) test(`an unanswered question suggests an observed agent: ${colorScheme} ${width}`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  f.store.command(f.keys.owner, "commons", { id: "quiet-channel", type: T.CHANNEL_CREATED, data: { channelId: "quiet", name: "quiet" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" }), errors = [];
  await page.addInitScript(theme => localStorage.setItem("project-room-theme", theme), colorScheme);
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });

  const box = page.locator("#chat-suggestions");
  f.store.command(f.keys.guest, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "unanswered", body: "Where does the deploy log live?" } });
  await page.locator("#message-list").getByText("Where does the deploy log live?").waitFor();
  assert.equal(await box.locator("[data-suggest-agent]").count(), 0, "no chip before the wait");
  await page.clock.fastForward("02:05");
  const ask = box.locator("[data-suggest-agent]");
  assert.equal(await ask.count(), 0, "an invited agent with no live observation is not recommended");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stream = await fetch(`${origin}/api/rooms/commons/stream`, { headers: { Authorization: `Bearer ${f.keys.producer}` } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  const refresh = async () => {
    const response = page.waitForResponse(r => r.url().endsWith("/presence"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await response;
  };
  await refresh();
  await ask.waitFor();
  assert.match(await ask.textContent(), /^Ask @/);
  const presenceRoute = /\/api\/rooms\/commons\/presence(?:\?|$)/;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(presenceRoute, async route => { await gate; await route.continue(); });
  await page.clock.fastForward("01:01");
  await ask.waitFor({ state: "detached" });
  release(); await page.unrouteAll({ behavior: "wait" });
  await refresh(); await ask.waitFor();
  await page.locator("#message-input").fill("Keep my follow-up");
  await page.route(presenceRoute, route => route.abort());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await ask.waitFor({ state: "detached" });
  assert.equal(await page.locator("#message-input").inputValue(), "Keep my follow-up");
  assert.equal(await page.locator("#message-list").getByText("Where does the deploy log live?").count(), 1, "a failed availability read preserves the question");
  await page.unroute(presenceRoute);
  await refresh(); await ask.waitFor();
  await page.locator("#message-input").fill("");
  await ensureSidebarOpen(page);
  await page.locator('#channel-list [data-channel="quiet"]').click();
  assert.equal(await box.locator("[data-suggest-agent]").count(), 0, "a different channel must not retain the previous question's agent suggestion");
  await ensureSidebarOpen(page);
  await page.locator('#channel-list [data-channel="general"]').click();
  await ask.waitFor();
  const before = f.store.snapshot(f.keys.owner, "commons").state.messages.length;
  await ask.focus(); await page.keyboard.press("Enter");
  assert.match(await page.locator("#message-input").inputValue(), /^@\S.* $/);
  await box.locator("[data-suggest-agent]").waitFor({ state: "detached" });
  assert.equal(f.store.snapshot(f.keys.owner, "commons").state.messages.length, before, "the tap sends nothing");
  assert.deepEqual(errors, []);
});
