// agent-connections-fingerprint-pin.test.mjs — pin for mutation catalogue
// IV-03 (verifyHistory request-fingerprint clause), filed by LAB wave
// Phase 2 lane E1 (mutation rig revival, 2026-10-30) in its lane package;
// NOT landed — the coordinator charters critic + PR assembly from the
// E1 report.
//
// PLACEMENT (when landed): tests/agent-connections-fingerprint-pin.test.mjs
// in Uuriko/project-room (companion to tests/agent-connections-fences.test.js,
// whose fixture shape this file follows).
//
// THE HOLE (proven, E1 at lab pin 63534b92): mutation IV-03 drops the
// clause `hash(operation.request_json) !== operation.fingerprint` from
// verifyHistory in server/agent-connections.mjs. The mutant SURVIVED the
// full integrity-verify-history target suites (32/32 green) in the
// 2026-10-19 baseline run and again in E1's 2026-10-30 rig run. It is a
// REAL hole, not an equivalent mutant — E1 probe evidence: a journal
// whose ONLY corruption is the fingerprint column is REFUSED by the
// pristine verifyHistory and ACCEPTED by the IV-03 mutant; no other
// clause in verifyHistory reads the fingerprint. Without this pin, a
// stored operation's fingerprint can be rewritten (or a request body
// swapped for a re-hashed one at apply time) with the journal's tamper
// evidence silently intact-looking.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const keyHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
  const ownerRevision = () => store.room("commons").state.members.owner.revision;
  const create = (memberId) => store.agentConnections.apply(session.token, "commons", {
    action: "create", requestId: randomUUID(), memberId, displayName: "Fingerprint Agent",
    access: "collaborate", keyHash: keyHash(), expiresAt: now + 3600000,
    expectedOwnerRevision: ownerRevision(),
  }, session.session.sessionBinding);
  return { store, create };
}

// The operations table is trigger-guarded against updates; drop its guard
// for the forge and recreate it byte-identically (verifyHistory compares
// the guard SQL), exactly as the CAL-M14 pin in the fences suite does.
function forgeFingerprint(store, memberId) {
  const db = store.db;
  const triggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_connection_operations_no_update'").get().sql;
  db.exec("DROP TRIGGER agent_connection_operations_no_update");
  try {
    db.prepare("UPDATE agent_connection_operations SET fingerprint=? WHERE room_id='commons' AND member_id=?")
      .run(createHash("sha256").update("forged").digest("hex"), memberId);
  } finally {
    db.exec(triggerSql);
  }
}

test("IV-03 control: the honest history verifies", (t) => {
  const f = fixture(t);
  f.create("agent-fp-ok");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("IV-03: a journal whose only corruption is the fingerprint column is refused", (t) => {
  const f = fixture(t);
  f.create("agent-fp-forged");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  forgeFingerprint(f.store, "agent-fp-forged");
  let error = null;
  try { f.store.agentConnections.verify(); } catch (caught) { error = caught; }
  assert.ok(error, "expected verify() to refuse a fingerprint-forged journal, but it accepted");
  assert.equal(error.status, 503);
  assert.equal(error.code, "connection_integrity_error");
});
