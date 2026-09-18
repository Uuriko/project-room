import test from "node:test";
import assert from "node:assert/strict";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { RecordedTelegramBot, bind, isTelegramReader } from "../server/channel-adapters/telegram.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";
import { LiveTelegramPoller, telegramReadAdapter, telegramGetUpdatesRequest, telegramPollRetryDelay } from "../server/channel-adapters/telegram-poller.mjs";

// Obviously fake bindings: the shape Telegram uses, never a real token.
const FAKE_TOKEN = "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFakeFa";
const FAKE_SECRET = "poll-test-webhook-secret-0123456789abcdef";
const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_SECRET };
const configured = () => telegramConfig(env);
const { connection, updates } = telegramContractFixture();
const small = { longPollSecs: 1, timeoutSlackMs: 50, baseDelayMs: 0, maxDelayMs: 10 };

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const okUpdates = result => jsonResponse(200, { ok: true, result });
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
// A scripted fetch: each call is answered by the next responder. Responders
// receive (index, options) so tests can hang until the request is aborted.
function scriptedFetch(responders, { sleeps = null } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => { calls.push({ url, options }); return responders[Math.min(calls.length - 1, responders.length - 1)](calls.length - 1, options); };
  fetch.calls = calls;
  if (sleeps) fetch.sleep = ms => { sleeps.push(ms); };
  return fetch;
}
const poller = (fetch, extra = {}) => new LiveTelegramPoller({ config: configured(), connection, fetch,
  sleep: extra.sleep ?? (() => {}), now: () => 1_700_000_000_000, ...small, ...extra });

test("the getUpdates request builder sends the long-poll shape Telegram expects", () => {
  assert.deepEqual(telegramGetUpdatesRequest(), { method: "getUpdates",
    body: { limit: 100, timeout: 30, allowed_updates: ["message", "edited_message", "channel_post"] } });
  assert.equal(telegramGetUpdatesRequest({ offset: 101, limit: 10, timeout: 50 }).body.offset, 101);
  assert.equal("offset" in telegramGetUpdatesRequest().body, false, "no offset key on a first poll");
  for (const bad of [() => telegramGetUpdatesRequest({ timeout: 0 }), () => telegramGetUpdatesRequest({ timeout: 51 }),
    () => telegramGetUpdatesRequest({ limit: 101 }), () => telegramGetUpdatesRequest({ offset: -1 })])
    assert.throws(bad, { name: "EmailContractError" });
  assert.deepEqual(telegramPollRetryDelay({ attempt: 0, baseDelayMs: 1000, maxDelayMs: 15000 }), 1000);
  assert.deepEqual(telegramPollRetryDelay({ attempt: 2, baseDelayMs: 1000, maxDelayMs: 15000 }), 4000);
  assert.deepEqual(telegramPollRetryDelay({ attempt: 0, retryAfter: 3, baseDelayMs: 1000, maxDelayMs: 15000 }), 3000);
});

test("one long-poll posts to the bot's getUpdates method with the injected timeout", async () => {
  const fetch = scriptedFetch([() => okUpdates([])]);
  const p = poller(fetch);
  const response = await p.getUpdates();
  assert.deepEqual(response, { ok: true, result: [] });
  assert.equal(fetch.calls.length, 1);
  const { url, options } = fetch.calls[0];
  assert.equal(url, "https://api.telegram.org/bot" + FAKE_TOKEN + "/getUpdates");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), { limit: 100, timeout: 1, allowed_updates: ["message", "edited_message", "channel_post"] });
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.ok(options.signal instanceof AbortSignal, "the request carries an abort signal");
  assert.equal(p.closed, false);
});

test("the cursor advances past the highest update_id and the next poll re-asks from there", async () => {
  const fetch = scriptedFetch([() => okUpdates([updates[0], updates[1]]), () => okUpdates([updates[2]])]);
  const p = poller(fetch);
  assert.deepEqual((await p.getUpdates()).result.map(u => u.update_id), [900001, 900002]);
  assert.equal("offset" in JSON.parse(fetch.calls[0].options.body), false);
  assert.deepEqual((await p.getUpdates()).result.map(u => u.update_id), [900003]);
  assert.equal(JSON.parse(fetch.calls[1].options.body).offset, 900003);
});

test("an explicit offset re-asks from there and redelivered updates are deduped by update_id", async () => {
  const fetch = scriptedFetch([() => okUpdates([updates[0], updates[1]])]);
  const p = poller(fetch);
  assert.equal((await p.getUpdates({ offset: "900001" })).result.length, 2);
  assert.equal(JSON.parse(fetch.calls[0].options.body).offset, 900001);
  assert.deepEqual((await p.getUpdates({ offset: "900001" })).result, [], "redelivery is dropped");
  assert.equal(fetch.calls.length, 2);
  await assert.rejects(p.getUpdates({ offset: "nope" }), { code: "invalid_telegram_cursor" });
});

test("the bound adapter pages, hydrates and normalizes over the live reader", async () => {
  const fetch = scriptedFetch([() => okUpdates(updates), () => okUpdates([])]);
  const p = poller(fetch);
  const adapter = bind({ reader: p, connection });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["telegram", "telegram-bot", "updates"]);
  assert.equal(typeof adapter.close, "function", "the live reader's lifecycle is exposed");
  const page = await adapter.changes({ cursor: null });
  assert.deepEqual(page.changes.map(c => c.messageId), ["-1001000000001:41", "-1001000000001:42", "-1001000000001:43", "-1001000000001:41", "-1001000000002:7"],
    "callback queries are skipped, the edit supersedes the original");
  assert.equal(page.cursor, "900007");
  const envelope = adapter.normalize(await adapter.hydrate("-1001000000001:41"));
  assert.equal(envelope.message.kind, "edited_message");
  assert.equal(await adapter.hydrate("-1001000000001:999"), null);
  const second = await adapter.changes({ cursor: page.cursor });
  assert.deepEqual(second.changes, []); assert.equal(second.cursor, "900007"); assert.equal(second.complete, true);
  adapter.close(); assert.equal(p.closed, true);
});

test("submit and lookup delegate to the attached sender, and report honestly unavailable without one", async () => {
  const fetch = scriptedFetch([() => okUpdates([])]);
  const receipts = new Map([["op-1", { operationId: "op-1", outcome: "accepted" }]]);
  const sender = { submit: async request => ({ ...request, via: "sender" }), lookup: async ({ operationId }) => receipts.get(operationId) ?? null };
  const withSender = bind({ reader: poller(fetch, { sender }), connection });
  assert.deepEqual(await withSender.submit({ operationId: "op-1" }), { operationId: "op-1", via: "sender" });
  assert.deepEqual(await withSender.lookup({ operationId: "op-1" }), { operationId: "op-1", outcome: "accepted" });
  const bare = bind({ reader: poller(fetch), connection });
  await assert.rejects(() => bare.submit({ operationId: "op-1" }), { code: "channel_send_unavailable" });
  await assert.rejects(() => bare.lookup({ operationId: "op-1" }), { code: "channel_send_unavailable" });
});

test("malformed getUpdates answers are contract errors, auth failures are connection failures", async () => {
  for (const [responder, code] of [
    [() => okUpdates({}), "invalid_telegram_updates"],
    [() => okUpdates([{ update_id: "nope" }]), "invalid_telegram_updates"],
    [() => okUpdates([{ update_id: -1 }]), "invalid_telegram_updates"],
    [() => jsonResponse(200, { ok: false, description: "bad request: chat not found" }), "channel_poller_unavailable"],
  ]) await assert.rejects(poller(scriptedFetch([responder])).getUpdates(), { code }, code);
  const denied = poller(scriptedFetch([() => jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" })]));
  await assert.rejects(() => denied.getUpdates(), { code: "channel_connection_unavailable" });
  // The token never leaks into an error message.
  const leaked = poller(scriptedFetch([() => jsonResponse(200, { ok: false, description: "wrong bot" + FAKE_TOKEN + " here" })]));
  const error = await leaked.getUpdates().catch(e => e);
  assert.equal(error.message.includes(FAKE_TOKEN), false);
  assert.match(error.message, /<redacted>/);
});

test("transient failures retry with backoff and honor retry_after", async () => {
  const sleeps = [];
  const fetch = scriptedFetch([
    () => jsonResponse(500, { ok: false, description: "boom" }),
    () => jsonResponse(429, { ok: false, parameters: { retry_after: 2 } }),
    () => okUpdates([updates[0]]),
  ]);
  const p = poller(fetch, { sleep: ms => sleeps.push(ms), maxAttempts: 3, maxDelayMs: 15000 });
  assert.deepEqual((await p.getUpdates()).result.map(u => u.update_id), [900001]);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [0, 2000], "first retry waits base*2^0, the 429 waits the hinted 2s");
  const exhausted = poller(scriptedFetch([() => jsonResponse(503, { ok: false, description: "down" })]), { sleep: () => {}, maxAttempts: 2 });
  await assert.rejects(() => exhausted.getUpdates(), { code: "channel_poller_unavailable" });
});

test("a hanging long-poll that outlives the request timeout is retried, then reported unavailable", async () => {
  const hang = (index, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(abortError())));
  const sleeps = [];
  const p = poller(scriptedFetch([hang, hang]), { sleep: ms => sleeps.push(ms), maxAttempts: 2 });
  const error = await p.getUpdates().catch(e => e);
  assert.equal(error.code, "channel_poller_unavailable");
  assert.match(error.message, /could not be reached/);
});

test("close() aborts the in-flight long-poll and the poll loop exits gracefully", async () => {
  const hang = (index, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(abortError())));
  const p = poller(scriptedFetch([hang]));
  const pending = p.getUpdates();
  p.close();
  await assert.rejects(pending, { code: "channel_poller_closed" });
  assert.equal(p.closed, true);
  await assert.rejects(() => p.getUpdates(), { code: "channel_poller_closed" });
});

test("poll() yields non-empty batches until closed or the signal aborts", async () => {
  const p = poller(scriptedFetch([() => okUpdates([updates[0]]), () => okUpdates([]), () => okUpdates([updates[1]])]));
  const batches = [];
  for await (const batch of p.poll()) { batches.push(batch.result.map(u => u.update_id)); if (batches.length === 2) p.close(); }
  assert.deepEqual(batches, [[900001], [900002]], "empty long-polls are not yielded");
  const hang = (index, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(abortError())));
  const q = poller(scriptedFetch([hang]));
  const controller = new AbortController();
  const run = (async () => { const seen = []; for await (const batch of q.poll({ signal: controller.signal })) seen.push(batch); return seen; })();
  controller.abort();
  assert.deepEqual(await run, [], "an aborted signal ends the loop without yielding");
});

test("live status records received batches, never empty long-polls", async () => {
  const received = [];
  const status = { received: (accountId, connectionId, row) => received.push({ accountId, connectionId, ...row }) };
  const p = poller(scriptedFetch([() => okUpdates([updates[0], updates[1]]), () => okUpdates([])]),
    { status, accountId: "acct", connectionId: "tg" });
  await p.getUpdates(); await p.getUpdates();
  assert.deepEqual(received, [{ accountId: "acct", connectionId: "tg", at: 1_700_000_000_000, count: 2 }]);
});

test("the reader contract admits the live poller and still rejects non-readers", () => {
  const p = poller(scriptedFetch([() => okUpdates([])]));
  assert.equal(isTelegramReader(p), true);
  assert.equal(isTelegramReader(new RecordedTelegramBot({ connection, updates, limit: 4 })), true);
  assert.equal(isTelegramReader({}), false);
  assert.equal(isTelegramReader(null), false);
  assert.throws(() => bind({ reader: {}, connection }), { code: "telegram_reader_required" });
  assert.equal(typeof bind({ reader: new RecordedTelegramBot({ connection, updates }), connection }).close, "undefined",
    "fixture adapters expose no lifecycle");
});

test("telegramReadAdapter: the fixture stays the default until the bindings exist", async () => {
  const notConfigured = telegramConfig({});
  const fixture = new RecordedTelegramBot({ connection, updates, limit: 100 });
  const fixtureAdapter = telegramReadAdapter({ config: notConfigured, fixture, connection });
  assert.equal(typeof fixtureAdapter.close, "undefined");
  const page = await fixtureAdapter.changes({ cursor: null });
  assert.equal(page.cursor, "900007");
  assert.throws(() => telegramReadAdapter({ config: notConfigured, connection }), TypeError);
  // Invalid bindings are also "not configured": still the fixture.
  const invalid = telegramConfig({ TELEGRAM_BOT_TOKEN: "nope" });
  assert.equal(invalid.configured, false);
  const invalidAdapter = telegramReadAdapter({ config: invalid, fixture, connection });
  assert.equal((await invalidAdapter.changes({ cursor: null })).cursor, "900007");
  // Configured bindings select the live poller behind the same interface.
  const fetch = scriptedFetch([() => okUpdates([updates[0]])]);
  const live = telegramReadAdapter({ config: configured(), connection, fetch, ...small, sleep: () => {} });
  assert.equal(typeof live.close, "function");
  assert.equal((await live.changes({ cursor: null })).cursor, "900002");
  assert.equal(fetch.calls.length, 1, "the live adapter reaches the network");
  live.close();
});

test("constructor validation is strict about config, connection and limits", () => {
  const fetch = scriptedFetch([() => okUpdates([])]);
  assert.throws(() => new LiveTelegramPoller({ config: telegramConfig({}), connection, fetch }), TypeError);
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection, fetch: null }), TypeError);
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection: { ...connection, provider: "microsoft-graph" }, fetch }), { name: "EmailContractError" });
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection, fetch, longPollSecs: 51 }), TypeError);
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection, fetch, longPollSecs: 0 }), TypeError);
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection, fetch, limit: 101 }), TypeError);
  assert.throws(() => new LiveTelegramPoller({ config: configured(), connection, fetch, sender: {} }), TypeError);
  assert.deepEqual(poller(fetch).connection, connection, "the connection getter clones");
});
