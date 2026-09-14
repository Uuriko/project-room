// B20: durable journal for channel webhook updates. A provider callback
// (Telegram today) is verified by the webhook inbox and then written here, so a
// verified update survives a process restart or a Durable Object eviction and
// waits for the account owner's import. One row per (account, connection,
// provider update id): a redelivery is a no-op, never a second import.
//
// Rows move pending -> imported when the owner's sync applies the page that
// consumed them (in the same transaction as the page), or pending -> failed
// once a bounded number of import attempts recorded an error. Nothing here
// fetches, sends or registers anything with a provider.
//
// Purely additive at v27, like wake_queue (W4-45) and the attention tables
// (W4-46): no data migration and no writer-fence impact, because a pre-journal
// writer has no code path to this table and the recovery audit's exact table
// list is the integrity gate. All writes go through the store transaction.
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const channelJournalLimits = Object.freeze({ maxAttempts: 5, payloadBytes: 16384, errorChars: 200, batch: 500 });
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
const view = row => ({ updateId: row.update_id, receivedAt: row.received_at, status: row.status, attempts: row.attempts,
  lastError: row.last_error, updatedAt: row.updated_at, payload: JSON.parse(row.payload) });
const scope = (accountId, connectionId) => { if (!validId(accountId) || !validId(connectionId)) fail(422, "invalid_channel_update", "Supply a connection."); };
const updateIds = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > channelJournalLimits.batch || !ids.every(id => Number.isSafeInteger(id) && id >= 0))
    fail(422, "invalid_channel_update", "Supply provider update IDs.");
  return [...new Set(ids)];
};

export class ChannelUpdateJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a v27 file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly missing
  // schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = channelJournalSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Channel update journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: every row's payload names the update id it is keyed by,
  // attempts stay within the bound, and only failed rows may have exhausted it.
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
    scope(accountId, connectionId);
    const counts = { pending: 0, imported: 0, failed: 0 };
    for (const row of this.db.prepare("SELECT status,count(*) n FROM pending_channel_updates WHERE account_id=? AND connection_id=? GROUP BY status").all(accountId, connectionId)) counts[row.status] = row.n;
    return counts;
  }
  // Journal verified updates. Idempotent by update id: a row that already
  // exists in any status is left exactly as it is. `rejected` maps update ids
  // the adapter already refused to their contract code; those rows are written
  // parked ('failed', attempts at the bound) so they never enter the backlog.
  // The pending backlog after the write is bounded; a full backlog refuses the
  // whole delivery unchanged.
  record(accountId, connectionId, updates, { backlog, rejected = new Map() }) {
    scope(accountId, connectionId);
    if (!Array.isArray(updates) || !updates.length) fail(422, "invalid_channel_update", "Supply provider updates.");
    return this.store.transaction(() => {
      const now = this.store.now();
      const insert = this.db.prepare("INSERT INTO pending_channel_updates (account_id,connection_id,update_id,received_at,payload,status,attempts,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,connection_id,update_id) DO NOTHING");
      let accepted = 0, parked = 0;
      for (const update of updates) {
        if (!update || typeof update !== "object" || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0)
          fail(422, "invalid_channel_update", "Supply provider update objects.");
        const payload = JSON.stringify(update);
        if (Buffer.byteLength(payload) > channelJournalLimits.payloadBytes) fail(422, "invalid_channel_update", "Update is too large.");
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
    scope(accountId, connectionId);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail(422, "invalid_channel_update", "Supply a positive page size.");
    return this.store.readTransaction(() => this.db.prepare("SELECT * FROM pending_channel_updates WHERE account_id=? AND connection_id=? AND status='pending' ORDER BY update_id LIMIT ?")
      .all(accountId, connectionId, limit ?? -1).map(view));
  }
  // Mark exactly these pending updates imported. Called inside the page
  // transaction, so the page and its acknowledgement commit or roll back together.
  imported(accountId, connectionId, ids) {
    scope(accountId, connectionId);
    const unique = updateIds(ids);
    return this.store.transaction(() => this.db.prepare("UPDATE pending_channel_updates SET status='imported',updated_at=? WHERE account_id=? AND connection_id=? AND status='pending' AND update_id IN (" + unique.map(() => "?").join(",") + ")")
      .run(this.store.now(), accountId, connectionId, ...unique).changes);
  }
  // Record one failed import attempt on the pending rows of a slice. The
  // error text is bounded; rows that reach maxAttempts park as failed and stop
  // being offered to the importer, so one poison update cannot block a
  // connection forever.
  failed(accountId, connectionId, ids, error) {
    scope(accountId, connectionId);
    const unique = updateIds(ids);
    const message = String(error?.code ?? error?.message ?? error ?? "unknown").slice(0, channelJournalLimits.errorChars);
    return this.store.transaction(() => {
      const now = this.store.now();
      const update = this.db.prepare(`UPDATE pending_channel_updates SET attempts=attempts+1,last_error=?,updated_at=?,
        status=CASE WHEN attempts+1>=${channelJournalLimits.maxAttempts} THEN 'failed' ELSE 'pending' END
        WHERE account_id=? AND connection_id=? AND update_id=? AND status='pending'`);
      let retried = 0;
      for (const id of unique) retried += update.run(message, now, accountId, connectionId, id).changes;
      const exhausted = this.db.prepare("SELECT count(*) n FROM pending_channel_updates WHERE account_id=? AND connection_id=? AND status='failed' AND update_id IN (" + unique.map(() => "?").join(",") + ")")
        .get(accountId, connectionId, ...unique).n;
      return { attempted: retried, exhausted, error: message };
    });
  }
}
