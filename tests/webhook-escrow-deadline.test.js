// PR-2 / HOT-PATH F2+F5: deadline discipline for the two cron jobs that
// never got it — the webhook drain and the escrow-epoch keeper.
//
// Before this, the drain selected up to 25 due deliveries and awaited
// them strictly sequentially with no deadline (worst-case tick >= 250 s
// at the 10 s per-attempt timeout), and progressEscrowEpochs looped
// every room with due work with no deadline and no per-tick cap. Every
// other job already takes cronDeadline() and yields cooperatively
// (budgetExceeded + the remainder stays due for the next tick). These
// tests pin that same yield/resume semantics on both paths:
//
// - the tick stops at the deadline bound;
// - work not reached stays pending, in its original order, untouched;
// - a later tick completes it with no duplicates and no loss;
// - for escrow, splitting the work across ticks conserves funds exactly
//   (balances identical to the single-tick outcome).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import { jobByName } from "../server/jobs.mjs";
import { backoffDelayMs } from "../server/webhook-dispatch.mjs";

const T0 = 1_700_000_000_000;
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

// A receiver that hangs for 10 s unless the caller's abort signal fires —
// the real transport's shape (AbortSignal.timeout in postDelivery).
const hangingFetch = calls => async (_url, init) => {
  calls.push(1);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("delivery timed out"), { name: "TimeoutError" }));
    }, { once: true });
  });
  return ok200();
};

function seedDeliveries(plugin, agentId, count, prefix = "dl") {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "test-secret-0123456789abcdef",
  });
  for (let i = 0; i < count; i++) {
    plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
       signature, state, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'message.posted', '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
      .run(`del_${prefix}_${i}`, `idem_${prefix}_${i}`, subscription.subscriptionId, agentId, T0 + i, T0 + i, T0 + i);
  }
  return subscription;
}

const deliveryRows = plugin => plugin.db.prepare(
  `SELECT delivery_id, state, attempts, next_attempt_at FROM agent_webhook_deliveries
   ORDER BY next_attempt_at ASC, created_at ASC, delivery_id ASC`).all();

test("webhook drain: a tick stops at its deadline and the remainder stays pending in order", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, "agent_deadline", 25);

  const calls = [];
  const started = Date.now();
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: hangingFetch(calls), now: T0 + 1000, dnsResolvers: publicDns,
    deadline: Date.now() + 250,
  });
  const elapsedMs = Date.now() - started;

  // The unbounded shape was 25 sequential attempts of up to 10 s each.
  // The bounded tick ends near its 250 ms budget: it starts one attempt,
  // the per-attempt timeout is capped at the time left, the attempt is
  // recorded as a retry (not lost), and no further delivery starts.
  assert.ok(elapsedMs < 2000, `tick must stop at the deadline bound, took ${elapsedMs} ms`);
  assert.equal(summary.budgetExceeded, 1);
  assert.equal(summary.processed, 1, "only the in-flight attempt ran");
  assert.equal(summary.retried, 1, "the budget-aborted attempt is a recorded retry");
  assert.equal(summary.pending, 24, "the summary names the work left for the next tick");
  assert.equal(calls.length, 1, "no delivery starts past the deadline");

  const rows = deliveryRows(plugin);
  assert.equal(rows.length, 25, "no delivery is lost");
  // The attempted row is in backoff; every unreached row is byte-identical
  // to its seeded state and still in the original due order.
  assert.deepEqual(rows.map(r => r.delivery_id),
    [...Array(24).keys()].map(i => `del_dl_${i + 1}`).concat(["del_dl_0"]),
    "unreached rows keep their order (the attempted row moved behind them by its backoff)");
  for (const row of rows.slice(0, 24)) {
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 0, "an unreached delivery is never attempted");
  }
  const attempted = rows[24];
  assert.equal(attempted.state, "failed");
  assert.equal(attempted.attempts, 1);
  assert.equal(attempted.next_attempt_at, T0 + 1000 + backoffDelayMs(1));

  // The next tick (generous budget, healthy receiver) completes all of
  // it: the 24 untouched rows plus the one retry, each delivered once.
  const deliveredTo = [];
  const fastFetch = async (_url, init) => {
    deliveredTo.push(JSON.parse(init.body).deliveryId);
    return ok200();
  };
  const second = await plugin.drainWebhookDeliveries({
    fetchImpl: fastFetch, now: T0 + 1000 + backoffDelayMs(1), dnsResolvers: publicDns,
    deadline: Date.now() + 60_000,
  });
  assert.equal(second.budgetExceeded, undefined);
  assert.equal(second.delivered, 25);
  assert.equal(new Set(deliveredTo).size, 25, "no delivery is POSTed successfully twice");
  assert.deepEqual(deliveryRows(plugin).map(r => r.state), Array(25).fill("delivered"));
  const attempts = deliveryRows(plugin).map(r => r.attempts).sort((a, b) => a - b);
  assert.deepEqual(attempts, [...Array(24).fill(1), 2],
    "the budget-aborted delivery took exactly one extra attempt; the rest took one");
});

test("webhook drain: an already-expired deadline attempts nothing and loses nothing", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, "agent_starved", 3);
  const calls = [];
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: hangingFetch(calls), now: T0 + 1000, dnsResolvers: publicDns,
    deadline: Date.now() - 1,
  });
  assert.equal(summary.budgetExceeded, 1);
  assert.equal(summary.processed, 0);
  assert.equal(summary.pending, 3);
  assert.equal(calls.length, 0);
  assert.deepEqual(deliveryRows(plugin).map(r => [r.state, r.attempts]),
    [["pending", 0], ["pending", 0], ["pending", 0]]);
});

test("webhook drain: DNS answers are cached per drain and re-resolved on the next", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, "agent_dnscache", 5);
  let resolve4Calls = 0;
  const countingDns = {
    resolve4: async () => { resolve4Calls += 1; return ["93.184.216.34"]; },
    resolve6: async () => [],
  };
  const first = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: countingDns,
  });
  assert.equal(first.delivered, 5);
  assert.equal(resolve4Calls, 1, "one drain resolves a hostname once, not once per delivery");

  // The cache is per-drain only: a later drain re-resolves (answers are
  // re-validated next drain, exactly as before this change).
  seedDeliveries(plugin, "agent_dnscache2", 1, "dl2");
  const second = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + 1000, dnsResolvers: countingDns,
  });
  assert.equal(second.delivered, 1);
  assert.equal(resolve4Calls, 2, "the next drain re-resolves instead of reusing a stale answer");
});

test("webhook-dispatch job: the registry passes its deadline into the drain", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDeliveries(plugin, "agent_jobwire", 2);
  const job = jobByName("webhook-dispatch");
  const summary = await job.run(f.store, {
    fetchImpl: async () => ok200(), dnsResolvers: publicDns, deadline: Date.now() - 1,
  });
  assert.equal(summary.budgetExceeded, 1);
  assert.equal(summary.processed, 0);
  assert.equal(deliveryRows(plugin).filter(r => r.state === "pending").length, 2);
});

// ---- Escrow -------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const LANES = ["id:agent/jill", "id:agent/grokbot", "id:agent/instinct", "id:agent/codex", "pool"];
let nowMs = 1_786_000_000_000;

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_deadline_test");
    try { const out = fn(); db.exec("RELEASE escrow_deadline_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_deadline_test"); db.exec("RELEASE escrow_deadline_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  return { store, db, escrow };
}

function runToAccepted(world, room) {
  world.escrow.ensureGenesis(room);
  const bounty = world.escrow.postBounty(room,
    { poster: "id:agent/jill", title: "T", criteria: "C", amount: 10,
      deadline: new Date(nowMs + 30 * DAY_MS).toISOString() }).bounty;
  world.escrow.fundBounty(room, bounty.bountyId, { funder: "id:agent/jill" });
  world.escrow.claimBounty(room, bounty.bountyId, { claimant: "id:agent/grokbot" });
  world.escrow.submitWork(room, bounty.bountyId, { claimant: "id:agent/grokbot",
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  world.escrow.acceptWork(room, bounty.bountyId, { acceptor: "id:agent/jill",
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return bounty.bountyId;
}

test("escrow: a deadline-split pass conserves funds and matches the single-tick outcome", () => {
  const rooms = ["room-split-a", "room-split-b", "room-split-c"];

  // Warm-up world: one full single-tick progression, so the shaped
  // ticks below measure the keeper loop, not first-call JIT/schema work.
  const warm = makeWorld();
  runToAccepted(warm, "room-split-warm");
  nowMs += 4 * DAY_MS;
  progressEscrowEpochs(warm.store, { now: nowMs, escrow: warm.escrow });
  progressEscrowEpochs(warm.store, { now: nowMs, escrow: warm.escrow });
  nowMs -= 4 * DAY_MS;

  // Split world: each tick's deadline expires after roughly one room
  // (closeEpoch is shaped to ~30 ms; the budget is 10 ms, so the first
  // room runs and every later room yields).
  const split = makeWorld();
  const splitIds = rooms.map(room => runToAccepted(split, room));
  nowMs += 4 * DAY_MS; // challenge windows (3 days) have passed
  const visited = [];
  const slow = {
    closeEpoch: roomId => {
      visited.push(roomId);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return split.escrow.closeEpoch(roomId);
    },
  };
  let ticks = 0;
  let last;
  do {
    last = progressEscrowEpochs(split.store,
      { now: nowMs, escrow: slow, deadline: Date.now() + 10 });
    ticks += 1;
    if (ticks === 1) {
      assert.equal(last.budgetExceeded, 1, "the first shaped tick yields");
      assert.equal(last.rooms, 1, "one room per shaped tick");
      assert.equal(last.pending, 2, "the other rooms stay due for the next tick");
    }
    assert.ok(ticks < 20, "split ticks must terminate");
  } while (last.due > 0 || last.approved > 0 || visited.length < 6);
  // Each room takes two ticks (approve, then sweep): the due-scan is
  // re-read from the head every tick and an approved room is still due
  // its sweep, so a room fully settles before the next room starts —
  // deterministic room order across the whole split progression.
  assert.deepEqual(visited, rooms.flatMap(room => [room, room]),
    "rooms settle in stable order across the split ticks");
  for (const [i, room] of rooms.entries()) {
    assert.equal(split.escrow.getBounty(room, splitIds[i]).state, "paid");
  }

  // Single-tick world: identical work, no deadline pressure.
  nowMs -= 4 * DAY_MS;
  const single = makeWorld();
  const singleIds = rooms.map(room => runToAccepted(single, room));
  nowMs += 4 * DAY_MS;
  progressEscrowEpochs(single.store, { now: nowMs, escrow: single.escrow });
  progressEscrowEpochs(single.store, { now: nowMs, escrow: single.escrow });
  for (const [i, room] of rooms.entries()) {
    assert.equal(single.escrow.getBounty(room, singleIds[i]).state, "paid");
    // Conservation across the split: balances identical to single-tick.
    for (const lane of LANES) {
      assert.deepEqual(split.escrow.balances(room, lane), single.escrow.balances(room, lane),
        `${room} / ${lane}`);
    }
    assert.equal(split.escrow.verifyConservation(room).ok, true);
    const payouts = split.db.prepare(
      `SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' AND amount > 0`)
      .get(room, splitIds[i]).n;
    assert.equal(payouts, 1, "exactly one payout per bounty across all split ticks");
  }
});

test("escrow: an expired deadline and the room limit both yield without touching funds", () => {
  const world = makeWorld();
  const rooms = ["room-yield-a", "room-yield-b"];
  const ids = rooms.map(room => runToAccepted(world, room));
  nowMs += 4 * DAY_MS;
  const balancesBefore = rooms.flatMap(room => LANES.map(lane => world.escrow.balances(room, lane)));

  const starved = progressEscrowEpochs(world.store,
    { now: nowMs, escrow: world.escrow, deadline: Date.now() - 1 });
  assert.equal(starved.budgetExceeded, 1);
  assert.equal(starved.rooms, 0);
  assert.equal(starved.pending, 2);
  assert.equal(starved.due, 2, "both bounties remain due — nothing is lost");
  assert.deepEqual(rooms.flatMap(room => LANES.map(lane => world.escrow.balances(room, lane))),
    balancesBefore, "a starved tick moves nothing at all");

  const capped = progressEscrowEpochs(world.store,
    { now: nowMs, escrow: world.escrow, limit: 1 });
  assert.equal(capped.budgetExceeded, 1);
  assert.equal(capped.rooms, 1);
  assert.equal(capped.pending, 1);
  assert.equal(capped.approved, 1, "the first room in order progressed one step");

  // The capped tick progressed only room A (its award moved from the
  // attributed bucket to the approved bucket — a state step, not a
  // payment): every lane's total and payable are unchanged in both
  // rooms, and room B's balances are byte-identical.
  for (const room of rooms) {
    for (const lane of LANES) {
      const before = balancesBefore[rooms.indexOf(room) * LANES.length + LANES.indexOf(lane)];
      const after = world.escrow.balances(room, lane);
      assert.equal(after.total, before.total, `${room}/${lane} total`);
      assert.equal(after.payable, before.payable, `${room}/${lane} payable`);
    }
  }
  assert.deepEqual(LANES.map(lane => world.escrow.balances(rooms[1], lane)),
    balancesBefore.slice(LANES.length), "the unreached room's balances are untouched");
  assert.equal(world.escrow.getBounty(rooms[0], ids[0]).state, "approved");
  assert.equal(world.escrow.getBounty(rooms[1], ids[1]).state, "accepted",
    "the unreached room is untouched, ready for the next tick");

  // And the remainder completes on later ticks, in full.
  progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });
  progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });
  assert.equal(world.escrow.getBounty(rooms[0], ids[0]).state, "paid");
  assert.equal(world.escrow.getBounty(rooms[1], ids[1]).state, "paid");
  assert.equal(world.escrow.verifyConservation(rooms[0]).ok, true);
  assert.equal(world.escrow.verifyConservation(rooms[1]).ok, true);
});

test("escrow-epochs job: the registry passes its deadline into the keeper", async () => {
  const world = makeWorld();
  runToAccepted(world, "room-jobwire");
  world.store.bountyEscrow = world.escrow;
  nowMs += 4 * DAY_MS;
  const job = jobByName("escrow-epochs");
  const summary = await job.run(world.store, { now: () => nowMs, deadline: Date.now() - 1 });
  assert.equal(summary.budgetExceeded, 1);
  assert.equal(summary.rooms, 0);
  assert.equal(summary.due, 1);
});
