import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T, validId } from "../src/events.js";
import { buildReturnBrief, resolveHistoryWindow, RETURN_BRIEF_DEFAULT_LIMIT } from "./return-brief.mjs";

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
const compact = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
const work = "workItemId expectedRevision";
const shapes = {
  [T.MEMBER_ADDED]: "memberId displayName kind permissions accountableHumanId",
  [T.MEMBER_ACCESS_CHANGED]: "memberId expectedMemberRevision permissions active",
  [T.MESSAGE_POSTED]: "messageId body workItemId replyToId toMemberId",
  [T.MESSAGE_REACTION_SET]: "messageId reaction active",
  [T.WORK_PROPOSED]: "workItemId title definitionOfDone accountableMemberId verifierMemberId independentVerificationRequired ownerDecisionRequired humanDecisionMakerId mode sourceMessageId",
  [T.WORK_ACCEPTED]: work,
  [T.WORK_STARTED]: `${work} resolvedBlocker`,
  [T.WORK_BLOCKED]: `${work} reason nextAction`,
  [T.WORK_BLOCKER_RESOLVED]: `${work} resolution`,
  [T.WORK_COMPLETED]: `${work} summary evidenceUrl evidenceVersion nextAction checksClaimed producerId`,
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
    const type = ["expectedRevision", "expectedMemberRevision"].includes(name) ? "number" : ["active", "independentVerificationRequired", "ownerDecisionRequired"].includes(name) ? "boolean" : ["permissions", "paths", "checksClaimed"].includes(name) ? "array" : "string";
    if (type === "array" ? !Array.isArray(value) : typeof value !== type) fail(422, "invalid_command", `Invalid field: ${name}`);
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 16384) fail(413, "too_large", "Command is too large");
}

export class RoomStore {
  constructor(filename, { now = () => Date.now() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(filename);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    const supported = new Set([0, 1, 2, 3]);
    const hasSchema = version === 0 && Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get());
    if (!supported.has(version) || hasSchema) {
      this.db.close();
      throw new Error(version > 3 ? "Database schema is newer than this service" : "Database schema version is unsupported");
    }
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
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
      PRAGMA user_version=3; COMMIT;`);
    this.repairProjectionProvenance({ upgradeV1: version === 1 });
    if (version === 1 || version === 2) this.migrateIdentityV3(version);
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
      this.db.exec("PRAGMA user_version=3");
    });
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
      if (upgradeV1) this.db.exec("PRAGMA user_version=2");
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  readTransaction(fn) {
    this.db.exec("BEGIN");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  room(roomId) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    return { sequence: row.sequence, state: JSON.parse(row.projection) };
  }
  rebuildProjection(roomId) {
    const room = this.room(roomId);
    const checkpoint = this.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(roomId);
    let state = checkpoint ? JSON.parse(checkpoint.projection) : emptyRoomState();
    let sequence = checkpoint?.sequence ?? 0;
    const rows = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence").all(roomId, sequence);
    for (const row of rows) {
      if (row.sequence !== sequence + 1) throw new Error("Event sequence is not contiguous");
      state = applyEvent(state, JSON.parse(row.body));
      sequence = row.sequence;
    }
    if (sequence !== room.sequence) throw new Error("Event sequence does not reach the room projection");
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
      this.db.prepare("INSERT INTO account_access_events(account_id,revision,active,auth_epoch,reason,at) VALUES(?,?,?,?,?,?)").run(accountId, revision, active ? 1 : 0, authEpoch, reason.trim(), at);
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
  authenticate(token, roomId) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, "unauthenticated", "Sign in with an active room key");
    const row = this.db.prepare(`SELECT c.*, p.revoked AS parent_revoked, p.expires_at AS parent_expiry, p.account_id AS parent_account_id, p.account_auth_epoch AS parent_account_auth_epoch,
      m.account_id AS bound_account_id, a.active AS account_active, a.revision AS account_revision, a.auth_epoch AS current_account_auth_epoch
      FROM credentials c LEFT JOIN credentials p ON p.hash=c.parent_hash
      LEFT JOIN member_accounts m ON m.room_id=c.room_id AND m.member_id=c.member_id
      LEFT JOIN accounts a ON a.id=m.account_id WHERE c.hash=?`).get(hash(token));
    if (!row || row.revoked || row.expires_at <= this.now() || (row.parent_hash && (row.parent_revoked !== 0 || row.parent_expiry <= this.now()))) fail(401, "unauthenticated", "Session or key expired or revoked");
    if (roomId && row.room_id !== roomId) fail(403, "access_denied", "This credential does not grant access to that room");
    const members = this.room(row.room_id).state.members;
    const member = Object.hasOwn(members, row.member_id) && members[row.member_id];
    if (!member || member.active === false) fail(403, "access_denied", "Room membership is inactive");
    let account = null;
    if (member.kind === "human") {
      const invalidAccount = !row.account_id || row.account_id !== row.bound_account_id || row.account_active !== 1
        || row.account_auth_epoch !== row.current_account_auth_epoch
        || (row.parent_hash && (row.parent_account_id !== row.account_id || row.parent_account_auth_epoch !== row.account_auth_epoch));
      if (invalidAccount) fail(401, "unauthenticated", "Session or key expired, revoked, or account access ended");
      account = { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch };
    } else if (row.account_id !== null || row.account_auth_epoch !== null) fail(401, "unauthenticated", "Agent credential has an invalid human account binding");
    return {
      account, member, roomId: row.room_id, credentialHash: row.hash, kind: row.kind, expiresAt: row.expires_at,
      csrf: row.kind === "session" ? hash(`csrf:${token}`) : null,
      sessionBinding: row.kind === "session" ? hash(`session-binding:${token}`) : null
    };
  }
  createSession(accessKey) {
    return this.transaction(() => {
      const auth = this.authenticate(accessKey);
      if (auth.kind !== "access" || auth.member.kind !== "human") fail(403, "access_denied", "Browser sessions require a human access key");
      const token = this.insertCredential(auth.roomId, auth.member.id, "session", auth.credentialHash, Math.min(auth.expiresAt, this.now() + 8 * 3600000));
      return { token, session: this.authenticate(token) };
    });
  }
  revoke(token) { this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(token)); }
  snapshot(token, roomId) {
    // One read transaction keeps sequence, projection, and audit tail at the same commit.
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      const room = this.room(roomId);
      const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 100").all(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      return { ...room, roomId, state: { ...room.state, eventLog: rows.reverse().map(r => JSON.parse(r.body)) }, cursor, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding };
    });
  }
  eventsAfter(token, roomId, after = 0, limit = 100) {
    return this.readTransaction(() => {
      this.authenticate(token, roomId);
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
  returnBrief(token, roomId, { horizon = null, after = null, cursor: frozenCursor = null, limit = RETURN_BRIEF_DEFAULT_LIMIT } = {}) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      const room = this.room(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      const { H, startAfter, C, limit: pageLimit } = resolveHistoryWindow({ sequence: room.sequence, storedCursor: cursor, horizon, after, continuationCursor: frozenCursor, limit });
      const rows = this.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?").all(roomId, startAfter, H, pageLimit)
        .map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      return { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, ...buildReturnBrief({ sequence: room.sequence, workItems: room.state.workItems, rows, H, startAfter, C, memberId: auth.member.id }) };
    });
  }
  markCaughtUp(token, roomId, sequence) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.room(roomId).sequence) fail(422, "invalid_cursor", "Invalid caught-up cursor");
      this.db.prepare("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(room_id,member_id) DO UPDATE SET sequence=max(cursors.sequence,excluded.sequence)").run(roomId, auth.member.id, sequence);
      return { cursor: this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id).sequence };
    });
  }
  command(token, roomId, command) {
    validateCommand(command);
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      const fingerprint = hash(canonical(command));
      const prior = this.db.prepare("SELECT c.fingerprint,e.sequence,e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.actor_id=? AND c.id=?").get(roomId, auth.member.id, command.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Command ID already used for different content");
        return { sequence: prior.sequence, event: JSON.parse(prior.body), duplicate: true };
      }
      if (command.causationId && !this.db.prepare("SELECT 1 FROM events WHERE room_id=? AND id=?").get(roomId, command.causationId)) fail(422, "invalid_cause", "Causation event must exist in this room");
      const room = this.room(roomId);
      if (room.sequence >= 10000 || (command.type === T.MEMBER_ADDED && Object.keys(room.state.members).length >= 100) || (command.type === T.WORK_PROPOSED && Object.keys(room.state.workItems).length >= 500)) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const incoming = event({ type: command.type, roomId, actorId: auth.member.id, at: new Date(this.now()).toISOString(), idempotencyKey: hash(`${auth.member.id}:${command.id}`), causationId: command.causationId, data: command.data });
      let state;
      try { state = compact(applyEvent(room.state, incoming)); }
      catch (error) { fail(/Stale|already exists|Invalid transition/.test(error.message) ? 409 : 422, "command_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, command.id, fingerprint, sequence);
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
      if (command.type === T.MEMBER_ACCESS_CHANGED && command.data.active === false) this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, command.data.memberId);
      return { sequence, event: incoming, duplicate: false };
    });
  }
}
