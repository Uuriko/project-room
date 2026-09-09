import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { replayInvitationJournal } from "../server/invitation-journal.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-journal-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-target");
  const login = id => {
    const access = store.issueAccountAccessKey(id), slot = store.createAccountSessionSlot();
    return { token: slot.token, session: store.loginAccountSession(slot.token, access, 0) };
  };
  const owner = login("account-owner"), target = login("account-target");
  const token = randomBytes(32).toString("base64url");
  const issued = store.issueInvitation(owner.token, "commons", {
    requestId: "offer", token, intendedAccountId: "account-target", intendedMemberId: "target", displayName: "Target",
    role: "member", expiresAt: Date.now() + 3600000, expectedIssuerMemberRevision: 0, expectedSessionBinding: owner.session.sessionBinding
  });
  const id = issued.invitation.id;
  return {
    get store() { return store; }, filename, owner, target, token, id,
    rows: () => store.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(id),
    record: () => store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(id),
    accept: () => store.acceptInvitation(target.token, token, { redemptionId: "b6bdc104-080f-4373-9c75-704c8fe4f002", expectedRevision: 0, expectedSessionBinding: target.session.sessionBinding }),
    revoke: () => store.revokeInvitation(owner.token, id, { expectedRevision: 0, reason: "Offer withdrawn", expectedSessionBinding: owner.session.sessionBinding }),
    close: () => { store.close(); store = null; },
    reopen: () => { store = new RoomStore(filename); return store; }
  };
}

test("private journal independently reconstructs issuance and acceptance without exposing its scope in Room history", t => {
  const f = fixture(t);
  assert.equal(replayInvitationJournal(f.rows()).record.status, "pending");
  assert.equal(f.store.room("commons").sequence, 2, "issuance is not shared conversation activity");
  f.accept();
  const replayed = replayInvitationJournal(f.rows());
  assert.deepEqual(replayed.record, { ...f.record() });
  assert.equal(replayed.legacyBaseline, false);
  assert.deepEqual(f.store.verifyInvitationAudit(), { consistent: true, invitations: 1, legacyBaselines: 0, journalEntries: 2 });
  const before = JSON.stringify(f.rows());
  assert.equal(f.accept().duplicate, true);
  assert.equal(JSON.stringify(f.rows()), before, "receipt replay adds no journal entry");
  const snapshot = f.store.snapshot(f.target.token, "commons");
  assert.equal(JSON.stringify(snapshot.state).includes("account-target"), false, "private target account is not copied into Room state");
  assert.equal(JSON.stringify(snapshot).includes(f.record().token_hash), false);
  f.close();
  assert.equal(f.reopen().verifyInvitationAudit().journalEntries, 2);
});

test("revocation is reconstructed and journal storage failure leaves the offer pending", t => {
  const f = fixture(t);
  assert.throws(() => f.store.revokeInvitation(f.owner.token, f.id, {
    expectedRevision: 0, reason: "Offer withdrawn", expectedSessionBinding: f.owner.session.sessionBinding, expectedRoomId: "another-room"
  }), { code: "invitation_not_found" });
  assert.equal(f.record().status, "pending", "the explicitly requested Room must match the offer before revocation");
  const append = f.store.appendInvitationJournal;
  f.store.appendInvitationJournal = () => { throw new Error("Simulated journal disk failure"); };
  assert.throws(f.revoke, /disk failure/);
  f.store.appendInvitationJournal = append;
  assert.equal(f.record().status, "pending");
  assert.equal(f.rows().length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(f.id).n, 1);
  f.revoke();
  assert.deepEqual(replayInvitationJournal(f.rows()).record, { ...f.record() });
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
});

test("acceptance journal failure rolls back membership, binding, event, and offer together", t => {
  const f = fixture(t), sequence = f.store.room("commons").sequence;
  const append = f.store.appendInvitationJournal;
  f.store.appendInvitationJournal = () => { throw new Error("Simulated journal disk failure"); };
  assert.throws(f.accept, /disk failure/);
  f.store.appendInvitationJournal = append;
  assert.equal(f.record().status, "pending");
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.equal(f.store.accountForMember("commons", "target"), null);
  assert.equal(f.store.verifyInvitationAudit().journalEntries, 1);
});

test("journal replay rejects incomplete or inconsistent records and append-only storage rejects edits", t => {
  const f = fixture(t);
  f.accept();
  const rows = f.rows();
  assert.throws(() => replayInvitationJournal(rows.slice(1)), /consistency/);
  const changed = structuredClone(rows);
  changed[1].checksum = "0".repeat(64);
  assert.throws(() => replayInvitationJournal(changed), /consistency/);
  assert.throws(() => f.store.db.prepare("UPDATE membership_invitation_journal SET checksum=? WHERE invitation_id=?").run("0".repeat(64), f.id), /append-only/);
  assert.throws(() => f.store.db.prepare("DELETE FROM membership_invitation_journal WHERE invitation_id=?").run(f.id), /append-only/);
});

for (const status of ["pending", "accepted", "revoked"]) test(`v4 ${status} migration preserves authority bytes and honestly marks its baseline`, t => {
  const f = fixture(t);
  if (status === "accepted") f.accept();
  if (status === "revoked") f.revoke();
  const record = { ...f.record() };
  const audits = f.store.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(f.id).map(row => ({ ...row }));
  const events = f.store.db.prepare("SELECT * FROM events ORDER BY room_id,sequence").all().map(row => ({ ...row }));
  // All pre-journal tables remain exactly the schema-v4 representation.
  f.store.db.exec("DROP TABLE private_email_folders; DROP TABLE private_email_commands; DROP TABLE private_email_connections; DROP TABLE private_inbox_drafts; DROP TABLE private_inbox_versions; DROP TABLE private_inbox_sources; DROP TABLE private_inbox_commands; DROP TABLE agent_connection_operations; DROP TABLE agent_connections; DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; PRAGMA user_version=4");
  f.close();
  const migrated = f.reopen();
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 19);
  assert.deepEqual({ ...f.record() }, record);
  assert.deepEqual(migrated.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(f.id).map(row => ({ ...row })), audits);
  assert.deepEqual(migrated.db.prepare("SELECT * FROM events ORDER BY room_id,sequence").all().map(row => ({ ...row })), events);
  assert.equal(JSON.parse(f.rows()[0].body).kind, "legacy-v4-baseline");
  assert.deepEqual(migrated.verifyInvitationAudit(), { consistent: true, invitations: 1, legacyBaselines: 1, journalEntries: 1 });
  if (status === "pending") {
    f.accept();
    assert.equal(replayInvitationJournal(f.rows()).legacyBaseline, true, "later acceptance does not erase baseline provenance");
    assert.equal(migrated.verifyInvitationAudit().journalEntries, 2);
  }
});

test("failed v4 journal migration leaves the version and existing tables untouched", t => {
  const f = fixture(t), record = { ...f.record() };
  f.store.db.exec("DROP TABLE private_email_folders; DROP TABLE private_email_commands; DROP TABLE private_email_connections; DROP TABLE private_inbox_drafts; DROP TABLE private_inbox_versions; DROP TABLE private_inbox_sources; DROP TABLE private_inbox_commands; DROP TABLE agent_connection_operations; DROP TABLE agent_connections; DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; PRAGMA user_version=4");
  f.close();
  const append = RoomStore.prototype.appendInvitationJournal;
  RoomStore.prototype.appendInvitationJournal = function (...args) {
    append.apply(this, args);
    throw new Error("Simulated failure after baseline insertion");
  };
  try { assert.throws(f.reopen, /after baseline insertion/); }
  finally { RoomStore.prototype.appendInvitationJournal = append; }
  const raw = new DatabaseSync(f.filename, { readOnly: true });
  try {
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 4);
    assert.deepEqual({ ...raw.prepare("SELECT * FROM membership_invitations").get() }, record);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='membership_invitation_journal'").get(), undefined);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='membership_invitation_journal_no_update'").get(), undefined);
  } finally { raw.close(); }
});

test("read-only operator audit prints only counts and performs no database mutation", t => {
  const f = fixture(t);
  f.accept();
  const before = JSON.stringify(f.rows());
  const script = fileURLToPath(new URL("../scripts/audit-invitations.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--db", f.filename], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), { consistent: true, invitations: 1, legacyBaselines: 0, journalEntries: 2, completeJournalHistory: true });
  assert.equal(run.stdout.includes(f.token), false);
  assert.equal(run.stdout.includes("account-target"), false);
  assert.equal(JSON.stringify(f.rows()), before);
});

test("damaged invited-member projection fails closed during access and startup; a consistent backup remains auditable", t => {
  const f = fixture(t);
  f.accept();
  f.close();
  // Copy only after the sole writer has closed and checkpointed its WAL.
  const restoredPath = join(f.filename, "..", "restored.sqlite");
  copyFileSync(f.filename, restoredPath);
  f.reopen();
  const damaged = f.store.room("commons").state;
  delete damaged.members.target.membershipOrigin;
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(damaged));
  assert.throws(() => f.store.snapshot(f.target.token, "commons"), { code: "invitation_integrity_error" });
  f.close();
  assert.throws(f.reopen, { code: "invitation_integrity_error" });
  const restored = new RoomStore(restoredPath, { readOnly: true });
  try { assert.deepEqual(restored.verifyInvitationAudit(), { consistent: true, invitations: 1, legacyBaselines: 0, journalEntries: 2 }); }
  finally { restored.close(); }
});

test("read-only audit refuses a v4 input without migrating or creating a journal", t => {
  const f = fixture(t);
  f.store.db.exec("DROP TABLE private_email_folders; DROP TABLE private_email_commands; DROP TABLE private_email_connections; DROP TABLE private_inbox_drafts; DROP TABLE private_inbox_versions; DROP TABLE private_inbox_sources; DROP TABLE private_inbox_commands; DROP TABLE agent_connection_operations; DROP TABLE agent_connections; DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; PRAGMA user_version=4");
  f.close();
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /requires schema v19/);
  const raw = new DatabaseSync(f.filename, { readOnly: true });
  try {
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 4);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='membership_invitation_journal'").get(), undefined);
  } finally { raw.close(); }
});
