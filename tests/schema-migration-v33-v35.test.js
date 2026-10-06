// 33→34→35 migration correctness. agent-upgrade pins v8–v27 and
// invitation-migration-v36 pins 35→36; nothing pins the 33→34 writer-fence
// install + attachment convergence or the 34→35 issuer-nullable rebuild.
// These tests build a representative database at the current schema, seed
// it through the real store paths, downgrade it to the exact v33/v34
// shapes (writer triggers, table DDL, user_version), reopen it so the
// migrator runs forward, and assert data integrity: no lost rows,
// constraints hold, every additive table is present and registered with
// the recovery audit, and the v35 unlock (accountless agent issuers)
// works afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { INVITATION_ROLE_POLICY_VERSION } from "../src/events.js";
import { attachmentSchemaV28 } from "../server/attachment-schema.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { STORE_SCHEMA_VERSION, fenceDefinitions } from "../server/writer-fence.mjs";

// Exact v34 share_links DDL from main @ ea4eef9a~1 (the 34→35 migration's
// "before" shape). Issuer columns are NOT NULL; there is no agent-issuer
// partial index yet. Only difference from the v35 shape is the nullable
// issuer columns plus the CHECK pairing account-null to epoch-null.
const V34_SHARE_LINKS_TABLE = `CREATE TABLE share_links (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id), issuer_account_id TEXT NOT NULL REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL, issuer_auth_epoch INTEGER NOT NULL, issuer_member_revision INTEGER NOT NULL,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), max_joins INTEGER NOT NULL CHECK(max_joins BETWEEN 1 AND 25),
    revoked_at INTEGER, revoked_by_member_id TEXT,
    CHECK((revoked_at IS NULL AND revoked_by_member_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_member_id IS NOT NULL)),
    UNIQUE(room_id,issuer_account_id,request_id)
  )`;
const V34_SHARE_LINKS_INDEXES = [
  `CREATE INDEX share_links_room ON share_links(room_id,created_at)`,
];

// Exact v34 membership_invitations DDL from main @ ea4eef9a~1. Issuer
// columns NOT NULL and the revoked-state CHECK still demands a non-null
// revoked_by_account_id. v35 relaxes the issuer columns; v36 relaxes the
// revoked CHECK (pinned by invitation-migration-v36.test.js).
const V34_INVITATIONS_TABLE = `CREATE TABLE membership_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    intended_account_id TEXT NOT NULL REFERENCES accounts(id),
    intended_member_id TEXT NOT NULL,
    intended_display_name TEXT NOT NULL,
    intended_role TEXT NOT NULL CHECK(intended_role IN ('moderator','member','guest')),
    intended_permissions_json TEXT NOT NULL CHECK(json_valid(intended_permissions_json) AND json_type(intended_permissions_json)='array'),
    role_policy_version INTEGER NOT NULL CHECK(role_policy_version=${INVITATION_ROLE_POLICY_VERSION}),
    issuer_account_id TEXT NOT NULL REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL,
    issuer_account_auth_epoch INTEGER NOT NULL,
    issuer_member_revision INTEGER NOT NULL,
    issue_request_id TEXT NOT NULL,
    issue_fingerprint TEXT NOT NULL CHECK(length(issue_fingerprint)=64),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by_account_id TEXT REFERENCES accounts(id),
    redemption_id TEXT,
    joined_event_id TEXT UNIQUE REFERENCES events(id),
    revoked_at INTEGER,
    revoked_by_account_id TEXT REFERENCES accounts(id),
    revoked_by_member_id TEXT,
    revoke_reason TEXT,
    CHECK(expires_at>created_at),
    CHECK(
      (status='pending' AND revision=0 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='accepted' AND revision=1 AND accepted_at IS NOT NULL AND accepted_by_account_id=intended_account_id AND redemption_id IS NOT NULL AND joined_event_id IS NOT NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='revoked' AND revision=1 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL AND revoked_by_member_id IS NOT NULL AND revoke_reason IS NOT NULL)
    )
  )`;
const V34_INVITATIONS_INDEXES = [
  `CREATE UNIQUE INDEX membership_invitation_issue_request ON membership_invitations(room_id,issuer_account_id,issue_request_id)`,
  `CREATE INDEX membership_invitation_target ON membership_invitations(room_id,intended_account_id,intended_member_id)`,
];

// The deployed v28–v33 attachment lineage: states are staged/discarded/
// expired only and there is no message_id column. The 33→34 migration
// (ensureAttachmentSchema) rebuilds this into the current shape, backfilling
// message_id NULL. attachmentSchemaV28 is the module's frozen reference to
// that lineage.
const V28_ATTACHMENTS_TABLE = attachmentSchemaV28.split(";")[0];
const V28_ATTACHMENTS_INDEXES = [attachmentSchemaV28.split(";")[1].trim()];
assert.ok(!V28_ATTACHMENTS_TABLE.includes("message_id"), "the v28 attachment fixture must predate message_id");
assert.ok(V28_ATTACHMENTS_TABLE.includes("'staged','discarded','expired'"), "the v28 attachment fixture keeps the old state set");

const token = () => randomBytes(32).toString("base64url");

function accountSession(store, accountId) {
  const accessKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
  return { token: slot.token, session };
}

function issue(store, ownerToken, sessionBinding, accountId, memberId, requestId, now) {
  return store.issueInvitation(ownerToken, "commons", {
    requestId, token: token(), intendedAccountId: accountId,
    intendedMemberId: memberId, displayName: "Target", role: "member",
    expiresAt: now + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision,
    expectedSessionBinding: sessionBinding
  });
}

// Representative database at the current schema, seeded through the real
// store paths. Every table the 33→35 migrations rewrite carries rows:
// share_links (+ a join row), membership_invitations in pending and revoked
// states (+ events/journal), room_attachments in every v28 state, and a
// fenced agent_invite_codes row.
function seed(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-schema-migration-"));
  const filename = join(directory, "room.sqlite");
  const now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());
  const ownerRoomKey = store.issueAccessKey("commons", "owner");
  const ownerAccountId = store.authenticate(ownerRoomKey).account.id;
  const owner = accountSession(store, ownerAccountId);
  store.createAccount("account-target");
  store.createAccount("account-target-2");

  const linkToken = token();
  const link = store.shareLinks.create(ownerRoomKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 3,
    expectedMemberRevision: store.room("commons").state.members.owner.revision,
  }, null).link;

  const pending = issue(store, owner.token, owner.session.sessionBinding, "account-target", "target-pending", "request-pending", now);
  const revoked = issue(store, owner.token, owner.session.sessionBinding, "account-target-2", "target-revoked", "request-revoked", now);
  store.revokeInvitation(owner.token, revoked.invitation.id, {
    expectedRevision: 0, reason: "no longer needed",
    expectedSessionBinding: owner.session.sessionBinding, expectedRoomId: "commons"
  });

  // A real link redemption: creates the accepted guest invitation and the
  // share_link_joins row the v35 migration's rebuild must preserve.
  const joinSlot = store.createAccountSessionSlot();
  const joinCurrent = store.accountSessionSlot(joinSlot.token);
  store.shareLinks.join(joinSlot.token, linkToken, {
    displayName: "Link Guest", redemptionId: randomUUID(),
    expectedSessionRevision: joinCurrent.sessionRevision, expectedSessionBinding: joinCurrent.sessionBinding,
  });

  // Attachments in every v28 state. Staged and discarded go through the
  // real paths; expired is what expire() would have written.
  const data = Buffer.from("hello room").toString("base64");
  const stageArgs = { filename: "note.txt", mediaType: "text/plain", data };
  store.roomAttachments.stage(ownerRoomKey, "commons", { id: "file-staged", ...stageArgs });
  store.roomAttachments.stage(ownerRoomKey, "commons", { id: "file-doomed", ...stageArgs });
  store.roomAttachments.discard(ownerRoomKey, "commons", "file-doomed");
  store.roomAttachments.stage(ownerRoomKey, "commons", { id: "file-old", ...stageArgs });
  store.db.prepare("UPDATE room_attachments SET state='expired', bytes=NULL WHERE id='file-old'").run();
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM room_attachments WHERE state NOT IN ('staged','discarded','expired')").get().n, 0);

  // agent_invite_codes is fenced in the v33/v34 lineages: a row here proves
  // the fence install does not disturb fenced data.
  store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`).run(createHash("sha256").update("invite-code").digest("hex"),
    "commons", "owner", JSON.stringify(["accept_work"]), "Invited Agent", now, now + 86400000);

  store.close();
  return { directory, filename, now, linkId: link.id, pendingId: pending.invitation.id, revokedId: revoked.invitation.id };
}

// Downgrade a current-schema database to the exact v33 or v34 shape: the
// "before" DDL for every table the 33→35 migrations rewrite, the historical
// writer-trigger set, and the historical user_version. ALTER TABLE RENAME
// would rewrite trigger SQL to the backup name and trip the fence, so each
// table is dropped and rebuilt with its domain triggers recreated verbatim.
function downgradeTo(fixture, version) {
  assert.ok(version === 33 || version === 34, "this lane pins the 33→35 migrations");
  const raw = new DatabaseSync(fixture.filename);
  raw.exec("PRAGMA foreign_keys=OFF");
  // The writer-fence triggers call versioned writer functions; register
  // them on this raw connection so the rebuild below can fire triggers.
  for (let v = 6; v <= STORE_SCHEMA_VERSION; v++) raw.function(`project_room_writer_v${v}`, () => v);

  const rebuild = (name, oldTableDDL, oldIndexDDLs) => {
    const domainTriggers = raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name NOT GLOB 'writer_v*'").all(name).map(r => r.sql);
    raw.exec(`CREATE TABLE ${name}_downgrade_backup AS SELECT * FROM ${name}`);
    raw.exec(`DROP TABLE ${name}`);
    raw.exec(oldTableDDL);
    for (const sql of oldIndexDDLs) raw.exec(sql);
    for (const sql of domainTriggers) raw.exec(sql);
    const columns = raw.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name).join(",");
    raw.exec(`INSERT INTO ${name}(${columns}) SELECT ${columns} FROM ${name}_downgrade_backup`);
    raw.exec(`DROP TABLE ${name}_downgrade_backup`);
  };
  rebuild("share_links", V34_SHARE_LINKS_TABLE, V34_SHARE_LINKS_INDEXES);
  rebuild("membership_invitations", V34_INVITATIONS_TABLE, V34_INVITATIONS_INDEXES);
  if (version === 33) rebuild("room_attachments", V28_ATTACHMENTS_TABLE, V28_ATTACHMENTS_INDEXES);

  // A real v33/v34 database predates the v37 messages table and its replay
  // cursor: drop them so the migration's CREATE TABLE path is exercised
  // rather than no-opped by IF NOT EXISTS. Nothing references them.
  raw.exec("DROP TABLE IF EXISTS messages");
  raw.exec("DROP TABLE IF EXISTS messages_backfill_cursor");

  // A real v33/v34 database carries writer triggers only up to its version;
  // drop everything newer, then install the historical fence set for every
  // table present (mirrors the pre-migration fence check).
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
    if (parseInt(name.split("_")[1].slice(1), 10) > version) raw.exec(`DROP TRIGGER ${name}`);
  }
  const present = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const { name, sql } of fenceDefinitions(version)) {
    const table = name.slice(`writer_v${version}_`.length).replace(/_(insert|update|delete)$/, "");
    if (present.has(table)) raw.exec(sql);
  }
  raw.exec(`PRAGMA user_version=${version}`);

  // The downgrade itself must be lossless: pin the fixture shape before the
  // migrator runs, including the old NOT NULL issuer columns.
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, version);
  assert.equal(raw.prepare("SELECT issuer_account_id FROM share_links WHERE id=?").get(fixture.linkId).issuer_account_id?.length > 0, true);
  const linkNotNull = raw.prepare("PRAGMA table_info(share_links)").all().find(c => c.name === "issuer_account_id").notnull;
  const invNotNull = raw.prepare("PRAGMA table_info(membership_invitations)").all().find(c => c.name === "issuer_account_id").notnull;
  assert.equal(linkNotNull, 1, "v33/v34 share_links.issuer_account_id is NOT NULL");
  assert.equal(invNotNull, 1, "v33/v34 membership_invitations.issuer_account_id is NOT NULL");
  if (version === 33) {
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM pragma_table_info('room_attachments') WHERE name='message_id'").get().n, 0);
  }
  const before = snapshot(raw, false);
  raw.close();
  return before;
}

// Table-name → sorted row digests. room_schema_stamp is excluded: the
// version bump is the migration's purpose and is asserted directly.
// sqlite internal tables carry no user data.
function snapshot(db, stripAttachmentMessageId) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'room_schema_stamp' ORDER BY name").all().map(r => r.name);
  const out = {};
  for (const table of tables) {
    let columns = "*";
    if (stripAttachmentMessageId && table === "room_attachments") {
      columns = db.prepare("PRAGMA table_info(room_attachments)").all().map(c => c.name).filter(n => n !== "message_id").join(",");
    }
    out[table] = db.prepare(`SELECT ${columns} FROM ${table}`).all().map(row => JSON.stringify(row)).sort();
  }
  return out;
}

function columnInfo(db, table) {
  return Object.fromEntries(db.prepare(`PRAGMA table_info(${table})`).all().map(c => [c.name, c]));
}

// The v37 writer fence is installed exactly: every present fenced table
// carries the full insert/update/delete triple with byte-identical SQL.
function assertWriterFenceCurrent(db) {
  const prefix = `writer_v${STORE_SCHEMA_VERSION}_`;
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  let installed = 0;
  for (const { name, sql } of fenceDefinitions(STORE_SCHEMA_VERSION)) {
    const table = name.slice(prefix.length).replace(/_(insert|update|delete)$/, "");
    if (!present.has(table)) continue;
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql, sql, `${name} is installed exactly`);
    installed++;
  }
  assert.ok(installed > 0, "the migration installs v37 writer triggers");
}

// Shared post-migration assertions for a database downgraded to `version`
// and reopened. `before` is the downgraded fixture's row snapshot;
// `stripAttachmentMessageId` normalises the one intended column addition.
function assertMigrated(t, fixture, version, before, stripAttachmentMessageId) {
  const store = new RoomStore(fixture.filename, { now: () => fixture.now });
  t.after(() => { store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const db = store.db;

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION,
    `a v${version} database migrates all the way to v${STORE_SCHEMA_VERSION}`);

  // The migration's promised shape changes, asserted exactly.
  const linkCols = columnInfo(db, "share_links");
  assert.equal(linkCols.issuer_account_id.notnull, 0, "v35 relaxes share_links.issuer_account_id");
  const invCols = columnInfo(db, "membership_invitations");
  assert.equal(invCols.issuer_account_id.notnull, 0, "v35 relaxes membership_invitations.issuer_account_id");
  assert.ok(columnInfo(db, "room_attachments").message_id, "the attachment lineage converges with message_id");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='share_links_agent_request'").get(),
    "the v35 agent-issuer partial index is created");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='membership_invitation_agent_issue_request'").get(),
    "the v35 agent-issuer invitation index is created");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get(),
    "the v37 messages table is created");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_backfill_cursor'").get(),
    "the v37 replay cursor table is created");

  // No migration debris: every legacy table the rebuilds rename away is dropped.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_legacy_v34'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_downgrade_backup'").get().n, 0);
  assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_migration_v28'").get(),
    "the attachment rebuild drops its staging table");

  // No lost rows: every table's rows survive byte-identical, except the one
  // intended column addition (room_attachments.message_id on the v33 path,
  // backfilled NULL by the migration). The migration adds exactly the v37
  // tables (messages + replay cursor, dropped from the fixture above) and
  // drops nothing.
  const after = snapshot(db, stripAttachmentMessageId);
  const beforeTables = Object.keys(before).sort(), afterTables = Object.keys(after).sort();
  assert.deepEqual(afterTables.filter(t => !beforeTables.includes(t)), ["messages", "messages_backfill_cursor"],
    "the migration adds exactly the v37 tables");
  assert.deepEqual(beforeTables.filter(t => !afterTables.includes(t)), [], "the migration drops no tables");
  for (const table of beforeTables) {
    assert.deepEqual(after[table], before[table], `${table}: no lost or rewritten rows`);
  }
  const attachments = db.prepare("SELECT * FROM room_attachments ORDER BY room_id,id").all();
  assert.equal(attachments.length, 3, "all three attachment rows survive");
  for (const row of attachments) assert.equal(row.message_id, null, "the migration backfills message_id NULL, nothing else");
  assert.deepEqual(attachments.map(r => r.state).sort(), ["discarded", "expired", "staged"]);

  // The seeded rows are still the rows, field for field.
  assert.equal(db.prepare("SELECT status FROM membership_invitations WHERE id=?").get(fixture.pendingId).status, "pending");
  assert.equal(db.prepare("SELECT status FROM membership_invitations WHERE id=?").get(fixture.revokedId).status, "revoked");
  assert.equal(db.prepare("SELECT revoke_reason FROM membership_invitations WHERE id=?").get(fixture.revokedId).revoke_reason, "no longer needed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM share_link_joins WHERE link_id=?").get(fixture.linkId).n, 1);
  const joinedInvitationId = db.prepare("SELECT invitation_id FROM share_link_joins WHERE link_id=?").get(fixture.linkId).invitation_id;
  const joined = db.prepare("SELECT status, intended_role FROM membership_invitations WHERE id=?").get(joinedInvitationId);
  assert.equal(joined.status, "accepted");
  assert.equal(joined.intended_role, "guest");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM membership_invitation_journal").get().n,
    before.membership_invitation_journal.length, "the invitation journal is fully preserved");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_invite_codes").get().n, 1);

  // Constraints hold.
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no foreign-key violations");
  assert.equal(store.verifyInvitationAudit().consistent, true, "the invitation audit stays consistent");
  store.shareLinks.verify();

  // The writer fence is exactly the current one.
  assertWriterFenceCurrent(db);

  // Every additive table is present and registered: the recovery audit is
  // the registry gate — it throws on an unregistered or missing table.
  auditRecovery(store);

  // The v35 unlock the migration exists for: an accountless agent room
  // owner can now issue invitations and share links recorded with a NULL
  // issuer account. On the pre-migration shape this insert violates the
  // NOT NULL constraint, so this fails if the rebuild never ran.
  const agentIdentity = store.identities.create("Keeper");
  db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  rooms.create(agentIdentity.secret, {
    roomId: "agent-den", title: "Den", purpose: "migration check", kind: "personal", displayName: "Keeper"
  });
  const memberRevision = store.room("agent-den").state.members[agentIdentity.identityId].revision;
  const agentIssued = store.issueInvitation(agentIdentity.secret, "agent-den", {
    requestId: randomUUID(), token: token(), intendedAccountId: "account-target",
    intendedMemberId: "target-agent", displayName: "Target", role: "member",
    expiresAt: fixture.now + 3600000,
    expectedIssuerMemberRevision: memberRevision, expectedSessionBinding: null
  });
  assert.equal(db.prepare("SELECT issuer_account_id FROM membership_invitations WHERE id=?").get(agentIssued.invitation.id).issuer_account_id, null);
  const agentLink = store.shareLinks.create(agentIdentity.secret, "agent-den", {
    requestId: randomUUID(), linkToken: token(), expiresAt: fixture.now + 3600000, maxJoins: 2,
    expectedMemberRevision: memberRevision,
  }, null).link;
  assert.equal(db.prepare("SELECT issuer_account_id FROM share_links WHERE id=?").get(agentLink.id).issuer_account_id, null);
  assert.equal(store.verifyInvitationAudit().consistent, true);
}

test("a v33 database migrates to the current schema with every row intact", async t => {
  const fixture = seed(t);
  const before = downgradeTo(fixture, 33);
  // stripAttachmentMessageId: the 33→34 attachment convergence is the one
  // intended column addition on this path.
  assertMigrated(t, fixture, 33, before, true);
});

test("a v34 database migrates to the current schema with every row intact", async t => {
  const fixture = seed(t);
  const before = downgradeTo(fixture, 34);
  assertMigrated(t, fixture, 34, before, false);
});
