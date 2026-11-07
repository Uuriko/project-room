// HUNT-COVERAGE (2026-10-18) — pin for connection-history integrity
// (server/agent-connections.mjs verifyHistory), scoped by experiment.
//
// What the hunt established (all runs on main @ 3fc3a1458):
//  - Removing verifyHistory's generation-continuity clause
//    (operation.generation !== index + 1) is caught by NO existing test
//    (61 tests across the agent-connections + integrity suites, plus
//    the incident evals, all green under the mutation).
//  - The renumber forgery below — one operation's generation rewritten
//    in its row and payloads, the connection row left as written — is
//    refused today, by the last-operation-state/connection-row equality
//    check, with or without the continuity clause. The clause is
//    defence-in-depth for this class, and this test pins the BEHAVIOUR
//    (a renumbered journal is refused) so a future simplification that
//    removes both guards at once goes red.
//  - A complete journal rewrite (delete an operation, renumber the
//    survivors, recompute the request fingerprints — the fingerprint
//    is an unkeyed hash — and update the connection row) verifies on
//    UNMUTATED code: the journal's integrity is self-referential, with
//    no external anchor. That is a threat-model fact about the surface,
//    recorded in the hunt deliverable, not something a unit test fixes.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";

// Fixture mirrors tests/agent-connections-ownership-transfer.test.js.
function fixture(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const rooms = new AgentRooms(store);
  const secret = () => { const token = randomBytes(32).toString("base64url"); return { token, keyHash: createHash("sha256").update(token).digest("hex") }; };
  const create = (token, binding, expectedOwnerRevision) => store.agentConnections.apply(token, "commons", {
    action: "create", requestId: randomUUID(), memberId: "agent-one", displayName: "Agent One",
    access: "collaborate", keyHash: secret().keyHash, expiresAt: now + 3600000, expectedOwnerRevision
  }, binding);
  const addHuman = (memberId, accountId) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: ["manage_members"] } });
    store.createAccount(accountId);
    store.bindHumanAccount("commons", memberId, accountId);
    const key = store.issueAccessKey("commons", memberId);
    return store.createSession(key);
  };
  return { store, ownerKey, session, rooms, secret, create, addHuman };
}

test("a renumbered operation is refused: the journal's generations are 1, 2, ... with no gaps", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  const two = f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  const member = f.store.room("commons").state.members["agent-one"];
  const sponsorRevision = f.store.room("commons").state.members["human-two"].revision;
  f.store.agentConnections.apply(two.token, "commons", {
    action: "rotate", requestId: randomUUID(), memberId: "agent-one",
    expectedOwnerRevision: sponsorRevision, expectedGeneration: 1, expectedMemberRevision: member.revision,
    keyHash: f.secret().keyHash, expiresAt: Date.now() + 7200000
  }, two.session.sessionBinding);
  assert.doesNotThrow(() => f.store.agentConnections.verify(), "the honest two-operation journal verifies");

  // Forge: renumber the generation-2 operation to generation 3 — in the
  // row and in its state/receipt payloads. The operations table is
  // trigger-guarded against updates; drop its guard for the probe and
  // recreate it byte-identically (verifyHistory compares the guard SQL).
  const db = f.store.db;
  const triggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_connection_operations_no_update'").get().sql;
  db.exec("DROP TRIGGER agent_connection_operations_no_update");
  try {
    const row = db.prepare("SELECT rowid, state_json, receipt_json FROM agent_connection_operations WHERE generation=2").get();
    const state = JSON.parse(row.state_json); state.generation = 3;
    const receipt = JSON.parse(row.receipt_json); receipt.generation = 3;
    db.prepare("UPDATE agent_connection_operations SET generation=3, state_json=?, receipt_json=? WHERE rowid=?")
      .run(JSON.stringify(state), JSON.stringify(receipt), row.rowid);
  } finally {
    db.exec(triggerSql);
  }
  assert.throws(() => f.store.agentConnections.verify(), { code: "connection_integrity_error" },
    "a journal whose generations skip is refused");
});
