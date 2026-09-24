// Task #41 — per-connection send budgets via token bucket. Unit tests for the
// budget registry (server/channel-send-budgets.mjs) and the token-bucket peek:
// config precedence, burst/exhaustion with an honest 429 + Retry-After, refill,
// per-connection isolation, parallel-send atomicity, non-consuming diagnostics,
// and the Gmail no-op (live Gmail budgets are [JOHN]-gated on task 17).
import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, RateLimitError } from "../server/token-bucket.mjs";
import { ServiceError } from "../server/store.mjs";
import { createSendBudgetRegistry, resolveSendBudget, parseConnectionBudgets,
  DEFAULT_SEND_BUDGET_PER_MIN, DEFAULT_SEND_BUDGET_BURST, GMAIL_BUDGET_PENDING_APPROVAL } from "../server/channel-send-budgets.mjs";
import { telegramLiveView } from "../server/channel-adapters/telegram-config.mjs";

// Controllable clock for the registry's `now`.
const fakeClock = (start = 1_000_000) => { const box = { now: start }; return { box, now: () => box.now, advance: ms => { box.now += ms; } }; };
const scope = (over = {}) => ({ channel: "telegram", accountId: "acct-1", connectionId: "conn-1", ...over });
const throwsServiceError = (fn, status, code) =>
  assert.throws(fn, error => error instanceof ServiceError && error.status === status && error.code === code);

test("resolveSendBudget defaults to 30 sends/min per Telegram bot", () => {
  assert.equal(DEFAULT_SEND_BUDGET_PER_MIN, 30);
  assert.equal(DEFAULT_SEND_BUDGET_BURST, 30);
  const base = resolveSendBudget({ channel: "telegram", env: {} });
  assert.equal(base.rate, 30 / 60);
  assert.equal(base.burst, 30);
});

test("resolveSendBudget honors channel env knobs with a generic fallback", () => {
  assert.equal(resolveSendBudget({ channel: "telegram", env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60" } }).rate, 1);
  assert.equal(resolveSendBudget({ channel: "telegram", env: { CHANNEL_SEND_BUDGET_PER_MIN: "120", TELEGRAM_SEND_BUDGET_BURST: "5" } }).burst, 5);
  assert.equal(resolveSendBudget({ channel: "telegram", env: { CHANNEL_SEND_BUDGET_PER_MIN: "120" } }).rate, 2);
  assert.equal(resolveSendBudget({ channel: "telegram", env: { TELEGRAM_SEND_BUDGET_PER_MIN: "nope" } }).rate, 30 / 60, "garbage degrades to the default");
});

test("resolveSendBudget returns null for gmail: budgets wait on the task-17 approval", () => {
  assert.equal(GMAIL_BUDGET_PENDING_APPROVAL, true);
  assert.equal(resolveSendBudget({ channel: "gmail", env: {} }), null);
});

test("parseConnectionBudgets reads per-connection overrides and ignores garbage", () => {
  assert.deepEqual(parseConnectionBudgets('{"telegram:conn-9": {"perMin": 10, "burst": 5}}'), { "telegram:conn-9": { perMin: 10, burst: 5 } });
  assert.deepEqual(parseConnectionBudgets('{"telegram:conn-9": {"perMin": 10}}'), { "telegram:conn-9": { perMin: 10 } });
  assert.deepEqual(parseConnectionBudgets("not json"), {});
  assert.deepEqual(parseConnectionBudgets('{"telegram:x": {"perMin": "fast"}}'), {});
  assert.deepEqual(parseConnectionBudgets('{"telegram:x": 42}'), {});
  assert.deepEqual(parseConnectionBudgets(""), {});
});

test("burst is allowed, then exhaustion throws an honest 429 with Retry-After", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "2" }, now: clock.now });
  assert.deepEqual(budgets.check(scope()), { remaining: 1 });
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
  assert.throws(() => budgets.check(scope()), error => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "send_budget_exhausted");
    assert.ok(error.headers && typeof error.headers["Retry-After"] === "string", "Retry-After header is set");
    assert.ok(Number(error.headers["Retry-After"]) >= 1, "Retry-After is a positive number of seconds");
    return true;
  });
});

test("the bucket refills over time", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "1" }, now: clock.now });
  budgets.check(scope());
  throwsServiceError(() => budgets.check(scope()), 429, "send_budget_exhausted");
  clock.advance(60_000); // one token per minute at 60/min... 1 token per 60s
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
});

test("budgets are isolated per connection and per account", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "1" }, now: clock.now });
  budgets.check(scope({ connectionId: "conn-a" }));
  throwsServiceError(() => budgets.check(scope({ connectionId: "conn-a" })), 429, "send_budget_exhausted");
  assert.deepEqual(budgets.check(scope({ connectionId: "conn-b" })), { remaining: 0 }, "another connection is unaffected");
  assert.deepEqual(budgets.check(scope({ connectionId: "conn-a", accountId: "acct-2" })), { remaining: 0 }, "another account is unaffected");
  assert.deepEqual(budgets.check(scope({ connectionId: null })), { remaining: 0 }, "direct sends get their own per-account bucket");
});

test("parallel sends cannot exceed the budget", async () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "30" }, now: clock.now });
  const attempts = Array.from({ length: 60 }, () =>
    Promise.resolve().then(() => { try { budgets.check(scope()); return "sent"; } catch { return "limited"; } }));
  const results = await Promise.all(attempts);
  assert.equal(results.filter(r => r === "sent").length, 30, "exactly the burst is admitted");
  assert.equal(results.filter(r => r === "limited").length, 30);
});

test("per-connection overrides beat the channel default", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({
    env: { TELEGRAM_SEND_BUDGET_PER_MIN: "6000", TELEGRAM_SEND_BUDGET_BURST: "100",
      CHANNEL_SEND_BUDGETS: JSON.stringify({ "telegram:slow-conn": { perMin: 60, burst: 1 } }) }, now: clock.now });
  assert.deepEqual(budgets.check(scope({ connectionId: "slow-conn" })), { remaining: 0 });
  throwsServiceError(() => budgets.check(scope({ connectionId: "slow-conn" })), 429, "send_budget_exhausted");
  assert.deepEqual(budgets.check(scope({ connectionId: "fast-conn" })), { remaining: 99 }, "other connections keep the channel default");
});

test("view reports budget state without consuming tokens", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "30", TELEGRAM_SEND_BUDGET_BURST: "30" }, now: clock.now });
  const full = budgets.view(scope());
  assert.equal(full.remaining, 30);
  assert.equal(full.resetsAtMs, null, "a full bucket has no reset time");
  budgets.view(scope());
  assert.equal(budgets.view(scope()).remaining, 30, "viewing never consumes");
  budgets.check(scope());
  const spent = budgets.view(scope());
  assert.equal(spent.remaining, 29);
  assert.equal(spent.resetsAtMs, clock.now() + 2000, "refill of one token at 0.5 tokens/sec takes 2s");
  clock.advance(2000);
  const refilled = budgets.view(scope());
  assert.equal(refilled.remaining, 30);
  assert.equal(refilled.resetsAtMs, null);
  assert.equal(budgets.view({ channel: "whatsapp", accountId: "acct-1", connectionId: "c" }).remaining, 30, "unknown channels fall back to the generic default");
});

test("gmail check is a no-op and view flags the pending approval", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now });
  assert.deepEqual(budgets.check({ channel: "gmail", accountId: "acct-1", connectionId: null }), { remaining: null, pendingApproval: true });
  assert.deepEqual(budgets.view({ channel: "gmail", accountId: "acct-1", connectionId: null }), { pendingApproval: true });
});

test("the limiter cache is bounded", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now, cacheSize: 4 });
  for (let i = 0; i < 10; i++) budgets.check(scope({ connectionId: "conn-" + i }));
  assert.ok(budgets.size() <= 4, "stale connections do not accumulate limiters");
});

test("the connectionBudget callback receives channel, accountId and connectionId", () => {
  const seen = [];
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now,
    connectionBudget: (channel, accountId, connectionId) => { seen.push([channel, accountId, connectionId]); return { perMin: 60, burst: 1 }; } });
  assert.deepEqual(budgets.check({ channel: "telegram", accountId: "acct-9", connectionId: "conn-9" }), { remaining: 0 });
  assert.deepEqual(seen, [["telegram", "acct-9", "conn-9"]]);
  throwsServiceError(() => budgets.check({ channel: "telegram", accountId: "acct-9", connectionId: "conn-9" }), 429, "send_budget_exhausted");
});

test("token-bucket peek snapshots without consuming", () => {
  const limiter = createLimiter({ rate: 1, burst: 2 });
  assert.deepEqual(limiter.peek("k", { now: 1000 }), { remaining: 2, retryAfterMs: 0, fullAtMs: null });
  limiter.tryTake("k", { now: 1000 });
  assert.deepEqual(limiter.peek("k", { now: 1000 }), { remaining: 1, retryAfterMs: 0, fullAtMs: 2000 });
  limiter.tryTake("k", { now: 1000 });
  const empty = limiter.peek("k", { now: 1000 });
  assert.equal(empty.remaining, 0);
  assert.ok(empty.retryAfterMs > 0);
  assert.equal(empty.fullAtMs, 3000);
  assert.ok(Object.isFrozen(empty));
  assert.throws(() => limiter.peek("", { now: 0 }), error => error instanceof RateLimitError);
});

test("telegramLiveView carries the budget on the connection card only when provided", () => {
  const record = { channel: "telegram", accountId: "acct-1", id: "conn-1" };
  const plain = telegramLiveView({ config: { state: "configured", bindings: [], missing: [], invalid: [] }, connection: {}, record });
  assert.ok(!("sendBudget" in plain), "callers without budgets see the previous shape");
  const withBudget = telegramLiveView({ config: { state: "configured", bindings: [], missing: [], invalid: [] }, connection: {}, record,
    sendBudget: { remaining: 27, resetsAtMs: 1_699_999_999_000 } });
  assert.deepEqual(withBudget.sendBudget, { remaining: 27, resetsAt: "2023-11-14T22:13:19.000Z" });
  const exhausted = telegramLiveView({ config: { state: "configured", bindings: [], missing: [], invalid: [] }, connection: {}, record,
    sendBudget: { remaining: 0, resetsAtMs: null } });
  assert.deepEqual(exhausted.sendBudget, { remaining: 0, resetsAt: null });
});
