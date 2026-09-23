import { clickChrome } from "./room-chrome.mjs";
// Browser check: the Telegram connection card shows live status (not configured,
// webhook, last delivery, last send) and the Reconnect trigger imports verified
// webhook updates from the browser without a loopback client. Fixture data only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { telegramContractFixture } from "./telegram-contract-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramConfig, TelegramLiveStatus } from "../server/channel-adapters/telegram-config.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

const WEBHOOK_SECRET = "fixture-webhook-secret-0123456789"; // Invented; only its hash is stored.

async function setup(t, { configured = false, storedSecret = WEBHOOK_SECRET } = {}) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner"), accountKey = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, accountKey, 0);
  const telegram = telegramContractFixture(); telegram.connection.accountId = account.id;
  const apply = request => f.store.connections.apply(slot.token, request, session.sessionBinding);
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: telegram.connection.id, expectedRevision: 0, profile: telegram.connection });
  apply({ action: "connection.webhook", requestId: crypto.randomUUID(), connectionId: telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(storedSecret) });
  const webhooks = new ChannelWebhookInbox(f.store), status = new TelegramLiveStatus();
  // Remote visitors, like a hosted deployment: the loopback-only sync is unavailable to the browser.
  const config = configured ? telegramConfig({ TELEGRAM_BOT_TOKEN: "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFa", TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }) : telegramConfig({});
  const server = createRoomServer({ store: f.store, streamInterval: 50, channelWebhooks: webhooks, telegram: config, telegramStatus: status, resolveClientAddress: () => "203.0.113.7" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(9000); const errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin + "/?room=commons");
  await fillAccessKey(page, accountKey); await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  await clickChrome(page, "#nav-inbox"); await page.locator("#inbox-panel").waitFor({ state: "visible" });
  const deliver = updates => fetch(origin + "/api/inbox/webhooks/" + telegram.connection.id, { method: "POST", body: JSON.stringify({ updates }),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET } });
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: "test-results/inbox-telegram-" + name + ".png", fullPage: true }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  return { ...f, page, origin, telegram, webhooks, status, deliver, capture, card: page.locator(`.inbox-connection-card[data-connection-id="${telegram.connection.id}"]`) };
}

test("the Telegram card says not configured, names the bindings, and Reconnect imports webhook updates from a remote browser", { timeout: 35000 }, async t => {
  const f = await setup(t), card = f.card;
  await card.waitFor();
  assert.equal(await card.getAttribute("data-live-state"), "not_configured");
  await card.getByText("Telegram · Fixture Room Bot").waitFor();
  await card.getByText("Live: not configured · set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET").waitFor();
  await card.getByText(/^Webhook: secret stored /).waitFor();
  await card.getByText("Last update received: none yet").waitFor();
  await card.getByText("Last send: none yet").waitFor();
  assert.equal(await f.page.locator("#inbox-empty").isVisible(), true);
  assert.match(await f.page.locator("#inbox-empty").textContent(), /Nothing here yet/);
  const text = await card.textContent();
  for (const secret of [WEBHOOK_SECRET, ChannelWebhookInbox.hash(WEBHOOK_SECRET), "7000000001"]) assert.equal(text.includes(secret), false, secret);
  // Nothing pending yet: the trigger says so instead of failing.
  await card.getByRole("button", { name: /Reconnect/ }).click();
  await card.getByText("No new updates yet").waitFor();
  // Telegram delivers two updates; the card shows the delivery once refreshed by Reconnect, and the messages arrive in the list.
  assert.equal((await f.deliver(f.telegram.updates.slice(0, 2))).status, 202);
  await card.getByRole("button", { name: /Reconnect/ }).click();
  await card.getByText("Imported 2 updates").waitFor();
  await card.getByText(/^Last update received: (?!none yet)/).waitFor();
  await f.page.locator('.inbox-group[data-connection-id="telegram-fixture"] .inbox-row').first().waitFor();
  assert.equal(await f.page.locator('.inbox-group[data-connection-id="telegram-fixture"] .inbox-row').count(), 2);
  assert.equal(f.webhooks.pending(f.telegram.connection.accountId, f.telegram.connection.id).length, 0);
  assert.equal(f.store.inbox.verify().sources, 2);
  await f.capture("card");
});
test("with the bindings set the card reports configured and Reconnect re-registers a differing webhook secret", { timeout: 35000 }, async t => {
  // The stored hash belongs to an older secret, so deliveries signed with the binding would be refused until Reconnect.
  const f = await setup(t, { configured: true, storedSecret: "older-fixture-secret-9876543210" }), card = f.card;
  await card.waitFor();
  assert.equal(await card.getAttribute("data-live-state"), "configured");
  await card.getByText("Live: configured").waitFor();
  await card.getByText("Webhook: stored secret differs from the binding · use Reconnect").waitFor();
  assert.equal((await f.deliver(f.telegram.updates.slice(0, 1))).status, 401, "the binding's secret is not accepted yet");
  await card.getByRole("button", { name: /Reconnect/ }).click();
  await card.getByText("Webhook secret registered").waitFor();
  await card.getByText(/^Webhook: registered /).waitFor();
  assert.equal((await f.deliver(f.telegram.updates.slice(0, 1))).status, 202, "deliveries signed with the binding are accepted now");
  await card.getByRole("button", { name: /Reconnect/ }).click();
  await card.getByText("Imported 1 update").waitFor();
  const text = await card.textContent();
  assert.equal(text.includes("AAFake"), false); assert.equal(text.includes(WEBHOOK_SECRET), false);
  await f.capture("configured");
});
