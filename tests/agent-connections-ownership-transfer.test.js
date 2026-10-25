// Regression: verifyHistory demanded that every historical operation's
// sponsor still be the room's CURRENT owner, so a supported ownership
// transfer (server/agent-rooms.mjs) made the connection journal fail
// integrity forever (connection_integrity_error on every integrity tick),
// even though the journal is exactly what apply() wrote and the sponsor
// WAS the owner when they acted. The check now scopes sponsorship to the
// operation's own time, using the room's ownership.transferred history —
// the same tolerance verify already extends to sponsor revisions and
// account epochs, which also only move forward.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";

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

test("connection history verifies after the room is transferred to another human", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  assert.equal(f.store.room("commons").state.room.ownerId, "human-two");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("connection history verifies after the room is transferred to the connected agent", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "agent-one" }, f.session.session.sessionBinding);
  assert.equal(f.store.room("commons").state.room.ownerId, "agent-one");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("operations by the new owner after a transfer verify alongside the original sponsor's", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  const two = f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  // The new owner rotates the connection: this operation's sponsor is the
  // new owner, the create's sponsor was the previous owner. Both are
  // legitimate at their own times and the journal must verify whole.
  const member = f.store.room("commons").state.members["agent-one"];
  const sponsorRevision = f.store.room("commons").state.members["human-two"].revision;
  f.store.agentConnections.apply(two.token, "commons", {
    action: "rotate", requestId: randomUUID(), memberId: "agent-one",
    expectedOwnerRevision: sponsorRevision, expectedGeneration: 1, expectedMemberRevision: member.revision,
    keyHash: f.secret().keyHash, expiresAt: Date.now() + 7200000
  }, two.session.sessionBinding);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("a sponsor who was never the room owner is still rejected", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  f.addHuman("human-two", "human-two-acct");
  // Forge the journal: name a member who has never owned the room as the
  // sponsor, in the operations history and in the connection row (the row
  // must still match the last operation's state, so forge both, keeping
  // every other check — fingerprints, receipts, credentials — intact).
  // The operations table is trigger-guarded against updates; drop its
  // guard for the probe and recreate it byte-identically so the only
  // failing condition left is the forged sponsor itself.
  const db = f.store.db;
  const triggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_connection_operations_no_update'").get().sql;
  db.exec("DROP TRIGGER agent_connection_operations_no_update");
  try {
    for (const row of db.prepare("SELECT rowid, state_json FROM agent_connection_operations").all()) {
      const state = JSON.parse(row.state_json);
      state.sponsor_member_id = "human-two";
      db.prepare("UPDATE agent_connection_operations SET state_json=? WHERE rowid=?").run(JSON.stringify(state), row.rowid);
    }
    db.prepare("UPDATE agent_connections SET sponsor_member_id=?").run("human-two");
  } finally {
    db.exec(triggerSql);
  }
  assert.throws(() => f.store.agentConnections.verify(), { code: "connection_integrity_error" });
});
