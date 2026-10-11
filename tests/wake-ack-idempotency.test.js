// ackWakes idempotency + validation probes (guild 5 worker B5 — wake ack bug-hunt).
//
// NOTE 2026-10-11: this file was first written against a build that carried
// the #2536 wake-listener lease subsystem (fencing tokens, claimWakeBatch);
// two real bugs were confirmed fail-first there (a roomId-null ack bypassing
// a live room lease's fencing, and claim rows leaking after ack). Upstream
// commit 401ccfccb ("Release hold: take #2536's wake-listener lease logic out
// of the candidate") deliberately removed that whole subsystem from main, so
// both findings are moot on the current tree. What remains is the ackWakes
// idempotency + validation contract itself — pinned here.
//
// Authoring gate (repo test-audit): each test names the observable contract,
// the credible regression, why existing coverage misses it, and confirms no
// test-only production seam was added.
//
// 1. Double-ack is idempotent — contract: acking an already-delivered signal
//    reports it as NOT acknowledged again (delivered_at IS NULL guard), so a
//    retried ack never double-counts. Regression: a naive UPDATE without the
//    guard would report every id every time. Existing coverage pins the first
//    ack; no test ever acked the same signal twice. (Verification probe.)
// 2. Unknown signalIds are reported, not applied — contract: the return shape
//    is { acknowledged: [] } for unknown ids, no error, no phantom ids echoed
//    back (the class docstring documents exactly this). Regression: an ack
//    that echoed its input would let callers believe unknown work was
//    handled. No existing test acks unknown ids. (Verification probe.)
// 3. Empty / non-string signalIds are 422 — contract: signalIds must be a
//    non-empty array of non-empty strings. The route layer only checks
//    Array.isArray, so the class-level validator is the real gate; pin it.
//    (Verification probe.)
// 4. Duplicate ids in one call are acknowledged once — contract: ["s","s"]
//    yields acknowledged ["s"], not ["s","s"]. Regression: a fix that pushed
//    per-input would double-report. (Verification probe.)
// 5. Acks are agent-scoped — contract: ackWakes only ever touches the
//    caller's own agent_id rows; one agent cannot drain another's queue.
//    Regression: a dropped agent_id filter would let any agent ack anyone's
//    wakes. Existing tests always ack the agent's own signals; no test ever
//    tried a cross-agent ack. (Verification probe.)
//
// Synthetic fixtures only — in-memory SQLite, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const AGENT = "ai_ackb5";
const OTHER = "ai_ackb5_other";
const ROOM = "ack-room";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, {});
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; } };
}

const wakeable = (agentId = AGENT, hostId = "host-1") => ({ agentId, hostId, mode: "pull-only" });

let msgSeq = 0;
function enqueue(hb, agentId = AGENT, roomId = ROOM) {
  return hb.enqueueWake({ agentId, kind: "mention", roomId, messageId: `ack-b5-${msgSeq++}` })
    .signal.signalId;
}

const badRequest = (code, status) => err =>
  err instanceof HeartbeatError && err.status === status && err.code === code;

test("double-ack of the same signal is idempotent", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  const id = enqueue(hb);
  const first = hb.ackWakes({ agentId: AGENT, signalIds: [id] });
  assert.deepEqual(first.acknowledged, [id], "first ack reports the signal");
  const second = hb.ackWakes({ agentId: AGENT, signalIds: [id] });
  assert.deepEqual(second.acknowledged, [], "second ack reports nothing newly applied");
  assert.deepEqual(Object.keys(second), ["acknowledged"], "return shape stays { acknowledged }");
});

test("acking unknown signalIds is reported, not applied", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  enqueue(hb);
  const res = hb.ackWakes({ agentId: AGENT, signalIds: ["ws_nope_1", "ws_nope_2"] });
  assert.deepEqual(res.acknowledged, [], "unknown ids are silently not applied");
  assert.equal(hb.pendingWakes(AGENT).length, 1, "the real signal is still pending");
});

test("empty and non-string signalIds are 422", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: [] }),
    badRequest("invalid_heartbeat_ack", 422), "empty array is 422");
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: ["ok", 42] }),
    badRequest("invalid_heartbeat_ack", 422), "non-string id is 422");
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: ["ok", ""] }),
    badRequest("invalid_heartbeat_ack", 422), "empty-string id is 422");
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: "nope" }),
    badRequest("invalid_heartbeat_ack", 422), "non-array is 422");
});

test("duplicate ids in one call are acknowledged once", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  const id = enqueue(hb);
  const res = hb.ackWakes({ agentId: AGENT, signalIds: [id, id] });
  assert.deepEqual(res.acknowledged, [id], "duplicates collapse to one entry");
});

test("acks cannot drain another agent's wake queue", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  hb.heartbeat(wakeable(OTHER, "host-2"));
  const id = enqueue(hb, AGENT);
  const res = hb.ackWakes({ agentId: OTHER, signalIds: [id] });
  assert.deepEqual(res.acknowledged, [], "cross-agent ack applies nothing");
  assert.equal(hb.pendingWakes(AGENT).length, 1, "the victim's signal is still pending");
  assert.equal(hb.pendingWakes(OTHER).length, 0, "the attacker learns nothing");
});
