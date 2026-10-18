// Regression: account deletion purges the sponsor's member_accounts row and
// keeps the account as a deactivated tombstone. verifyHistory demanded a
// current binding, so one deleted sponsor made integrity fail on every tick
// (agent_connections / connection_integrity_error).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";

function connectedAndTransferred(t) {
  const now = Date.now(), store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom()); t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner"), s = store.createSession(ownerKey);
  store.agentConnections.apply(s.token, "commons", { action: "create", requestId: randomUUID(), memberId: "agent-one",
    displayName: "Agent One", access: "collaborate", expectedOwnerRevision: 0, expiresAt: now + 3600000,
    keyHash: createHash("sha256").update(randomBytes(32)).digest("hex") }, s.session.sessionBinding);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "human-two", displayName: "human-two", kind: "human", permissions: ["manage_members"] } });
  store.createAccount("acct-two"); store.bindHumanAccount("commons", "human-two", "acct-two");
  new AgentRooms(store).transfer(s.token, "commons", { toMemberId: "human-two" }, s.session.sessionBinding);
  const sponsor = store.db.prepare("SELECT sponsor_account_id a FROM agent_connections").get().a;
  assert.doesNotThrow(() => store.agentConnections.verify());
  return { store, sponsor };
}

test("connection history verifies after the sponsor's account is deleted", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  executeAccountDeletion(store, planAccountDeletion(store, sponsor).plan);
  assert.equal(store.db.prepare("SELECT count(*) n FROM member_accounts WHERE account_id=?").get(sponsor).n, 0);
  assert.doesNotThrow(() => store.agentConnections.verify());
});

test("a live sponsor account with its binding removed is still rejected", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a suspended sponsor with its binding removed is still rejected", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  const { revision } = store.db.prepare("SELECT revision FROM accounts WHERE id=?").get(sponsor);
  store.changeAccountAccess(sponsor, { expectedRevision: revision, active: false, reason: "Temporary suspension" });
  assert.doesNotThrow(() => store.agentConnections.verify());
  store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a deletion tombstone without the deletion record is still rejected", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  executeAccountDeletion(store, planAccountDeletion(store, sponsor).plan);
  store.db.prepare("DELETE FROM account_access_events WHERE account_id=? AND reason='account_deleted'").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("an operator suspension cannot claim the reserved deletion reason", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  const { revision } = store.db.prepare("SELECT revision FROM accounts WHERE id=?").get(sponsor);
  for (const reason of ["account_deleted", " Account_Deleted ", "account_deleted (manual)"]) {
    assert.throws(() => store.changeAccountAccess(sponsor, { expectedRevision: revision, active: false, reason }), { code: "reserved_account_reason" });
  }
  assert.equal(store.db.prepare("SELECT active FROM accounts WHERE id=?").get(sponsor).active, 1);
  store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a deletion record that is not the account's current revision is rejected", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  executeAccountDeletion(store, planAccountDeletion(store, sponsor).plan);
  assert.doesNotThrow(() => store.agentConnections.verify());
  store.db.prepare("UPDATE accounts SET revision=revision+1 WHERE id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a sponsor binding moved to another account is still rejected", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  store.createAccount("acct-other");
  store.db.prepare("UPDATE member_accounts SET account_id='acct-other' WHERE account_id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});
