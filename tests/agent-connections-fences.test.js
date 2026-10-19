// PIN-02 CONNECTIONS-FENCE-PINS (Fix Programme v2, clause (c) critical
// path) — negative tests for the fences in server/agent-connections.mjs
// apply() and verifyHistory(). The mutation sweep (2026-10-19) found
// every sampled fence SURVIVING a 77-test family net: the family proved
// the flows work, never that the guards refuse. Each test below names
// the mutant it kills; each killer case is paired with controls that
// pass on clean and mutant alike, so the pin cannot go green by the
// fence simply refusing everything.
//
//   A-05 BOUND-SHIFT   expiry cap 30 d -> 300 d in apply()
//   A-06 CMP-FLIP      generation fence !== -> > (ahead generations pass)
//   A-07 GUARD-INVERT  idempotency fingerprint check made vacuous
//   A-08 CMP-FLIP      owner-revision fence !== -> < (future revisions pass)
//   CAL-M14 CONJUNCT-DROP  verifyHistory generation-continuity clause
//     dropped. NOTE (evidence in fixplan-2026-10-19/pin-02-report.md):
//     CAL-M14 is an equivalent mutant at this seam — the clause is
//     defence-in-depth, redundant with the operations-count check, the
//     per-operation state/receipt generation equalities and the final
//     row/last-state equality, so no journal is accepted with the
//     clause removed ALONE. The pin here is the chartered clause-level
//     behaviour pin: a renumbered journal is refused, and it goes red
//     if the clause and its redundant partners are removed together.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const CAP_MS = 30 * 86400000 + 3600000; // the A-05 fence, verbatim shape

function fixture(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const keyHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
  const ownerRevision = () => store.room("commons").state.members.owner.revision;
  const memberRevision = memberId => store.room("commons").state.members[memberId].revision;
  const create = (memberId, over = {}) => store.agentConnections.apply(session.token, "commons", {
    action: "create", requestId: randomUUID(), memberId, displayName: "Fence Agent",
    access: "collaborate", keyHash: keyHash(), expiresAt: now + 3600000,
    expectedOwnerRevision: ownerRevision(), ...over
  }, session.session.sessionBinding);
  const rotate = (memberId, over = {}) => store.agentConnections.apply(session.token, "commons", {
    action: "rotate", requestId: randomUUID(), memberId,
    expectedOwnerRevision: ownerRevision(), expectedGeneration: 1,
    expectedMemberRevision: memberRevision(memberId),
    keyHash: keyHash(), expiresAt: now + 3600000, ...over
  }, session.session.sessionBinding);
  const disconnect = (memberId, over = {}) => store.agentConnections.apply(session.token, "commons", {
    action: "disconnect", requestId: randomUUID(), memberId,
    expectedOwnerRevision: ownerRevision(), expectedGeneration: 1,
    expectedMemberRevision: memberRevision(memberId), ...over
  }, session.session.sessionBinding);
  const refused = (fn, status, code) => {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    assert.ok(error, `expected refusal ${status}/${code}, but the call succeeded`);
    assert.equal(error.status, status, `expected status ${status}, got ${error.status} (${error.code})`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
  };
  return { store, ownerKey, session, now, keyHash, ownerRevision, memberRevision, create, rotate, disconnect, refused };
}

// ------------------------------------------------------------- A-05 ---

test("A-05: a sponsor key expiring exactly at the 30-day cap is accepted", t => {
  const f = fixture(t);
  const { receipt } = f.create("agent-cap-exact", { expiresAt: f.now + CAP_MS });
  assert.equal(receipt.expiresAt, f.now + CAP_MS);
  assert.equal(receipt.status, "issued");
});

test("A-05: a sponsor key expiring one millisecond past the 30-day cap is refused", t => {
  const f = fixture(t);
  // Kills A-05: under the 300-day mutant this create succeeds.
  f.refused(() => f.create("agent-cap-over", { expiresAt: f.now + CAP_MS + 1 }), 422, "invalid_expiry");
  assert.equal(f.store.agentConnections.row("commons", "agent-cap-over"), undefined);
});

test("A-05: a sponsor key expiring 31 days out is refused; one already expired is refused", t => {
  const f = fixture(t);
  f.refused(() => f.create("agent-cap-31d", { expiresAt: f.now + 31 * 86400000 }), 422, "invalid_expiry");
  f.refused(() => f.create("agent-cap-past", { expiresAt: f.now }), 422, "invalid_expiry");
});

// ------------------------------------------------------------- A-06 ---

test("A-06: rotate with the exact generation succeeds (positive control)", t => {
  const f = fixture(t);
  f.create("agent-gen-ok");
  const { receipt } = f.rotate("agent-gen-ok", { expectedGeneration: 1 });
  assert.equal(receipt.generation, 2);
});

test("A-06: rotate with expected generation one BELOW actual is refused 409", t => {
  const f = fixture(t);
  f.create("agent-gen-below");
  f.rotate("agent-gen-below", { expectedGeneration: 1 }); // generation now 2
  f.refused(() => f.rotate("agent-gen-below", { expectedGeneration: 1 }), 409, "connection_changed");
});

test("A-06: rotate with expected generation one ABOVE actual is refused 409", t => {
  const f = fixture(t);
  f.create("agent-gen-above");
  f.rotate("agent-gen-above", { expectedGeneration: 1 }); // generation now 2
  // Kills A-06: under !== -> > the fence sees 2 > 3 as false and rotates.
  f.refused(() => f.rotate("agent-gen-above", { expectedGeneration: 3 }), 409, "connection_changed");
  assert.equal(f.store.agentConnections.row("commons", "agent-gen-above").generation, 2);
});

test("A-06: disconnect with expected generation one ABOVE actual is refused 409", t => {
  const f = fixture(t);
  f.create("agent-gen-disc");
  // Kills A-06 on the disconnect path: under the mutant this disconnects.
  f.refused(() => f.disconnect("agent-gen-disc", { expectedGeneration: 2 }), 409, "connection_changed");
  assert.equal(f.store.agentConnections.row("commons", "agent-gen-disc").status, "issued");
});

// ------------------------------------------------------------- A-07 ---

test("A-07: replaying a requestId with different settings is refused 409 idempotency_conflict", t => {
  const f = fixture(t);
  const requestId = randomUUID();
  f.create("agent-idem", { requestId });
  // Kills A-07: with the fingerprint check vacuous, the replay returns
  // the original receipt instead of refusing.
  f.refused(() => f.create("agent-idem", { requestId, displayName: "Different Name" }), 409, "idempotency_conflict");
  f.refused(() => f.create("agent-idem", { requestId, access: "review" }), 409, "idempotency_conflict");
});

test("A-07: replaying a requestId with identical settings returns the original receipt", t => {
  const f = fixture(t);
  const requestId = randomUUID(), hash = f.keyHash();
  const first = f.create("agent-idem-same", { requestId, keyHash: hash });
  const replay = f.create("agent-idem-same", { requestId, keyHash: hash });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(f.store.agentConnections.row("commons", "agent-idem-same").generation, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connection_operations WHERE member_id='agent-idem-same'").get().n, 1);
});

// ------------------------------------------------------------- A-08 ---

test("A-08: create with the exact owner revision is accepted (positive control)", t => {
  const f = fixture(t);
  const { receipt } = f.create("agent-rev-exact");
  assert.equal(receipt.status, "issued");
});

test("A-08: create with a FUTURE expected owner revision is refused 409 stale_member_revision", t => {
  const f = fixture(t);
  // Kills A-08: under !== -> < the fence sees 1 < 0 as false and creates.
  f.refused(() => f.create("agent-rev-future", { expectedOwnerRevision: f.ownerRevision() + 1 }), 409, "stale_member_revision");
  assert.equal(f.store.agentConnections.row("commons", "agent-rev-future"), undefined);
});

test("A-08: create with a STALE expected owner revision is refused 409 stale_member_revision", t => {
  const f = fixture(t);
  const owner = f.store.room("commons").state.members.owner;
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: owner.revision, active: true, permissions: owner.permissions } });
  assert.equal(f.ownerRevision(), owner.revision + 1, "fixture: the owner's revision advanced");
  f.refused(() => f.create("agent-rev-stale", { expectedOwnerRevision: owner.revision }), 409, "stale_member_revision");
});

// ---------------------------------------------------------- CAL-M14 ---

test("CAL-M14: the honest three-operation history verifies (positive control)", t => {
  const f = fixture(t);
  f.create("agent-hist-ok");
  f.rotate("agent-hist-ok", { expectedGeneration: 1 });
  f.rotate("agent-hist-ok", { expectedGeneration: 2 });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("CAL-M14: a history with a renumbered operation (generations 1, 2, 4) is refused by verifyHistory", t => {
  const f = fixture(t);
  f.create("agent-hist-gap");
  f.rotate("agent-hist-gap", { expectedGeneration: 1 });
  f.rotate("agent-hist-gap", { expectedGeneration: 2 });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  // Forge: renumber the generation-3 operation to generation 4 — in the
  // column and in its state/receipt payloads — leaving generations
  // 1, 2, 4: a gap in the continuity the dropped clause guards. The operations table is
  // trigger-guarded against updates; drop its guard for the probe and
  // recreate it byte-identically (verifyHistory compares the guard SQL).
  const db = f.store.db;
  const triggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_connection_operations_no_update'").get().sql;
  db.exec("DROP TRIGGER agent_connection_operations_no_update");
  try {
    const row = db.prepare("SELECT rowid, state_json, receipt_json FROM agent_connection_operations WHERE room_id='commons' AND member_id='agent-hist-gap' AND generation=3").get();
    const state = JSON.parse(row.state_json); state.generation = 4;
    const receipt = JSON.parse(row.receipt_json); receipt.generation = 4;
    db.prepare("UPDATE agent_connection_operations SET generation=4, state_json=?, receipt_json=? WHERE rowid=?")
      .run(JSON.stringify(state), JSON.stringify(receipt), row.rowid);
  } finally {
    db.exec(triggerSql);
  }
  f.refused(() => f.store.agentConnections.verify(), 503, "connection_integrity_error");
});

// ----------------------------------------------------------- IV-03 ---

test("IV-03: the honest two-operation history verifies (positive control)", t => {
  const f = fixture(t);
  f.create("agent-fp-ok");
  f.rotate("agent-fp-ok", { expectedGeneration: 1 });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("IV-03: an operation whose stored fingerprint no longer matches its request is refused by verifyHistory", t => {
  const f = fixture(t);
  f.create("agent-fp-forged");
  f.rotate("agent-fp-forged", { expectedGeneration: 1 });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  // Forge: rewrite ONLY the fingerprint column of the generation-2
  // operation, leaving request_json untouched. The request still
  // replays to itself, so the fingerprint comparison is the one leg of
  // verifyHistory that can catch this — LAB-MUTATION IV-03 dropped
  // exactly that comparison and every agent-connections suite stayed
  // green (the binding leg is pinned; the fingerprint leg was not).
  // Trigger drop/recreate follows the CAL-M14 seam above.
  const db = f.store.db;
  const triggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_connection_operations_no_update'").get().sql;
  db.exec("DROP TRIGGER agent_connection_operations_no_update");
  try {
    db.prepare("UPDATE agent_connection_operations SET fingerprint=? WHERE room_id='commons' AND member_id='agent-fp-forged' AND generation=2")
      .run(createHash("sha256").update("a request body that was never journaled").digest("hex"));
  } finally {
    db.exec(triggerSql);
  }
  f.refused(() => f.store.agentConnections.verify(), 503, "connection_integrity_error");
});
