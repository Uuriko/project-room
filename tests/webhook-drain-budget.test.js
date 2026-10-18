// Drain-until-budget + retry fairness (HUNT-SOAK S-1; ATLAS-JOBS-WAKES
// WP-1/R-2 follow-through on PR-2's deadline plumbing, #4099/#4134).
//
// Before this change a drain call was a single batch of at most 25 rows:
// the sustained drain rate was 25 deliveries per minute per store
// whatever the backlog (a healthy 10k burst needed ~400 ticks ≈ 6.7 h;
// sustained arrivals above 25/min never caught up), and selection was
// purely next_attempt_at-ordered, so under a fresh flood retries — whose
// next_attempt_at is always a backoff past their last attempt — were
// attempted only after every fresh row ahead of them had its first
// attempt (at a 10k failing backlog, 100 ticks processed 2,500 first
// attempts and no retries past them; the soak lane's repro scripts are
// the at-scale evidence, these tests pin the mechanism).
//
// The drain now repeats batches until the due queue is empty or the
// caller's deadline is spent, and each batch reserves a share for
// retries (WEBHOOK_DRAIN_RETRY_RESERVE_SHARE) with a proportional
// round-robin attempt order. Tests are written to be independent of
// wall-clock drain speed: bounded drains are bounded by gated/hanging
// fetches against a generous deadline, never by racing real timers.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { backoffDelayMs } from "../server/webhook-dispatch.mjs";

const T0 = 1_700_000_000_000;
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });
const fail503 = async () => ({ status: 503, headers: { get: () => null }, text: async () => "no" });

// A receiver that hangs until the caller's abort signal fires — the
// real transport's shape (AbortSignal.timeout in postDelivery). The
// attempt that reaches it is cut by the drain's per-attempt timeout
// cap at the time left to the deadline and recorded as a retry.
const hangUntilAbort = async (_url, init) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 60_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("delivery timed out"), { name: "TimeoutError" }));
    }, { once: true });
  });
  return ok200();
};

function seedDeliveries(plugin, { agentId, count, prefix, attempts = 0, state = null,
  nextAttemptAt = T0, createdAt = T0, claimExpiresAt = null }) {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "test-secret-0123456789abcdef",
  });
  const ins = plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at, claim_expires_at)
    VALUES (?, ?, ?, ?, 'message.posted', '{"data":{}}', '', ?, ?, ?, ?, ?, ?)`);
  const st = state ?? (attempts > 0 ? "failed" : "pending");
  for (let i = 0; i < count; i++) {
    ins.run(`${prefix}_${i}`, `idem_${prefix}_${i}`, subscription.subscriptionId, agentId,
      st, attempts, nextAttemptAt, createdAt + i, createdAt + i, claimExpiresAt);
  }
  return subscription;
}

// Rows normalized to plain objects: node:sqlite returns null-prototype
// rows, which deepStrictEqual refuses to match against object literals.
const census = plugin => plugin.db.prepare(
  `SELECT state, attempts, COUNT(*) AS n FROM agent_webhook_deliveries
   GROUP BY state, attempts ORDER BY state, attempts`).all()
  .map(row => ({ state: row.state, attempts: row.attempts, n: row.n }));

test("webhook drain: one call drains a burst far past the old 25-per-tick ceiling", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  // 300 due deliveries: twelve old ticks' worth. One drain call must
  // take all of them (the loop repeats batches until the queue is
  // empty); the soak lane's 10k repro is the same claim at scale.
  seedDeliveries(plugin, { agentId: "agent_burst", count: 300, prefix: "burst" });
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: publicDns,
    deadline: Date.now() + 600_000,
  });
  assert.equal(summary.processed, 300, "every due delivery is attempted in one drain call");
  assert.equal(summary.delivered, 300);
  assert.equal(summary.budgetExceeded, undefined, "the queue emptied before the budget did");
  assert.deepEqual(census(plugin), [{ state: "delivered", attempts: 1, n: 300 }]);

  const second = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: publicDns,
  });
  assert.equal(second.processed, 0, "a follow-up drain finds an empty queue");
  f.store.close();
});

test("webhook drain: a failing flood dead-letters in a bounded number of ticks", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, { agentId: "agent_flood", count: 60, prefix: "flood" });
  // Production cadence: one drain per simulated minute. Every tick
  // must process ALL currently-due rows (the old ceiling processed 25
  // and the flood's later attempts waited behind its first attempts).
  // Backoffs are 10/20/40/80 s, so attempts land on ticks 1,2,3,4,6
  // and the fifth failure dead-letters: all rows dead by tick 6.
  let now = T0;
  let ticks = 0;
  let firstTickProcessed = null;
  for (;;) {
    const summary = await plugin.drainWebhookDeliveries({
      fetchImpl: fail503, now, dnsResolvers: publicDns, deadline: Date.now() + 600_000,
    });
    ticks += 1;
    if (firstTickProcessed === null) firstTickProcessed = summary.processed;
    const remaining = plugin.db.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE state IN ('pending','failed')`).get().n;
    if (remaining === 0) break;
    assert.ok(ticks < 12, "the flood must terminate");
    now += 60_000;
  }
  assert.equal(firstTickProcessed, 60, "tick 1 attempts every due row, not one 25-row batch");
  assert.ok(ticks <= 8, `flood dead-lettered in ${ticks} ticks (old shape: 12 ticks of first attempts alone)`);
  assert.deepEqual(census(plugin), [{ state: "dead_letter", attempts: 5, n: 60 }],
    "every row took exactly its five attempts and dead-lettered — none lost, none extra");
  f.store.close();
});

test("webhook drain: a batch reserves a retry share — fresh floods cannot starve retries", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  // 30 retries whose backoff lands at T0+50s and 30 fresh rows due at
  // T0. Pure next_attempt_at ordering attempts ALL fresh rows first —
  // a bounded drain would spend its whole budget on first attempts.
  seedDeliveries(plugin, { agentId: "agent_fair", count: 30, prefix: "retry", attempts: 2, nextAttemptAt: T0 + 50_000 });
  seedDeliveries(plugin, { agentId: "agent_fair", count: 30, prefix: "fresh", attempts: 0, nextAttemptAt: T0 });

  // Record the drain's attempt order at the fetch boundary; fetches
  // past the first batch's worth (25) wait on a gate so the test can
  // inspect exactly one batch's composition before letting it finish.
  const started = [];
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const gatedFetch = async (_url, init) => {
    started.push(JSON.parse(init.body).deliveryId);
    if (started.length > 25) await gate;
    return ok200();
  };
  const drainPromise = plugin.drainWebhookDeliveries({
    fetchImpl: gatedFetch, now: T0 + 60_000, dnsResolvers: publicDns,
    deadline: Date.now() + 600_000,
  });
  while (started.length < 25) await new Promise(resolve => setTimeout(resolve, 5));
  const firstBatch = started.slice(0, 25);
  assert.equal(firstBatch.filter(id => id.startsWith("retry_")).length, 10,
    "the batch reserves ceil(25 × 0.4) = 10 of 25 slots for retries");
  assert.equal(firstBatch.filter(id => id.startsWith("fresh_")).length, 15,
    "fresh rows take the remaining 15 slots");
  openGate();
  const summary = await drainPromise;
  assert.equal(summary.delivered, 60, "with the gate open the same drain empties both classes");
  assert.equal(new Set(started).size, 60, "no delivery is POSTed twice");
  f.store.close();
});

test("webhook drain: a deadline stop mid-drain leaves the queue consistent", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, { agentId: "agent_consistent", count: 40, prefix: "keep" });
  const untouchedBefore = plugin.db.prepare(
    `SELECT delivery_id, state, attempts, next_attempt_at FROM agent_webhook_deliveries
     WHERE delivery_id LIKE 'keep_%' ORDER BY created_at ASC`).all();

  // Three instant deliveries, then a receiver that hangs: the fourth
  // attempt is cut at the deadline by the per-attempt timeout cap.
  let calls = 0;
  const cutFetch = async (_url, init) => {
    calls += 1;
    if (calls > 3) return hangUntilAbort(_url, init);
    return ok200();
  };
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: cutFetch, now: T0 + 1000, dnsResolvers: publicDns,
    deadline: Date.now() + 6_000,
  });
  assert.equal(summary.processed, 4, "three deliveries plus the cut attempt");
  assert.equal(summary.delivered, 3);
  assert.equal(summary.retried, 1, "the cut attempt is a recorded retry, not a loss");
  assert.equal(summary.budgetExceeded, 1);
  assert.equal(summary.pending, 36, "the summary names all work left due");

  const rows = plugin.db.prepare(
    `SELECT delivery_id, state, attempts, next_attempt_at FROM agent_webhook_deliveries
     ORDER BY created_at ASC`).all();
  assert.equal(rows.length, 40, "no delivery is lost");
  const cut = rows[3];
  assert.equal(cut.state, "failed");
  assert.equal(cut.attempts, 1);
  assert.equal(cut.next_attempt_at, T0 + 1000 + backoffDelayMs(1));
  assert.deepEqual(rows.slice(4), untouchedBefore.slice(4),
    "rows the tick never reached are byte-identical to their seeded state");

  // The next drain completes the rest; across both drains every
  // delivery is POSTed to a successful response exactly once.
  const successPosts = new Map();
  const countingFetch = async (_url, init) => {
    const id = JSON.parse(init.body).deliveryId;
    successPosts.set(id, (successPosts.get(id) ?? 0) + 1);
    return ok200();
  };
  const second = await plugin.drainWebhookDeliveries({
    fetchImpl: countingFetch, now: T0 + 1000 + backoffDelayMs(1), dnsResolvers: publicDns,
    deadline: Date.now() + 600_000,
  });
  assert.equal(second.delivered, 37, "the 36 untouched rows plus the cut row's retry");
  assert.equal(successPosts.size, 37);
  assert.ok([...successPosts.values()].every(n => n === 1), "no delivery is delivered twice");
  assert.deepEqual(census(plugin).filter(row => row.state === "delivered"),
    [{ state: "delivered", attempts: 1, n: 39 }, { state: "delivered", attempts: 2, n: 1 }]);
  f.store.close();
});

test("webhook drain: rows under another instance's live claim end the drain, never spin it", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  // 30 rows held by a live cross-instance claim (#3251: claim lease
  // unexpired at the drain's `now`) sort ahead of 15 ordinary rows.
  // The claim-held rows read as skipped and keep their next_attempt_at,
  // so a looping drain that re-selected them would spin until its
  // deadline; this drain has NO deadline and must still return.
  seedDeliveries(plugin, { agentId: "agent_claimed", count: 30, prefix: "held",
    nextAttemptAt: T0, claimExpiresAt: T0 + 300_000 });
  seedDeliveries(plugin, { agentId: "agent_claimed", count: 15, prefix: "free", nextAttemptAt: T0 + 500 });
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: publicDns,
  });
  assert.equal(summary.skipped, 25, "one batch's worth of claim-held rows is attempted once each and reads skipped");
  assert.equal(summary.processed, 25);
  assert.equal(summary.delivered, 0,
    "the claim-held window fills the batch, so ordinary rows wait for the next drain — progress is the other instance's");
  const held = plugin.db.prepare(
    `SELECT COUNT(*) AS n FROM agent_webhook_deliveries
     WHERE delivery_id LIKE 'held_%' AND state='pending' AND attempts=0 AND claim_expires_at=?`)
    .get(T0 + 300_000).n;
  assert.equal(held, 30, "claim-held rows are untouched: state, attempts and the claim itself unchanged");
  f.store.close();
});

test("webhook drain: the batch window slides past claim-held rows to reachable work", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  // A partial window of claim-held rows must not strand the rows
  // behind them: batches repeat, the held rows are filtered as
  // already-attempted, and the window slides to the reachable rows.
  seedDeliveries(plugin, { agentId: "agent_slide", count: 10, prefix: "held",
    nextAttemptAt: T0, claimExpiresAt: T0 + 300_000 });
  seedDeliveries(plugin, { agentId: "agent_slide", count: 40, prefix: "free", nextAttemptAt: T0 + 500 });
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: publicDns,
  });
  assert.equal(summary.skipped, 10);
  assert.equal(summary.delivered, 40, "every reachable row is delivered in the same drain");
  assert.equal(summary.processed, 50);
  f.store.close();
});

test("webhook drain: an agent-scoped drain loops within its scope only", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, { agentId: "agent_scoped_a", count: 60, prefix: "scopea" });
  seedDeliveries(plugin, { agentId: "agent_scoped_b", count: 60, prefix: "scopeb" });
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: publicDns,
    agentId: "agent_scoped_a", deadline: Date.now() + 600_000,
  });
  assert.equal(summary.delivered, 60, "the scoped drain loops past one batch within its agent");
  const other = plugin.db.prepare(
    `SELECT COUNT(*) AS n FROM agent_webhook_deliveries
     WHERE delivery_id LIKE 'scopeb_%' AND state='pending' AND attempts=0`).get().n;
  assert.equal(other, 60, "the other agent's deliveries are untouched");
  f.store.close();
});
