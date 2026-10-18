// Regression: account deletion purges the sponsor's member_accounts row and
// keeps the account as a deactivated tombstone. verifyHistory demanded a
// current binding, so one deleted sponsor made integrity fail on every tick
// (agent_connections / connection_integrity_error).
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";

function connectedAndTransferred(t, file = ":memory:") {
  const now = Date.now(), store = new RoomStore(file, { now: () => now });
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

test("a free-form suspension reason cannot manufacture deletion evidence", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  const { revision } = store.db.prepare("SELECT revision FROM accounts WHERE id=?").get(sponsor);
  assert.throws(() => store.changeAccountAccess(sponsor, { expectedRevision: revision, active: false, reason: "account_deleted" }), { code: "reserved_account_reason" });
  assert.equal(store.account(sponsor).active, true);
  store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(sponsor);
  assert.throws(() => store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a rolled-back deletion leaves no completion evidence", t => {
  const { store, sponsor } = connectedAndTransferred(t);
  assert.throws(() => store.transaction(() => {
    executeAccountDeletion(store, planAccountDeletion(store, sponsor).plan);
    throw new Error("abort deletion");
  }), /abort deletion/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM account_access_events WHERE account_id=? AND reason='account_deleted'").get(sponsor).n, 0);
  assert.equal(store.account(sponsor).active, true);
  assert.doesNotThrow(() => store.agentConnections.verify());
});

test("completed deletion evidence survives an eager file reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "sponsor-v2-reopen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "room.sqlite"), { store, sponsor } = connectedAndTransferred(t, file);
  executeAccountDeletion(store, planAccountDeletion(store, sponsor).plan);
  store.close();
  const reopened = new RoomStore(file);
  t.after(() => reopened.close());
  assert.doesNotThrow(() => reopened.agentConnections.verify());
});
