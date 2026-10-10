// hs2-webhook-counts (1c): the agent.wake webhook sends a counts-only payload
// by default, with the durable redelivery queue covering failed wake pings.
//
// Fail-first: these tests assert the John-ordered 1c behavior against code
// that currently sends the full signal on every wake ping.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildWakePing, WAKE_PING_EVENT, WAKE_ACK_HINT } from "../server/outbound-webhooks.mjs";
import { wakeCountsFromSignals, pendingWakeCounts } from "../server/agent-wake-webhooks.mjs";
import { AgentPluginStore, agentPluginSchema } from "../server/agent-plugin-store.mjs";
import { agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

const SIGNAL = { signalId: "ws_1", agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m1" };

// ---- pure payload shape -------------------------------------------------

test("buildWakePing defaults to counts-only: no signal content on the wire", () => {
  const payload = buildWakePing({ agentId: "ai_x", signal: SIGNAL,
    counts: { pending: 2, mentions: 1, dms: 1 } });
  assert.equal(payload.event, WAKE_PING_EVENT);
  assert.equal(payload.event, "agent.wake");
  assert.equal(payload.agentId, "ai_x");
  assert.deepEqual({ ...payload.counts }, { pending: 2, mentions: 1, dms: 1 });
  assert.ok(!("signal" in payload), "default wake ping must not carry the signal");
  assert.equal(payload.ackHint, WAKE_ACK_HINT);
  assert.ok(Object.isFrozen(payload));
});

test("buildWakePing still validates the signal in counts-only mode", () => {
  assert.throws(() => buildWakePing({ agentId: "ai_x", signal: { kind: "mention" } }), /signalId/);
  assert.throws(() => buildWakePing({ agentId: "", signal: SIGNAL }), /agentId/);
});

test("buildWakePing with full:true keeps the legacy full-signal payload", () => {
  const payload = buildWakePing({ agentId: "ai_x", signal: SIGNAL, full: true });
  assert.equal(payload.event, WAKE_PING_EVENT);
  assert.deepEqual(payload.signal, SIGNAL);
  assert.equal(payload.ackHint, WAKE_ACK_HINT);
});

// ---- counts helpers ------------------------------------------------------

test("wakeCountsFromSignals tallies pending by kind", () => {
  const signals = [
    { kind: "mention" }, { kind: "mention" }, { kind: "dm" },
  ];
  assert.deepEqual({ ...wakeCountsFromSignals(signals) }, { pending: 3, mentions: 2, dms: 1 });
  assert.deepEqual({ ...wakeCountsFromSignals([]) }, { pending: 0, mentions: 0, dms: 0 });
  assert.ok(Object.isFrozen(wakeCountsFromSignals(signals)));
});

test("pendingWakeCounts reads the durable wake queue, uncapped", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const insert = db.prepare(`INSERT INTO agent_wake_signals
    (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`);
  insert.run("ws_1", "ai_x", "mention", "r", "m1", 100);
  insert.run("ws_2", "ai_x", "mention", "r", "m2", 101);
  insert.run("ws_3", "ai_x", "dm", null, "m3", 102);
  insert.run("ws_4", "ai_other", "dm", null, "m4", 103);
  db.prepare("UPDATE agent_wake_signals SET delivered_at=200 WHERE signal_id='ws_2'").run();
  assert.deepEqual({ ...pendingWakeCounts(db, "ai_x") }, { pending: 2, mentions: 1, dms: 1 });
  assert.deepEqual({ ...pendingWakeCounts(db, "ai_other") }, { pending: 1, mentions: 0, dms: 1 });
  assert.deepEqual({ ...pendingWakeCounts(db, "ai_nobody") }, { pending: 0, mentions: 0, dms: 0 });
});

test("pendingWakeCounts returns zeros when the wake table is absent (older DB)", () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual({ ...pendingWakeCounts(db, "ai_x") }, { pending: 0, mentions: 0, dms: 0 });
});

// ---- journaled delivery: counts-only payload + redelivery ----------------

const makePlugin = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentPluginSchema);
  db.exec(agentHeartbeatSchema);
  // Minimal identity_links: the drain's fan-out scope check joins it.
  // Wake rows carry room_id NULL so the check passes regardless.
  db.exec("CREATE TABLE IF NOT EXISTS identity_links (room_id TEXT, identity_id TEXT)");
  let now = 1_700_000_000_000;
  const store = {
    db,
    now: () => now,
    transaction: fn => fn(),
    readTransaction: fn => fn(),
    agentHeartbeats: null, // counts read straight from the shared db
  };
  const plugin = new AgentPluginStore(store);
  return { plugin, db, store, setNow: v => { now = v; }, getNow: () => now };
};

const enqueue = (db, signalId, agentId, kind, at) => {
  db.prepare(`INSERT INTO agent_wake_signals
    (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES (?, ?, ?, 'r', ?, ?, NULL)`).run(signalId, agentId, kind, "m_" + signalId, at);
};

const SECRET = "wake-counts-test-secret-0123456789";

// The sandbox resolver maps .test names into blocked space; the drain's
// dispatch-time SSRF guard would dead-letter before the injected fetch
// runs. Pin the test webhook host to a public IP instead.
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const drainable = plugin => { plugin.setWebhookLookup(publicDns); return plugin; };

test("deliverWakePing journals a counts-only wake ping", () => {
  const { plugin, db } = makePlugin();
  plugin.subscribeWebhook({ identityId: "ai_x", url: "https://wake.example.test/hook",
    events: ["agent.wake"], secret: SECRET });
  enqueue(db, "ws_1", "ai_x", "mention", 100);
  enqueue(db, "ws_2", "ai_x", "dm", 101);

  const result = plugin.deliverWakePing({ identityId: "ai_x", signal: SIGNAL });
  assert.equal(result.deliveries.length, 1);

  const row = db.prepare("SELECT payload_json FROM agent_webhook_deliveries").get();
  const envelope = JSON.parse(row.payload_json);
  assert.equal(envelope.eventType, "agent.wake");
  assert.deepEqual({ ...envelope.data.counts }, { pending: 2, mentions: 1, dms: 1 });
  assert.ok(!("signal" in envelope.data), "journaled wake payload must be counts-only");
  assert.equal(envelope.data.ackHint, WAKE_ACK_HINT);
});

test("deliverWakePing full:true journals the legacy full-signal payload", () => {
  const { plugin, db } = makePlugin();
  plugin.subscribeWebhook({ identityId: "ai_x", url: "https://wake.example.test/hook",
    events: ["agent.wake"], secret: SECRET });
  enqueue(db, "ws_1", "ai_x", "mention", 100);

  plugin.deliverWakePing({ identityId: "ai_x", signal: SIGNAL, full: true });
  const row = db.prepare("SELECT payload_json FROM agent_webhook_deliveries").get();
  const envelope = JSON.parse(row.payload_json);
  assert.deepEqual(envelope.data.signal, SIGNAL);
});

test("a failed wake ping enters the redelivery queue and dead-letters after max attempts", async () => {
  const { plugin, db, setNow, getNow } = makePlugin();
  drainable(plugin);
  plugin.subscribeWebhook({ identityId: "ai_x", url: "https://wake.example.test/hook",
    events: ["agent.wake"], secret: SECRET });
  enqueue(db, "ws_1", "ai_x", "mention", 100);
  plugin.deliverWakePing({ identityId: "ai_x", signal: SIGNAL });

  const posted = [];
  const failingFetch = async (url, init) => {
    posted.push(JSON.parse(init.body));
    return { status: 500, headers: { get: () => null }, text: async () => "boom" };
  };

  const state = () => db.prepare(
    "SELECT state, attempts, next_attempt_at FROM agent_webhook_deliveries").get();

  // First drain: the 500 is retryable — the wake ping waits with backoff.
  let summary = await plugin.drainWebhookDeliveries({ fetchImpl: failingFetch, now: getNow() });
  assert.equal(summary.retried, 1);
  let row = state();
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > getNow(), "failed wake ping backs off before redelivery");
  assert.equal(posted.length, 1);
  assert.ok(!("signal" in posted[0].data), "redelivered wake ping stays counts-only");

  // Redrive through the backoff until the attempt budget is spent.
  for (let i = 0; i < 4; i++) {
    setNow(row.next_attempt_at + 1);
    summary = await plugin.drainWebhookDeliveries({ fetchImpl: failingFetch, now: getNow() });
    row = state();
  }
  assert.equal(row.state, "dead_letter");
  assert.equal(row.attempts, 5);
  assert.equal(posted.length, 5, "the wake ping was redelivered on every due drain");

  // A later drain does not pick up the dead letter.
  setNow(row.next_attempt_at + 1_000_000);
  summary = await plugin.drainWebhookDeliveries({ fetchImpl: failingFetch, now: getNow() });
  assert.equal(summary.processed, 0);
  assert.equal(posted.length, 5);
});

test("a wake ping that recovers on retry is marked delivered", async () => {
  const { plugin, db, getNow } = makePlugin();
  drainable(plugin);
  plugin.subscribeWebhook({ identityId: "ai_x", url: "https://wake.example.test/hook",
    events: ["agent.wake"], secret: SECRET });
  enqueue(db, "ws_1", "ai_x", "dm", 100);
  plugin.deliverWakePing({ identityId: "ai_x", signal: SIGNAL });

  let calls = 0;
  const flaky = async () => (++calls === 1
    ? { status: 503, headers: { get: () => null }, text: async () => "down" }
    : { status: 200, headers: { get: () => null }, text: async () => "ok" });
  await plugin.drainWebhookDeliveries({ fetchImpl: flaky, now: getNow() });
  const row = db.prepare(
    "SELECT state, attempts, next_attempt_at FROM agent_webhook_deliveries").get();
  const due = await plugin.drainWebhookDeliveries({ fetchImpl: flaky, now: row.next_attempt_at + 1 });
  assert.equal(due.delivered, 1);
  const done = db.prepare("SELECT state, attempts FROM agent_webhook_deliveries").get();
  assert.deepEqual([done.state, done.attempts], ["delivered", 2]);
});
