import { clickChrome } from "./room-chrome.mjs";
// Browser check for the unified inbox UI (B27): one list across email, Telegram
// and samples with channel badges and filters, a Telegram reply through the
// fixture transport, connection add / reconnect / remove, the needs-you marker
// and sharing a Telegram excerpt into a room. Fixture data only; the server has
// no Telegram bindings, so nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { telegramContractFixture } from "./telegram-contract-fixture.mjs";
import { emailContractFixture } from "./email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramConfig, TelegramLiveStatus } from "../server/channel-adapters/telegram-config.mjs";
import { telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

const WEBHOOK_SECRET = "fixture-webhook-secret-0123456789"; // Invented; only its hash is stored.

async function setup(t, { mobile = false } = {}) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner"), accountKey = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, accountKey, 0);
  const telegram = telegramContractFixture(); telegram.connection.accountId = account.id;
  const email = emailContractFixture(); email.connection.accountId = account.id;
  const apply = request => f.store.connections.apply(slot.token, request, session.sessionBinding);
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: telegram.connection.id, expectedRevision: 0, profile: telegram.connection });
  apply({ action: "connection.webhook", requestId: crypto.randomUUID(), connectionId: telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(WEBHOOK_SECRET) });
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: email.connection.id, expectedRevision: 0, profile: email.connection });
  const envelope = normalizeGraphEmail(email.connection, email.message, email.options);
  const state = f.store.email.state(slot.token, email.connection.id, email.message.parentFolderId, session.sessionBinding);
  apply({ action: "page.apply", requestId: crypto.randomUUID(), connectionId: email.connection.id, connectionRevision: 1, folderId: email.message.parentFolderId,
    expectedRevision: 0, expectedCursor: state.expectedCursor, cursor: crypto.randomUUID(), complete: true, reset: state.needsReset, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] });
  f.store.inbox.apply(slot.token, { action: "source.save", requestId: "note", sourceId: "note", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "A quieter launch", paragraphs: ["Could we make the launch note warmer?"] } }, session.sessionBinding);
  const webhooks = new ChannelWebhookInbox(f.store), status = new TelegramLiveStatus();
  // Remote visitors, no Telegram bindings: replies go through the fixture sender.
  const server = createRoomServer({ store: f.store, streamInterval: 50, channelWebhooks: webhooks, telegram: telegramConfig({}), telegramStatus: status, resolveClientAddress: () => "203.0.113.7" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
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
  const card = id => page.locator(`.inbox-connection-card[data-connection-id="${id}"]`);
  // Opening the inbox lists the connections and opens the first message, two independent
  // round trips; on a phone the opened reader covers the sidebar (display: none). Settle both
  // before touching the sidebar, or a step-back probe passes an instant before the reader
  // appears and the Reconnect click waits on a card that is attached but never visible.
  await page.locator("#inbox-reader").waitFor({ state: "visible" });
  await card(telegram.connection.id).waitFor({ state: "attached" }); await card(email.connection.id).waitFor({ state: "attached" });
  // Two group messages; the second mentions the bot, so it needs the owner.
  const chat = telegram.chat, avery = { id: 5000000001, is_bot: false, first_name: "Avery", last_name: "Quinn" };
  const updates = [telegram.updates[0], { update_id: 900002, message: { message_id: 42, date: 1788948060, chat, from: avery, text: "@fixture_room_bot could you draft the agenda?" } }];
  // On a phone the reader covers the sidebar (list, filters, connections); step back to it.
  const sidebar = async () => { if (mobile && await page.locator("#inbox-back").isVisible()) await page.locator("#inbox-back").click(); };
  const importUpdates = async () => {
    assert.equal((await deliver(updates)).status, 202);
    await sidebar();
    await card(telegram.connection.id).getByRole("button", { name: /^Reconnect/ }).click();
    await card(telegram.connection.id).getByText("Imported 2 updates").waitFor();
    await sidebar();
  };
  const openAdd = async () => { if (!await page.locator("#inbox-add-connection").evaluate(el => el.open)) await page.locator("#inbox-add-connection summary").click(); };
  const pick = async id => {
    if (mobile && await page.locator("#inbox-back").isVisible()) await page.locator("#inbox-back").click();
    await page.locator(`[data-source-id="${id}"]`).click();
    await page.waitForFunction(id => document.querySelector("#inbox-list [aria-current=true]")?.dataset.sourceId === id, id);
    await page.locator("#inbox-reader").waitFor({ state: "visible" });
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: "test-results/inbox-unified-" + name + ".png", fullPage: true }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  return { ...f, page, origin, telegram, email, emailSourceId: envelope.sourceId, tgId: messageId => telegramSourceId(telegram.connection, messageId), webhooks, status, deliver, importUpdates, sidebar, openAdd, pick, card, capture, slot, session };
}

for (const mobile of [false, true]) test(`one list across channels ${mobile ? "mobile" : "desktop"}: badges, channel and connection filters, grouping toggle, needs-you markers`, { timeout: 40000 }, async t => {
  const f = await setup(t, { mobile }), p = f.page;
  await f.importUpdates();
  const rows = p.locator("#inbox-list .inbox-row");
  await p.waitForFunction(() => document.querySelectorAll("#inbox-list .inbox-row").length === 4);
  assert.deepEqual((await rows.locator(".inbox-channel-badge").allTextContents()).sort(), ["Email", "Sample", "Telegram", "Telegram"]);
  // Grouped by default: one section per connection plus the samples, named after the connection.
  assert.equal(await p.locator(".inbox-group").count(), 3);
  await p.locator(".inbox-group-label", { hasText: "Telegram · Fixture Room Bot" }).waitFor();
  await p.locator(".inbox-group-label", { hasText: "Email · Morgan" }).waitFor();
  // Needs you: the email is addressed To the mailbox, the second Telegram message mentions the bot.
  assert.equal(await p.locator('.inbox-row[data-needs-you="true"]').count(), 2);
  assert.equal(await p.locator('.inbox-row[data-needs-you="true"] .inbox-needs-you').first().textContent(), "Needs you");
  assert.equal(await p.locator("#inbox-attention-count").textContent(), "(2 need you)");
  assert.equal(await p.locator(`[data-source-id="${f.tgId("-1001000000001:41")}"]`).getAttribute("data-needs-you"), "false");
  // Filters are labelled controls that narrow the same list.
  const channel = p.locator("#inbox-filter-channel"), connection = p.locator("#inbox-filter-connection");
  assert.equal(await channel.evaluate(el => el.labels[0].firstChild.textContent.trim()), "Channel", "the filter is a labelled control");
  assert.equal(await p.locator('#inbox-filters[role="group"]').getAttribute("aria-label"), "Filter messages");
  await channel.selectOption("telegram"); await p.waitForFunction(() => document.querySelectorAll("#inbox-list .inbox-row").length === 2);
  assert.deepEqual(await rows.evaluateAll(list => list.map(el => el.dataset.channel)), ["telegram", "telegram"]);
  await channel.selectOption("all"); await connection.selectOption(f.email.connection.id);
  await p.waitForFunction(() => document.querySelectorAll("#inbox-list .inbox-row").length === 1);
  assert.equal(await rows.first().getAttribute("data-source-id"), f.emailSourceId);
  await connection.selectOption("sample"); await p.waitForFunction(() => document.querySelectorAll("#inbox-list .inbox-row").length === 1);
  assert.equal(await rows.first().locator(".inbox-channel-badge").textContent(), "Sample");
  await channel.selectOption("email"); await p.getByText("No messages match these filters.").waitFor();
  await channel.selectOption("all"); await connection.selectOption("all");
  // Grouping off: one flat list, most recent first, still with badges.
  await p.getByLabel("Group by connection").uncheck();
  await p.waitForFunction(() => document.querySelectorAll(".inbox-group").length === 0 && document.querySelectorAll("#inbox-list > .inbox-row").length === 4);
  await p.getByLabel("Group by connection").check(); await p.waitForFunction(() => document.querySelectorAll(".inbox-group").length === 3);
  // The reader marks an addressed message and the row keeps aria-current.
  await f.pick(f.tgId("-1001000000001:42"));
  await p.locator("#inbox-addressed", { hasText: "Addressed to you" }).waitFor();
  await f.pick(f.tgId("-1001000000001:41")); assert.equal(await p.locator("#inbox-addressed").isVisible(), false); await f.pick(f.tgId("-1001000000001:42"));
  await f.sidebar(); assert.equal(await p.locator("#inbox-list [aria-current=true]").getAttribute("data-source-id"), f.tgId("-1001000000001:42"));
  assert.equal(await p.locator("#inbox-source-label").textContent(), "Sample Telegram message · only you");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture("list-" + (mobile ? "mobile" : "desktop"));
});

test("a Telegram reply goes through the fixture transport with sample labels; email offers no send", { timeout: 40000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.importUpdates();
  await f.pick(f.tgId("-1001000000001:41"));
  await p.locator("#inbox-email-details summary").click();
  await p.locator("#inbox-email-metadata", { hasText: "Replies go through the bot" }).waitFor();
  await p.locator("#inbox-draft").fill("Thanks Avery, reading it now."); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#inbox-send-preview").waitFor({ state: "visible" });
  assert.equal(await p.locator("#inbox-send-panel").getAttribute("data-send-mode"), "fixture");
  assert.equal(await p.locator("#inbox-send-panel").getAttribute("aria-label"), "Sample Telegram reply");
  await p.locator("#inbox-send-preview").click();
  await p.waitForFunction(() => !document.getElementById("inbox-send-confirm").disabled);
  assert.equal(await p.locator("#inbox-send-title").textContent(), "Sample Telegram reply");
  assert.equal(await p.locator("#inbox-send-addresses").textContent(), "Fixture Room Bot → Fixture planning");
  assert.equal(await p.locator("#inbox-send-body").textContent(), "Thanks Avery, reading it now.");
  assert.equal(await p.locator("#inbox-send-dialog-status").textContent(), "Sample only · Telegram is not configured here, nothing is sent");
  assert.equal(await p.locator("#inbox-send-confirm").textContent(), "Send sample");
  const text = await p.locator("#inbox-send-dialog").textContent();
  for (const secret of ["7000000001", "-1001000000001", WEBHOOK_SECRET]) assert.equal(text.includes(secret), false, secret);
  await f.capture("telegram-reply-preview");
  await p.locator("#inbox-send-confirm").click();
  await p.getByText("Sample accepted · nothing left this server", { exact: true }).waitFor();
  const sends = f.store.inbox.sends(f.slot.token, f.tgId("-1001000000001:41"), f.session.sessionBinding).sends;
  assert.equal(sends.length, 1); assert.equal(sends[0].status, "accepted"); assert.match(sends[0].providerId, /^fixture:/);
  assert.deepEqual(f.status.snapshot(f.telegram.connection.accountId, f.telegram.connection.id).lastSendResult.outcome, "accepted");
  await f.card(f.telegram.connection.id).getByText(/^Last send: accepted · fixture · /).waitFor();
  assert.equal(await p.locator("#inbox-send-preview").isVisible(), false);
  // Reload: the journal is the memory.
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await clickChrome(p, "#nav-inbox"); await f.pick(f.tgId("-1001000000001:41"));
  await p.getByText("Sample accepted · nothing left this server", { exact: true }).waitFor();
  await f.capture("telegram-reply-accepted");
  // Email: sending stays unavailable until an outbound email slice exists.
  await f.pick(f.emailSourceId);
  assert.equal(await p.locator("#inbox-send-panel").isVisible(), false);
  await p.locator("#inbox-email-details summary").click();
  await p.locator("#inbox-email-metadata", { hasText: "Sending unavailable" }).waitFor();
  assert.equal(await p.locator("#inbox-source-label").textContent(), "Email copy · only you");
});

test("connection management: add a Telegram bot and a fixture mailbox, reconnect, then remove with a deliberate confirmation", { timeout: 40000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.card(f.telegram.connection.id).waitFor(); await f.card(f.email.connection.id).waitFor();
  await f.card(f.email.connection.id).getByText("Inbound: fixture mailbox · not yet routed").waitFor();
  await f.card(f.email.connection.id).getByText("Sending: not available").waitFor();
  assert.equal(await f.card(f.email.connection.id).getByRole("button", { name: /^Reconnect/ }).count(), 0, "email has no live path to reconnect");
  // Add a bot: client-side validation first, then the record appears with guidance.
  await f.openAdd();
  assert.equal(await p.locator("#inbox-connection-id").inputValue(), "telegram-bot");
  await p.locator("#inbox-connection-bot-id").fill("not-digits"); await p.locator("#inbox-connection-username").fill("room_helper_bot");
  await p.locator("#inbox-connection-form button[type=submit]").click();
  await p.locator("#inbox-connection-form-status", { hasText: "Bot id: the digits before the colon" }).waitFor();
  await p.locator("#inbox-connection-bot-id").fill("8000000002"); await p.locator("#inbox-connection-name").fill("Room Helper");
  await p.locator("#inbox-connection-form button[type=submit]").click();
  await p.locator("#inbox-connection-form-status", { hasText: "Added Room Helper." }).waitFor();
  const added = f.card("telegram-bot"); await added.waitFor();
  await added.getByText("Telegram · Room Helper").waitFor();
  await added.getByText("Added · set the Telegram bindings, then Reconnect").waitFor();
  await added.getByText("Live: not configured · set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET").waitFor();
  await added.getByText("Webhook: not registered").waitFor();
  const stored = f.store.connections.connection(f.telegram.connection.accountId, "telegram-bot");
  assert.equal(stored.profile.externalId, "8000000002"); assert.equal(stored.profile.identity.handle, "@room_helper_bot"); assert.equal(stored.state, "active");
  assert.equal((await added.textContent()).includes("8000000002"), false, "the card never shows the bot id");
  // Reconnect on the new bot: nothing to drain yet, and no bindings to register.
  await added.getByRole("button", { name: /^Reconnect/ }).click(); await added.getByText("No new updates yet").waitFor();
  // Add a fixture mailbox.
  await f.openAdd();
  await p.locator("#inbox-connection-channel").selectOption("email");
  assert.equal(await p.locator("#inbox-connection-id").inputValue(), "mailbox");
  assert.equal(await p.locator("#inbox-connection-bot-id").isVisible(), false);
  await p.locator("#inbox-connection-address").fill("John@Example.test"); await p.locator("#inbox-connection-name").fill("John");
  await p.locator("#inbox-connection-form button[type=submit]").click();
  await p.locator("#inbox-connection-form-status", { hasText: "Added John." }).waitFor();
  await f.card("mailbox").getByText("Email · John").waitFor(); await f.card("mailbox").getByText("Inbound: fixture mailbox · not yet routed").waitFor();
  assert.equal(f.store.connections.connection(f.telegram.connection.accountId, "mailbox").profile.identity.address, "john@example.test");
  // The same mailbox cannot be added twice under another id.
  await f.openAdd(); await p.locator("#inbox-connection-channel").selectOption("email");
  await p.locator("#inbox-connection-id").fill("mailbox-2"); await p.locator("#inbox-connection-address").fill("john@example.test");
  await p.locator("#inbox-connection-form button[type=submit]").click();
  await p.locator("#inbox-connection-form-status", { hasText: "already has a connection for that mailbox or bot" }).waitFor();
  await f.capture("connections");
  // Remove: two clicks, Keep backs out, Confirm disconnects; saved copies stay.
  await added.getByRole("button", { name: "Remove Telegram · Room Helper" }).click();
  await added.getByRole("button", { name: "Confirm remove Telegram · Room Helper" }).waitFor();
  await added.getByRole("button", { name: "Keep" }).click();
  await added.getByRole("button", { name: "Remove Telegram · Room Helper" }).waitFor();
  assert.equal(f.store.connections.connection(f.telegram.connection.accountId, "telegram-bot").state, "active");
  await added.getByRole("button", { name: "Remove Telegram · Room Helper" }).click();
  await added.getByRole("button", { name: "Confirm remove Telegram · Room Helper" }).click();
  await added.getByText("Removed · saved copies stay in the inbox").waitFor();
  await p.waitForFunction(() => document.querySelector('.inbox-connection-card[data-connection-id="telegram-bot"]')?.dataset.connectionState === "disconnected");
  assert.equal(await added.getByRole("button", { name: /Remove/ }).count(), 0);
  assert.equal(f.store.connections.connection(f.telegram.connection.accountId, "telegram-bot").state, "disconnected");
  assert.equal(f.store.connections.connections(f.slot.token, f.session.sessionBinding).connections.length, 4, "nothing is deleted");
  // Focus stays on the card's controls through the confirmation.
  const original = f.card(f.telegram.connection.id);
  await original.getByRole("button", { name: /^Remove/ }).click();
  assert.equal(await p.evaluate(() => document.activeElement?.dataset.remove), f.telegram.connection.id);
  await original.getByRole("button", { name: "Keep" }).click();
});

test("share a Telegram excerpt into the room exactly like an email excerpt", { timeout: 40000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.importUpdates();
  await f.pick(f.tgId("-1001000000001:41"));
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-excerpt-text").waitFor();
  assert.equal(await p.locator("#inbox-share-confirm").isEnabled(), false);
  assert.equal(await p.locator("#inbox-excerpt-text").inputValue(), "Shall we work on this together?\n\nPrivate budget: 4200.");
  const excerpt = "Shall we work on this together?";
  const field = p.locator("#inbox-excerpt-text"); await field.focus();
  await field.press("ControlOrMeta+A"); await field.press("ArrowLeft");
  await p.keyboard.down("Shift"); for (const _ of excerpt) await p.keyboard.press("ArrowRight"); await p.keyboard.up("Shift");
  await p.locator("#inbox-share-confirm:not([disabled])").waitFor();
  assert.equal(await p.locator("#inbox-excerpt-preview").textContent(), "Shared message excerpt\n\n" + excerpt);
  await f.capture("telegram-share");
  await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  await p.locator("#main").waitFor({ state: "visible" });
  const record = f.store.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='source.excerpt'").get();
  const receipt = JSON.parse(record.receipt_json), posted = f.store.room("commons").state.messages.find(m => m.id === receipt.messageId);
  assert.equal(posted.body, "Shared message excerpt\n\n" + excerpt);
  assert.equal(JSON.stringify(posted).includes("4200"), false, "the private budget line stays private");
  assert.equal(JSON.stringify(f.store.room("commons").state).includes("-1001000000001"), false, "chat ids never reach the room");
});
