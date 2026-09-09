import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  applyEvent, emptyRoomState, event, EVENT_TYPES as T, INVITATION_ROLE_POLICIES,
  INVITATION_ROLE_POLICY_VERSION, INVITATION_ROLES,
  MEMBERSHIP_AUTHORITY_POLICY_VERSION, validId
} from "../src/events.js";
import { buildReturnBrief, resolveHistoryWindow, RETURN_BRIEF_DEFAULT_LIMIT } from "./return-brief.mjs";
import { canonicalInvitationData, invitationJournalEntry, invitationJournalSchema, replayInvitationJournal } from "./invitation-journal.mjs";
import { invitationJoinedEvent, assertInvitationMembershipEvidence } from "./invitation-evidence.mjs";
import { STORE_SCHEMA_VERSION, registerWriter, installWriterFence, verifyWriterFence } from "./writer-fence.mjs";
import { ShareLinks, shareLinkSchema } from "./share-links.mjs";
import { conflictingClaim } from "./claim-scopes.mjs";
import { Reminders, reminderSchema } from "./reminders.mjs";
import { selectedWorkContext, currentWorkRecord } from "./work-context.mjs";
import { discussionWindow, selectedWorkDiscussion } from "./work-discussion.mjs";
import { AgentConnections, agentConnectionSchema } from "./agent-connections.mjs";
import { verifyTextCompletion, selectedWorkResult } from "./text-results.mjs";
import { charterContext, charterFromEvent } from "../src/room-charter.js";
import { REPLY_FIELDS, REPLY_POLICY_VERSION, replyPostMode } from "../src/reply-requests.js";
import { ReplyRequests } from "./reply-requests.mjs";
import { validateHelpData } from "../src/work-help.js";
import { auditWorkHelp } from "./work-help.mjs";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, validateHelpOfferData } from "../src/help-offers.js";
import { Inbox, inboxSchema } from "./inbox.mjs";
import { EmailImport, emailImportSchema } from "./email-import.mjs";

export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
const key = () => randomBytes(32).toString("base64url");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
const provisionalAccountPrefix = "acct-legacy-";
const provisionalAccountId = (roomId, memberId) => `${provisionalAccountPrefix}${hash(`${roomId}\0${memberId}`).slice(0, 32)}`;
const accountView = row => row ? { id: row.id, active: Boolean(row.active), revision: row.revision, authEpoch: row.auth_epoch } : null;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const redemptionPattern = /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const invitationStatus = (row, now) => row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
const invitationView = (row, now, { includeScope = false } = {}) => ({
  id: row.id,
  roomId: row.room_id,
  displayName: row.intended_display_name,
  role: row.intended_role,
  expiresAt: row.expires_at,
  revision: row.revision,
  status: invitationStatus(row, now),
  ...(includeScope ? {
    intendedAccountId: row.intended_account_id,
    intendedMemberId: row.intended_member_id,
    permissions: JSON.parse(row.intended_permissions_json),
    invitedByMemberId: row.issuer_member_id
  } : {})
});
const invitationSchema = `
  CREATE TABLE IF NOT EXISTS account_credentials (
    hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    account_auth_epoch INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS account_credential_account ON account_credentials(account_id);
  CREATE TABLE IF NOT EXISTS account_session_slots (
    hash TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    account_id TEXT REFERENCES accounts(id),
    account_auth_epoch INTEGER,
    parent_credential_hash TEXT REFERENCES account_credentials(hash),
    expires_at INTEGER NOT NULL,
    authenticated_until INTEGER,
    created_at INTEGER NOT NULL,
    CHECK(
      (account_id IS NULL AND account_auth_epoch IS NULL AND parent_credential_hash IS NULL AND authenticated_until IS NULL)
      OR
      (account_id IS NOT NULL AND account_auth_epoch IS NOT NULL AND parent_credential_hash IS NOT NULL AND authenticated_until IS NOT NULL AND authenticated_until<=expires_at)
    )
  );
  CREATE INDEX IF NOT EXISTS account_session_slot_account ON account_session_slots(account_id);
  CREATE TABLE IF NOT EXISTS membership_invitations (
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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS membership_invitation_issue_request ON membership_invitations(room_id,issuer_account_id,issue_request_id);
  CREATE INDEX IF NOT EXISTS membership_invitation_target ON membership_invitations(room_id,intended_account_id,intended_member_id);
  CREATE TABLE IF NOT EXISTS membership_invitation_events (
    invitation_id TEXT NOT NULL REFERENCES membership_invitations(id),
    sequence INTEGER NOT NULL CHECK(sequence>0),
    type TEXT NOT NULL CHECK(type IN ('issued','accepted','revoked')),
    actor_account_id TEXT REFERENCES accounts(id),
    actor_member_id TEXT,
    actor_auth_epoch INTEGER,
    actor_session_revision INTEGER,
    invitation_revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    room_event_id TEXT REFERENCES events(id),
    reason TEXT,
    PRIMARY KEY(invitation_id,sequence)
  );
  CREATE TRIGGER IF NOT EXISTS membership_invitation_scope_immutable
    BEFORE UPDATE OF token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,created_at,expires_at
    ON membership_invitations BEGIN SELECT RAISE(ABORT,'invitation scope is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS membership_invitation_events_append_only_update BEFORE UPDATE ON membership_invitation_events BEGIN SELECT RAISE(ABORT,'invitation audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS membership_invitation_events_append_only_delete BEFORE DELETE ON membership_invitation_events BEGIN SELECT RAISE(ABORT,'invitation audit is append-only'); END;
`;
const compact = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
// Platform differences stay at the database boundary; identity, invitation and
// command rules below are shared by every runtime. The default remains Node.
const nodeReadTransactions = new WeakSet();
const nodeStorage = {
  version: db => db.prepare("PRAGMA user_version").get().user_version,
  setVersion: (db, version) => db.exec(`PRAGMA user_version=${version}`),
  hasSchema: db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()),
  configure(db, readOnly) {
    db.exec(readOnly ? "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;"
      : "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
  },
  registerWriter, installWriterFence, verifyWriterFence,
  transaction(db, fn, readOnly) {
    if (db.isTransaction) {
      if (!readOnly && nodeReadTransactions.has(db)) throw new Error("Cannot write inside a read-only transaction");
      return fn();
    }
    const queryOnly = readOnly ? db.prepare("PRAGMA query_only").get().query_only : null;
    db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      if (readOnly) { db.exec("PRAGMA query_only=ON"); nodeReadTransactions.add(db); }
      const result = fn(); db.exec("COMMIT"); return result;
    }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { if (readOnly) { nodeReadTransactions.delete(db); db.exec(`PRAGMA query_only=${queryOnly}`); } }
  }
};
const work = "workItemId expectedRevision";
const shapes = {
  [T.ROOM_CHARTER_UPDATED]: "expectedRevision purpose outputs boundaries escalation",
  [T.MEMBER_ADDED]: "memberId displayName kind permissions accountableHumanId",
  [T.MEMBER_ACCESS_CHANGED]: "memberId expectedMemberRevision permissions active",
  [T.MESSAGE_POSTED]: `messageId body workItemId replyToId toMemberId packetId basisRevision allowOlderBasis ${REPLY_FIELDS.join(" ")}`,
  [T.REPLY_REQUEST_CANCELLED]: "requestMessageId expectedRequestRevision reason",
  [T.MESSAGE_REACTION_SET]: "messageId reaction active",
  [T.WORK_PROPOSED]: "workItemId title definitionOfDone accountableMemberId verifierMemberId independentVerificationRequired ownerDecisionRequired humanDecisionMakerId mode sourceMessageId",
  [T.WORK_ACCEPTED]: work,
  [T.WORK_HELP_UPDATED]: `${work} expectedHelpRevision status scope expiresAt`,
  [HELP_OFFER_OPENED]: `${work} offerId expectedHelpRevision helpEventId plan`,
  [HELP_OFFER_UPDATED]: `${work} offerId expectedOfferRevision status reason expectedHelpRevision helpEventId externalActivityUnverified`,
  [T.WORK_STARTED]: `${work} resolvedBlocker`,
  [T.WORK_BLOCKED]: `${work} reason nextAction`,
  [T.WORK_BLOCKER_RESOLVED]: `${work} resolution`,
  [T.WORK_COMPLETED]: `${work} summary evidenceUrl evidenceVersion nextAction checksClaimed producerId evidenceKind evidenceMessageId evidenceMessageEventId previousCompletionEventId`,
  [T.WORK_SUPERSEDED]: `${work} supersededByWorkItemId reason`,
  [T.CLAIM_ACQUIRED]: `${work} repository ref paths expiresAt`,
  [T.CLAIM_RELEASED]: work,
  [T.VERIFICATION_RECORDED]: `${work} result completionEventId evidenceVersion summary nextAction`,
  [T.OWNER_DECISION_RECORDED]: `${work} decision completionEventId evidenceVersion reason`
};

export function validateCommand(command) {
  if (!command || Array.isArray(command) || typeof command !== "object" || Object.keys(command).some(k => !["id", "type", "data", "causationId"].includes(k))) fail(422, "invalid_command", "Supply only id, type, data, and optional causationId");
  if (!validId(command.id) || !Object.hasOwn(shapes, command.type)) fail(422, "invalid_command", "Invalid command id or type");
  if (command.causationId != null && !validId(command.causationId)) fail(422, "invalid_command", "Invalid causationId");
  if (!command.data || Array.isArray(command.data) || typeof command.data !== "object") fail(422, "invalid_command", "Data must be an object");
  const allowed = shapes[command.type].split(" ");
  for (const [name, value] of Object.entries(command.data)) {
    if (!allowed.includes(name)) fail(422, "invalid_command", `Unexpected field: ${name}`);
    if (value === null) continue;
    const type = ["expectedRevision", "expectedMemberRevision", "basisRevision", "expectedRequestRevision", "contextSequence", "expectedHelpRevision", "expectedOfferRevision"].includes(name) ? "number" : ["active", "independentVerificationRequired", "ownerDecisionRequired", "allowOlderBasis", "externalActivityUnverified"].includes(name) ? "boolean" : ["permissions", "paths", "checksClaimed"].includes(name) ? "array" : "string";
    if (type === "array" ? !Array.isArray(value) : typeof value !== type) fail(422, "invalid_command", `Invalid field: ${name}`);
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 16384) fail(413, "too_large", "Command is too large");
  if (command.type === T.MESSAGE_POSTED) {
    try { replyPostMode(command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
  if (command.type === T.WORK_HELP_UPDATED) {
    try { validateHelpData(command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
  if ([HELP_OFFER_OPENED, HELP_OFFER_UPDATED].includes(command.type)) {
    try { validateHelpOfferData(command.type, command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
}

export class RoomStore {
  constructor(filename, { now = () => Date.now(), readOnly = false, database, storagePlatform = nodeStorage } = {}) {
    this.now = now;
    this.db = database ?? new DatabaseSync(filename, { readOnly });
    this.storagePlatform = storagePlatform;
    this.shareLinks = new ShareLinks(this);
    this.reminders = new Reminders(this);
    this.agentConnections = new AgentConnections(this);
    this.replyRequests = new ReplyRequests(this);
    this.inbox = new Inbox(this);
    this.email = new EmailImport(this);
    const version = this.storagePlatform.version(this.db);
    const supported = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, STORE_SCHEMA_VERSION]);
    const hasSchema = version === 0 && this.storagePlatform.hasSchema(this.db);
    if (!supported.has(version) || hasSchema) {
      this.db.close();
      throw new Error(version > STORE_SCHEMA_VERSION ? "Database schema is newer than this service" : "Database schema version is unsupported");
    }
    if (readOnly) {
      try {
        if (version !== STORE_SCHEMA_VERSION) throw new Error(`Read-only invitation audit requires schema v${STORE_SCHEMA_VERSION}; migrate a backed-up database through the service first`);
        this.storagePlatform.configure(this.db, true);
        this.storagePlatform.verifyWriterFence(this.db);
        this.verifyInvitationAudit();
        this.shareLinks.verify();
        this.reminders.verifySchema();
        this.agentConnections.verify();
        this.verifyHelpHistory();
        this.inbox.verify();
        this.email.verify();
        return;
      } catch (error) { this.db.close(); throw error; }
    }
    this.storagePlatform.configure(this.db, false);
    this.storagePlatform.registerWriter(this.db);
    try { this.transaction(() => {
    // Reread under the write lock: another startup may have upgraded while we waited.
    if (this.storagePlatform.version(this.db) !== version) throw new Error("Database changed during startup; retry with the current service");
    if (version >= 6) this.storagePlatform.verifyWriterFence(this.db, version);
    if (version > 0 && version < 12) {
      // Legacy fixture import allowed ignored scalar fields. Never reinterpret a
      // previously stored policy marker, even when it is null or behind a checkpoint.
      const collision = this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type')='message.posted' AND json_type(body,'$.data.requestPolicyVersion') IS NOT NULL LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM rooms WHERE json_type(projection,'$.replyRequests') IS NOT NULL LIMIT 1").get();
      const checkpointCollision = version >= 2 && this.db.prepare("SELECT 1 FROM projection_checkpoints WHERE json_type(projection,'$.replyRequests') IS NOT NULL LIMIT 1").get();
      if (collision || checkpointCollision) throw new Error("Legacy reply request marker requires operator reconciliation");
    }
    if (version > 0 && version < 13) {
      const collision = table => this.db.prepare(`SELECT 1 FROM ${table}, json_each(projection,'$.workItems') AS item WHERE json_type(item.value,'$.helpWanted') IS NOT NULL LIMIT 1`).get();
      if (collision("rooms") || version >= 2 && collision("projection_checkpoints")
        || this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type')='work.help_updated' LIMIT 1").get()) throw new Error("Legacy help invitation field requires operator reconciliation");
    }
    if (version > 0 && version < 14) {
      const collision = table => this.db.prepare(`SELECT 1 FROM ${table} WHERE json_type(projection,'$.helpOffers') IS NOT NULL LIMIT 1`).get();
      if (collision("rooms") || version >= 2 && collision("projection_checkpoints")
        || this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type') IN ('work.help_offer_opened','work.help_offer_updated') LIMIT 1").get()) throw new Error("Legacy help offer field requires operator reconciliation");
    }
    if (version === 0) { this.db.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL);
      CREATE TABLE events (room_id TEXT NOT NULL REFERENCES rooms(id), sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
      CREATE TABLE commands (room_id TEXT NOT NULL REFERENCES rooms(id), actor_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, actor_id, id), FOREIGN KEY(room_id, sequence) REFERENCES events(room_id, sequence));
      CREATE TABLE accounts (id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE member_accounts (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), origin TEXT NOT NULL, PRIMARY KEY(room_id,member_id), UNIQUE(room_id,account_id));
      CREATE TABLE account_access_events (account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), auth_epoch INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,revision));
      CREATE TABLE credentials (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','session')), parent_hash TEXT REFERENCES credentials(hash), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, account_id TEXT REFERENCES accounts(id), account_auth_epoch INTEGER);
      CREATE INDEX credential_member ON credentials(room_id, member_id);
      CREATE INDEX credential_account ON credentials(account_id);
      CREATE TABLE cursors (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, member_id));
      CREATE TABLE projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL);
      ${invitationSchema}`);
      this.storagePlatform.setVersion(this.db, 4);
    }
    this.repairProjectionProvenance({ upgradeV1: version === 1 });
    if (version === 1 || version === 2) this.migrateIdentityV3(version);
    if (version === 1 || version === 2 || version === 3) this.migrateInvitationsV4();
      if (version < 5) this.migrateInvitationJournalV5();
      if (version < 7) this.db.exec(shareLinkSchema);
      if (version < 8) this.db.exec(reminderSchema);
      if (version < 9) this.db.exec(agentConnectionSchema);
      if (version < 15) this.db.exec(inboxSchema);
      if (version < 18) this.db.exec(emailImportSchema);
      if (version < 21 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') LIKE 'reply.%' OR json_type(receipt_json,'$.attempt') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v21 reply history requires operator reconciliation");
      if (version < 22 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') IN ('reply.observed','reply.review') OR json_type(receipt_json,'$.attempt.observation') IS NOT NULL OR json_type(receipt_json,'$.attempt.review') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v22 reply review history requires operator reconciliation");
      if (version < 23 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') LIKE 'reply.update.%' OR json_type(receipt_json,'$.update') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v23 reply update history requires operator reconciliation");
      if (version < STORE_SCHEMA_VERSION) this.storagePlatform.installWriterFence(this.db);
      this.storagePlatform.verifyWriterFence(this.db);
      this.verifyInvitationAudit();
      this.shareLinks.verify();
      this.reminders.verifySchema();
      this.agentConnections.verify();
      this.verifyHelpHistory();
      this.inbox.verify();
      this.email.verify();
    }); } catch (error) { this.db.close(); throw error; }
  }

  verifyHelpHistory() {
    return this.readTransaction(() => {
      for (const row of this.db.prepare("SELECT id,projection FROM rooms ORDER BY id").all()) {
        const history = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence").all(row.id);
        const checkpoint = this.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(row.id);
        auditWorkHelp(JSON.parse(row.projection), history, checkpoint);
      }
    });
  }

  // v2 had only Room-local member identities. Give each historical human membership its
  // own provisional account: matching member ids or display names across Rooms are not proof
  // that they are the same person. Existing credential bytes remain valid and become bound to
  // that exact provisional account and epoch. Historical Room events stay byte-identical.
  migrateIdentityV3(sourceVersion) {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS member_accounts (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), origin TEXT NOT NULL, PRIMARY KEY(room_id,member_id), UNIQUE(room_id,account_id));
        CREATE TABLE IF NOT EXISTS account_access_events (account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), auth_epoch INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,revision));
      `);
      const columns = new Set(this.db.prepare("PRAGMA table_info(credentials)").all().map(column => column.name));
      if (!columns.has("account_id")) this.db.exec("ALTER TABLE credentials ADD COLUMN account_id TEXT REFERENCES accounts(id)");
      if (!columns.has("account_auth_epoch")) this.db.exec("ALTER TABLE credentials ADD COLUMN account_auth_epoch INTEGER");
      this.db.exec("CREATE INDEX IF NOT EXISTS credential_account ON credentials(account_id)");
      const origin = `legacy-v${sourceVersion}`;
      const insertAccount = this.db.prepare("INSERT OR IGNORE INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)");
      const insertBinding = this.db.prepare("INSERT OR IGNORE INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)");
      for (const { id: roomId, projection } of this.db.prepare("SELECT id,projection FROM rooms ORDER BY id").all()) {
        const state = JSON.parse(projection);
        for (const member of Object.values(state.members ?? {}).filter(candidate => candidate?.kind === "human")) {
          const accountId = provisionalAccountId(roomId, member.id);
          insertAccount.run(accountId, origin, this.now());
          insertBinding.run(roomId, member.id, accountId, origin);
        }
      }
      const conflicts = this.db.prepare(`SELECT c.hash FROM credentials c JOIN member_accounts m ON m.room_id=c.room_id AND m.member_id=c.member_id
        WHERE c.account_id IS NOT NULL AND c.account_id<>m.account_id LIMIT 1`).get();
      if (conflicts) fail(409, "identity_conflict", "Existing credential has a conflicting account binding");
      this.db.exec(`UPDATE credentials SET
        account_id=(SELECT account_id FROM member_accounts m WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id),
        account_auth_epoch=(SELECT a.auth_epoch FROM member_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id)
        WHERE EXISTS (SELECT 1 FROM member_accounts m WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id)`);
      this.storagePlatform.setVersion(this.db, 3);
    });
  }
  migrateInvitationsV4() {
    this.transaction(() => {
      this.db.exec(invitationSchema);
      this.storagePlatform.setVersion(this.db, 4);
    });
  }
  migrateInvitationJournalV5() {
    this.transaction(() => {
      this.db.exec(invitationJournalSchema);
      for (const record of this.db.prepare("SELECT * FROM membership_invitations ORDER BY id").all()) {
        this.appendInvitationJournal(record, "legacy-v4-baseline");
        this.verifyInvitationRecord(record.id);
      }
      this.storagePlatform.setVersion(this.db, 5);
    });
  }
  appendInvitationJournal(record, kind) {
    const rows = this.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(record.id);
    const audits = this.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(record.id);
    const entry = invitationJournalEntry(record, audits, kind, this.now(), rows.at(-1));
    try { replayInvitationJournal([...rows, entry]); }
    catch { fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation"); }
    this.db.prepare("INSERT INTO membership_invitation_journal(invitation_id,sequence,body,checksum) VALUES(?,?,?,?)")
      .run(entry.invitation_id, entry.sequence, entry.body, entry.checksum);
  }
  verifyInvitationRecord(invitationId) {
    try {
      const stored = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      const journal = this.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(invitationId);
      const replayed = replayInvitationJournal(journal);
      const audits = this.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(invitationId);
      if (canonicalInvitationData(stored) !== canonicalInvitationData(replayed.record)
        || canonicalInvitationData(audits) !== canonicalInvitationData(replayed.audits)) throw new Error("Projection differs from journal");
      if (stored.status === "accepted") {
        const linked = this.db.prepare("SELECT id,sequence,body,room_id FROM events WHERE id=?").get(stored.joined_event_id);
        const binding = this.db.prepare("SELECT account_id,origin FROM member_accounts WHERE room_id=? AND member_id=?").get(stored.room_id, stored.intended_member_id);
        const { sequence, members } = this.roomAuthority(stored.room_id);
        assertInvitationMembershipEvidence(stored, linked, binding, { sequence, state: { members } });
      }
      return replayed;
    } catch { fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation"); }
  }
  verifyInvitationAudit() {
    return this.readTransaction(() => {
      const records = this.db.prepare("SELECT id FROM membership_invitations ORDER BY id").all();
      if (this.db.prepare("SELECT 1 FROM membership_invitation_journal j LEFT JOIN membership_invitations i ON i.id=j.invitation_id WHERE i.id IS NULL LIMIT 1").get()) {
        fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation");
      }
      const result = { consistent: true, invitations: records.length, legacyBaselines: 0, journalEntries: 0 };
      for (const { id } of records) {
        const verified = this.verifyInvitationRecord(id);
        result.legacyBaselines += Number(verified.legacyBaseline);
        result.journalEntries += verified.journalSequence;
      }
      return result;
    });
  }
  verifyInvitedMembership(roomId, member) {
    const accepted = this.db.prepare("SELECT id FROM membership_invitations WHERE room_id=? AND intended_member_id=? AND status='accepted'").get(roomId, member.id);
    const binding = this.db.prepare("SELECT origin FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, member.id);
    const fromBinding = binding?.origin?.startsWith("invitation:") ? binding.origin.slice("invitation:".length) : null;
    const fromProjection = member.membershipOrigin?.kind === "invitation" ? member.membershipOrigin.invitationId : null;
    const invitationId = accepted?.id ?? fromBinding ?? fromProjection;
    if (!invitationId) return;
    const verified = this.verifyInvitationRecord(invitationId);
    if (verified.record.status !== "accepted" || verified.record.room_id !== roomId || verified.record.intended_member_id !== member.id) {
      fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation");
    }
  }
  // Deterministic upgrade repair: persisted projections are not replayed on startup. Recover
  // proposers and authenticated completion reporters from their own authoritative envelopes,
  // then backfill verification independence only where explicit producer attribution proves it.
  // The legacy reducer guessed that every reporter was also the producer, so legacy receipts
  // deliberately migrate to explicit unknown producer attribution unless their event carried
  // the newer producerId field. Idempotent current projections are left untouched.
  repairProjectionProvenance({ upgradeV1 = false } = {}) {
    this.transaction(() => {
      // A v1 projection was produced under v1 transition rules. Preserve its repaired,
      // conservative form as an immutable recovery checkpoint; all later v2 events replay
      // normally from there. This keeps legacy event bodies byte-for-byte append-only without
      // weakening the current reducer to accept rules that no longer apply.
      this.db.exec("CREATE TABLE IF NOT EXISTS projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
      const findEvents = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence");
      const saveCheckpoint = this.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)");
      for (const { id, sequence, projection } of this.db.prepare("SELECT id, sequence, projection FROM rooms ORDER BY id").all()) {
        const state = JSON.parse(projection);
        const missing = Object.values(state.workItems ?? {}).filter(item => item && !Object.hasOwn(item, "proposedById"));
        const workItems = Object.values(state.workItems ?? {}).filter(item => item && typeof item === "object");
        const legacyReceipts = workItems.flatMap(item => [...(item.receiptHistory ?? []), item.receipt].filter(Boolean))
          .filter(receipt => !Object.hasOwn(receipt, "reportedById") || !Object.hasOwn(receipt, "producerId") || !Object.hasOwn(receipt, "producerAttribution"));
        const legacyVerifications = workItems.flatMap(item => [...(item.verificationHistory ?? []), item.verification].filter(Boolean)
          .map(verification => ({ item, verification })))
          .filter(({ verification }) => !Object.hasOwn(verification, "independenceConfirmed"));
        const approvalsToCheck = workItems.filter(item => item.decision?.decision === "approved");
        const legacySupersededClaims = workItems.filter(item => item.state === "superseded" && item.claim?.status === "active");
        const hasInvalidSupersession = item => {
          if (item.state !== "superseded" || !item.supersededBy) return false;
          const visited = new Set([item.id]);
          let nextId = item.supersededBy;
          while (nextId) {
            if (visited.has(nextId)) return true;
            visited.add(nextId);
            const next = state.workItems[nextId];
            if (!next) return true;
            nextId = next.supersededBy;
          }
          return false;
        };
        const invalidSupersessions = workItems.filter(hasInvalidSupersession);
        const proposers = new Map();
        const completions = new Map();
        const verifications = new Map();
        const decisions = new Map();
        const supersessions = new Map();
        for (const row of findEvents.all(id)) {
          const parsed = JSON.parse(row.body);
          if (parsed.type === T.WORK_PROPOSED && parsed.data?.workItemId && !proposers.has(parsed.data.workItemId)) proposers.set(parsed.data.workItemId, parsed.actorId ?? null);
          if (parsed.type === T.WORK_COMPLETED && parsed.id) completions.set(parsed.id, parsed);
          if (parsed.type === T.VERIFICATION_RECORDED && parsed.id) verifications.set(parsed.id, parsed);
          if (parsed.type === T.OWNER_DECISION_RECORDED && parsed.id) decisions.set(parsed.id, parsed);
          if (parsed.type === T.WORK_SUPERSEDED && parsed.data?.workItemId) supersessions.set(parsed.data.workItemId, parsed);
        }
        let changed = false;
        for (const item of missing) {
          const proposer = proposers.get(item.id);
          if (proposer) { item.proposedById = proposer; changed = true; }
        }
        for (const receipt of legacyReceipts) {
          const completion = completions.get(receipt.eventId);
          const producerId = completion?.data && Object.hasOwn(completion.data, "producerId") ? completion.data.producerId : null;
          receipt.reportedById = completion?.actorId ?? null;
          receipt.producerId = producerId ?? null;
          receipt.producerAttribution = producerId == null ? "unknown" : "reported";
          changed = true;
        }
        for (const { item, verification } of legacyVerifications) {
          const receipt = [...(item.receiptHistory ?? []), item.receipt].filter(Boolean)
            .find(candidate => candidate.eventId === verification.completionEventId && candidate.evidenceVersion === verification.evidenceVersion);
          const verificationEvent = verifications.get(verification.eventId);
          const producerKnown = receipt?.producerAttribution === "reported" && receipt.producerId != null;
          const verifierAuthenticated = verificationEvent?.actorId === verification.verifierId && verificationEvent.actorId === item.verifierMemberId;
          const exactReceipt = verificationEvent?.data?.completionEventId === receipt?.eventId && verificationEvent?.data?.evidenceVersion === receipt?.evidenceVersion;
          verification.independenceConfirmed = producerKnown && verifierAuthenticated && exactReceipt && receipt.producerId !== verificationEvent.actorId;
          changed = true;
        }
        for (const item of approvalsToCheck) {
          const receipt = item.receipt, verification = item.verification, decision = item.decision;
          const decisionEvent = decisions.get(decision.eventId);
          const approvalStillCurrent = item.state === "completed";
          const approvalProvenanceSatisfied = decision.actorId === item.humanDecisionMakerId
            && decision.completionEventId === receipt?.eventId
            && decision.evidenceVersion === receipt?.evidenceVersion
            && decisionEvent?.actorId === decision.actorId
            && decisionEvent?.data?.workItemId === item.id
            && decisionEvent?.data?.decision === "approved"
            && decisionEvent?.data?.completionEventId === receipt?.eventId
            && decisionEvent?.data?.evidenceVersion === receipt?.evidenceVersion
            && decisionEvent?.data?.reason === decision.reason;
          const independentGateSatisfied = !item.independentVerificationRequired || (
            verification?.result === "pass" && verification.independenceConfirmed === true
            && verification.verifierId === item.verifierMemberId
            && verification.completionEventId === receipt?.eventId
            && verification.evidenceVersion === receipt?.evidenceVersion
            && receipt?.producerAttribution === "reported" && receipt.producerId != null
            && receipt.producerId !== verification.verifierId
          );
          const confirmed = approvalStillCurrent && approvalProvenanceSatisfied && independentGateSatisfied;
          if (!confirmed) {
            item.decisionHistory ||= [];
            const invalidatedByRepair = !approvalStillCurrent ? "approval_not_current"
              : !approvalProvenanceSatisfied ? "approval_provenance_unconfirmed"
              : "producer_independence_unconfirmed";
            item.decisionHistory.push({
              ...decision,
              historical: true,
              invalidatedByRepair,
              ...(!approvalStillCurrent ? { invalidatedState: item.state } : {})
            });
            item.decision = null;
            changed = true;
          }
        }
        for (const item of legacySupersededClaims) {
          const supersession = supersessions.get(item.id);
          item.claim.status = "superseded";
          item.claim.supersededAt = supersession?.at ?? item.updatedAt;
          changed = true;
        }
        for (const item of invalidSupersessions) {
          item.supersessionRepair = { previousTargetId: item.supersededBy, reason: "invalid_legacy_link" };
          item.supersededBy = null;
          changed = true;
        }
        if (changed) this.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), id);
        if (upgradeV1) saveCheckpoint.run(id, sequence, JSON.stringify(state));
      }
      // v2 marks the producer/reporter/verification-independence projection contract.
      // Commit its marker atomically with every v1 projection repair so older binaries
      // either see untouched v1 or reject the fully upgraded database.
      if (upgradeV1) this.storagePlatform.setVersion(this.db, 2);
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    // Nested startup helpers share the outer migration transaction and its rollback.
    return this.storagePlatform.transaction(this.db, fn, false);
  }
  readTransaction(fn) {
    return this.storagePlatform.transaction(this.db, fn, true);
  }
  room(roomId) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    return { sequence: row.sequence, state: JSON.parse(row.projection) };
  }
  roomAuthority(roomId) {
    // Fresh storage read, not an authorization cache. Keep membership provenance
    // intact without decoding conversation, work history or the Room brief in JS.
    const row = this.db.prepare("SELECT sequence,json_extract(projection,'$.room.ownerId','$.members') AS authority FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    const [ownerId, members] = JSON.parse(row.authority);
    return { sequence: row.sequence, ownerId, members };
  }
  rebuildProjection(roomId, through = null) {
    const room = this.room(roomId);
    through ??= room.sequence;
    if (!Number.isSafeInteger(through) || through < 0 || through > room.sequence) throw new Error("Invalid historical room boundary");
    const checkpoint = this.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(roomId);
    let state = checkpoint ? JSON.parse(checkpoint.projection) : emptyRoomState();
    let sequence = checkpoint?.sequence ?? 0;
    if (sequence > through) throw new Error("Historical room boundary predates the retained checkpoint");
    const rows = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence").all(roomId, sequence, through);
    for (const row of rows) {
      if (row.sequence !== sequence + 1) throw new Error("Event sequence is not contiguous");
      state = applyEvent(state, JSON.parse(row.body));
      sequence = row.sequence;
    }
    if (sequence !== through) throw new Error("Event sequence does not reach the room projection");
    return { sequence, state: compact(state) };
  }
  // Administrative bootstrap, never exposed over HTTP. Historical demo events are test fixtures only.
  initialize(events) {
    return this.transaction(() => {
      const state = events.reduce(applyEvent, emptyRoomState());
      this.db.prepare("INSERT INTO rooms VALUES(?,?,?)").run(state.room.id, events.length, JSON.stringify(compact(state)));
      const insert = this.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
      events.forEach((e, i) => insert.run(state.room.id, i + 1, e.id, JSON.stringify(e)));
      return state.room.id;
    });
  }
  account(accountId) {
    if (!validId(accountId)) fail(422, "invalid_account", "Invalid account id");
    const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!row) fail(404, "account_not_found", "Account not found");
    return accountView(row);
  }
  accountForMember(roomId, memberId) {
    const row = this.db.prepare("SELECT a.* FROM member_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=? AND m.member_id=?").get(roomId, memberId);
    return accountView(row);
  }
  createAccount(accountId, origin = "local-provisioning") {
    if (!validId(accountId) || accountId.startsWith(provisionalAccountPrefix)) fail(422, "invalid_account", "Invalid or reserved account id");
    if (typeof origin !== "string" || !origin.trim() || origin.length > 128) fail(422, "invalid_account", "A bounded account origin is required");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) fail(409, "account_exists", "Account already exists");
      this.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)").run(accountId, origin.trim(), this.now());
      return this.account(accountId);
    });
  }
  issueAccountAccessKey(accountId, lifetimeMs = 7 * 86400000) {
    return this.transaction(() => {
      const account = this.account(accountId);
      if (!account.active) fail(403, "access_denied", "Active account required");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30 * 86400000) fail(422, "invalid_expiry", "Account access keys expire within 30 days");
      this.db.prepare("UPDATE account_credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.db.prepare("UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL WHERE account_id=?").run(accountId);
      return this.insertAccountCredential(accountId, this.now() + lifetimeMs);
    });
  }
  insertAccountCredential(accountId, expiresAt) {
    const count = this.db.prepare("SELECT count(*) AS n FROM account_credentials WHERE account_id=?").get(accountId).n;
    if (count >= 5000) fail(409, "pilot_limit", "Account credential retention limit reached; administrator maintenance required");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) fail(422, "invalid_credential", "Invalid account credential");
    const account = this.account(accountId);
    if (!account.active) fail(403, "access_denied", "Active account required");
    const token = key();
    this.db.prepare("INSERT INTO account_credentials(hash,account_id,account_auth_epoch,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(hash(token), accountId, account.authEpoch, expiresAt, this.now());
    return token;
  }
  authenticateAccountAccessKey(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Sign in with an active account key");
    const row = this.db.prepare(`SELECT c.*,a.active AS account_active,a.revision AS account_revision,a.auth_epoch AS current_account_auth_epoch
      FROM account_credentials c JOIN accounts a ON a.id=c.account_id WHERE c.hash=?`).get(hash(token));
    if (!row || row.revoked || row.expires_at <= this.now() || row.account_active !== 1 || row.account_auth_epoch !== row.current_account_auth_epoch) {
      fail(401, "unauthenticated", "Account key expired, revoked, or account access ended");
    }
    return {
      account: { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch },
      member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-access", kind: "access", expiresAt: row.expires_at,
      csrf: null, sessionBinding: null, sessionRevision: null
    };
  }
  createAccountSessionSlot(lifetimeMs = 30 * 86400000) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 90 * 86400000) fail(422, "invalid_expiry", "Account session slots expire within 90 days");
    return this.transaction(() => {
      if (this.db.prepare("SELECT count(*) AS n FROM account_session_slots").get().n >= 10000) fail(409, "pilot_limit", "Account session slot limit reached; administrator maintenance required");
      const token = key(), now = this.now();
      this.db.prepare("INSERT INTO account_session_slots(hash,revision,expires_at,created_at) VALUES(?,0,?,?)").run(hash(token), now + lifetimeMs, now);
      return { token, session: this.accountSessionSlot(token) };
    });
  }
  accountSessionSlot(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Invalid account session slot");
    const row = this.db.prepare("SELECT * FROM account_session_slots WHERE hash=?").get(hash(token));
    if (!row || row.expires_at <= this.now()) fail(401, "unauthenticated", "Account session slot expired");
    return {
      account: null, member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-session", kind: "session",
      expiresAt: row.expires_at, authenticatedUntil: null, sessionRevision: row.revision,
      csrf: hash(`account-csrf:${token}:${row.revision}`),
      sessionBinding: hash(`account-session-binding:${token}:${row.revision}`)
    };
  }
  sessionOwnership(auth) {
    return {
      account: auth.account,
      member: auth.member,
      roomId: auth.roomId,
      csrf: auth.csrf,
      sessionBinding: auth.sessionBinding,
      sessionRevision: auth.sessionRevision,
      expiresAt: auth.expiresAt
    };
  }
  loginAccountSession(slotToken, accountAccessKey, expectedRevision, { revokeRoomToken = null } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing in");
      const access = this.authenticateAccountAccessKey(accountAccessKey);
      const revision = expectedRevision + 1;
      this.db.prepare(`UPDATE account_session_slots SET revision=?,account_id=?,account_auth_epoch=?,parent_credential_hash=?,authenticated_until=?
        WHERE hash=? AND revision=?`).run(revision, access.account.id, access.account.authEpoch, access.credentialHash, Math.min(slot.expiresAt, access.expiresAt, this.now() + 8 * 3600000), slot.credentialHash, expectedRevision);
      // Switching browser identity and retiring its former Room credential are one
      // commit. A storage failure must not report a rejected login after switching.
      if (revokeRoomToken !== null) {
        if (typeof revokeRoomToken !== "string" || !tokenPattern.test(revokeRoomToken)) fail(422, "invalid_credential", "Invalid prior Room credential");
        this.revoke(revokeRoomToken);
      }
      return this.authenticateAccountSession(slotToken);
    });
  }
  logoutAccountSession(slotToken, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing out");
      const changed = this.db.prepare(`UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL
        WHERE hash=? AND revision=?`).run(slot.credentialHash, expectedRevision).changes;
      if (changed !== 1) fail(409, "stale_session_revision", "Account session changed; refresh before signing out");
      return this.accountSessionSlot(slotToken);
    });
  }
  authenticateAccountSession(token, roomId = null, expectedSessionBinding = null) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Invalid account session");
    const row = this.db.prepare(`SELECT s.*,c.revoked AS parent_revoked,c.expires_at AS parent_expiry,c.account_id AS parent_account_id,c.account_auth_epoch AS parent_account_auth_epoch,
      a.active AS account_active,a.revision AS account_revision,a.auth_epoch AS current_account_auth_epoch
      FROM account_session_slots s LEFT JOIN account_credentials c ON c.hash=s.parent_credential_hash LEFT JOIN accounts a ON a.id=s.account_id WHERE s.hash=?`).get(hash(token));
    const invalid = !row || row.expires_at <= this.now() || row.account_id === null || row.authenticated_until <= this.now()
      || row.parent_revoked !== 0 || row.parent_expiry <= this.now() || row.parent_account_id !== row.account_id || row.parent_account_auth_epoch !== row.account_auth_epoch
      || row.account_active !== 1 || row.account_auth_epoch !== row.current_account_auth_epoch;
    if (invalid) fail(401, "unauthenticated", "Account session expired, revoked, or account access ended");
    const sessionBinding = hash(`account-session-binding:${token}:${row.revision}`);
    if (expectedSessionBinding !== null && expectedSessionBinding !== sessionBinding) fail(409, "session_binding_changed", "Account session changed; discard the stale response or stream");
    const auth = {
      account: { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch },
      member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-session", kind: "session",
      expiresAt: Math.min(row.expires_at, row.authenticated_until), authenticatedUntil: row.authenticated_until, sessionRevision: row.revision,
      csrf: hash(`account-csrf:${token}:${row.revision}`), sessionBinding
    };
    if (roomId === null) return auth;
    if (!validId(roomId)) fail(422, "invalid_room", "Invalid Room id");
    const binding = this.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, auth.account.id);
    if (!binding) fail(403, "access_denied", "This account has no membership in that Room");
    const member = this.roomAuthority(roomId).members[binding.member_id];
    if (!member || member.kind !== "human" || member.active === false) fail(403, "access_denied", "Active human Room membership required");
    this.verifyInvitedMembership(roomId, member);
    return { ...auth, member, roomId };
  }
  accountRooms(token, binding, { after = null } = {}) {
    if (after !== null && !validId(after)) fail(422, "invalid_room", "Invalid room continuation");
    return this.transaction(() => {
      const auth = this.authenticateAccountSession(token, null, binding);
      const rows = this.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=? AND room_id>? ORDER BY room_id LIMIT 51")
        .all(auth.account.id, after ?? "");
      const rooms = [];
      for (const row of rows.slice(0, 50)) {
        try {
          const access = this.authenticateAccountSession(token, row.room_id, binding);
          const room = this.db.prepare("SELECT json_extract(projection,'$.room.title') AS title FROM rooms WHERE id=?").get(row.room_id);
          rooms.push({ id: row.room_id, title: room.title, memberId: access.member.id });
        } catch (error) { if (error.status !== 403) throw error; }
      }
      return { contractVersion: 1, viewer: { accountId: auth.account.id, authEpoch: auth.account.authEpoch,
        sessionRevision: auth.sessionRevision, sessionBinding: auth.sessionBinding },
        rooms, nextCursor: rows.length > 50 ? rows[49].room_id : null };
    });
  }
  ensureHumanAccountBinding(roomId, memberId, requestedAccountId = null, origin = "local-provisioning") {
    const members = this.room(roomId).state.members;
    const member = validId(memberId) && Object.hasOwn(members, memberId) && members[memberId];
    if (!member || member.kind !== "human") fail(422, "invalid_account_binding", "Only a human Room member can bind to an account");
    if (requestedAccountId !== null && !validId(requestedAccountId)) fail(422, "invalid_account", "Invalid account id");
    const existing = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, memberId);
    if (existing) {
      if (requestedAccountId !== null && existing.account_id !== requestedAccountId) fail(409, "identity_conflict", "Room membership already belongs to another account");
      return this.account(existing.account_id);
    }
    if (requestedAccountId?.startsWith(provisionalAccountPrefix)) fail(422, "invalid_account", "Provisional account ids are reserved for one Room membership");
    const accountId = requestedAccountId === null ? provisionalAccountId(roomId, memberId) : requestedAccountId;
    if (requestedAccountId === null && this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) fail(409, "identity_conflict", "Provisional account id is already reserved");
    this.db.prepare(`${requestedAccountId === null ? "INSERT" : "INSERT OR IGNORE"} INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)`).run(accountId, origin, this.now());
    try { this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)").run(roomId, memberId, accountId, origin); }
    catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) fail(409, "identity_conflict", "Account already has a different membership in this Room");
      throw error;
    }
    return this.account(accountId);
  }
  bindHumanAccount(roomId, memberId, accountId) {
    return this.transaction(() => this.ensureHumanAccountBinding(roomId, memberId, accountId));
  }
  issueInvitation(accountSessionToken, roomId, details) {
    const {
      requestId, token, intendedAccountId, intendedMemberId, displayName, role, expiresAt,
      expectedIssuerMemberRevision, expectedSessionBinding
    } = details ?? {};
    if (!validId(roomId) || !validId(requestId) || !tokenPattern.test(token ?? "") || !validId(intendedAccountId) || !validId(intendedMemberId)) {
      fail(422, "invalid_invitation", "Invitation requires valid Room, request, token, account, and member identifiers");
    }
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 256 || !Object.hasOwn(INVITATION_ROLES, role)) {
      fail(422, "invalid_invitation", "Invitation requires a bounded display name and known human role");
    }
    if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(expectedIssuerMemberRevision) || expectedIssuerMemberRevision < 0) {
      fail(422, "invalid_invitation", "Invitation requires an expiry and current issuer member revision");
    }
    if (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding)) fail(422, "invalid_session_binding", "Current account session binding required");
    const tokenHash = hash(token);
    const permissions = [...INVITATION_ROLES[role]];
    const fingerprint = hash(canonical({ roomId, requestId, tokenHash, intendedAccountId, intendedMemberId, displayName: displayName.trim(), role, permissions, expiresAt, expectedIssuerMemberRevision }));
    return this.transaction(() => {
      const issuer = this.authenticateAccountSession(accountSessionToken, roomId, expectedSessionBinding);
      if (!issuer.member.permissions.includes("manage_members")) fail(403, "access_denied", "Current membership administration grant required");
      const prior = this.db.prepare("SELECT * FROM membership_invitations WHERE room_id=? AND issuer_account_id=? AND issue_request_id=?")
        .get(roomId, issuer.account.id, requestId);
      if (prior) {
        this.verifyInvitationRecord(prior.id);
        if (prior.issue_fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Invitation request ID already used for different scope");
        return { invitation: invitationView(prior, this.now(), { includeScope: true }), duplicate: true };
      }
      const now = this.now();
      if (expiresAt <= now || expiresAt > now + 30 * 86400000) fail(422, "invalid_expiry", "Invitations expire within 30 days");
      if (issuer.member.revision !== expectedIssuerMemberRevision) fail(409, "stale_member_revision", "Issuer membership changed; review the invitation again");
      const room = this.room(roomId);
      if (issuer.member.id !== room.state.room.ownerId && permissions.some(permission => !issuer.member.permissions.includes(permission))) {
        fail(403, "access_denied", "A membership administrator cannot offer authority they do not hold");
      }
      const targetAccount = this.account(intendedAccountId);
      if (!targetAccount.active) fail(403, "access_denied", "Invitation target account is inactive");
      if (Object.hasOwn(room.state.members, intendedMemberId)) fail(409, "membership_conflict", "That Room member already exists");
      if (this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, intendedAccountId)) fail(409, "membership_conflict", "That account already has a membership in this Room");
      if (this.db.prepare(`SELECT 1 FROM membership_invitations WHERE room_id=? AND status='pending' AND expires_at>? AND (intended_member_id=? OR intended_account_id=?) LIMIT 1`)
        .get(roomId, now, intendedMemberId, intendedAccountId)) fail(409, "invitation_conflict", "An active invitation already reserves that Room identity");
      if (this.db.prepare("SELECT 1 FROM membership_invitations WHERE token_hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM credentials WHERE hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM account_credentials WHERE hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM account_session_slots WHERE hash=?").get(tokenHash)) fail(409, "token_conflict", "Invitation token is already registered");
      const invitationId = randomUUID();
      this.db.prepare(`INSERT INTO membership_invitations(
        id,token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,
        issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,revision,status,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,0,'pending',?,?)`).run(
        invitationId, tokenHash, roomId, intendedAccountId, intendedMemberId, displayName.trim(), role, JSON.stringify(permissions),
        INVITATION_ROLE_POLICY_VERSION,
        issuer.account.id, issuer.member.id, issuer.account.authEpoch, issuer.member.revision, requestId, fingerprint, now, expiresAt
      );
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,1,'issued',?,?,?,?,0,?,NULL,NULL)`).run(invitationId, issuer.account.id, issuer.member.id, issuer.account.authEpoch, issuer.sessionRevision, now);
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.appendInvitationJournal(row, "issued");
      return { invitation: invitationView(row, now, { includeScope: true }), duplicate: false };
    });
  }
  previewInvitation(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(404, "invitation_unavailable", "Invitation is unavailable");
    return this.readTransaction(() => {
      const row = this.db.prepare("SELECT i.*,r.projection FROM membership_invitations i JOIN rooms r ON r.id=i.room_id WHERE i.token_hash=?").get(hash(token));
      if (!row) fail(404, "invitation_unavailable", "Invitation is unavailable");
      this.verifyInvitationRecord(row.id);
      const room = JSON.parse(row.projection);
      let status = invitationStatus(row, this.now());
      if (status === "pending") {
        const issuerAccount = this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
        const targetAccount = this.db.prepare("SELECT active FROM accounts WHERE id=?").get(row.intended_account_id);
        const issuerBinding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
        const issuerMember = room.members?.[row.issuer_member_id];
        if (!issuerAccount || issuerAccount.active !== 1 || issuerAccount.auth_epoch !== row.issuer_account_auth_epoch
          || targetAccount?.active !== 1 || issuerBinding?.account_id !== row.issuer_account_id || !issuerMember || issuerMember.active === false
          || issuerMember.revision !== row.issuer_member_revision || !issuerMember.permissions.includes("manage_members")) status = "stale";
      }
      return {
        ...invitationView(row, this.now()),
        status,
        memberId: row.intended_member_id,
        permissions: JSON.parse(row.intended_permissions_json),
        invitedByDisplayName: room.members?.[row.issuer_member_id]?.displayName ?? "Room administrator",
        roomTitle: room.room?.title ?? "Project Room",
        roomPurpose: room.room?.purpose ?? ""
      };
    });
  }
  revokeInvitation(accountSessionToken, invitationId, { expectedRevision, reason, expectedSessionBinding, expectedRoomId = null } = {}) {
    if (!validId(invitationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof reason !== "string" || !reason.trim() || reason.length > 4096) {
      fail(422, "invalid_invitation_change", "Invitation revocation requires its current revision and a reason");
    }
    if (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding)) fail(422, "invalid_session_binding", "Current account session binding required");
    if (expectedRoomId !== null && !validId(expectedRoomId)) fail(422, "invalid_room", "Invalid Room id");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      if (!row || (expectedRoomId !== null && row.room_id !== expectedRoomId)) fail(404, "invitation_not_found", "Invitation not found in this Room");
      const actor = this.authenticateAccountSession(accountSessionToken, row.room_id, expectedSessionBinding);
      if (!actor.member.permissions.includes("manage_members")) fail(403, "access_denied", "Current membership administration grant required");
      this.verifyInvitationRecord(row.id);
      if (row.revision !== expectedRevision) fail(409, "stale_invitation_revision", "Invitation changed; refresh before revoking it");
      if (row.status !== "pending") fail(409, "invitation_not_pending", "Only a pending invitation can be revoked");
      const revision = row.revision + 1, now = this.now();
      const changed = this.db.prepare(`UPDATE membership_invitations SET revision=?,status='revoked',revoked_at=?,revoked_by_account_id=?,revoked_by_member_id=?,revoke_reason=?
        WHERE id=? AND revision=? AND status='pending'`).run(revision, now, actor.account.id, actor.member.id, reason.trim(), invitationId, expectedRevision).changes;
      if (changed !== 1) fail(409, "stale_invitation_revision", "Invitation changed; refresh before revoking it");
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,2,'revoked',?,?,?,?,?,?,NULL,?)`).run(invitationId, actor.account.id, actor.member.id, actor.account.authEpoch, actor.sessionRevision, revision, now, reason.trim());
      const revoked = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.appendInvitationJournal(revoked, "revoked");
      return { invitation: invitationView(revoked, now, { includeScope: true }), duplicate: false };
    });
  }
  acceptInvitation(accountSessionToken, token, { redemptionId, expectedRevision, expectedSessionBinding } = {}) {
    if (typeof token !== "string" || !tokenPattern.test(token) || typeof redemptionId !== "string" || !redemptionPattern.test(redemptionId) || expectedRevision !== 0) {
      fail(422, "invalid_invitation_acceptance", "Invitation acceptance requires its token, redemption ID, and expected revision zero");
    }
    if (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding)) fail(422, "invalid_session_binding", "Current account session binding required");
    return this.transaction(() => {
      const accountSession = this.authenticateAccountSession(accountSessionToken, null, expectedSessionBinding);
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE token_hash=?").get(hash(token));
      if (!row) fail(404, "invitation_unavailable", "Invitation is unavailable");
      if (row.intended_account_id !== accountSession.account.id) fail(403, "invitation_account_mismatch", "Invitation belongs to a different account");
      this.verifyInvitationRecord(row.id);
      if (row.status === "accepted") {
        if (row.redemption_id !== redemptionId) fail(409, "invitation_already_used", "Invitation was already accepted by this account through another request");
        const auth = this.authenticateAccountSession(accountSessionToken, row.room_id, expectedSessionBinding);
        const stored = this.db.prepare("SELECT body,sequence FROM events WHERE id=? AND room_id=?").get(row.joined_event_id, row.room_id);
        if (!stored || auth.member.id !== row.intended_member_id) fail(409, "invitation_receipt_unavailable", "Accepted invitation cannot be reconciled safely");
        return { invitation: invitationView(row, this.now(), { includeScope: true }), sequence: stored.sequence, event: JSON.parse(stored.body), session: this.sessionOwnership(auth), duplicate: true };
      }
      if (row.status === "revoked") fail(410, "invitation_revoked", "Invitation was revoked");
      if (row.revision !== expectedRevision) fail(409, "stale_invitation_revision", "Invitation changed; preview it again");
      const now = this.now();
      if (now >= row.expires_at) fail(410, "invitation_expired", "Invitation expired");
      const room = this.room(row.room_id);
      const issuerAccount = this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
      const issuerBinding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
      const issuerMember = room.state.members[row.issuer_member_id];
      if (!issuerAccount || issuerAccount.active !== 1 || issuerAccount.auth_epoch !== row.issuer_account_auth_epoch
        || issuerBinding?.account_id !== row.issuer_account_id || !issuerMember || issuerMember.active === false
        || issuerMember.revision !== row.issuer_member_revision || !issuerMember.permissions.includes("manage_members")) {
        fail(409, "invitation_authority_changed", "Inviter authority changed; ask a current Room administrator for a new invitation");
      }
      if (Object.hasOwn(room.state.members, row.intended_member_id)
        || this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND (member_id=? OR account_id=?) LIMIT 1").get(row.room_id, row.intended_member_id, row.intended_account_id)) {
        fail(409, "membership_conflict", "Invitation target already has a Room identity");
      }
      const permissions = JSON.parse(row.intended_permissions_json);
      const rolePolicy = INVITATION_ROLE_POLICIES[row.role_policy_version];
      const rolePermissions = rolePolicy?.[row.intended_role];
      if (!rolePermissions || permissions.length !== rolePermissions.length || permissions.some((permission, index) => permission !== rolePermissions[index])) {
        fail(409, "invitation_scope_invalid", "Stored invitation grants no longer match its immutable role policy");
      }
      if (room.sequence >= 10000 || Object.keys(room.state.members).length >= 100) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const incoming = invitationJoinedEvent({ ...row, joined_event_id: randomUUID(), accepted_at: now, redemption_id: redemptionId });
      let state;
      try { state = compact(applyEvent(room.state, incoming)); }
      catch (error) { fail(409, "invitation_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)")
        .run(row.room_id, row.intended_member_id, row.intended_account_id, `invitation:${row.id}`);
      const changed = this.db.prepare(`UPDATE membership_invitations SET revision=1,status='accepted',accepted_at=?,accepted_by_account_id=?,redemption_id=?,joined_event_id=?
        WHERE id=? AND revision=0 AND status='pending'`).run(now, accountSession.account.id, redemptionId, incoming.id, row.id).changes;
      if (changed !== 1) fail(409, "stale_invitation_revision", "Invitation changed while it was being accepted");
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,2,'accepted',?,?,?,?,1,?,?,NULL)`).run(row.id, accountSession.account.id, row.intended_member_id, accountSession.account.authEpoch, accountSession.sessionRevision, now, incoming.id);
      this.appendInvitationJournal(this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(row.id), "accepted");
      const authorized = this.authenticateAccountSession(accountSessionToken, row.room_id, expectedSessionBinding);
      return {
        invitation: invitationView(this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(row.id), now, { includeScope: true }),
        sequence, event: incoming, session: this.sessionOwnership(authorized), duplicate: false
      };
    });
  }
  changeAccountAccess(accountId, { expectedRevision, active, reason }) {
    if (!validId(accountId)) fail(422, "invalid_account", "Invalid account id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof active !== "boolean" || typeof reason !== "string" || !reason.trim() || reason.length > 4096) fail(422, "invalid_account_change", "Account change requires a current revision, active state, and reason");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
      if (!row) fail(404, "account_not_found", "Account not found");
      if (row.revision !== expectedRevision) fail(409, "stale_account_revision", "Stale account revision");
      if (Boolean(row.active) === active) fail(409, "account_state_unchanged", "Account already has that access state");
      const revision = row.revision + 1, authEpoch = row.auth_epoch + 1, at = this.now();
      this.db.prepare("UPDATE accounts SET active=?,revision=?,auth_epoch=? WHERE id=?").run(active ? 1 : 0, revision, authEpoch, accountId);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.agentConnections.revokeAccount(accountId);
      this.db.prepare("UPDATE account_credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.db.prepare("UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL WHERE account_id=?").run(accountId);
      this.db.prepare("INSERT INTO account_access_events(account_id,revision,active,auth_epoch,reason,at) VALUES(?,?,?,?,?,?)").run(accountId, revision, active ? 1 : 0, authEpoch, reason.trim(), at);
      if (!active) this.reminders.retireAccount(accountId);
      return this.account(accountId);
    });
  }
  issueAccessKey(roomId, memberId, lifetimeMs = 7 * 86400000, accountId = null) {
    return this.transaction(() => {
      const members = this.room(roomId).state.members;
      const member = validId(memberId) && Object.hasOwn(members, memberId) && members[memberId];
      if (!member || member.active === false) fail(403, "access_denied", "Active member required");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30 * 86400000) fail(422, "invalid_expiry", "Access keys expire within 30 days");
      if (member.kind === "human") {
        const account = this.ensureHumanAccountBinding(roomId, memberId, accountId);
        if (!account.active) fail(403, "access_denied", "Active account required");
      } else if (accountId !== null) fail(422, "invalid_account_binding", "Agent credentials are not human account credentials");
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, memberId);
      return this.insertCredential(roomId, memberId, "access", null, this.now() + lifetimeMs);
    });
  }
  insertCredential(roomId, memberId, kind, parent, expiresAt) {
    if (this.agentConnections.row(roomId, memberId)) fail(409, "managed_agent", "Replace this agent's key through its room connection");
    const count = this.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id=?").get(roomId).n;
    if (count >= 5000) fail(409, "pilot_limit", "Credential retention limit reached; administrator maintenance required");
    const member = this.room(roomId).state.members[memberId];
    if (!member) fail(403, "access_denied", "Room member required");
    const account = member.kind === "human" ? this.ensureHumanAccountBinding(roomId, memberId) : null;
    if (account && !account.active) fail(403, "access_denied", "Active account required");
    const token = key();
    this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,?,?,?,?,?)").run(hash(token), roomId, memberId, kind, parent, expiresAt, account?.id ?? null, account?.authEpoch ?? null);
    return token;
  }
  authenticate(token, roomId, expectedSessionBinding = null, { allowAccountSession = true } = {}) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Sign in with an active room key");
    const row = this.db.prepare(`SELECT c.*, p.revoked AS parent_revoked, p.expires_at AS parent_expiry, p.account_id AS parent_account_id, p.account_auth_epoch AS parent_account_auth_epoch,
      m.account_id AS bound_account_id, a.active AS account_active, a.revision AS account_revision, a.auth_epoch AS current_account_auth_epoch
      FROM credentials c LEFT JOIN credentials p ON p.hash=c.parent_hash
      LEFT JOIN member_accounts m ON m.room_id=c.room_id AND m.member_id=c.member_id
      LEFT JOIN accounts a ON a.id=m.account_id WHERE c.hash=?`).get(hash(token));
    if (!row) {
      if (allowAccountSession && this.db.prepare("SELECT 1 FROM account_session_slots WHERE hash=?").get(hash(token))) return this.authenticateAccountSession(token, roomId ?? null, expectedSessionBinding);
      fail(401, "unauthenticated", "Session or key expired or revoked");
    }
    if (row.revoked || row.expires_at <= this.now() || (row.parent_hash && (row.parent_revoked !== 0 || row.parent_expiry <= this.now()))) fail(401, "unauthenticated", "Session or key expired or revoked");
    if (roomId && row.room_id !== roomId) fail(403, "access_denied", "This credential does not grant access to that room");
    const members = this.roomAuthority(row.room_id).members;
    const member = Object.hasOwn(members, row.member_id) && members[row.member_id];
    if (!member || member.active === false) fail(403, "access_denied", "Room membership is inactive");
    this.verifyInvitedMembership(row.room_id, member);
    let account = null;
    if (member.kind === "human") {
      const invalidAccount = !row.account_id || row.account_id !== row.bound_account_id || row.account_active !== 1
        || row.account_auth_epoch !== row.current_account_auth_epoch
        || (row.parent_hash && (row.parent_account_id !== row.account_id || row.parent_account_auth_epoch !== row.account_auth_epoch));
      if (invalidAccount) fail(401, "unauthenticated", "Session or key expired, revoked, or account access ended");
      account = { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch };
    } else if (row.account_id !== null || row.account_auth_epoch !== null) fail(401, "unauthenticated", "Agent credential has an invalid human account binding");
    if (member.kind === "agent") this.agentConnections.assertCredential(row);
    const auth = {
      account, member, roomId: row.room_id, credentialHash: row.hash, credentialScope: "room", kind: row.kind, expiresAt: row.expires_at,
      csrf: row.kind === "session" ? hash(`csrf:${token}`) : null,
      sessionBinding: row.kind === "session" ? hash(`session-binding:${token}`) : null
    };
    if (expectedSessionBinding !== null && expectedSessionBinding !== auth.sessionBinding) fail(409, "session_binding_changed", "Session changed; discard the stale response or stream");
    return auth;
  }
  createSession(accessKey) {
    return this.transaction(() => {
      const auth = this.authenticate(accessKey);
      if (auth.credentialScope !== "room" || auth.kind !== "access" || auth.member.kind !== "human") fail(403, "access_denied", "Browser sessions require a human Room access key");
      const token = this.insertCredential(auth.roomId, auth.member.id, "session", auth.credentialHash, Math.min(auth.expiresAt, this.now() + 8 * 3600000));
      return { token, session: this.authenticate(token) };
    });
  }
  revoke(token) { this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(token)); }
  snapshot(token, roomId, expectedSessionBinding = null, view = "full", helpContext = false, offerContext = false) {
    // One read transaction keeps sequence, projection, and audit tail at the same commit.
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!["full", "work"].includes(view)) fail(422, "invalid_snapshot_view", "Choose a supported snapshot view");
      if (typeof helpContext !== "boolean" || helpContext && view !== "work") fail(422, "invalid_help_context", "Help discovery requires the current work view");
      if (typeof offerContext !== "boolean" || offerContext && view !== "full") fail(422, "invalid_offer_context", "Browser offers require the full room view");
      const room = this.room(roomId);
      if (view === "work") return { snapshotView: "work", snapshotVersion: 1, roomId, sequence: room.sequence,
        ...(helpContext ? { helpContextVersion: 1, evaluatedAt: new Date(this.now()).toISOString() } : {}),
        state: { room: room.state.room, members: room.state.members,
          workItems: Object.fromEntries(Object.entries(room.state.workItems).map(([id, item]) => [id, currentWorkRecord(item)])) },
        charter: charterContext(room.state.room), viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
        viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
      const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 100").all(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      return { ...room, roomId, ...(offerContext ? { offerContextVersion: 1 } : {}), charter: charterContext(room.state.room), replyRequestContractVersion: REPLY_POLICY_VERSION, state: { ...room.state, eventLog: rows.reverse().map(r => JSON.parse(r.body)) }, cursor, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  charter(token, roomId, { revision, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding), room = this.room(roomId);
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) fail(422, "invalid_charter_revision", "Choose an instructions version");
      const current = charterContext(room.state.room);
      const selected = revision ?? current.revision;
      if (selected > current.revision) fail(404, "charter_not_found", "That instructions version is unavailable");
      let charter = selected === current.revision ? current.charter : null;
      if (selected > 0 && selected !== current.revision) {
        // Return one bounded event, not all discussion bodies or every version.
        // Full retained-history/checkpoint validation belongs to the recovery audit.
        const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.expectedRevision')=? LIMIT 2").all(roomId, T.ROOM_CHARTER_UPDATED, selected - 1);
        if (rows.length !== 1) fail(404, "charter_not_found", "That instructions version is unavailable");
        const event = JSON.parse(rows[0].body);
        if (event.roomId !== roomId || event.actorId !== room.state.room.ownerId) fail(409, "charter_integrity_error", "Instructions history requires reconciliation");
        charter = charterFromEvent(event, { revision: selected - 1 });
      }
      return { contractVersion: 1, roomId, evaluatedThrough: room.sequence, currentRevision: current.revision, currentEventId: current.eventId,
        ...charterContext({ charter }), viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
        viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workContext(token, roomId, workItemId, { includeSource = false, includeOffers = false, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId) || typeof includeSource !== "boolean" || typeof includeOffers !== "boolean") fail(422, "invalid_work_context", "Choose one work ID and boolean context options");
      const room = this.room(roomId), now = this.now();
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      return { ...selectedWorkContext({ state: room.state, workItemId, viewerId: auth.member.id, sequence: room.sequence, now, includeSource, includeOffers }),
        viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workDiscussion(token, roomId, workItemId, { cursor = null, since, limit, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId)) fail(422, "invalid_discussion", "Choose one work item");
      const room = this.room(roomId);
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      const window = discussionWindow({ sequence: room.sequence, roomId, workItemId, viewerId: auth.member.id, cursor, since, limit });
      const anchorId = this.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, window.horizon)?.id;
      if (!anchorId || (window.anchorId !== null && window.anchorId !== anchorId)) fail(409, "discussion_history_changed", "Discussion history changed; restart after recovery");
      const metadata = this.db.prepare("SELECT sequence,id,json_extract(body,'$.data.messageId') AS message_id FROM events WHERE room_id=? AND sequence<=? AND json_extract(body,'$.type')=? ORDER BY sequence").all(roomId, window.horizon, T.MESSAGE_POSTED);
      return { ...selectedWorkDiscussion({ state: room.state, workItemId, viewerId: auth.member.id, sequence: room.sequence,
        now: this.now(), metadata, window, anchorId, cursor }),
        viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workResult(token, roomId, workItemId, { completionEventId = null, draftMessageId = null, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId) || [completionEventId, draftMessageId].some(id => id !== null && !validId(id))
        || completionEventId !== null && draftMessageId !== null) fail(422, "invalid_result_selection", "Choose current result, one completion, or one draft");
      const room = this.room(roomId);
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      let value;
      try { value = selectedWorkResult({ db: this.db, state: room.state, workItemId, sequence: room.sequence, now: this.now(), completionEventId, draftMessageId }); }
      catch { fail(422, "result_unavailable", "Exact text evidence is unavailable; no other result was substituted"); }
      if (!value) fail(404, "result_not_found", "Completion not found on this work; no other result was substituted");
      return { ...value, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  eventsAfter(token, roomId, after = 0, limit = 100, expectedSessionBinding = null) {
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, "invalid_cursor", "Invalid event cursor or limit");
      const sequence = this.room(roomId).sequence;
      if (after > sequence) fail(409, "cursor_ahead", "Cursor exceeds room history; fetch a fresh snapshot");
      const events = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(roomId, after, limit).map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      const next = events.at(-1)?.sequence ?? after;
      return { events, next, hasMore: next < sequence };
    });
  }
  // Return-brief wiring (disposition 5557850637): one read transaction keeps the frozen
  // horizon, the cursor, the paged events, and the live projection at the same commit.
  // Fetching never acknowledges - only markCaughtUp does, explicitly.
  returnBrief(token, roomId, { horizon = null, after = null, cursor: frozenCursor = null, limit = RETURN_BRIEF_DEFAULT_LIMIT, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const room = this.room(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      const { H, startAfter, C, limit: pageLimit } = resolveHistoryWindow({ sequence: room.sequence, storedCursor: cursor, horizon, after, continuationCursor: frozenCursor, limit });
      const rows = this.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?").all(roomId, startAfter, H, pageLimit)
        .map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      return { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null, ...buildReturnBrief({ sequence: room.sequence, workItems: room.state.workItems, rows, H, startAfter, C, memberId: auth.member.id }) };
    });
  }
  markCaughtUp(token, roomId, sequence, expectedSessionBinding = null) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.room(roomId).sequence) fail(422, "invalid_cursor", "Invalid caught-up cursor");
      this.db.prepare("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(room_id,member_id) DO UPDATE SET sequence=max(cursors.sequence,excluded.sequence)").run(roomId, auth.member.id, sequence);
      return { cursor: this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id).sequence };
    });
  }
  command(token, roomId, command, expectedSessionBinding = null) {
    validateCommand(command);
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const fingerprint = hash(canonical(command));
      const prior = this.db.prepare("SELECT c.fingerprint,e.sequence,e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.actor_id=? AND c.id=?").get(roomId, auth.member.id, command.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Command ID already used for different content");
        return { sequence: prior.sequence, event: JSON.parse(prior.body), duplicate: true };
      }
      if (command.causationId && !this.db.prepare("SELECT 1 FROM events WHERE room_id=? AND id=?").get(roomId, command.causationId)) fail(422, "invalid_cause", "Causation event must exist in this room");
      const room = this.room(roomId);
      const target = room.state.members[command.data.memberId];
      const endingAccess = command.type === T.MEMBER_ACCESS_CHANGED && target?.active === true && command.data.active === false
        && canonical(target.permissions) === canonical(command.data.permissions);
      const requestMode = command.type === T.MESSAGE_POSTED && replyPostMode(command.data);
      const endingRequest = (requestMode === "respond" || command.type === T.REPLY_REQUEST_CANCELLED)
        && room.state.replyRequests?.[command.data.responseToRequestId ?? command.data.requestMessageId]?.status === "open";
      const endingHelp = command.type === T.WORK_HELP_UPDATED && command.data.status === "withdrawn"
        && room.state.workItems[command.data.workItemId]?.helpWanted?.status === "open";
      const priorOffer = room.state.helpOffers?.[command.data.offerId];
      const endingOffer = command.type === HELP_OFFER_UPDATED &&
        (priorOffer?.status === "offered" && ["declined", "withdrawn"].includes(command.data.status)
          || priorOffer?.status === "selected" && command.data.status === "released");
      const cleanup = endingAccess || endingRequest || endingHelp || endingOffer;
      // At capacity, each remaining membership/request/invitation can still be ended once.
      if ((room.sequence >= 10000 && !cleanup) || (command.type === T.MEMBER_ADDED && Object.keys(room.state.members).length >= 100) || (command.type === T.WORK_PROPOSED && Object.keys(room.state.workItems).length >= 500)) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const memberAuthorityEvent = [T.MEMBER_ADDED, T.MEMBER_ACCESS_CHANGED].includes(command.type);
      const incoming = event({
        type: command.type, roomId, actorId: auth.member.id, at: new Date(this.now()).toISOString(),
        idempotencyKey: hash(`${auth.member.id}:${command.id}`), causationId: command.causationId,
        data: memberAuthorityEvent ? { ...command.data, authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION }
          : requestMode ? { ...command.data, requestPolicyVersion: REPLY_POLICY_VERSION } : command.data
      });
      let state;
      try {
        if (requestMode === "respond") {
          const basis = this.db.prepare("SELECT id,body FROM events WHERE room_id=? AND sequence=?").get(roomId, command.data.contextSequence);
          if (basis?.id !== command.data.contextEventId || JSON.parse(basis.body).type !== T.MESSAGE_POSTED) throw new Error("Stale reply request context sequence");
        }
        state = compact(applyEvent(room.state, incoming));
        if (incoming.type === T.WORK_COMPLETED && incoming.data.evidenceKind === "room_text") verifyTextCompletion(this.db, room.state, room.state.workItems[incoming.data.workItemId], incoming.data);
      }
      catch (error) { fail(/Stale|already exists|Invalid transition|capacity reached|already_offered|helper_selected|history_full|offer_limit|Offer transition unavailable/.test(error.message) ? 409 : 422, "command_rejected", error.message); }
      if (incoming.type === T.CLAIM_ACQUIRED) {
        // Same transaction as actor/revision validation and persistence. Keeping
        // this live-only preserves replay of previously accepted reservations.
        const conflict = conflictingClaim(room.state.workItems, state.workItems[incoming.data.workItemId], Date.parse(incoming.at));
        if (conflict) fail(409, "claim_conflict", `Scope is reserved by work ${conflict.id}. Coordinate or release that reservation first; no new claim was saved.`);
      }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024 && !cleanup) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, command.id, fingerprint, sequence);
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
      if (command.data.workItemId) this.reminders.resolveWork(roomId, state.workItems[command.data.workItemId]);
      if (command.type === T.MEMBER_ACCESS_CHANGED) this.agentConnections.revokeMember(roomId, command.data.memberId);
      if (command.type === T.MEMBER_ACCESS_CHANGED && command.data.active === false) {
        this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, command.data.memberId);
        this.reminders.retireMember(roomId, command.data.memberId);
      }
      return { sequence, event: incoming, duplicate: false };
    });
  }
}
