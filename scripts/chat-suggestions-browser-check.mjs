// Explicit choices prepare a draft; ordinary prose adds no suggested actions.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

for (const [name, viewport] of [["desktop", { width: 1360, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`chat suggestions ${name}: prepare an explicit reply without sending or adding inferred tasks`, { timeout: 60000 }, async t => {
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
    await page.locator("#message-list").getByText("I can take the README intro. Want it short or detailed?", { exact: true }).waitFor();
    assert.equal(await box.isVisible(), false);
    say("producer", "Pick a format.\nOptions: Short | Detailed");
    await box.getByRole("button", { name: "Short", exact: true }).waitFor();
    const before = f.store.snapshot(f.keys.owner, "commons").state.messages.length;
    await box.getByRole("button", { name: "Short", exact: true }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "Short");
    assert.equal(f.store.snapshot(f.keys.owner, "commons").state.messages.length, before, "choosing is not sending");
    await box.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator("#message-list").getByRole("button", { name: "1 reply ↗", exact: true }).waitFor();
    assert.ok(f.store.snapshot(f.keys.owner, "commons").state.messages.some(m => m.body === "Short" && m.replyToId), "manual send retains the source reply link");
    assert.equal(await box.isVisible(), false, "an answered choice does not immediately reappear");
    say("producer", "Can someone check the staging deploy before Friday?");
    await page.locator("#message-list").getByText("Can someone check the staging deploy before Friday?", { exact: true }).waitFor();
    assert.equal(await box.isVisible(), false);
    assert.deepEqual(errors, []);
  });
}

test("an unanswered question does not grow an inferred agent-selection control", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  f.store.command(f.keys.owner, "commons", { id: "quiet-channel", type: T.CHANNEL_CREATED, data: { channelId: "quiet", name: "quiet" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, reducedMotion: "reduce" }), errors = [];
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
  assert.equal(await box.isVisible(), false, "waiting does not add a suggestion");
  assert.equal(await page.locator("#message-input").inputValue(), "");
  assert.deepEqual(errors, []);
});
