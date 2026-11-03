// S-05 behavioural pin (written BEFORE the second-bucket merge, against the
// unmodified tip): burst / allowance counts at the affected call sites.
// Surfaces pinned are the ones that must survive the merge unchanged:
//   - the send-budget registry (server/channel-send-budgets.mjs), the sole
//     production consumer of the retired second limiter, and
//   - the surviving per-identity limiter (server/identity-ratelimit.mjs).
// This file imports only the surviving surfaces, so it must pass
// identically before and after the second limiter module is retired.
import test from "node:test";
import assert from "node:assert/strict";
import { createSendBudgetRegistry } from "../server/channel-send-budgets.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { ServiceError } from "../server/store.mjs";

const fakeClock = (start = 1_000_000) => { const box = { now: start }; return { box, now: () => box.now, advance: ms => { box.now += ms; }, set: ms => { box.now = ms; } }; };
const scope = (over = {}) => ({ channel: "telegram", accountId: "acct-1", connectionId: "conn-1", ...over });
const throws429 = (fn, retryAfter) => assert.throws(fn, error => {
  assert.ok(error instanceof ServiceError);
  assert.equal(error.status, 429);
  assert.equal(error.code, "send_budget_exhausted");
  if (retryAfter !== undefined) assert.equal(error.headers["Retry-After"], retryAfter);
  return true;
});

test("pin: default burst is exactly 30, remaining counts down 29..0, then 429 Retry-After 2", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now });
  for (let i = 0; i < 30; i += 1) assert.deepEqual(budgets.check(scope()), { remaining: 29 - i });
  // rate 30/min = 0.5 tokens/s: one token needs 2000ms -> Retry-After 2s.
  throws429(() => budgets.check(scope()), "2");
  clock.advance(1000); // half a token: still refused, 1000ms to a whole token
  throws429(() => budgets.check(scope()), "1");
  clock.advance(1000); // one full token
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
  throws429(() => budgets.check(scope()), "2");
});

test("pin: fractional refill — allowance appears only at whole-token boundaries", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "2" }, now: clock.now });
  assert.deepEqual(budgets.check(scope()), { remaining: 1 });
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
  throws429(() => budgets.check(scope()), "1"); // rate 1/s: 1000ms to next token
  clock.advance(500); // 0.5 tokens banked: no allowance yet
  throws429(() => budgets.check(scope()), "1"); // 500ms short -> ceil to 1s header
  clock.advance(499); // 0.999 tokens: still no allowance
  throws429(() => budgets.check(scope()));
  clock.advance(1); // exactly 1 token
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
});

test("pin: refill is capped at burst after a long idle gap", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "3" }, now: clock.now });
  budgets.check(scope()); budgets.check(scope()); budgets.check(scope());
  throws429(() => budgets.check(scope()));
  clock.advance(3_600_000); // an hour at 1 token/s would be 3600 uncapped
  assert.deepEqual(budgets.check(scope()), { remaining: 2 });
  assert.deepEqual(budgets.check(scope()), { remaining: 1 });
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
  throws429(() => budgets.check(scope()));
});

test("pin: view reports fractional-token reset time exactly (fullAtMs semantics)", () => {
  const clock = fakeClock();
  const t0 = clock.box.now;
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now }); // burst 30, rate 0.5/s
  budgets.check(scope());
  assert.deepEqual(budgets.view(scope()), { remaining: 29, resetsAtMs: t0 + 2000 });
  for (let i = 0; i < 29; i += 1) budgets.check(scope());
  assert.deepEqual(budgets.view(scope()), { remaining: 0, resetsAtMs: t0 + 60_000 });
  clock.advance(1000); // 0.5 tokens banked: remaining still 0, reset instant unchanged
  assert.deepEqual(budgets.view(scope()), { remaining: 0, resetsAtMs: t0 + 60_000 });
  clock.advance(59_000); // fully refilled
  assert.deepEqual(budgets.view(scope()), { remaining: 30, resetsAtMs: null });
});

test("pin: a backwards clock step grants nothing and does not rewind the bucket", () => {
  const clock = fakeClock(10_000);
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "1" }, now: clock.now });
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
  throws429(() => budgets.check(scope()));
  clock.set(0); // NTP-style rewind
  throws429(() => budgets.check(scope()));
  clock.set(10_000); // back to the drain instant: the rewound interval must not refill twice
  throws429(() => budgets.check(scope()));
  clock.set(11_000); // one token interval after the drain
  assert.deepEqual(budgets.check(scope()), { remaining: 0 });
});

test("pin: per-call now override drives refill, independent of the registry clock", () => {
  const clock = fakeClock(5000);
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "1" }, now: clock.now });
  assert.deepEqual(budgets.check(scope(), { now: 5000 }), { remaining: 0 });
  throws429(() => budgets.check(scope(), { now: 5000 }));
  assert.deepEqual(budgets.check(scope(), { now: 6000 }), { remaining: 0 }); // explicit future time refills
  throws429(() => budgets.check(scope())); // registry clock (5000) is now backwards vs the bucket: no grant
  assert.deepEqual(budgets.view(scope(), { now: 6500 }), { remaining: 0, resetsAtMs: 7000 });
});

test("pin: per-connection override burst counts and isolation between scopes", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({
    env: { CHANNEL_SEND_BUDGETS: JSON.stringify({ "telegram:slow": { perMin: 120, burst: 3 } }) },
    now: clock.now,
  });
  assert.deepEqual(budgets.check(scope({ connectionId: "slow" })), { remaining: 2 });
  assert.deepEqual(budgets.check(scope({ connectionId: "slow" })), { remaining: 1 });
  assert.deepEqual(budgets.check(scope({ connectionId: "slow" })), { remaining: 0 });
  throws429(() => budgets.check(scope({ connectionId: "slow" })));
  assert.deepEqual(budgets.check(scope({ connectionId: "other" })), { remaining: 29 }, "default scope keeps burst 30");
  assert.deepEqual(budgets.check(scope({ connectionId: "slow", accountId: "acct-2" })), { remaining: 2 }, "override keys on channel:connection (not account): a new account scope is a fresh bucket with the override burst");
});

test("pin: parallel burst admits exactly the burst count", async () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "5" }, now: clock.now });
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    Promise.resolve().then(() => { try { budgets.check(scope()); return "sent"; } catch { return "limited"; } })));
  assert.equal(results.filter(r => r === "sent").length, 5);
  assert.equal(results.filter(r => r === "limited").length, 7);
});

test("pin: an evicted scope resumes its consumed burst, then refills exactly", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: { TELEGRAM_SEND_BUDGET_PER_MIN: "60", TELEGRAM_SEND_BUDGET_BURST: "2" }, now: clock.now, cacheSize: 2 });
  const a = scope({ connectionId: "a" }), b = scope({ connectionId: "b" }), c = scope({ connectionId: "c" });
  budgets.check(a); budgets.check(a);
  throws429(() => budgets.check(a));
  budgets.check(b); budgets.check(c); // evicts a
  throws429(() => budgets.check(a), undefined, "evicted scope keeps its consumed burst");
  clock.advance(2000); // 2 tokens at 1/s from the drain instant
  assert.deepEqual(budgets.check(a), { remaining: 1 });
});

test("pin: gmail stays a no-op however often it is checked", () => {
  const clock = fakeClock();
  const budgets = createSendBudgetRegistry({ env: {}, now: clock.now });
  for (let i = 0; i < 40; i += 1)
    assert.deepEqual(budgets.check({ channel: "gmail", accountId: "acct-1", connectionId: null }), { remaining: null, pendingApproval: true });
});

test("pin: surviving identity limiter burst counts, retryAfter and refill boundaries", () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t, capacity: 3, refillPerSecond: 2 });
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.state("ada").tokens, 2);
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.state("ada").tokens, 0);
  const refused = limiter.check("ada");
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 500); // (1 - 0) / 2 per sec
  assert.equal(refused.message, "Rate limit reached. Please wait 1 second and try again.");
  t += 250; // 0.5 tokens: still refused, half the wait remains
  assert.equal(limiter.check("ada").allowed, false);
  assert.equal(limiter.check("ada").retryAfterMs, 250);
  t += 250; // exactly 1 token
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.state("ada").tokens, 0);
  assert.equal(limiter.check("bob").allowed, true, "identities are isolated");
});
