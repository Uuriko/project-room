// One append journal, one config block per kind. Schema SQL, hash inputs, id
// text, and JSON column bytes stay the historical per-kind formats, so a
// database written by the old modules opens here with no migration.
//
// Kinds that only record decisions (invitation, membership delegation, Jev
// shadow, SLA breach) append. Channel updates and spam quarantine also move
// a row through a fixed status list. Graph reply is the same idea in memory:
// the stored record is the JSON of the transition result.
import { createHash } from "node:crypto";
import { INVITATION_ROLE_POLICIES, validId } from "../src/events.js";
import { emailInput, emailOpaqueId, exactEmailFields } from "./email-envelope.mjs";
import { compareReplyEnvelope, compareReplyUpdateEnvelope, replyObservationReviewable } from "./graph-reply-draft.mjs";
import { inspectUpdate } from "./graph-reply-update-review.mjs";
import { ServiceError } from "./service-error.mjs";

export { replyObservationReviewable };

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const boundedText = (value, limit, field, code) => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    fail(422, code, `${field} must be a 1..${limit} character string`);
  return value;
};
const textOf = (value, limit, field, code, { optional = false } = {}) => {
  if (value === null || value === undefined) {
    if (optional) return null;
    fail(422, code, `${field} is required`);
  }
  return boundedText(value, limit, field, code);
};
const normalizeSql = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
// Same comparison the channel and Jev journals used: a wholly missing schema
// may be absent on a read-only open; a partial schema does not match.
function verifyCreateSchema(db, schema, error, { allowAbsent = false } = {}) {
  const expected = schema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({
    sql, actual: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z0-9_]+)/.exec(sql.trim())[1])?.sql
  }));
  if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
  for (const { sql, actual } of expected) if (normalizeSql(actual) !== normalizeSql(sql)) throw new Error(error);
  return true;
}
const nextSerial = (db, sql, ...params) => db.prepare(sql).get(...params).next + 1;

class JournalBase {
  constructor(store) { this.store = store; this.db = store.db; }
}

// --- channel updates -------------------------------------------------------

export const channelJournalLimits = Object.freeze({ maxAttempts: 5, payloadBytes: 65536, errorChars: 200, batch: 500 });
export const channelJournalStatuses = Object.freeze(["pending", "imported", "failed"]);
export const channelJournalSchema = `
  CREATE TABLE IF NOT EXISTS pending_channel_updates (
    account_id TEXT NOT NULL, connection_id TEXT NOT NULL, update_id INTEGER NOT NULL,
    received_at INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    status TEXT NOT NULL CHECK(status IN ('pending','imported','failed')),
    attempts INTEGER NOT NULL CHECK(attempts >= 0), last_error TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,connection_id,update_id),
    FOREIGN KEY(account_id,connection_id) REFERENCES private_email_connections(account_id,id)
  );
  CREATE INDEX IF NOT EXISTS pending_channel_updates_status ON pending_channel_updates(account_id,connection_id,status,update_id);
`;
const channelView = row => ({ updateId: row.update_id, receivedAt: row.received_at, status: row.status, attempts: row.attempts,
  lastError: row.last_error, updatedAt: row.updated_at, payload: JSON.parse(row.payload) });
const channelFail = message => fail(422, "invalid_channel_update", message);
const channelScope = (accountId, connectionId) => { if (!validId(accountId) || !validId(connectionId)) channelFail("Supply a connection."); };
const channelUpdateIds = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > channelJournalLimits.batch || !ids.every(id => Number.isSafeInteger(id) && id >= 0))
    channelFail("Supply provider update IDs.");
  return [...new Set(ids)];
};

export class ChannelUpdateJournal extends JournalBase {
  verifySchema(options) { return verifyCreateSchema(this.db, channelJournalSchema, "Channel update journal schema requires operator reconciliation", options); }
  verify() {
    return this.store.readTransaction(() => {
      const counts = { pending: 0, imported: 0, failed: 0 };
      for (const row of this.db.prepare("SELECT * FROM pending_channel_updates").all()) {
        const payload = JSON.parse(row.payload);
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.update_id !== row.update_id
          || !channelJournalStatuses.includes(row.status) || row.attempts > channelJournalLimits.maxAttempts
          || (row.status === "failed") !== (row.attempts >= channelJournalLimits.maxAttempts)
          || (row.attempts > 0 && row.status !== "imported" && typeof row.last_error !== "string")
          || row.updated_at < row.received_at) throw new Error("Channel update journal requires operator reconciliation");
        counts[row.status]++;
      }
      return counts;
    });
  }
  summary(accountId, connectionId) {
    channelScope(accountId, connectionId);
    const counts = { pending: 0, imported: 0, failed: 0 };
    for (const row of this.db.prepare("SELECT status,count(*) n FROM pending_channel_updates WHERE account_id=? AND connection_id=? GROUP BY status").all(accountId, connectionId)) counts[row.status] = row.n;
    return counts;
  }
  // Idempotent by update id. `rejected` parks those ids as failed at the
  // attempt bound so they never enter the backlog. One row per statement:
  // a legal batch is 500 ids, and an IN list exceeds Durable Object SQL's
  // 100-bind limit.
  record(accountId, connectionId, updates, { backlog, rejected = new Map() }) {
    channelScope(accountId, connectionId);
    if (!Array.isArray(updates) || !updates.length) channelFail("Supply provider updates.");
    return this.store.transaction(() => {
      const now = this.store.now();
      const insert = this.db.prepare("INSERT INTO pending_channel_updates (account_id,connection_id,update_id,received_at,payload,status,attempts,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,connection_id,update_id) DO NOTHING");
      let accepted = 0, parked = 0;
      for (const update of updates) {
        if (!update || typeof update !== "object" || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0)
          channelFail("Supply provider update objects.");
        const payload = JSON.stringify(update);
        if (Buffer.byteLength(payload) > channelJournalLimits.payloadBytes) channelFail("Update is too large.");
        const code = rejected.get(update.update_id);
        const written = code === undefined
          ? insert.run(accountId, connectionId, update.update_id, now, payload, "pending", 0, null, now).changes
          : insert.run(accountId, connectionId, update.update_id, now, payload, "failed", channelJournalLimits.maxAttempts, String(code).slice(0, channelJournalLimits.errorChars), now).changes;
        accepted += written; if (code !== undefined) parked += written;
      }
      const pending = this.summary(accountId, connectionId).pending;
      if (pending > backlog) fail(409, "channel_webhook_backlog", "Import pending updates before sending more.");
      return { received: updates.length, accepted, rejected: parked, pending };
    });
  }
  pending(accountId, connectionId, { limit = null } = {}) {
    channelScope(accountId, connectionId);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) channelFail("Supply a positive page size.");
    return this.store.readTransaction(() => this.db.prepare("SELECT * FROM pending_channel_updates WHERE account_id=? AND connection_id=? AND status='pending' ORDER BY update_id LIMIT ?")
      .all(accountId, connectionId, limit ?? -1).map(channelView));
  }
  imported(accountId, connectionId, ids) {
    channelScope(accountId, connectionId);
    const unique = channelUpdateIds(ids);
    return this.store.transaction(() => {
      const now = this.store.now();
      const update = this.db.prepare("UPDATE pending_channel_updates SET status='imported',updated_at=? WHERE account_id=? AND connection_id=? AND status='pending' AND update_id=?");
      let changes = 0;
      for (const id of unique) changes += update.run(now, accountId, connectionId, id).changes;
      return changes;
    });
  }
  failed(accountId, connectionId, ids, error) {
    channelScope(accountId, connectionId);
    const unique = channelUpdateIds(ids);
    const message = String(error?.code ?? error?.message ?? error ?? "unknown").slice(0, channelJournalLimits.errorChars);
    return this.store.transaction(() => {
      const now = this.store.now();
      const update = this.db.prepare(`UPDATE pending_channel_updates SET attempts=attempts+1,last_error=?,updated_at=?,
        status=CASE WHEN attempts+1>=${channelJournalLimits.maxAttempts} THEN 'failed' ELSE 'pending' END
        WHERE account_id=? AND connection_id=? AND update_id=? AND status='pending'`);
      let retried = 0;
      for (const id of unique) retried += update.run(message, now, accountId, connectionId, id).changes;
      const failedIds = new Set(this.db.prepare("SELECT update_id FROM pending_channel_updates WHERE account_id=? AND connection_id=? AND status='failed'")
        .all(accountId, connectionId).map(row => row.update_id));
      return { attempted: retried, exhausted: unique.filter(id => failedIds.has(id)).length, error: message };
    });
  }
}

// --- spam quarantine -------------------------------------------------------

export const spamQuarantineLimits = Object.freeze({ reasonBytes: 8192, noteChars: 2048, batch: 500,
  messageIdChars: 512, channelChars: 128, connectionIdChars: 256, reviewerChars: 256,
  accountIdChars: 256, sourceIdChars: 256 });
export const spamQuarantineStatuses = Object.freeze(["held", "released", "dismissed"]);
export const spamQuarantineDecisions = Object.freeze(["release", "confirm_spam"]);
export const spamQuarantineSchema = `
  CREATE TABLE IF NOT EXISTS spam_quarantine (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT,
    account_id TEXT, source_id TEXT,
    reason TEXT NOT NULL CHECK(json_valid(reason)),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    quarantined_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held','released','dismissed')),
    reviewed_by TEXT, reviewed_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spam_quarantine_held ON spam_quarantine(status, quarantined_at);
`;
const spamView = row => ({ id: row.id, messageId: row.message_id, channel: row.channel, connectionId: row.connection_id,
  accountId: row.account_id ?? null, sourceId: row.source_id ?? null,
  reason: JSON.parse(row.reason), score: row.score, quarantinedAt: row.quarantined_at, status: row.status,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, note: row.note, updatedAt: row.updated_at });
// ALTER TABLE appends columns, so a database created before account_id and
// source_id keeps those names at the end. Fresh creates use the order in
// spamQuarantineSchema. verifySchema compares the name set, not the order.
export function migrateSpamQuarantineColumns(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='spam_quarantine'").get()) return;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('spam_quarantine')").all().map(row => row.name));
  for (const column of ["account_id", "source_id"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE spam_quarantine ADD COLUMN ${column} TEXT`);
  }
}
const quarantineColumns = schema => {
  const body = schema.trim().split(";")[0];
  const inner = body.slice(body.indexOf("(") + 1, body.lastIndexOf(")"));
  const parts = []; let depth = 0, current = "";
  for (const char of inner) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
};
const spamFlag = flag => {
  if (!flag || typeof flag !== "object" || Array.isArray(flag) || typeof flag.score !== "number"
    || !Number.isInteger(flag.score) || flag.score < 0 || flag.score > 100
    || !Array.isArray(flag.signals) || flag.quarantine !== true)
    fail(422, "invalid_quarantine", "flag must be a flagMessage() result with quarantine true");
  const reason = flag.signals.map(signal => {
    if (!signal || typeof signal !== "object" || typeof signal.key !== "string" || typeof signal.weight !== "number" || typeof signal.detail !== "string")
      fail(422, "invalid_quarantine", "flag signals must be {key, weight, detail}");
    return { key: signal.key, weight: signal.weight, detail: signal.detail };
  });
  if (Buffer.byteLength(JSON.stringify(reason)) > spamQuarantineLimits.reasonBytes)
    fail(422, "invalid_quarantine", "flag signals are too large to journal");
  return { reason, score: flag.score };
};

export class SpamQuarantineJournal extends JournalBase {
  verifySchema({ allowAbsent = false } = {}) {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='spam_quarantine'").get()?.sql;
    const index = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='spam_quarantine_held'").get()?.sql;
    if (allowAbsent && table === undefined && index === undefined) return false;
    if (table === undefined || index === undefined) throw new Error("Spam quarantine journal schema requires operator reconciliation");
    const actualColumns = this.db.prepare("SELECT name FROM pragma_table_info('spam_quarantine')").all().map(row => row.name);
    const sorted = names => [...names].sort().join(",");
    if (sorted(actualColumns) !== sorted(quarantineColumns(spamQuarantineSchema)))
      throw new Error("Spam quarantine journal schema requires operator reconciliation");
    if (normalizeSql(index) !== normalizeSql("CREATE INDEX spam_quarantine_held ON spam_quarantine(status, quarantined_at)"))
      throw new Error("Spam quarantine journal schema requires operator reconciliation");
    return true;
  }
  verify() {
    return this.store.readTransaction(() => {
      const counts = { held: 0, released: 0, dismissed: 0 };
      for (const row of this.db.prepare("SELECT * FROM spam_quarantine").all()) {
        if (!/^qz-[1-9][0-9]*$/.test(row.id) || !spamQuarantineStatuses.includes(row.status)
          || !Number.isInteger(row.score) || row.score < 0 || row.score > 100
          || row.quarantined_at <= 0 || row.updated_at < row.quarantined_at) throw new Error("Spam quarantine journal requires operator reconciliation");
        for (const [column, limit] of [["account_id", spamQuarantineLimits.accountIdChars], ["source_id", spamQuarantineLimits.sourceIdChars]]) {
          const value = row[column];
          if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > limit))
            throw new Error("Spam quarantine journal requires operator reconciliation");
        }
        let reason; try { reason = JSON.parse(row.reason); } catch { throw new Error("Spam quarantine journal requires operator reconciliation"); }
        if (!Array.isArray(reason) || !reason.every(signal => signal && typeof signal === "object" && typeof signal.key === "string" && typeof signal.weight === "number" && typeof signal.detail === "string"))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        const reviewed = row.status !== "held";
        if ((reviewed ? typeof row.reviewed_by !== "string" || !row.reviewed_by.length || !Number.isInteger(row.reviewed_at) || row.reviewed_at < row.quarantined_at
            : row.reviewed_by !== null || row.reviewed_at !== null || row.note !== null))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        if (row.note !== null && (typeof row.note !== "string" || row.note.length > spamQuarantineLimits.noteChars))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        counts[row.status]++;
      }
      return counts;
    });
  }
  quarantine({ messageId, channel, connectionId = null, accountId = null, sourceId = null, flag, at = null }) {
    boundedText(messageId, spamQuarantineLimits.messageIdChars, "messageId", "invalid_quarantine");
    boundedText(channel, spamQuarantineLimits.channelChars, "channel", "invalid_quarantine");
    if (connectionId !== null && connectionId !== undefined) boundedText(connectionId, spamQuarantineLimits.connectionIdChars, "connectionId", "invalid_quarantine");
    if (accountId !== null && accountId !== undefined) boundedText(accountId, spamQuarantineLimits.accountIdChars, "accountId", "invalid_quarantine");
    if (sourceId !== null && sourceId !== undefined) boundedText(sourceId, spamQuarantineLimits.sourceIdChars, "sourceId", "invalid_quarantine");
    const { reason, score } = spamFlag(flag);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_quarantine", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const id = `qz-${nextSerial(this.db, "SELECT COALESCE(MAX(CAST(SUBSTR(id,4) AS INTEGER)),0) next FROM spam_quarantine")}`;
      this.db.prepare("INSERT INTO spam_quarantine (id,message_id,channel,connection_id,account_id,source_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, messageId, channel, connectionId ?? null, accountId ?? null, sourceId ?? null, JSON.stringify(reason), score, now, "held", null, null, null, now);
      return spamView(this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id));
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_quarantine", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id);
      return row ? spamView(row) : null;
    });
  }
  held(options) { return this.list({ status: "held", ...options }); }
  list({ status = "held", limit = null } = {}) {
    if (!spamQuarantineStatuses.includes(status)) fail(422, "invalid_quarantine", "status must be held, released or dismissed");
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail(422, "invalid_quarantine", "Supply a positive page size.");
    return this.store.readTransaction(() => this.db
      .prepare(`SELECT * FROM spam_quarantine WHERE status=? ORDER BY quarantined_at ${status === "held" ? "ASC" : "DESC"} LIMIT ?`)
      .all(status, limit ?? -1).map(spamView));
  }
  counts() {
    return this.store.readTransaction(() => {
      const counts = { held: 0, released: 0, dismissed: 0 };
      for (const row of this.db.prepare("SELECT status,count(*) n FROM spam_quarantine GROUP BY status").all()) counts[row.status] = row.n;
      return counts;
    });
  }
  release(id, review) { return this.#transition(id, "released", review); }
  dismiss(id, review) { return this.#transition(id, "dismissed", review); }
  review(id, { decision, reviewer, note = null } = {}) {
    if (!spamQuarantineDecisions.includes(decision)) fail(422, "invalid_quarantine", "decision must be release or confirm_spam");
    return decision === "release" ? this.release(id, { reviewer, note }) : this.dismiss(id, { reviewer, note });
  }
  #transition(id, status, { reviewer, note = null } = {}) {
    if (typeof id !== "string") fail(422, "invalid_quarantine", "id must be a string");
    boundedText(reviewer, spamQuarantineLimits.reviewerChars, "reviewer", "invalid_quarantine");
    if (note !== null && (typeof note !== "string" || note.length > spamQuarantineLimits.noteChars))
      fail(422, "invalid_quarantine", `note must be text up to ${spamQuarantineLimits.noteChars} chars`);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id);
      if (!row) fail(404, "unknown_quarantine", `unknown quarantine id "${id}"`);
      if (row.status !== "held") fail(409, "quarantine_already_reviewed", `quarantine "${id}" is already ${row.status}; reviews are final`);
      const now = this.store.now();
      this.db.prepare("UPDATE spam_quarantine SET status=?,reviewed_by=?,reviewed_at=?,note=?,updated_at=? WHERE id=?").run(status, reviewer, now, note, now, id);
      return spamView(this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id));
    });
  }
}

// --- Jev shadow decisions --------------------------------------------------

export const jevShadowLimits = Object.freeze({
  roomIdChars: 384, identityIdChars: 256, subjectChars: 256, ipHashChars: 128,
  pathChars: 128, decisionChars: 32, signalsBytes: 16384, batch: 500,
});
export const jevShadowGates = Object.freeze(["admission", "receipt"]);
export const jevShadowDecisions = Object.freeze(["admit", "review", "reject", "accept", "request-changes", "escalate"]);
export const jevShadowSchema = `
  CREATE TABLE IF NOT EXISTS jev_shadow_decisions (
    id TEXT PRIMARY KEY,
    gate TEXT NOT NULL CHECK(gate IN ('admission','receipt')),
    room_id TEXT NOT NULL,
    identity_id TEXT,
    subject TEXT,
    ip_hash TEXT,
    path TEXT NOT NULL,
    score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
    decision TEXT NOT NULL,
    escalate INTEGER NOT NULL CHECK(escalate IN (0,1)),
    signals TEXT NOT NULL CHECK(json_valid(signals)),
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jev_shadow_by_room ON jev_shadow_decisions(room_id, recorded_at);
  CREATE INDEX IF NOT EXISTS jev_shadow_velocity ON jev_shadow_decisions(recorded_at, identity_id, ip_hash);
`;
const jevView = row => ({ id: row.id, gate: row.gate, roomId: row.room_id,
  identityId: row.identity_id ?? null, subject: row.subject ?? null, ipHash: row.ip_hash ?? null,
  path: row.path, score: row.score, decision: row.decision, escalate: row.escalate === 1,
  signals: JSON.parse(row.signals), recordedAt: row.recorded_at });
const jevSignals = signals => {
  if (!Array.isArray(signals)) fail(422, "invalid_jev_shadow", "signals must be an array");
  for (const signal of signals) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)
      || typeof signal.key !== "string" || typeof signal.weight !== "number"
      || typeof signal.value !== "number" || typeof signal.detail !== "string")
      fail(422, "invalid_jev_shadow", "signals must be {key, weight, value, detail}");
  }
  if (Buffer.byteLength(JSON.stringify(signals)) > jevShadowLimits.signalsBytes)
    fail(422, "invalid_jev_shadow", "signals are too large to journal");
  return signals;
};

export class JevShadowJournal extends JournalBase {
  verifySchema(options) { return verifyCreateSchema(this.db, jevShadowSchema, "Jev shadow journal schema requires operator reconciliation", options); }
  verify() {
    return this.store.readTransaction(() => {
      const counts = { admission: 0, receipt: 0, escalate: 0 };
      for (const row of this.db.prepare("SELECT * FROM jev_shadow_decisions").all()) {
        if (!/^(jad|jrd)-[1-9][0-9]*$/.test(row.id) || !jevShadowGates.includes(row.gate) || !jevShadowDecisions.includes(row.decision)
          || typeof row.score !== "number" || row.score < 0 || row.score > 1 || ![0, 1].includes(row.escalate) || row.recorded_at <= 0)
          throw new Error("Jev shadow journal requires operator reconciliation");
        if ((row.gate === "admission") !== row.id.startsWith("jad-")) throw new Error("Jev shadow journal requires operator reconciliation");
        let signals; try { signals = JSON.parse(row.signals); } catch { throw new Error("Jev shadow journal requires operator reconciliation"); }
        jevSignals(signals);
        counts[row.gate]++;
        if (row.escalate === 1) counts.escalate++;
      }
      return counts;
    });
  }
  // Ids are jad-<n> / jrd-<n>. The counter is the max suffix already stored
  // for that prefix, so a restart does not reuse or skip an id.
  record({ gate, roomId, identityId = null, subject = null, ipHash = null, path, score, decision, escalate = false, signals = [], at = null }) {
    if (!jevShadowGates.includes(gate)) fail(422, "invalid_jev_shadow", "gate must be admission or receipt");
    textOf(roomId, jevShadowLimits.roomIdChars, "roomId", "invalid_jev_shadow");
    if (identityId !== null && identityId !== undefined) textOf(identityId, jevShadowLimits.identityIdChars, "identityId", "invalid_jev_shadow");
    if (subject !== null && subject !== undefined) textOf(subject, jevShadowLimits.subjectChars, "subject", "invalid_jev_shadow");
    if (ipHash !== null && ipHash !== undefined) textOf(ipHash, jevShadowLimits.ipHashChars, "ipHash", "invalid_jev_shadow");
    textOf(path, jevShadowLimits.pathChars, "path", "invalid_jev_shadow");
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) fail(422, "invalid_jev_shadow", "score must be 0..1");
    if (!jevShadowDecisions.includes(decision)) fail(422, "invalid_jev_shadow", `decision must be one of ${jevShadowDecisions.join(", ")}`);
    if (typeof escalate !== "boolean") fail(422, "invalid_jev_shadow", "escalate must be a boolean");
    jevSignals(signals);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_jev_shadow", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const prefix = gate === "admission" ? "jad-" : "jrd-";
      const id = `${prefix}${nextSerial(this.db, "SELECT COALESCE(MAX(CAST(SUBSTR(id,5) AS INTEGER)),0) next FROM jev_shadow_decisions WHERE id LIKE ?", `${prefix}%`)}`;
      this.db.prepare(`INSERT INTO jev_shadow_decisions
        (id,gate,room_id,identity_id,subject,ip_hash,path,score,decision,escalate,signals,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, gate, roomId, identityId ?? null, subject ?? null, ipHash ?? null, path, score, decision, escalate ? 1 : 0, JSON.stringify(signals), now);
      return jevView(this.db.prepare("SELECT * FROM jev_shadow_decisions WHERE id=?").get(id));
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_jev_shadow", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM jev_shadow_decisions WHERE id=?").get(id);
      return row ? jevView(row) : null;
    });
  }
  list({ gate = null, roomId = null, escalate = null, limit = 50 } = {}) {
    if (gate !== null && !jevShadowGates.includes(gate)) fail(422, "invalid_jev_shadow", "gate must be admission or receipt");
    if (roomId !== null) textOf(roomId, jevShadowLimits.roomIdChars, "roomId", "invalid_jev_shadow");
    if (escalate !== null && typeof escalate !== "boolean") fail(422, "invalid_jev_shadow", "escalate must be a boolean or null");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > jevShadowLimits.batch)
      fail(422, "invalid_jev_shadow", `limit must be 1..${jevShadowLimits.batch}`);
    return this.store.readTransaction(() => this.db.prepare(
      `SELECT * FROM jev_shadow_decisions
       WHERE (? IS NULL OR gate=?) AND (? IS NULL OR room_id=?) AND (? IS NULL OR escalate=?)
       ORDER BY recorded_at DESC, id DESC LIMIT ?`)
      .all(gate, gate, roomId, roomId, escalate === null ? null : 1, escalate === null ? null : (escalate ? 1 : 0), limit).map(jevView));
  }
  counts({ roomId = null } = {}) {
    if (roomId !== null) textOf(roomId, jevShadowLimits.roomIdChars, "roomId", "invalid_jev_shadow");
    return this.store.readTransaction(() => {
      const counts = { admission: 0, receipt: 0, escalate: 0 };
      for (const row of this.db.prepare("SELECT gate,escalate,count(*) n FROM jev_shadow_decisions WHERE (? IS NULL OR room_id=?) GROUP BY gate,escalate").all(roomId, roomId)) {
        counts[row.gate] += row.n;
        if (row.escalate === 1) counts.escalate += row.n;
      }
      return counts;
    });
  }
  recentJoinCount({ identityId = null, ipHash = null, windowMs }) {
    if (identityId === null && ipHash === null) fail(422, "invalid_jev_shadow", "identityId or ipHash is required");
    if (identityId !== null) textOf(identityId, jevShadowLimits.identityIdChars, "identityId", "invalid_jev_shadow");
    if (ipHash !== null) textOf(ipHash, jevShadowLimits.ipHashChars, "ipHash", "invalid_jev_shadow");
    if (!Number.isFinite(windowMs) || windowMs <= 0) fail(422, "invalid_jev_shadow", "windowMs must be a positive duration");
    return this.store.readTransaction(() => this.db.prepare(
      `SELECT count(*) n FROM jev_shadow_decisions
       WHERE gate='admission' AND recorded_at>=? AND ((? IS NOT NULL AND identity_id=?) OR (? IS NOT NULL AND ip_hash=?))`)
      .get(this.store.now() - windowMs, identityId, identityId, ipHash, ipHash).n);
  }
}

function requireOwner(store, auth, roomId) {
  if (auth.member.kind !== "human" || auth.member.id !== store.room(roomId).state.room.ownerId
    || !auth.member.permissions.includes("manage_members")) {
    fail(403, "owner_required", "Only the room owner can review shadow decisions");
  }
}

export function jevShadowReport(deps, token, roomId, { gate = null, escalate = null, limit = 50 } = {}, expectedSessionBinding = null, nowMs = Date.now()) {
  const { store } = deps;
  if (!store || !store.jevShadow) fail(500, "misconfigured", "Shadow journal is not wired");
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  requireOwner(store, auth, roomId);
  const entries = store.jevShadow.list({ gate, roomId, escalate, limit });
  return Object.freeze({ roomId, viewerId: auth.member.id, evaluatedAt: new Date(nowMs).toISOString(),
    counts: store.jevShadow.counts({ roomId }), entries: Object.freeze(entries) });
}

// --- SLA breach alerts -----------------------------------------------------

export const slaBreachAlertLimits = Object.freeze({ idChars: 64, accountIdChars: 512, threadIdChars: 1024,
  channelChars: 128, kindChars: 32, summaryChars: 4096, decisionChars: 32, reasonChars: 1024,
  snapshotBytes: 16384, batch: 500 });
export const slaBreachAlertSchema = `
  CREATE TABLE IF NOT EXISTS sla_breach_alerts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    kind TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
    target_ms INTEGER NOT NULL CHECK(target_ms > 0),
    awaiting_since TEXT NOT NULL,
    deadline_at TEXT,
    produced_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    prefs_snapshot TEXT NOT NULL CHECK(json_valid(prefs_snapshot)),
    notified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, thread_id, produced_at)
  );
  CREATE INDEX IF NOT EXISTS sla_breach_alerts_account ON sla_breach_alerts(account_id, notified_at);
`;
const slaView = row => Object.freeze({ id: row.id, accountId: row.account_id, threadId: row.thread_id,
  channel: row.channel, kind: row.kind, elapsedMs: row.elapsed_ms, targetMs: row.target_ms,
  awaitingSince: row.awaiting_since, deadlineAt: row.deadline_at, producedAt: row.produced_at,
  summary: row.summary, decision: row.decision, reason: row.reason,
  prefsSnapshot: JSON.parse(row.prefs_snapshot), notifiedAt: row.notified_at, createdAt: row.created_at });
const slaRecord = record => {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(422, "invalid_sla_alert", "record must be a breach record object");
  boundedText(record.threadId, slaBreachAlertLimits.threadIdChars, "record.threadId", "invalid_sla_alert");
  boundedText(record.channel, slaBreachAlertLimits.channelChars, "record.channel", "invalid_sla_alert");
  boundedText(record.kind, slaBreachAlertLimits.kindChars, "record.kind", "invalid_sla_alert");
  boundedText(record.summary, slaBreachAlertLimits.summaryChars, "record.summary", "invalid_sla_alert");
  if (typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0)
    fail(422, "invalid_sla_alert", "record.elapsedMs must be a non-negative number");
  if (typeof record.targetMs !== "number" || !Number.isFinite(record.targetMs) || record.targetMs <= 0)
    fail(422, "invalid_sla_alert", "record.targetMs must be a positive number");
  for (const [field, value] of [["record.awaitingSince", record.awaitingSince], ["record.producedAt", record.producedAt]]) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(422, "invalid_sla_alert", `${field} must be a parseable timestamp`);
  }
  if (record.deadlineAt !== undefined && record.deadlineAt !== null
    && (typeof record.deadlineAt !== "string" || !Number.isFinite(Date.parse(record.deadlineAt))))
    fail(422, "invalid_sla_alert", "record.deadlineAt must be a parseable timestamp when present");
  return record;
};
const slaDecision = decision => {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) fail(422, "invalid_sla_alert", "decision must be a notify decision object");
  boundedText(decision.decision, slaBreachAlertLimits.decisionChars, "decision.decision", "invalid_sla_alert");
  if (typeof decision.reason !== "string" || decision.reason.length > slaBreachAlertLimits.reasonChars)
    fail(422, "invalid_sla_alert", "decision.reason must be a string");
  return decision;
};
const slaSnapshot = snapshot => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail(422, "invalid_sla_alert", "prefsSnapshot must be an object");
  let json; try { json = JSON.stringify(snapshot); } catch { fail(422, "invalid_sla_alert", "prefsSnapshot must be JSON-safe"); }
  if (json === undefined || Buffer.byteLength(json) > slaBreachAlertLimits.snapshotBytes) fail(422, "invalid_sla_alert", "prefsSnapshot is too large to journal");
  return json;
};

export class SlaBreachAlertJournal extends JournalBase {
  // Idempotent per (accountId, threadId, producedAt). A conflicting insert
  // keeps the original id and receipt; the caller gets that row back.
  notify({ accountId, record, decision, prefsSnapshot, at = null }) {
    boundedText(accountId, slaBreachAlertLimits.accountIdChars, "accountId", "invalid_sla_alert");
    const cleanRecord = slaRecord(record), cleanDecision = slaDecision(decision), snapshotJson = slaSnapshot(prefsSnapshot);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_sla_alert", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const id = `sba-${nextSerial(this.db, "SELECT COALESCE(MAX(CAST(SUBSTR(id,5) AS INTEGER)),0) next FROM sla_breach_alerts")}`;
      this.db.prepare(`INSERT INTO sla_breach_alerts
        (id,account_id,thread_id,channel,kind,elapsed_ms,target_ms,awaiting_since,deadline_at,produced_at,
         summary,decision,reason,prefs_snapshot,notified_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,thread_id,produced_at) DO NOTHING`)
        .run(id, accountId, cleanRecord.threadId, cleanRecord.channel, cleanRecord.kind,
          Math.round(cleanRecord.elapsedMs), Math.round(cleanRecord.targetMs), cleanRecord.awaitingSince,
          cleanRecord.deadlineAt ?? null, cleanRecord.producedAt, cleanRecord.summary,
          cleanDecision.decision, cleanDecision.reason, snapshotJson, now, now);
      return slaView(this.db.prepare("SELECT * FROM sla_breach_alerts WHERE account_id=? AND thread_id=? AND produced_at=?").get(accountId, cleanRecord.threadId, cleanRecord.producedAt));
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_sla_alert", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM sla_breach_alerts WHERE id=?").get(id);
      return row ? slaView(row) : null;
    });
  }
  list(accountId, { limit = slaBreachAlertLimits.batch } = {}) {
    boundedText(accountId, slaBreachAlertLimits.accountIdChars, "accountId", "invalid_sla_alert");
    if (!Number.isInteger(limit) || limit < 1 || limit > slaBreachAlertLimits.batch)
      fail(422, "invalid_sla_alert", `limit must be an integer 1..${slaBreachAlertLimits.batch}`);
    return this.store.readTransaction(() => Object.freeze(this.db.prepare("SELECT * FROM sla_breach_alerts WHERE account_id=? ORDER BY notified_at DESC,id DESC LIMIT ?").all(accountId, limit).map(slaView)));
  }
}

// --- membership delegation -------------------------------------------------

export const membershipDelegationJournalSchema = `
  CREATE TABLE IF NOT EXISTS membership_delegation_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('baseline_active','baseline_revoked','grant','revoke','revoke_effective')),
    actor_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    prior_active INTEGER NOT NULL CHECK(prior_active IN (0,1)),
    next_active INTEGER NOT NULL CHECK(next_active IN (0,1)),
    prior_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS membership_delegation_journal_room ON membership_delegation_journal(room_id, sequence);
  CREATE TABLE IF NOT EXISTS membership_delegation_pending (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    prior_active INTEGER NOT NULL, next_active INTEGER NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_insert AFTER INSERT ON membership_delegation_grants
    BEGIN INSERT INTO membership_delegation_pending(room_id,identity_id,prior_active,next_active,recorded_at)
      VALUES(NEW.room_id,NEW.identity_id,0,NEW.revoked_at IS NULL,NEW.granted_at); END;
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_update AFTER UPDATE OF revoked_at ON membership_delegation_grants
    WHEN (OLD.revoked_at IS NULL) <> (NEW.revoked_at IS NULL)
    BEGIN INSERT INTO membership_delegation_pending(room_id,identity_id,prior_active,next_active,recorded_at)
      VALUES(NEW.room_id,NEW.identity_id,OLD.revoked_at IS NULL,NEW.revoked_at IS NULL,
        CASE WHEN NEW.revoked_at IS NULL THEN NEW.granted_at ELSE NEW.revoked_at END); END;
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_delete BEFORE DELETE ON membership_delegation_grants
    BEGIN SELECT RAISE(ABORT,'Membership delegation grant deletion requires operator reconciliation'); END;
`;
const MEMBERSHIP_ZERO = "0".repeat(64);
const membershipHash = row => createHash("sha256").update(JSON.stringify([
  row.prior_hash, row.sequence, row.room_id, row.identity_id, row.action, row.actor_id,
  row.recorded_at, row.prior_active, row.next_active
])).digest("hex");
const membershipInvalid = () => { throw new Error("Membership delegation journal requires operator reconciliation"); };

export class MembershipDelegationJournal extends JournalBase {
  append(roomId, identityId, action, actorId, at, priorActive, nextActive) {
    const previous = this.db.prepare("SELECT hash FROM membership_delegation_journal WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(roomId);
    const row = { room_id: roomId, identity_id: identityId, action, actor_id: actorId,
      recorded_at: at, prior_active: Number(priorActive), next_active: Number(nextActive), prior_hash: previous?.hash ?? MEMBERSHIP_ZERO };
    const inserted = this.db.prepare(`INSERT INTO membership_delegation_journal
      (room_id,identity_id,action,actor_id,recorded_at,prior_active,next_active,prior_hash,hash)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING sequence`).get(roomId, identityId, action, actorId, at,
      row.prior_active, row.next_active, row.prior_hash, "pending");
    row.sequence = Number(inserted.sequence);
    const hash = membershipHash(row);
    this.db.prepare("UPDATE membership_delegation_journal SET hash=? WHERE sequence=?").run(hash, row.sequence);
    if (action !== "baseline_active" && action !== "baseline_revoked" && actorId !== "rollback_unattributed") {
      const pending = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence LIMIT 1").get();
      if (!pending || pending.room_id !== roomId || pending.identity_id !== identityId
        || pending.prior_active !== Number(priorActive) || pending.next_active !== Number(nextActive)) membershipInvalid();
      this.db.prepare("DELETE FROM membership_delegation_pending WHERE sequence=?").run(pending.sequence);
    }
    return { sequence: row.sequence, hash };
  }
  baseline() {
    const rows = this.db.prepare("SELECT room_id,identity_id,revoked_at FROM membership_delegation_grants ORDER BY room_id,identity_id").all();
    for (const row of rows) {
      const active = row.revoked_at === null;
      this.append(row.room_id, row.identity_id, active ? "baseline_active" : "baseline_revoked", "legacy_unattributed", this.store.now(), false, active);
    }
  }
  reconcileRollback() {
    this.verify({ allowPending: true });
    const rows = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence").all();
    for (const row of rows) {
      const latest = this.db.prepare("SELECT next_active FROM membership_delegation_journal WHERE room_id=? AND identity_id=? ORDER BY sequence DESC LIMIT 1").get(row.room_id, row.identity_id);
      if (Number(latest?.next_active ?? 0) !== row.prior_active || row.prior_active === row.next_active
        || !Number.isSafeInteger(row.recorded_at) || row.recorded_at < 0) membershipInvalid();
      this.append(row.room_id, row.identity_id, row.next_active ? "baseline_active" : "baseline_revoked",
        "rollback_unattributed", row.recorded_at, !!row.prior_active, !!row.next_active);
      this.db.prepare("DELETE FROM membership_delegation_pending WHERE sequence=?").run(row.sequence);
    }
    this.verify();
    return rows.length;
  }
  verify({ allowAbsent = false, allowPending = false } = {}) {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='membership_delegation_journal'").get();
    if (!table) { if (allowAbsent) return { entries: 0, absent: true }; membershipInvalid(); }
    const columns = this.db.prepare("PRAGMA table_info(membership_delegation_journal)").all().map(row => row.name);
    if (columns.join(",") !== "sequence,room_id,identity_id,action,actor_id,recorded_at,prior_active,next_active,prior_hash,hash"
      || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='membership_delegation_journal_room'").get()) membershipInvalid();
    const pendingColumns = this.db.prepare("PRAGMA table_info(membership_delegation_pending)").all().map(row => row.name);
    if (pendingColumns.join(",") !== "sequence,room_id,identity_id,prior_active,next_active,recorded_at") membershipInvalid();
    for (const name of ["membership_delegation_pending_insert", "membership_delegation_pending_update", "membership_delegation_pending_delete"]) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) membershipInvalid();
    }
    const state = new Map(), chain = new Map();
    const rows = this.db.prepare("SELECT * FROM membership_delegation_journal ORDER BY sequence").all();
    let lastSequence = 0;
    for (const row of rows) {
      const key = JSON.stringify([row.room_id, row.identity_id]);
      const prior = state.get(key) ?? false;
      const baseline = row.action === "baseline_active" || row.action === "baseline_revoked";
      const rollback = baseline && row.actor_id === "rollback_unattributed";
      const next = row.next_active === 1;
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== lastSequence + 1 || !Number.isSafeInteger(row.recorded_at)
        || row.recorded_at < 0 || !/^[A-Za-z0-9_-]{1,64}$/.test(row.identity_id)
        || typeof row.room_id !== "string" || !row.room_id || typeof row.actor_id !== "string" || !row.actor_id
        || ![0, 1].includes(row.prior_active) || ![0, 1].includes(row.next_active)
        || !["baseline_active", "baseline_revoked", "grant", "revoke", "revoke_effective"].includes(row.action)
        || row.prior_hash !== (chain.get(row.room_id) ?? MEMBERSHIP_ZERO) || row.hash !== membershipHash(row)
        || row.prior_active !== Number(prior) || state.has(key) && baseline && !rollback
        || baseline && (!rollback && row.actor_id !== "legacy_unattributed"
          || next !== (row.action === "baseline_active") || rollback && prior === next)
        || !baseline && (row.actor_id === "legacy_unattributed" || row.actor_id === "rollback_unattributed"
          || prior === next || next !== (row.action === "grant"))) membershipInvalid();
      lastSequence = row.sequence; chain.set(row.room_id, row.hash); state.set(key, next);
    }
    const grants = this.db.prepare("SELECT room_id,identity_id,revoked_at FROM membership_delegation_grants").all();
    const seq = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='membership_delegation_journal'").get()?.seq ?? 0;
    const pending = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence").all();
    if (seq !== lastSequence || (!allowPending && pending.length)) membershipInvalid();
    if (allowPending) {
      const projected = new Map(state);
      for (const row of pending) {
        const key = JSON.stringify([row.room_id, row.identity_id]);
        if (Number(projected.get(key) ?? false) !== row.prior_active || row.prior_active === row.next_active) membershipInvalid();
        projected.set(key, !!row.next_active);
      }
      state.clear(); for (const [key, value] of projected) state.set(key, value);
    }
    if (grants.length !== state.size) membershipInvalid();
    for (const row of grants) {
      const key = JSON.stringify([row.room_id, row.identity_id]);
      if (!state.has(key) || state.get(key) !== (row.revoked_at === null)) membershipInvalid();
    }
    return { entries: rows.length, absent: false };
  }
}

// --- invitations -----------------------------------------------------------

export const canonicalInvitationData = value => Array.isArray(value) ? `[${value.map(canonicalInvitationData).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInvitationData(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const invitationDigest = value => createHash("sha256").update(canonicalInvitationData(value)).digest("hex");
const invitationAssert = condition => { if (!condition) throw new Error("Invitation journal consistency check failed"); };
const invitationExact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invitationEqual = (left, right) => canonicalInvitationData(left) === canonicalInvitationData(right);
const invitationInteger = value => Number.isSafeInteger(value) && value >= 0;
const invitationBounded = (value, max) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const invitationHashPattern = /^[a-f0-9]{64}$/;
const invitationScopeKeys = "id token_hash room_id intended_account_id intended_member_id intended_display_name intended_role intended_permissions_json role_policy_version issuer_account_id issuer_member_id issuer_account_auth_epoch issuer_member_revision issue_request_id issue_fingerprint created_at expires_at".split(" ");
const invitationStateKeys = "revision status accepted_at accepted_by_account_id redemption_id joined_event_id revoked_at revoked_by_account_id revoked_by_member_id revoke_reason".split(" ");
const invitationAuditKeys = "invitation_id sequence type actor_account_id actor_member_id actor_auth_epoch actor_session_revision invitation_revision at room_event_id reason".split(" ");
const invitationEntryKeys = "version invitationId sequence kind recordedAt previousHash record audits".split(" ");
const invitationNullFields = (record, fields) => fields.every(field => record[field] === null);
const invitationAcceptKeys = "accepted_at accepted_by_account_id redemption_id joined_event_id".split(" ");
const invitationRevokeKeys = "revoked_at revoked_by_account_id revoked_by_member_id revoke_reason".split(" ");

export const invitationJournalSchema = `
  CREATE TABLE membership_invitation_journal (
    invitation_id TEXT NOT NULL REFERENCES membership_invitations(id),
    sequence INTEGER NOT NULL CHECK(sequence>0),
    body TEXT NOT NULL CHECK(json_valid(body)),
    checksum TEXT NOT NULL CHECK(length(checksum)=64),
    PRIMARY KEY(invitation_id,sequence)
  );
  CREATE TRIGGER membership_invitation_journal_no_update BEFORE UPDATE ON membership_invitation_journal
    BEGIN SELECT RAISE(ABORT,'invitation journal is append-only'); END;
  CREATE TRIGGER membership_invitation_journal_no_delete BEFORE DELETE ON membership_invitation_journal
    BEGIN SELECT RAISE(ABORT,'invitation journal is append-only'); END;
`;

export function validateInvitationSnapshot(record, audits) {
  invitationAssert(invitationExact(record, [...invitationScopeKeys, ...invitationStateKeys]));
  const agentIssued = record.issuer_account_id === null;
  for (const key of ["id", "room_id", "intended_account_id", "intended_member_id", "issuer_member_id", "issue_request_id"]) invitationAssert(validId(record[key]));
  if (agentIssued) invitationAssert(record.issuer_account_id === null && record.issuer_account_auth_epoch === null);
  else { invitationAssert(validId(record.issuer_account_id)); invitationAssert(invitationInteger(record.issuer_account_auth_epoch)); }
  for (const key of ["token_hash", "issue_fingerprint"]) invitationAssert(typeof record[key] === "string" && invitationHashPattern.test(record[key]));
  for (const key of ["issuer_member_revision", "created_at", "expires_at"]) invitationAssert(invitationInteger(record[key]));
  invitationAssert(invitationBounded(record.intended_display_name, 256) && record.expires_at > record.created_at);
  const policy = INVITATION_ROLE_POLICIES[record.role_policy_version];
  invitationAssert(policy && Object.hasOwn(policy, record.intended_role));
  const permissions = JSON.parse(record.intended_permissions_json);
  invitationAssert(invitationEqual(permissions, policy[record.intended_role]));
  invitationAssert(record.issue_fingerprint === invitationDigest({
    roomId: record.room_id, requestId: record.issue_request_id, tokenHash: record.token_hash,
    intendedAccountId: record.intended_account_id, intendedMemberId: record.intended_member_id,
    displayName: record.intended_display_name, role: record.intended_role, permissions,
    expiresAt: record.expires_at, expectedIssuerMemberRevision: record.issuer_member_revision
  }));
  invitationAssert(Array.isArray(audits) && audits.length === (record.status === "pending" ? 1 : 2));
  const agentRevoker = record.status === "revoked" && record.revoked_by_account_id === null;
  for (const [index, audit] of audits.entries()) {
    invitationAssert(invitationExact(audit, invitationAuditKeys) && audit.invitation_id === record.id && audit.sequence === index + 1);
    const agentActor = (agentIssued && index === 0) || (agentRevoker && index === 1);
    if (agentActor) invitationAssert(audit.actor_account_id === null && audit.actor_auth_epoch === null);
    else invitationAssert(validId(audit.actor_account_id) && invitationInteger(audit.actor_auth_epoch));
    invitationAssert(validId(audit.actor_member_id));
    invitationAssert(invitationInteger(audit.actor_session_revision) && invitationInteger(audit.at));
  }
  const first = audits[0];
  invitationAssert(first.type === "issued" && first.invitation_revision === 0 && first.at === record.created_at);
  invitationAssert(first.actor_account_id === record.issuer_account_id && first.actor_member_id === record.issuer_member_id && first.actor_auth_epoch === record.issuer_account_auth_epoch);
  invitationAssert(first.room_event_id === null && first.reason === null);
  if (record.status === "pending") {
    invitationAssert(record.revision === 0 && invitationNullFields(record, [...invitationAcceptKeys, ...invitationRevokeKeys]));
  } else {
    const last = audits[1];
    invitationAssert(record.revision === 1 && last.invitation_revision === 1 && last.type === record.status);
    if (record.status === "accepted") {
      invitationAssert(invitationInteger(record.accepted_at) && record.accepted_at < record.expires_at && record.accepted_by_account_id === record.intended_account_id);
      invitationAssert(typeof record.redemption_id === "string" && /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(record.redemption_id));
      invitationAssert(validId(record.joined_event_id) && invitationNullFields(record, invitationRevokeKeys));
      invitationAssert(last.actor_account_id === record.intended_account_id && last.actor_member_id === record.intended_member_id);
      invitationAssert(last.at === record.accepted_at && last.room_event_id === record.joined_event_id && last.reason === null);
    } else {
      invitationAssert(record.status === "revoked" && invitationInteger(record.revoked_at));
      if (agentRevoker) invitationAssert(record.revoked_by_account_id === null);
      else invitationAssert(validId(record.revoked_by_account_id));
      invitationAssert(validId(record.revoked_by_member_id) && invitationBounded(record.revoke_reason, 4096));
      invitationAssert(invitationNullFields(record, invitationAcceptKeys) && last.at === record.revoked_at && last.room_event_id === null && last.reason === record.revoke_reason);
      invitationAssert(last.actor_account_id === record.revoked_by_account_id && last.actor_member_id === record.revoked_by_member_id);
    }
  }
}

export function invitationJournalEntry(record, audits, kind, recordedAt, prior = null) {
  const entry = {
    version: 1, invitationId: record.id, sequence: prior ? prior.sequence + 1 : 1,
    kind, recordedAt, previousHash: prior?.checksum ?? null, record, audits
  };
  return { invitation_id: record.id, sequence: entry.sequence, body: canonicalInvitationData(entry), checksum: invitationDigest(entry) };
}

export function replayInvitationJournal(rows) {
  invitationAssert(Array.isArray(rows) && rows.length > 0 && rows.length <= 2);
  let previous = null, checksum = null, legacyBaseline = false;
  for (const [index, row] of rows.entries()) {
    const entry = JSON.parse(row.body);
    invitationAssert(invitationExact(entry, invitationEntryKeys) && entry.version === 1 && invitationInteger(entry.recordedAt));
    invitationAssert(row.invitation_id === entry.invitationId && row.sequence === index + 1 && entry.sequence === row.sequence);
    invitationAssert(entry.record.id === entry.invitationId && entry.previousHash === checksum && row.checksum === invitationDigest(entry));
    validateInvitationSnapshot(entry.record, entry.audits);
    if (!previous) {
      invitationAssert(entry.kind === "legacy-v4-baseline" || (entry.kind === "issued" && entry.record.status === "pending"));
      legacyBaseline = entry.kind === "legacy-v4-baseline";
    } else {
      invitationAssert(previous.record.status === "pending" && ["accepted", "revoked"].includes(entry.kind) && entry.record.status === entry.kind);
      invitationAssert(invitationScopeKeys.every(key => invitationEqual(previous.record[key], entry.record[key])));
      invitationAssert(invitationEqual(previous.audits, entry.audits.slice(0, 1)));
    }
    previous = entry;
    checksum = row.checksum;
  }
  return { record: previous.record, audits: previous.audits, legacyBaseline, journalSequence: previous.sequence, checksum };
}

// --- graph reply -----------------------------------------------------------

const replyFail = (code, message, status = 409) => { throw new ServiceError(status, code, message); };
const replyRevision = n => Number.isSafeInteger(n) && n >= 0;
const replyHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const replyObservationBytes = 32768;
export const isReplyAttempt = request => typeof request?.action === "string" && request.action.startsWith("reply.");
export const isReplyUpdate = request => typeof request?.action === "string" && request.action.startsWith("reply.update.");
export const unresolvedReplyUpdate = (updates, attemptId) => [...updates.values()].some(update => update.attemptId === attemptId && !["cancelled", "resolved"].includes(update.status));
const replyAttemptFields = {
  "reply.reserve": ["action", "requestId", "sourceId", "mode", "planVersion"],
  "reply.cancel": ["action", "requestId", "sourceId", "attemptId", "expectedRevision"],
  "reply.dispatch": ["action", "requestId", "sourceId", "attemptId", "expectedRevision"],
  "reply.created": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "planVersion", "providerDraftId"],
  "reply.observed": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "observation"],
  "reply.review": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "reviewVersion"]
};
const replyUpdateFields = {
  "reply.update.reserve": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateVersion"],
  "reply.update.cancel": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateId"],
  "reply.update.dispatch": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateId"],
  "reply.update.observed": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateId", "observation"],
  "reply.update.inspected": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateId", "observation", "inspectionVersion", "connectionRevision"],
  "reply.update.review": ["action", "requestId", "sourceId", "attemptId", "expectedRevision", "updateId", "reviewVersion"]
};

export function validateReplyAttempt(request) {
  if (isReplyUpdate(request)) return validateReplyUpdate(request);
  emailInput(request);
  const fields = replyAttemptFields[request?.action];
  if (!fields || !exactEmailFields(request, fields) || !validId(request.requestId) || !validId(request.sourceId))
    replyFail("invalid_reply_attempt", "Choose an exact reply operation.", 422);
  if (request.action === "reply.reserve") {
    if (!["reply", "replyAll"].includes(request.mode) || !replyHash(request.planVersion))
      replyFail("invalid_reply_attempt", "Review the saved reply first.", 422);
  } else if (!validId(request.attemptId) || !replyRevision(request.expectedRevision))
    replyFail("invalid_reply_attempt", "Choose the current attempt.", 422);
  if (request.action === "reply.created") {
    if (!replyHash(request.planVersion)) replyFail("invalid_reply_attempt", "Choose the original reply plan.", 422);
    emailOpaqueId(request.providerDraftId);
  }
  if (request.action === "reply.review" && !replyHash(request.reviewVersion))
    replyFail("invalid_reply_review", "Choose the exact observed draft.", 422);
  if (request.action === "reply.observed" && (request.observation === undefined || Buffer.byteLength(JSON.stringify(request.observation)) > replyObservationBytes))
    replyFail("reply_observation_limit", "This draft is too large for the review pilot.", 422);
}

function validateReplyUpdate(request) {
  emailInput(request);
  if (request.action === "reply.update.acknowledged") {
    if (!exactEmailFields(request, ["action", "requestId", "sourceId", "attemptId", "updateId", "dispatchRequestId", "updateVersion", "providerDraftId", "providerRevision"])
      || ![request.requestId, request.sourceId, request.attemptId, request.updateId, request.dispatchRequestId].every(validId)
      || !replyHash(request.updateVersion))
      replyFail("invalid_reply_update", "Choose the exact dispatched update.", 422);
    emailOpaqueId(request.providerDraftId); emailOpaqueId(request.providerRevision);
    return;
  }
  const fields = replyUpdateFields[request?.action];
  if (!fields || !exactEmailFields(request, fields) || ![request.requestId, request.sourceId, request.attemptId].every(validId)
    || !replyRevision(request.expectedRevision) || (request.action === "reply.update.reserve" ? !replyHash(request.updateVersion) : !validId(request.updateId)))
    replyFail("invalid_reply_update", "Choose an exact reply update.", 422);
  if (["reply.update.observed", "reply.update.inspected"].includes(request.action) && (request.observation === undefined || Buffer.byteLength(JSON.stringify(request.observation)) > replyObservationBytes))
    replyFail("reply_observation_limit", "This draft is too large for the review pilot.", 422);
  if (request.action === "reply.update.inspected" && (!replyHash(request.inspectionVersion) || !replyRevision(request.connectionRevision) || request.connectionRevision === 0)
    || request.action === "reply.update.review" && !replyHash(request.reviewVersion))
    replyFail("invalid_reply_update", "Choose the exact checked update.", 422);
}

export function transitionReplyUpdate(updates, request, { proposal, dispatch, inspection, review, at }) {
  validateReplyUpdate(request);
  if (!Number.isSafeInteger(at)) replyFail("invalid_reply_time", "Reply timestamp is unavailable.");
  if (request.action === "reply.update.reserve") {
    if (!proposal || proposal.requestId !== request.requestId || proposal.sourceId !== request.sourceId
      || proposal.attemptId !== request.attemptId || proposal.attemptRevision !== request.expectedRevision || proposal.updateVersion !== request.updateVersion)
      replyFail("stale_email_reply_update", "The reply changed. Compare it again.");
    if (unresolvedReplyUpdate(updates, request.attemptId)) replyFail("reply_update_unresolved", "Check the existing update first.");
    if (proposal.status !== "update_proposed" || !proposal.update) replyFail("reply_update_not_needed", "The text already matches.");
    return { id: request.requestId, sourceId: request.sourceId, attemptId: request.attemptId, revision: 0,
      status: "reserved", proposal: structuredClone(proposal), observation: null, dispatchedAt: null,
      createdAt: at, updatedAt: at, canExecute: false, canRetryUpdate: false, canReview: false, canSend: false };
  }
  const prior = updates.get(request.updateId);
  if (!prior || prior.sourceId !== request.sourceId || prior.attemptId !== request.attemptId)
    replyFail("reply_update_not_found", "Reply update not found.", 404);
  if (request.action === "reply.update.acknowledged") {
    if (prior.status !== "update_unconfirmed" || prior.acknowledgment
      || dispatch?.action !== "reply.update.dispatch" || dispatch.requestId !== request.dispatchRequestId
      || dispatch.sourceId !== prior.sourceId || dispatch.update?.id !== prior.id
      || dispatch.update.attemptId !== prior.attemptId || dispatch.update.status !== "update_unconfirmed"
      || dispatch.update.revision !== 1 || dispatch.update.dispatchedAt !== prior.dispatchedAt
      || JSON.stringify(dispatch.update.proposal) !== JSON.stringify(prior.proposal)
      || request.updateVersion !== prior.proposal.updateVersion || request.providerDraftId !== prior.proposal.providerDraftId)
      replyFail("conflicting_reply_update_acknowledgment", "The acknowledgment does not match this dispatched update.");
    return { ...prior, revision: prior.revision + 1, updatedAt: at, status: "update_acknowledged",
      acknowledgment: { dispatchRequestId: request.dispatchRequestId, updateVersion: request.updateVersion,
        providerDraftId: request.providerDraftId, providerRevision: request.providerRevision, at } };
  }
  if (prior.revision !== request.expectedRevision) replyFail("stale_reply_update", "Update status changed. Refresh it.");
  if (request.action === "reply.update.inspected") {
    if (!inspection || inspection.updateId !== prior.id || inspection.expectedRevision !== prior.revision
      || inspection.inspectionVersion !== request.inspectionVersion || inspection.connection.revision !== request.connectionRevision)
      replyFail("stale_reply_inspection", "The reply or connection changed. Check it again.");
    return { ...prior, ...inspectUpdate(prior, request.observation, inspection, request.requestId),
      revision: prior.revision + 1, review: null, updatedAt: at };
  }
  if (request.action === "reply.update.review") {
    if (!["update_acknowledged", "resolved"].includes(prior.status) || !review?.canReview
      || review.updateId !== prior.id || review.reviewVersion !== request.reviewVersion)
      replyFail("stale_reply_update_review", "Check and review the current mailbox draft.");
    return { ...prior, status: "resolved", revision: prior.revision + 1, updatedAt: at,
      resolvedAt: prior.resolvedAt ?? at, review: { version: review.reviewVersion, accountId: review.accountId, authEpoch: review.authEpoch, at } };
  }
  if (request.action === "reply.update.observed") {
    if (!["update_unconfirmed", "update_acknowledged"].includes(prior.status)) replyFail("reply_update_not_started", "No update has started.");
    return { ...prior, revision: prior.revision + 1, updatedAt: at,
      ...(prior.inspection ? { inspection: null, review: null } : {}),
      observation: compareReplyUpdateEnvelope(prior.proposal, request.observation) };
  }
  if (prior.status !== "reserved") replyFail("reply_update_started", "The update may have started. Check this attempt.");
  if (request.action === "reply.update.dispatch" && JSON.stringify(proposal) !== JSON.stringify(prior.proposal))
    replyFail("stale_email_reply_update", "The reply changed. Cancel and compare again.");
  return { ...prior, revision: prior.revision + 1, updatedAt: at,
    status: request.action === "reply.update.cancel" ? "cancelled" : "update_unconfirmed",
    dispatchedAt: request.action === "reply.update.dispatch" ? at : null };
}

export function transitionReplyAttempt(attempts, request, { plan, authEpoch, at }) {
  if (isReplyUpdate(request)) replyFail("invalid_reply_attempt", "Use the child update transition.", 422);
  validateReplyAttempt(request);
  if (!Number.isSafeInteger(at)) replyFail("invalid_reply_time", "Reply timestamp is unavailable.");
  if (request.action === "reply.reserve") {
    if (!plan || plan.sourceId !== request.sourceId || plan.requestId !== request.requestId
      || plan.mode !== request.mode || plan.planVersion !== request.planVersion)
      replyFail("stale_email_reply_plan", "The reply changed. Prepare it again.");
    for (const attempt of attempts.values()) if (attempt.sourceId === request.sourceId && attempt.status !== "cancelled")
      replyFail("email_reply_unresolved", "Resolve the existing mailbox draft attempt first.");
    return { id: request.requestId, sourceId: request.sourceId, revision: 0, status: "reserved", plan,
      providerDraftId: null, createdAt: at, updatedAt: at, canSend: false };
  }
  const prior = attempts.get(request.attemptId);
  if (!prior || prior.sourceId !== request.sourceId) replyFail("reply_attempt_not_found", "Reply attempt not found.", 404);
  if (prior.revision !== request.expectedRevision) replyFail("stale_reply_attempt", "Reply status changed. Refresh it.");
  let status, providerDraftId = prior.providerDraftId;
  if (request.action === "reply.cancel") {
    if (prior.status !== "reserved") replyFail("reply_creation_started", "Creation may have started. Check the existing attempt.");
    status = "cancelled";
  } else if (request.action === "reply.dispatch") {
    if (prior.status !== "reserved") replyFail("reply_creation_started", "Do not create this mailbox draft again.");
    if (plan?.planVersion !== prior.plan.planVersion) replyFail("stale_email_reply_plan", "Reply or authority changed. Cancel and review again.");
    status = "creation_unconfirmed";
  } else if (request.action === "reply.created") {
    if (prior.status !== "creation_unconfirmed" || request.planVersion !== prior.plan.planVersion
      || request.providerDraftId === prior.plan.sourceMessageId)
      replyFail("conflicting_reply_observation", "The provider observation does not match this attempt.");
    for (const attempt of attempts.values()) if (attempt.id !== prior.id && attempt.providerDraftId === request.providerDraftId
      && attempt.plan.connection.provider === prior.plan.connection.provider
      && attempt.plan.connection.mailboxId === prior.plan.connection.mailboxId)
      replyFail("conflicting_reply_observation", "That mailbox draft already belongs to another attempt.");
    status = "created_unverified"; providerDraftId = request.providerDraftId;
  } else {
    if (!providerDraftId) replyFail("reply_draft_unconfirmed", "A confirmed mailbox draft identity is required.");
    if (!replyRevision(authEpoch)) replyFail("invalid_reply_authority", "Current account authority is required.");
    let observation = prior.observation, review = prior.review ?? null;
    if (request.action === "reply.observed") {
      observation = compareReplyEnvelope(prior.plan, providerDraftId, request.observation);
      if (!observation.reviewVersion || review?.version !== observation.reviewVersion || review.authEpoch !== authEpoch) review = null;
    } else {
      if (plan?.planVersion !== prior.plan.planVersion)
        replyFail("stale_email_reply_plan", "Reply or authority changed. Review the current reply.");
      if (!observation?.reviewVersion || request.reviewVersion !== observation.reviewVersion)
        replyFail("stale_reply_review", "The mailbox draft changed. Review it again.");
      if (!replyObservationReviewable(observation))
        replyFail("unsupported_reply_review", "This draft needs a supported, complete mailbox preview.");
      review = { version: request.reviewVersion, accountId: plan.accountId, authEpoch, at };
    }
    status = review ? "draft_reviewed" : observation.status === "draft_unavailable" ? "draft_unavailable" : "awaiting_review";
    return { ...prior, revision: prior.revision + 1, status, observation, review, updatedAt: at };
  }
  return { ...prior, revision: prior.revision + 1, status, providerDraftId, updatedAt: at };
}

export const journalKinds = Object.freeze({
  channel: Object.freeze({ id: "channel", table: "pending_channel_updates", schema: channelJournalSchema,
    limits: channelJournalLimits, statuses: channelJournalStatuses, Journal: ChannelUpdateJournal }),
  spamQuarantine: Object.freeze({ id: "spamQuarantine", table: "spam_quarantine", schema: spamQuarantineSchema,
    limits: spamQuarantineLimits, statuses: spamQuarantineStatuses, decisions: spamQuarantineDecisions,
    migrate: migrateSpamQuarantineColumns, Journal: SpamQuarantineJournal }),
  jevShadow: Object.freeze({ id: "jevShadow", table: "jev_shadow_decisions", schema: jevShadowSchema,
    limits: jevShadowLimits, gates: jevShadowGates, decisions: jevShadowDecisions, Journal: JevShadowJournal, report: jevShadowReport }),
  slaBreach: Object.freeze({ id: "slaBreach", table: "sla_breach_alerts", schema: slaBreachAlertSchema,
    limits: slaBreachAlertLimits, Journal: SlaBreachAlertJournal }),
  membershipDelegation: Object.freeze({ id: "membershipDelegation", table: "membership_delegation_journal",
    schema: membershipDelegationJournalSchema, Journal: MembershipDelegationJournal }),
  invitation: Object.freeze({ id: "invitation", table: "membership_invitation_journal", schema: invitationJournalSchema,
    canonicalInvitationData, validateInvitationSnapshot, invitationJournalEntry, replayInvitationJournal }),
  graphReply: Object.freeze({ id: "graphReply", replyObservationBytes, isReplyAttempt, isReplyUpdate, unresolvedReplyUpdate,
    validateReplyAttempt, transitionReplyAttempt, transitionReplyUpdate, replyObservationReviewable })
});

export function openJournal(store, kind) {
  const config = journalKinds[kind];
  if (!config?.Journal) throw new Error(`Unknown journal kind ${kind}`);
  return new config.Journal(store);
}
