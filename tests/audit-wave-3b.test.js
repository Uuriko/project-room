// Audit wave 3B regression tests (RC-2026-09-30-3626): one baseline-failing
// test per MEDIUM finding M-3..M-23 (inbox family, non-store modules).
// Each test fails on current main for the finding's intended reason.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// ---- M-3: push-delivery promises must not accumulate unboundedly ----
import { AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

test("M-3: settled push deliveries self-remove from _pushInflight", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => 1_750_000_000_000 }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS });
  hb.pushTargets = () => [{ agentId: "ai_x", hostId: "h1", url: "https://x.test/wake", token: "t" }];
  hb.deliverPush = async () => ({ ok: true });
  hb.pushNotify({ identityId: "ai_x", eventType: "message.posted", roomId: "r1", id: "e1", ts: 1 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(hb._pushInflight.length, 0, "settled push promises must self-remove (unbounded memory leak)");
  // flushPushes still works for genuinely in-flight pushes
  let release;
  hb.deliverPush = () => new Promise(r => { release = r; });
  hb.pushNotify({ identityId: "ai_x", eventType: "message.posted", roomId: "r1", id: "e2", ts: 2 });
  assert.equal(hb._pushInflight.length, 1);
  release({ ok: true });
  await hb.flushPushes();
  assert.equal(hb._pushInflight.length, 0);
});

// ---- M-4: requestEdits must persist the edit payload ----
import { createApprovalQueue, ApprovalError } from "../server/inbox-approval.mjs";

const agentA = { kind: "agent", id: "claude", label: "Claude" };
const agentB = { kind: "agent", id: "grok", label: "Grok" };
const human = { kind: "human", id: "john", label: "John" };
const draft = { subject: "Re: kickoff", body: "Sounds good?" };
const expectApprovalCode = (fn, code) => {
  try { fn(); } catch (e) { assert.ok(e instanceof ApprovalError, `expected ApprovalError, got ${e}`); assert.equal(e.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};

test("M-4: requestEdits persists requestedEdits (get() shows the reviewer's feedback)", () => {
  const queue = createApprovalQueue({ clock: () => 1000, id: () => `p-${Math.random()}` });
  const p = queue.propose("thread:1", { draft, byAgent: agentA, channel: "email" });
  queue.requestEdits(p.proposalId, { by: human, edits: "Soften the opening line." });
  const reread = queue.get(p.proposalId);
  assert.ok(reread.requestedEdits, "requestedEdits must be persisted, not just returned");
  assert.equal(reread.requestedEdits.edits, "Soften the opening line.");
});

// ---- M-5: escalate must persist the new target ----
import { createAgentRouter } from "../server/inbox-agent-routing.mjs";

test("M-5: escalate(to:) persists escalatedTo (get() shows the new target)", () => {
  const router = createAgentRouter({ clock: () => 1000, id: () => `r-${Math.random()}` });
  const rec = router.route("thread:1", { text: "@claude help", from: human });
  const target = { kind: "agent", id: "grok", label: "Grok" };
  router.escalate(rec.records[0].routingId, { by: human, reason: "needs a human", to: target });
  const reread = router.get(rec.records[0].routingId);
  assert.deepEqual(reread.escalatedTo, target, "escalatedTo must be persisted, not stale");
});

// ---- M-6: cross-agent resubmit must be rejected ----
test("M-6: resubmit by a different agent than the proposer is rejected", () => {
  const queue = createApprovalQueue({ clock: () => 1000, id: () => `p-${Math.random()}` });
  const p = queue.propose("thread:1", { draft, byAgent: agentA, channel: "email" });
  queue.requestEdits(p.proposalId, { by: human, edits: "fix it" });
  expectApprovalCode(
    () => queue.resubmit(p.proposalId, { draft: { body: "hijacked draft" }, byAgent: agentB }),
    "approval_invalid");
  // the original proposer can still resubmit
  const ok = queue.resubmit(p.proposalId, { draft: { body: "revised" }, byAgent: agentA });
  assert.equal(ok.status, "pending");
});

// ---- M-9: Jaro-Winkler window must be floored ----
import { nameSimilarity } from "../server/inbox-stitch.mjs";

test("M-9: nameSimilarity floors the matching window (odd max length)", () => {
  const sim = nameSimilarity("xxxx", "yxxxx");
  assert.ok(Math.abs(sim - 0.9333) < 0.01, `expected ~0.9333, got ${sim}`);
  // reference pairs unchanged
  assert.ok(Math.abs(nameSimilarity("dixon", "dicksonx") - 0.8133) < 0.01);
  assert.ok(Math.abs(nameSimilarity("martha", "marhta") - 0.9611) < 0.01);
});

// ---- M-12: rejected clusters must re-open on refile, not absorb as duplicate ----
import { createFeedbackStore } from "../server/feedback-store.mjs";

const goodFiling = (over = {}) => ({
  agent: { lane: "jill", card_uri: "https://x.example/.well-known/agent-card.json" },
  endpoint: { method: "POST", path: "/api/rooms/abc123/work-claims" },
  attempt: { goal: "g", request: { method: "POST", path: "/api/rooms/abc123/work-claims", body: {} },
    response: { status: 422, body: { code: "bad" } } },
  observed: "422 bad", expected: "201", severity: "bug", ...over,
});

test("M-12: filing matching a rejected-junk cluster re-opens it as new (triageable)", () => {
  const store = createFeedbackStore({ isReviewer: ["reviewer-a"] });
  const first = store.submit(goodFiling());
  store.triage(first.item.id, "junk", "reviewer-a");
  const again = store.submit(goodFiling());
  assert.notEqual(again.outcome, "duplicate", "must not be absorbed as an untriageable duplicate");
  assert.equal(again.item.status, "new", "refiled item must be triageable");
  assert.equal(again.cluster.status, "new", "rejected cluster must re-open");
  // and it can actually be triaged now
  const t = store.triage(again.item.id, "real", "reviewer-a");
  assert.equal(t.item.status, "promoted");
});

// ---- M-14: avgScore must divide by scored rows, not total rows ----
import { reviewCoverageBySignal } from "../server/quarantine-review-coverage.mjs";

test("M-14: avgScore excludes scoreless rows", () => {
  const rows = [
    { id: "q1", reason: [{ key: "s1", weight: 1, detail: "d" }], status: "released", score: 8, quarantinedAt: 1000 },
    { id: "q2", reason: [{ key: "s1", weight: 1, detail: "d" }], status: "released", score: 6, quarantinedAt: 1000 },
    { id: "q3", reason: [{ key: "s1", weight: 1, detail: "d" }], status: "released", score: null, quarantinedAt: 1000 },
    { id: "q4", reason: [{ key: "s1", weight: 1, detail: "d" }], status: "released", score: null, quarantinedAt: 1000 },
  ];
  const out = reviewCoverageBySignal({ rows });
  const s1 = out.perSignal.find(s => s.key === "s1");
  assert.equal(s1.avgScore, 7, `avgScore must be (8+6)/2=7, got ${s1.avgScore}`);
});

// ---- M-15: unknown cursor must 400, not silently restart ----
import { PublicFace, roomPublicFaceSchema } from "../server/public-face.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";

test("M-15: feedByCode rejects an unknown cursor instead of restarting pagination", t => {
  const db = new DatabaseSync(":memory:");
  db.exec(roomPublicFaceSchema);
  db.exec(roomDirectorySchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  t.after(() => db.close());
  const store = {
    db,
    transaction(fn) { return fn(); },
    room: id => id === "r1" ? { state: {
      room: { id: "r1", title: "t", ownerId: "owner", createdAt: 1000 },
      members: { owner: { id: "owner", displayName: "O", active: true, kind: "agent", permissions: [] } },
      messages: [
        { id: "m1", authorId: "owner", body: "hello", createdAt: 1001, toMemberId: null },
        { id: "m2", authorId: "owner", body: "world", createdAt: 1002, toMemberId: null },
      ],
    } } : null,
  };
  const face = new PublicFace(store);
  const enabled = face.enable("r1", "owner");
  assert.throws(() => face.feedByCode(enabled.publicCode, { after: "no-such-cursor" }),
    err => { assert.equal(err.code, "invalid_feed_cursor"); return true; });
  // a valid cursor still paginates
  const page = face.feedByCode(enabled.publicCode, { after: "m1" });
  assert.deepEqual(page.messages.map(m => m.id), ["m2"]);
});

// ---- M-18/M-19/M-20: wake queue recovery, completion idempotency, capacity ----
import { WakeQueue, wakeQueueSchema } from "../server/wake-queue.mjs";

function wakeStore({ now = 1000 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(wakeQueueSchema);
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO rooms (id) VALUES (?)").run("r1");
  const store = {
    db,
    _now: now,
    now() { return this._now; },
    transaction(fn) { return fn(); },
  };
  const q = new WakeQueue(store);
  return { db, store, q };
}

function memberRow({ memberId = "m1", now = 1000 } = {}) {
  return { room_id: "r1", member_id: memberId, queue_key: "k1", state: "pending",
    due_at: now + 5000, intent: JSON.stringify({ recipe: "x" }),
    attempts: 0, max_attempts: 3, last_error: null, lease_owner: null,
    lease_expires_at: null, created_at: now, updated_at: now };
}

test("M-18: recover() sends exhausted leases to dead instead of re-queueing", () => {
  const { db, store, q } = wakeStore();
  const now = store._now;
  const base = memberRow();
  base.max_attempts = 1;
  base.state = "leased"; base.attempts = 1;
  base.lease_owner = "owner-1"; base.lease_expires_at = now - 1; // expired lease, attempts exhausted
  db.prepare("INSERT INTO wake_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    base.room_id, base.member_id, base.queue_key, base.intent, base.state, base.due_at,
    base.attempts, base.max_attempts, base.lease_owner, base.lease_expires_at, base.last_error,
    base.created_at, base.updated_at);
  const recovered = q.recover(now);
  assert.equal(recovered, 0, "no wake returned to pending");
  const row = db.prepare("SELECT * FROM wake_queue").get();
  assert.equal(row.state, "dead", "exhausted lease went to dead, not pending");
  assert.equal(row.lease_owner, null);
});

test("M-19: complete() with a colliding requestId from another wake conflicts", () => {
  const { db, store, q } = wakeStore();
  const now = store._now;
  for (const queueKey of ["k1", "k2"]) {
    const base = memberRow({ memberId: "m1" });
    base.queue_key = queueKey; base.state = "leased";
    base.lease_owner = "owner-1"; base.lease_expires_at = now + 60000;
    db.prepare("INSERT INTO wake_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      base.room_id, base.member_id, base.queue_key, base.intent, base.state, base.due_at,
      base.attempts, base.max_attempts, base.lease_owner, base.lease_expires_at, base.last_error,
      base.created_at, base.updated_at);
  }
  const rid = randomUUID();
  q.complete("r1", "m1", "k1", { requestId: rid, leaseOwner: "owner-1" });
  assert.throws(
    () => q.complete("r1", "m1", "k2", { requestId: rid, leaseOwner: "owner-1" }),
    err => { assert.equal(err.code, "idempotency_conflict"); return true; },
    "same requestId for a different wake must conflict, not complete k2");
  // exact retry of k1 still returns its historical receipt
  const retry = q.complete("r1", "m1", "k1", { requestId: rid, leaseOwner: "owner-1" });
  assert.equal(retry.duplicate, true);
});

test("M-20: complete() enforces the receipt capacity contract", () => {
  const { db, store } = wakeStore();
  class CappedWakeQueue extends WakeQueue {
    receiptCapacity() { throw Object.assign(new Error("full"), { code: "receipt_capacity" }); }
  }
  const q2 = new CappedWakeQueue(store);
  const base = memberRow();
  base.state = "leased"; base.lease_owner = "owner-1"; base.lease_expires_at = store._now + 60000;
  db.prepare("INSERT INTO wake_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    base.room_id, base.member_id, base.queue_key, base.intent, base.state, base.due_at,
    base.attempts, base.max_attempts, base.lease_owner, base.lease_expires_at, base.last_error,
    base.created_at, base.updated_at);
  assert.throws(
    () => q2.complete("r1", "m1", "k1", { requestId: randomUUID(), leaseOwner: "owner-1" }),
    err => { assert.equal(err.code, "receipt_capacity"); return true; },
    "complete() must enforce receipt capacity like other writers");
});

// ---- M-21: no cross-account fallback in shadow review matching ----
import { joinShadowOutcomes } from "../server/spam-shadow-report.mjs";

test("M-21: a scoped decision with no exact-triple match returns no match (not another account's review)", () => {
  const decision = { accountId: "acct-A", sourceId: "tg", messageId: "msg-1",
    score: 0.9, wouldHold: false, features: [], at: 1000 };
  const reviews = [
    { accountId: "acct-B", sourceId: "tg", messageId: "msg-1", status: "released", score: 1, quarantinedAt: 1000 },
  ];
  const out = joinShadowOutcomes({ decisions: [decision], reviews });
  assert.equal(out[0].review, null, "must not fall back to another account's scoped review");
  assert.equal(out[0].scopedMatch, true);
  assert.equal(out[0].label, "true_negative");
});

// ---- M-22: thread tree must fail loud on cycles and self-replies ----



// ---- M-23: SLA clock compares canonical epoch ms, not raw strings ----
import { assessThreadSla } from "../server/sla-clocks.mjs";

test("M-23: mixed ISO timestamp formats order correctly (Z vs +00:00)", () => {
  const out = assessThreadSla({
    threadId: "t1", channel: "email", now: Date.parse("2026-01-01T01:00:00Z"),
    messages: [
      { id: "in-1", occurredAt: "2026-01-01T00:10:00+00:00", direction: "inbound" },
      { id: "out-1", occurredAt: "2026-01-01T00:20:00Z", direction: "outbound" },
    ],
  });
  assert.equal(out.status, "responded", `reply 10 min after inbound must be 'responded', got ${out.status}`);
  assert.equal(out.respondedMs, 600000);
});
