// Browser coverage for the quarantine review UI (worker C): two held spam
// messages render with scores, sender, subject, and non-empty signal
// reasons; Confirm removes an item from held and shows it in
// released/confirmed history; Dismiss arms on the first click (changing
// nothing) and dismisses on the second. Boots a real server against an
// acceptance-fixture store over loopback; no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";

const flag = (score, key) => ({ score, quarantine: true,
  signals: [{ key, weight: score, detail: `Browser check signal ${key}` }] });

async function setup(t) {
  const f = createAcceptanceFixture();
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;
  const conn = { accountId: account.id, id: "tg-browser-conn", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000004", identity: { kind: "bot", id: "7000000004", handle: "@browser_bot", displayName: "Browser Bot" },
    capabilities: { read: true, send: false, threads: true, edit: false } };
  const importMessage = (n, text) => {
    const envelope = normalizeTelegramUpdate(conn, { update_id: 900000 + n,
      message: { message_id: 200 + n, date: 1788948000 + n, chat: { id: 5000000300, type: "private", first_name: "Spammer" },
        from: { id: 5000000019, is_bot: false, first_name: "Spammer", last_name: "Browser", username: "spammerbrowser" },
        text } });
    const sourceId = telegramSourceId(conn, `5000000300:${200 + n}`);
    f.store.transaction(() => f.store.inbox.importSource(token, { action: "source.import", requestId: randomUUID(),
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, binding));
    return envelope.message.id;
  };
  const firstId = importMessage(1, "You won a prize, claim now");
  const secondId = importMessage(2, "Urgent wire transfer needed");
  f.store.spamQuarantine.quarantine({ messageId: firstId, channel: "telegram", connectionId: conn.id, flag: flag(80, "prize_bait") });
  f.store.spamQuarantine.quarantine({ messageId: secondId, channel: "telegram", connectionId: conn.id, flag: flag(90, "wire_fraud") });

  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [], outside = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { page, origin, key };
}

const card = (page, n) => page.locator(".inbox-quarantine-item").nth(n);

test("quarantine review: held items render, Confirm accepts, Dismiss two-tap dismisses", { timeout: 60000 }, async t => {
  const { page, origin, key } = await setup(t);
  await page.goto(origin + "/?account=1");
  await page.locator("#access-key").fill(key);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#inbox-panel").waitFor();
  await page.locator("#inbox-quarantine").waitFor();

  // Two held messages render with scores, sender, subject, and signal reasons.
  await card(page, 1).waitFor();
  assert.equal(await page.locator(".inbox-quarantine-item").count(), 2);
  assert.equal(await page.locator("#inbox-quarantine-count").textContent(), "2 held");
  const firstCard = await card(page, 0).textContent();
  assert.ok(firstCard.includes("Score 80/100"), "score renders");
  assert.ok(firstCard.includes("Telegram"), "channel renders");
  assert.ok(firstCard.includes("Browser check signal prize_bait"), "signal reason renders");
  assert.ok(firstCard.includes("@spammerbrowser") || firstCard.includes("Spammer"), "sender renders");
  // The fixture journals holds directly (no import receipts), so the shadow
  // enforcement-hold context is honest absence, not a verdict.
  assert.ok(firstCard.includes("No shadow decision recorded"), "shadow absence renders");

  // Confirm removes the item from held and shows it in released history.
  await card(page, 0).getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".inbox-quarantine-item").length === 1);
  assert.equal(await page.locator("#inbox-quarantine-count").textContent(), "1 held");
  await page.locator("#inbox-quarantine-status").selectOption("released");
  await card(page, 0).waitFor();
  assert.equal(await page.locator(".inbox-quarantine-item").count(), 1);
  assert.ok((await card(page, 0).textContent()).includes("Score 80/100"));

  // Back to held: Dismiss arms on the first click (nothing changes), then
  // dismisses on the second click.
  await page.locator("#inbox-quarantine-status").selectOption("held");
  await card(page, 0).waitFor();
  const dismiss = card(page, 0).getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.click();
  await page.waitForFunction(() => {
    const btn = [...document.querySelectorAll(".inbox-quarantine-item button")].find(b => b.textContent.includes("Dismiss"));
    return btn && btn.textContent.includes("Dismiss?");
  });
  assert.equal(await page.locator(".inbox-quarantine-item").count(), 1, "arming changes nothing yet");
  await card(page, 0).getByRole("button", { name: /Dismiss\?/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".inbox-quarantine-item").length === 0);
  assert.equal(await page.locator("#inbox-quarantine-count").textContent(), "0 held");
  await page.locator("#inbox-quarantine-status").selectOption("dismissed");
  await card(page, 0).waitFor();
  assert.equal(await page.locator(".inbox-quarantine-item").count(), 1);
});
