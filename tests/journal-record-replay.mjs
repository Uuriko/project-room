// Scripted writes against a journal API. The on-disk rows and the JSON
// stored for graph-reply transitions are what the round-trip fixture locks.
// server/journal.mjs supplies `api`; the fixture rows it is checked against
// were captured from the per-kind modules it superseded (now removed).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const NOW = 1_700_000_000_000;
const HASH = "ab".repeat(32);
const TOKEN = "cd".repeat(32);

function openStore(now = NOW) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const store = {
    db,
    now: () => now,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    },
    readTransaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    }
  };
  return store;
}

const plainRow = row => Object.fromEntries(Object.entries(row));
function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const data = {};
  for (const name of tables) data[name] = db.prepare(`SELECT * FROM ${name}`).all().map(plainRow);
  const sequence = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
    ? db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all().map(plainRow) : [];
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(plainRow);
  return { data, sequence, master };
}

const digest = (canonical, value) => createHash("sha256").update(canonical(value)).digest("hex");

function invitationRecord(api, fields, state) {
  const record = {
    id: fields.id, token_hash: TOKEN, room_id: "room1", intended_account_id: "acct-target",
    intended_member_id: "member-target", intended_display_name: fields.displayName, intended_role: "member",
    intended_permissions_json: JSON.stringify(["accept_work", "complete_work", "verify"]),
    role_policy_version: 1, issuer_account_id: "acct-issuer", issuer_member_id: "member-issuer",
    issuer_account_auth_epoch: 2, issuer_member_revision: 0, issue_request_id: fields.requestId,
    issue_fingerprint: HASH, created_at: NOW, expires_at: NOW + 3_600_000,
    revision: 0, status: "pending", accepted_at: null, accepted_by_account_id: null, redemption_id: null,
    joined_event_id: null, revoked_at: null, revoked_by_account_id: null, revoked_by_member_id: null, revoke_reason: null,
    ...state
  };
  const permissions = JSON.parse(record.intended_permissions_json);
  record.issue_fingerprint = digest(api.canonicalInvitationData, {
    roomId: record.room_id, requestId: record.issue_request_id, tokenHash: record.token_hash,
    intendedAccountId: record.intended_account_id, intendedMemberId: record.intended_member_id,
    displayName: record.intended_display_name, role: record.intended_role, permissions,
    expiresAt: record.expires_at, expectedIssuerMemberRevision: record.issuer_member_revision
  });
  return record;
}

function invitationAudit(record, sequence, type, actor, at, roomEventId, reason) {
  return {
    invitation_id: record.id, sequence, type, actor_account_id: actor.accountId, actor_member_id: actor.memberId,
    actor_auth_epoch: actor.epoch, actor_session_revision: actor.session, invitation_revision: sequence - 1,
    at, room_event_id: roomEventId, reason
  };
}

const issuer = { accountId: "acct-issuer", memberId: "member-issuer", epoch: 2, session: 4 };
const target = { accountId: "acct-target", memberId: "member-target", epoch: 5, session: 6 };

function invitationChain(api, record, kind, audits, prior = null) {
  const entry = api.invitationJournalEntry(record, audits, kind, NOW + record.revision, prior);
  return entry;
}

function graphAttempts(api) {
  const plan = { sourceId: "src1", requestId: "req1", mode: "reply", planVersion: HASH, sourceMessageId: "msg-source",
    accountId: "acct1", connection: { provider: "microsoft-graph", mailboxId: "box1" } };
  const attempts = new Map();
  const at = NOW;
  const steps = [];
  const reserve = { action: "reply.reserve", requestId: "req1", sourceId: "src1", mode: "reply", planVersion: HASH };
  let current = api.transitionReplyAttempt(attempts, reserve, { plan, authEpoch: 3, at });
  attempts.set(current.id, current); steps.push(JSON.stringify(current));
  const dispatch = { action: "reply.dispatch", requestId: "req2", sourceId: "src1", attemptId: "req1", expectedRevision: 0 };
  current = api.transitionReplyAttempt(attempts, dispatch, { plan, authEpoch: 3, at: at + 1 });
  attempts.set(current.id, current); steps.push(JSON.stringify(current));
  const created = { action: "reply.created", requestId: "req3", sourceId: "src1", attemptId: "req1", expectedRevision: 1, planVersion: HASH, providerDraftId: "draft-1" };
  current = api.transitionReplyAttempt(attempts, created, { plan, authEpoch: 3, at: at + 2 });
  attempts.set(current.id, current); steps.push(JSON.stringify(current));
  const observed = { action: "reply.observed", requestId: "req4", sourceId: "src1", attemptId: "req1", expectedRevision: 2, observation: null };
  current = api.transitionReplyAttempt(attempts, observed, { plan, authEpoch: 3, at: at + 3 });
  steps.push(JSON.stringify(current));
  const cancelled = new Map();
  const reserved = api.transitionReplyAttempt(cancelled, reserve, { plan, authEpoch: 3, at });
  cancelled.set(reserved.id, reserved);
  const cancel = api.transitionReplyAttempt(cancelled, { action: "reply.cancel", requestId: "req5", sourceId: "src1", attemptId: "req1", expectedRevision: 0 }, { plan, authEpoch: 3, at: at + 4 });
  steps.push(JSON.stringify(cancel));
  return steps;
}

function graphUpdates(api) {
  const proposal = { requestId: "ureq1", sourceId: "src1", attemptId: "req1", attemptRevision: 0, updateVersion: HASH,
    status: "update_proposed", update: { method: "PATCH" } };
  const updates = new Map();
  const reserve = api.transitionReplyUpdate(updates, {
    action: "reply.update.reserve", requestId: "ureq1", sourceId: "src1", attemptId: "req1", expectedRevision: 0, updateVersion: HASH
  }, { proposal, at: NOW });
  updates.set(reserve.id, reserve);
  const dispatched = api.transitionReplyUpdate(updates, {
    action: "reply.update.dispatch", requestId: "ureq2", sourceId: "src1", attemptId: "req1", expectedRevision: 0, updateId: "ureq1"
  }, { proposal, at: NOW + 1 });
  const other = new Map();
  const reserved = api.transitionReplyUpdate(other, {
    action: "reply.update.reserve", requestId: "ureq3", sourceId: "src1", attemptId: "req1", expectedRevision: 0, updateVersion: HASH
  }, { proposal: { ...proposal, requestId: "ureq3" }, at: NOW });
  other.set(reserved.id, reserved);
  const cancelled = api.transitionReplyUpdate(other, {
    action: "reply.update.cancel", requestId: "ureq4", sourceId: "src1", attemptId: "req1", expectedRevision: 0, updateId: "ureq3"
  }, { proposal, at: NOW + 2 });
  return [JSON.stringify(reserve), JSON.stringify(dispatched), JSON.stringify(cancelled)];
}

function runChannel(api) {
  const store = openStore();
  store.db.exec("CREATE TABLE private_email_connections (account_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account_id, id))");
  store.db.exec(api.channelJournalSchema);
  store.db.prepare("INSERT INTO private_email_connections(account_id, id) VALUES(?,?)").run("acct1", "conn1");
  const journal = new api.ChannelUpdateJournal(store);
  const first = { update_id: 7, message: { text: "hi" } };
  const parked = { update_id: 8, message: { text: "nope" } };
  const recorded = journal.record("acct1", "conn1", [first, parked], { backlog: 10, rejected: new Map([[8, "unsupported_telegram_chat"]]) });
  const redelivered = journal.record("acct1", "conn1", [{ update_id: 7, message: { text: "changed" } }, { update_id: 9, message: { text: "third" } }], { backlog: 10 });
  const imported = journal.imported("acct1", "conn1", [9]);
  let failed = null;
  for (let n = 0; n < api.channelJournalLimits.maxAttempts; n++) failed = journal.failed("acct1", "conn1", [7], { code: "boom" });
  return {
    schemaOk: journal.verifySchema(),
    recorded, redelivered, imported, failed,
    pending: journal.pending("acct1", "conn1"),
    summary: journal.summary("acct1", "conn1"),
    verify: journal.verify(),
    snapshot: snapshot(store.db)
  };
}

function runSpam(api) {
  // Review stamps store.now(), which must not precede quarantined_at.
  const store = openStore(NOW + 10);
  store.db.exec(api.spamQuarantineSchema);
  const flag = { score: 80, quarantine: true, signals: [{ key: "urgent", weight: 2, detail: "act now" }] };
  const journal = new api.SpamQuarantineJournal(store);
  const held = journal.quarantine({ messageId: "m1", channel: "telegram", flag, at: NOW });
  const scoped = journal.quarantine({ messageId: "m2", channel: "email", connectionId: "c1", accountId: "acct1", sourceId: "src1", flag, at: NOW + 1 });
  const released = journal.release(held.id, { reviewer: "owner", note: "false positive" });
  const dismissed = journal.review(scoped.id, { decision: "confirm_spam", reviewer: "owner" });
  const plain = journal.quarantine({ messageId: "m3", channel: "sms", flag });
  return {
    schemaOk: journal.verifySchema(),
    held, scoped, released, dismissed, plain,
    counts: journal.counts(),
    listHeld: journal.held(),
    verify: journal.verify(),
    snapshot: snapshot(store.db)
  };
}

function runSpamMigration(api) {
  const store = openStore();
  store.db.exec(`CREATE TABLE spam_quarantine (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT,
    reason TEXT NOT NULL CHECK(json_valid(reason)),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    quarantined_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held','released','dismissed')),
    reviewed_by TEXT, reviewed_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  )`);
  store.db.exec("CREATE INDEX spam_quarantine_held ON spam_quarantine(status, quarantined_at)");
  store.db.prepare("INSERT INTO spam_quarantine (id,message_id,channel,connection_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("qz-1", "old", "email", null, JSON.stringify([{ key: "legacy", weight: 1, detail: "before columns" }]), 10, NOW, "held", null, null, null, NOW);
  api.migrateSpamQuarantineColumns(store.db);
  const journal = new api.SpamQuarantineJournal(store);
  return { schemaOk: journal.verifySchema(), row: journal.get("qz-1"), columns: store.db.prepare("SELECT name FROM pragma_table_info('spam_quarantine')").all().map(row => row.name) };
}

function runJev(api) {
  const store = openStore(NOW + 60_000);
  store.db.exec(api.jevShadowSchema);
  const journal = new api.JevShadowJournal(store);
  const admission = journal.record({ gate: "admission", roomId: "room-1", identityId: "ai_1", ipHash: "h1", path: "join:invite",
    score: 0.5, decision: "review", escalate: false, signals: [{ key: "freshIdentity", weight: 0.5, value: 1, detail: "minted seconds ago" }], at: NOW });
  const receipt = journal.record({ gate: "receipt", roomId: "room-1", identityId: "ai_2", subject: "work-9", path: "work-claim:done",
    score: 0.25, decision: "escalate", escalate: true, signals: [{ key: "evidence", weight: 1, value: 0, detail: "missing diff" }], at: NOW + 1 });
  const older = journal.record({ gate: "admission", roomId: "room-1", identityId: "ai_1", ipHash: "h9", path: "join:invite",
    score: 0.25, decision: "admit", at: NOW - 3_600_000 });
  return {
    schemaOk: journal.verifySchema(),
    admission, receipt, older,
    list: journal.list({ roomId: "room-1", limit: 10 }),
    escalate: journal.list({ roomId: "room-1", escalate: true, limit: 10 }),
    counts: journal.counts({ roomId: "room-1" }),
    recent: journal.recentJoinCount({ identityId: "ai_1", windowMs: 600_000 }),
    verify: journal.verify(),
    snapshot: snapshot(store.db)
  };
}

function runSla(api) {
  const store = openStore();
  store.db.exec(api.slaBreachAlertSchema);
  const journal = new api.SlaBreachAlertJournal(store);
  const record = { threadId: "t1", channel: "email", kind: "reply", elapsedMs: 1000.2, targetMs: 500.4,
    awaitingSince: "2026-01-01T00:00:00.000Z", producedAt: "2026-01-02T00:00:00.000Z", summary: "late",
    deadlineAt: "2026-01-01T00:01:00.000Z" };
  const decision = { decision: "deliver", reason: "urgent" };
  const prefs = { quiet: false, connections: ["c1"] };
  const first = journal.notify({ accountId: "acct1", record, decision, prefsSnapshot: prefs, at: NOW });
  const again = journal.notify({ accountId: "acct1", record, decision, prefsSnapshot: { quiet: true }, at: NOW + 50 });
  const second = journal.notify({ accountId: "acct1", record: { ...record, threadId: "t2", producedAt: "2026-01-03T00:00:00.000Z" }, decision, prefsSnapshot: prefs, at: NOW + 2 });
  return { first, again, second, list: journal.list("acct1"), snapshot: snapshot(store.db) };
}

function runMembership(api) {
  const store = openStore();
  store.db.exec(`CREATE TABLE membership_delegation_grants (
    room_id TEXT NOT NULL, identity_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL,
    revoked_at INTEGER, added_invite_member INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, identity_id)
  )`);
  store.db.prepare("INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,revoked_at) VALUES(?,?,?,?,?)")
    .run("commons", "agent_1", "owner", NOW, null);
  store.db.prepare("INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,revoked_at) VALUES(?,?,?,?,?)")
    .run("commons", "agent_2", "owner", NOW, NOW + 10);
  store.db.exec(api.membershipDelegationJournalSchema);
  const journal = new api.MembershipDelegationJournal(store);
  journal.baseline();
  store.db.prepare("INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,revoked_at) VALUES(?,?,?,?,?)")
    .run("commons", "agent_3", "owner", NOW + 20, null);
  const grant = journal.append("commons", "agent_3", "grant", "owner", NOW + 20, false, true);
  store.db.prepare("UPDATE membership_delegation_grants SET revoked_at=? WHERE identity_id=?").run(NOW + 30, "agent_1");
  const revoke = journal.append("commons", "agent_1", "revoke", "owner", NOW + 30, true, false);
  store.db.prepare("INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,revoked_at) VALUES(?,?,?,?,?)")
    .run("commons", "agent_4", "owner", NOW + 40, null);
  const rolled = journal.reconcileRollback();
  return { grant, revoke, rolled, verify: journal.verify(), snapshot: snapshot(store.db) };
}

function runInvitation(api) {
  const pending = invitationRecord(api, { id: "inv-pending", displayName: "Pending", requestId: "req-pending" });
  const pendingAudits = [invitationAudit(pending, 1, "issued", issuer, pending.created_at, null, null)];
  const pendingEntry = invitationChain(api, pending, "issued", pendingAudits);

  const acceptedBase = invitationRecord(api, { id: "inv-accept", displayName: "Accepted", requestId: "req-accept" });
  const issuedAudits = [invitationAudit(acceptedBase, 1, "issued", issuer, acceptedBase.created_at, null, null)];
  const issuedEntry = invitationChain(api, acceptedBase, "issued", issuedAudits);
  const accepted = invitationRecord(api, { id: "inv-accept", displayName: "Accepted", requestId: "req-accept" }, {
    revision: 1, status: "accepted", accepted_at: NOW + 60_000, accepted_by_account_id: "acct-target",
    redemption_id: "b6bdc104-080f-4373-9c75-704c8fe4f002", joined_event_id: "joined1"
  });
  const acceptedAudits = [...issuedAudits, invitationAudit(accepted, 2, "accepted", target, accepted.accepted_at, "joined1", null)];
  const acceptedEntry = invitationChain(api, accepted, "accepted", acceptedAudits, issuedEntry);

  const revokedBase = invitationRecord(api, { id: "inv-revoke", displayName: "Revoked", requestId: "req-revoke" });
  const revokedIssued = [invitationAudit(revokedBase, 1, "issued", issuer, revokedBase.created_at, null, null)];
  const revokedIssuedEntry = invitationChain(api, revokedBase, "issued", revokedIssued);
  const revoked = invitationRecord(api, { id: "inv-revoke", displayName: "Revoked", requestId: "req-revoke" }, {
    revision: 1, status: "revoked", revoked_at: NOW + 90_000, revoked_by_account_id: "acct-issuer",
    revoked_by_member_id: "member-issuer", revoke_reason: "Offer withdrawn"
  });
  const revokedAudits = [...revokedIssued, invitationAudit(revoked, 2, "revoked", issuer, revoked.revoked_at, null, "Offer withdrawn")];
  const revokedEntry = invitationChain(api, revoked, "revoked", revokedAudits, revokedIssuedEntry);

  const legacyRecord = invitationRecord(api, { id: "inv-legacy", displayName: "Legacy", requestId: "req-legacy" }, {
    revision: 1, status: "accepted", accepted_at: NOW + 30_000, accepted_by_account_id: "acct-target",
    redemption_id: "b6bdc104-080f-4373-9c75-704c8fe4f002", joined_event_id: "joined-legacy"
  });
  const legacyAudits = [invitationAudit(legacyRecord, 1, "issued", issuer, legacyRecord.created_at, null, null),
    invitationAudit(legacyRecord, 2, "accepted", target, legacyRecord.accepted_at, "joined-legacy", null)];
  const legacyEntry = invitationChain(api, legacyRecord, "legacy-v4-baseline", legacyAudits);

  const store = openStore();
  store.db.exec("CREATE TABLE membership_invitations (id TEXT PRIMARY KEY)");
  for (const id of ["inv-pending", "inv-accept", "inv-revoke", "inv-legacy"]) store.db.prepare("INSERT INTO membership_invitations(id) VALUES(?)").run(id);
  store.db.exec(api.invitationJournalSchema);
  const insert = store.db.prepare("INSERT INTO membership_invitation_journal(invitation_id,sequence,body,checksum) VALUES(?,?,?,?)");
  for (const entry of [pendingEntry, issuedEntry, acceptedEntry, revokedIssuedEntry, revokedEntry, legacyEntry])
    insert.run(entry.invitation_id, entry.sequence, entry.body, entry.checksum);
  const rows = id => store.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(id);
  return {
    entries: [pendingEntry, issuedEntry, acceptedEntry, revokedIssuedEntry, revokedEntry, legacyEntry],
    replay: {
      pending: api.replayInvitationJournal(rows("inv-pending")),
      accepted: api.replayInvitationJournal(rows("inv-accept")),
      revoked: api.replayInvitationJournal(rows("inv-revoke")),
      legacy: api.replayInvitationJournal(rows("inv-legacy"))
    },
    snapshot: snapshot(store.db)
  };
}

export function replayJournals(api) {
  return {
    schemas: {
      channel: api.channelJournalSchema,
      spam: api.spamQuarantineSchema,
      jev: api.jevShadowSchema,
      sla: api.slaBreachAlertSchema,
      membership: api.membershipDelegationJournalSchema,
      invitation: api.invitationJournalSchema
    },
    channel: runChannel(api),
    spam: runSpam(api),
    spamMigration: runSpamMigration(api),
    jev: runJev(api),
    sla: runSla(api),
    membership: runMembership(api),
    invitation: runInvitation(api),
    graph: { attempts: graphAttempts(api), updates: graphUpdates(api) }
  };
}

function insertRows(db, table, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`;
  const insert = db.prepare(sql);
  for (const row of rows) insert.run(...columns.map(column => row[column]));
}

// Read a snapshot produced by replayJournals back through `api`, without
// replaying the writes. Channel, spam, Jev, SLA, and invitation rows are
// inserted as stored. Membership grants are inserted after the journal so
// the pending triggers can be cleared back to the captured pending table.
export function readCapturedJournal(api, captured) {
  const channel = openStore();
  channel.db.exec("CREATE TABLE private_email_connections (account_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account_id, id))");
  channel.db.exec(api.channelJournalSchema);
  insertRows(channel.db, "private_email_connections", captured.channel.snapshot.data.private_email_connections);
  insertRows(channel.db, "pending_channel_updates", captured.channel.snapshot.data.pending_channel_updates);
  const channelJournal = new api.ChannelUpdateJournal(channel);
  const spam = openStore();
  spam.db.exec(api.spamQuarantineSchema);
  insertRows(spam.db, "spam_quarantine", captured.spam.snapshot.data.spam_quarantine);
  const spamJournal = new api.SpamQuarantineJournal(spam);
  const jev = openStore(NOW + 60_000);
  jev.db.exec(api.jevShadowSchema);
  insertRows(jev.db, "jev_shadow_decisions", captured.jev.snapshot.data.jev_shadow_decisions);
  const jevJournal = new api.JevShadowJournal(jev);
  const sla = openStore();
  sla.db.exec(api.slaBreachAlertSchema);
  insertRows(sla.db, "sla_breach_alerts", captured.sla.snapshot.data.sla_breach_alerts);
  const slaJournal = new api.SlaBreachAlertJournal(sla);
  const invitation = openStore();
  invitation.db.exec("CREATE TABLE membership_invitations (id TEXT PRIMARY KEY)");
  insertRows(invitation.db, "membership_invitations", captured.invitation.snapshot.data.membership_invitations);
  invitation.db.exec(api.invitationJournalSchema);
  insertRows(invitation.db, "membership_invitation_journal", captured.invitation.snapshot.data.membership_invitation_journal);
  const invitationRows = id => invitation.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(id);
  const membership = openStore();
  membership.db.exec(`CREATE TABLE membership_delegation_grants (
    room_id TEXT NOT NULL, identity_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL,
    revoked_at INTEGER, added_invite_member INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, identity_id)
  )`);
  membership.db.exec(api.membershipDelegationJournalSchema);
  insertRows(membership.db, "membership_delegation_journal", captured.membership.snapshot.data.membership_delegation_journal);
  membership.db.exec("DROP TRIGGER membership_delegation_pending_insert");
  membership.db.exec("DROP TRIGGER membership_delegation_pending_update");
  insertRows(membership.db, "membership_delegation_grants", captured.membership.snapshot.data.membership_delegation_grants);
  membership.db.exec("DELETE FROM membership_delegation_pending");
  insertRows(membership.db, "membership_delegation_pending", captured.membership.snapshot.data.membership_delegation_pending);
  membership.db.exec(api.membershipDelegationJournalSchema);
  const membershipJournal = new api.MembershipDelegationJournal(membership);
  return {
    channel: { verify: channelJournal.verify(), summary: channelJournal.summary("acct1", "conn1"), pending: channelJournal.pending("acct1", "conn1"), schemaOk: channelJournal.verifySchema() },
    spam: { verify: spamJournal.verify(), counts: spamJournal.counts(), held: spamJournal.list({ status: "held" }), released: spamJournal.list({ status: "released" }), schemaOk: spamJournal.verifySchema() },
    jev: { verify: jevJournal.verify(), list: jevJournal.list({ roomId: "room-1", limit: 10 }), counts: jevJournal.counts({ roomId: "room-1" }), recent: jevJournal.recentJoinCount({ identityId: "ai_1", windowMs: 600_000 }), schemaOk: jevJournal.verifySchema() },
    sla: { list: slaJournal.list("acct1"), first: slaJournal.get(captured.sla.first.id) },
    invitation: {
      pending: api.replayInvitationJournal(invitationRows("inv-pending")),
      accepted: api.replayInvitationJournal(invitationRows("inv-accept")),
      revoked: api.replayInvitationJournal(invitationRows("inv-revoke")),
      legacy: api.replayInvitationJournal(invitationRows("inv-legacy"))
    },
    membership: membershipJournal.verify(),
    graph: captured.graph.attempts.map(text => JSON.parse(text)).concat(captured.graph.updates.map(text => JSON.parse(text)))
  };
}
