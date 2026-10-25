// STRAT-1: land, answer the one question, stub GitHub sign-in, and open a
// room that already holds the connect card and the first task.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { chromiumAvailable } from "../scripts/perf-budget.mjs";

function signIn(store, accountId) {
  store.createAccount(accountId);
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding, csrf: session.csrf };
}

test("front door opens a room with two seeded cards", { timeout: 60000 }, async t => {
  if (!chromiumAvailable(chromium)) {
    t.skip("Chromium is not installed (npx playwright install chromium)");
    return;
  }
  const fixture = createAcceptanceFixture();
  const secret = "strat-github-secret";
  const server = createRoomServer({
    store: fixture.store,
    githubAuth: { clientId: "strat-github-client", clientSecret: secret }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const session = signIn(fixture.store, "stranger");
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/github/start**", async route => {
    await page.context().addCookies([{
      name: "account_session", value: session.token, url: origin, httpOnly: true, sameSite: "Strict"
    }]);
    await route.fulfill({ status: 302, headers: { location: `${origin}/?oauth=login` } });
  });
  const answer = "Ship the login fix";
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.content().then(html => html.includes(secret)), false);
  await page.locator("#front-door-work").waitFor({ state: "visible" });
  await page.locator("#github-signin").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#front-door-work").fill(answer);
  await page.locator("#github-signin").waitFor({ state: "visible" });
  const started = Date.now();
  await page.locator("#front-door-work").press("Enter");
  await page.locator("#main").waitFor({ state: "visible" });
  const ms = Date.now() - started;
  await page.locator("#message-list").getByText("Connect an agent").waitFor({ state: "visible" });
  await page.locator("#message-list").getByText(answer).first().waitFor({ state: "visible" });
  await page.locator("#message-list").getByText("Acceptance:").waitFor({ state: "visible" });
  assert.ok(ms < 60000, `time to first room ${ms}ms`);
  const room = fixture.store.db.prepare("SELECT id FROM rooms WHERE id LIKE 'room-%'").all();
  assert.equal(room.length, 1);
  const state = fixture.store.room(room[0].id).state;
  assert.equal(state.room.title, answer);
  assert.equal(state.messages.length, 2);
  assert.equal(fixture.store.workClaims.list(room[0].id).length, 1);
});