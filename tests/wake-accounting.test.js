// Wake-reliability accounting (#3345; charter B-5 step 1) + the #3265 /
// #3266 door-parity fixes. Authoring gate, per contract:
// 1. Every emission attempt resolves to exactly one counted outcome, so
//    emitted + coalesced + suppressed + failed reconciles against the
//    scripted attempts; the failure journal stays EMPTY on the happy
//    path (the #3345 acceptance shape: signals increment under fault
//    injection and stay silent when nothing is lost).
// 2. #3265: all three pull doors (heartbeat, poll, MCP receipt) report
//    the truncation flag `more` — a poll-only or MCP-only agent can tell
//    "exactly 50 pending" from "more waiting".
// 3. #3266: ack enforces the registration gate poll enforces (404
//    agent_not_registered for a never-registered identity, on the shared
//    ackWakes both doors funnel through), and a claim wake for a member
//    with no identity link creates NO signal row (previously it parked
//    an undrainable row under the bare memberId) — the loss is a counted,
//    journaled suppression instead.
// 4. Fault injection: a dead push endpoint increments doorbell_failed and
//    journals push_delivery_failed with kind/timestamp/subject only —
//    never the transport's error text.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AgentHeartbeats, HeartbeatError, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";
import { recordWakeEvent, wakeAccounting } from "../server/wake-metrics.mjs";
import { enqueueClaimWake } from "../server/work-claim-events.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const store = { db, now: () => at,
    transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const hb = new AgentHeartbeats(store);
  t.after(() => db.close());
  return { hb, db, at: () => at, advance: ms => { at += ms; } };
}
const beat = (agentId, hostId = "host-1") => ({ agentId, hostId, mode: "wakeable", wakeUrl: "https://host.example.test/wake" });

test("emission, delivery and ack reconcile per door; journal silent on the happy path", t => {
  const { hb } = unit(t);
  hb.heartbeat(beat("ai_a"));
  hb.enqueueWake({ agentId: "ai_a", kind: "mention", roomId: "r1", messageId: "m1" });
  hb.enqueueWake({ agentId: "ai_a", kind: "mention", roomId: "r1", messageId: "m1" }); // coalesced
  hb.enqueueWake({ agentId: "ai_a", kind: "dm", roomId: "r1", messageId: "m2" });
  const page = hb.heartbeat(beat("ai_a")); // delivered on the heartbeat door
  assert.equal(page.pendingWakes.length, 2);
  const polled = hb.notePoll({ agentId: "ai_a", roomId: "r1", hostId: "host-1" }); // delivered on poll too
  assert.equal(polled.pendingWakes.length, 2);
  hb.ackWakes({ agentId: "ai_a", signalIds: [page.pendingWakes[0].signalId], door: "rest" });
  const acct = hb.accounting();
  const s = acct.byStore.signals;
  assert.equal(s.emitted, 2);
  assert.equal(s.coalesced, 1);
  assert.equal(s.deliveredByDoor.heartbeat, 2);
  assert.equal(s.deliveredByDoor.poll, 2);
  assert.equal(s.ackedByDoor.rest, 1);
  assert.equal(acct.stock.signalsPending, 1);
  assert.equal(acct.stock.signalsAcked, 1);
  assert.equal(acct.loss.lostAttempts, 0);
  assert.equal(acct.loss.failureRate, 0);
  assert.equal(acct.failures.total, 0, "no loss classes on the happy path");
  assert.deepEqual(acct.failures.recent, []);
});

test("wakeIfOffline counts the no-host suppression instead of hiding it", t => {
  const { hb } = unit(t);
  const ghost = hb.wakeIfOffline({ agentId: "ai_ghost", kind: "mention", roomId: "r1", messageId: "m1" });
  assert.equal(ghost.woken, false);
  hb.heartbeat(beat("ai_ghost"));
  const woken = hb.wakeIfOffline({ agentId: "ai_ghost", kind: "mention", roomId: "r1", messageId: "m1" });
  assert.equal(woken.woken, true);
  const s = hb.accounting().byStore.signals;
  assert.equal(s.suppressed_no_host, 1);
  assert.equal(s.emitted, 1);
  assert.equal(hb.accounting().loss.failureRate, 0, "no_host is a designed suppression, not a loss");
});

test("#3265: heartbeat and poll doors both carry the truncation flag", t => {
  const { hb } = unit(t);
  hb.heartbeat(beat("ai_busy"));
  for (let i = 0; i < 55; i++) hb.enqueueWake({ agentId: "ai_busy", kind: "mention", roomId: "r1", messageId: `m${i}` });
  const viaBeat = hb.heartbeat(beat("ai_busy"));
  assert.equal(viaBeat.pendingWakes.length, 50);
  assert.equal(viaBeat.more, true);
  const viaPoll = hb.notePoll({ agentId: "ai_busy", roomId: "r1", hostId: "host-1" });
  assert.equal(viaPoll.pendingWakes.length, 50);
  assert.equal(viaPoll.more, true, "poll used to discard the page object and its flag");
  // Exactly at the cap there is nothing more: the flag must be honest.
  const { hb: hb2 } = unit(t);
  hb2.heartbeat(beat("ai_exact"));
  for (let i = 0; i < 50; i++) hb2.enqueueWake({ agentId: "ai_exact", kind: "mention", roomId: "r1", messageId: `m${i}` });
  assert.equal(hb2.notePoll({ agentId: "ai_exact", hostId: "host-1" }).more, false);
  assert.equal(hb2.heartbeat(beat("ai_exact")).more, false);
});

test("#3266: ack enforces the registration gate poll enforces", t => {
  const { hb } = unit(t);
  // A signal can exist for a never-registered identity (direct enqueue,
  // bond path) — poll calls that identity unregistered; ack used to drain.
  hb.enqueueWake({ agentId: "ai_stranger", kind: "bond", roomId: "r1", messageId: "b1" });
  const pending = hb.pendingWakes("ai_stranger");
  assert.equal(pending.length, 1);
  assert.equal(hb.notePoll({ agentId: "ai_stranger" }).registered, false);
  assert.throws(() => hb.ackWakes({ agentId: "ai_stranger", signalIds: [pending[0].signalId] }),
    err => err instanceof HeartbeatError && err.status === 404 && err.code === "agent_not_registered");
  assert.equal(hb.pendingWakes("ai_stranger").length, 1, "the refused ack drained nothing");
  assert.equal(hb.accounting().byStore.signals.ack_unregistered, 1, "the divergence probe is counted");
  hb.heartbeat(beat("ai_stranger"));
  assert.deepEqual(hb.ackWakes({ agentId: "ai_stranger", signalIds: [pending[0].signalId] }).acknowledged,
    [pending[0].signalId], "after registering, the same ack succeeds");
});

test("fault injection: a dead push endpoint is counted and journaled without error text", async t => {
  const { hb, advance } = unit(t);
  const calls = [];
  let status = 500;
  hb.setPushTransport({
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { status, headers: { get: () => null }, text: async () => "receiver exploded with secret detail" }; },
    dnsResolvers: { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] },
  });
  hb.heartbeat({ ...beat("ai_push"), cadenceSeconds: 60,
    pushNotification: { url: "https://push.example.test/hooks/room", token: "opaque-push-token-123" } });
  // Online inside the reachability window: the doorbell is not owed.
  hb.pushNotify({ identityId: "ai_push", eventType: "message.posted", roomId: "r1", id: "e0", ts: T0 });
  await hb.flushPushes();
  assert.equal(calls.length, 0, "no doorbell while the host is online");
  advance(180_001); // past the 180s floor window: the host now reads offline
  assert.equal(hb.statusOf("ai_push").status, "offline");
  hb.pushNotify({ identityId: "ai_push", eventType: "message.posted", roomId: "r1", id: "e1", ts: T0 });
  await hb.flushPushes();
  assert.equal(calls.length, 1, "the faulted endpoint was actually POSTed");
  let acct = hb.accounting();
  assert.equal(acct.byStore.signals.doorbell_failed, 1);
  assert.equal(acct.byStore.signals.doorbell_delivered, 0);
  assert.equal(acct.failures.byReason.push_delivery_failed, 1);
  const row = acct.failures.recent[0];
  assert.equal(row.reason, "push_delivery_failed");
  assert.equal(row.subjectId, "ai_push");
  assert.equal(row.kind, "mention");
  assert.ok(!JSON.stringify(acct.failures).includes("secret detail"), "journal carries no error text");
  // The endpoint recovers: successes count as delivered, journal stays put.
  status = 200;
  hb.pushNotify({ identityId: "ai_push", eventType: "dm.posted", roomId: "r1", id: "e2", ts: T0 });
  await hb.flushPushes();
  acct = hb.accounting();
  assert.equal(acct.byStore.signals.doorbell_delivered, 1);
  assert.equal(acct.failures.total, 1, "recovery adds no journal rows");
});

test("recordWakeEvent refuses non-allowlisted reasons and never throws on a bare db", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.equal(recordWakeEvent(db, { at: 1, store: "signals", event: "failed", reason: "raw exception text" }), false);
  assert.equal(recordWakeEvent(db, { at: 1, store: "signals", event: "failed", reason: "enqueue_error", subjectId: "ai_x" }), true);
  const acct = wakeAccounting(db, { now: 10 });
  assert.equal(acct.failures.total, 1);
  assert.equal(acct.loss.lostAttempts, 1);
  assert.equal(acct.loss.failureRate, 1, "one owed attempt, one loss");
  assert.equal(recordWakeEvent(null, { at: 1, store: "signals", event: "emitted" }), false);
});

// ---- Claim-wake stranding (#3266) against a real store ----

function claimFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => store.close());
  return { store, ownerKey };
}
const linkMember = (store, ownerKey, name) => {
  const identity = store.identities.create(name);
  const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName: name, permissions: ["accept_work"] });
  return { ...identity, memberId };
};

test("#3266: a claim wake for an unlinked member creates no phantom row — the loss is counted", t => {
  const { store, ownerKey } = claimFixture(t);
  const agent = linkMember(store, ownerKey, "Linked Agent");
  // Remove only the identity link: the member remains, now unaddressable —
  // the legacy shape whose wakes used to park under the bare memberId.
  store.db.prepare("DELETE FROM identity_links WHERE room_id=? AND member_id=?").run("commons", agent.memberId);
  const result = enqueueClaimWake(store, "commons", agent.memberId, `work-claim:lane-x:assigned:${randomUUID()}`);
  assert.deepEqual(result, { enqueued: false, skipped: "no_identity" });
  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals").get().n;
  assert.equal(rows, 0, "no signal row exists under any key");
  const acct = store.agentHeartbeats.accounting({ roomId: "commons" });
  assert.equal(acct.byStore.signals.suppressed_no_identity, 1);
  assert.equal(acct.failures.byReason.no_identity_link, 1);
  assert.equal(acct.failures.recent[0].subjectId, agent.memberId);
  assert.equal(acct.loss.failureRate, 1, "the single owed attempt was lost");
});

test("a claim wake for a linked member enqueues under the identity and counts emitted", t => {
  const { store, ownerKey } = claimFixture(t);
  const agent = linkMember(store, ownerKey, "Reachable Agent");
  const result = enqueueClaimWake(store, "commons", agent.memberId, `work-claim:lane-y:assigned:${randomUUID()}`);
  assert.equal(result.enqueued, true);
  assert.equal(result.signal.agentId, agent.identityId, "addressed to the identity, never the memberId");
  const acct = store.agentHeartbeats.accounting({ roomId: "commons" });
  assert.equal(acct.byStore.signals.emitted, 1);
  assert.equal(acct.failures.total, 0);
});

test("accounting degrades to zeros on a database with no wake tables at all", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const acct = wakeAccounting(db, { now: T0 });
  assert.equal(acct.loss.failureRate, 0);
  assert.equal(acct.stock.signalsPending, null, "missing store tables read as unknown, not as zero-loss proof");
  assert.equal(acct.attempts.emitted, 0);
});
