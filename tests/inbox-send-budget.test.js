// Task #41 — HTTP integration tests for per-connection send budgets on
// POST /api/inbox/channel-sends. Telegram provider endpoints are mocked; no
// network calls, no real credentials. Covers: a small budget admits one send
// then answers an honest 429 with a Retry-After header (nothing journaled for
// the refused send, no provider call), Gmail sends are NOT budget-limited
// (live Gmail budgets are [JOHN]-gated on task 17), and the connection card
// surfaces remaining budget + refill time.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";

const FAKE_BOT_TOKEN = "123456789:AAH-Fake-Token-For-Tests-Only-000";
const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-0123456789";

function fixture(t) {
  const f = createAcceptanceFixture();
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const loggedIn = f.store.loginAccountSession(slot.token, key, 0);
  f.accountId = account.id;
  f.token = slot.token; f.csrf = loggedIn.csrf; f.sessionBinding = loggedIn.sessionBinding;
  t.after(() => f.store.close());
  return f;
}
async function serve(t, f, { budgetEnv } = {}) {
  const telegramCalls = [];
  const fetchImpl = async (url, init) => {
    telegramCalls.push({ url, init });
    return Response.json({ ok: true, result: { message_id: 4242 } });
  };
  const server = createRoomServer({ store: f.store,
    telegram: telegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET }),
    directSendFetch: fetchImpl,
    sendBudgetEnv: budgetEnv ?? { TELEGRAM_SEND_BUDGET_PER_MIN: "1", TELEGRAM_SEND_BUDGET_BURST: "1" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = () => ({ Origin: origin, "Content-Type": "application/json",
    Cookie: "account_session=" + f.token, "X-CSRF-Token": f.csrf, "X-Session-Binding": f.sessionBinding });
  const post = data => fetch(origin + "/api/inbox/channel-sends", { method: "POST", headers: headers(), body: JSON.stringify(data) });
  const get = path => fetch(origin + path, { headers: headers() });
  return { origin, post, get, telegramCalls };
}
const directSend = (channel, to) => ({ channel, to, subject: "Hi", body: "hello" });
const journalRows = f => f.store.db.prepare("SELECT * FROM direct_channel_sends WHERE account_id=?").all(f.accountId);

test("a small telegram budget admits one send, then an honest 429 with Retry-After", async t => {
  const f = fixture(t), { post, telegramCalls } = await serve(t, f);
  const first = await post(directSend("telegram", "123"));
  assert.equal(first.status, 200, "first send is admitted");
  assert.equal(telegramCalls.length, 1, "the provider was called once");
  const second = await post(directSend("telegram", "123"));
  assert.equal(second.status, 429, "budget exhaustion is an honest 429");
  assert.equal((await second.json()).error.code, "send_budget_exhausted");
  const retryAfter = second.headers.get("retry-after");
  assert.ok(retryAfter !== null, "Retry-After header is present");
  assert.ok(Number(retryAfter) >= 1, "Retry-After is a positive number of seconds");
  assert.equal(telegramCalls.length, 1, "the refused send never reaches the provider");
  assert.equal(journalRows(f).length, 1, "the refused send is not journaled");
});

test("gmail sends are not budget-limited: the budget waits on the task-17 approval", async t => {
  const f = fixture(t), { post } = await serve(t, f);
  // Gmail is not connected in this fixture, so it fails honestly — but with
  // gmail_not_connected, never the budget's 429.
  for (let i = 0; i < 3; i++) {
    const res = await post(directSend("gmail", "a@example.com"));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "gmail_not_connected");
  }
});

test("the connection card surfaces remaining budget and refill time", async t => {
  const f = fixture(t);
  const tg = telegramContractFixture();
  tg.connection.accountId = f.accountId;
  f.store.connections.apply(f.token, { action: "connection.configure", requestId: randomUUID(),
    connectionId: tg.connection.id, expectedRevision: 0, profile: structuredClone(tg.connection) }, f.sessionBinding);
  const { get, post } = await serve(t, f, { budgetEnv: {} });
  const card = await get("/api/inbox/connections/" + tg.connection.id);
  assert.equal(card.status, 200);
  const live = (await card.json()).live;
  assert.ok(live, "the card carries the live view");
  assert.deepEqual(live.sendBudget, { remaining: 30, resetsAt: null }, "a fresh default budget is full");
  const send = await post(directSend("telegram", "123"));
  assert.equal(send.status, 200);
  const after = await get("/api/inbox/connections/" + tg.connection.id);
  const budget = (await after.json()).live.sendBudget;
  assert.equal(budget.remaining, 30, "direct sends spend the per-account direct bucket, not the connection bucket");
  assert.equal(budget.resetsAt, null);
});
