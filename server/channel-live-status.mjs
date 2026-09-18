// Task 10 — durable Telegram live status. TelegramLiveStatus in
// server/channel-adapters/telegram-config.mjs keeps the last webhook delivery
// and the last send result in process memory only, so a restart (or a Durable
// Object eviction in production) wipes the connection card's "is Telegram
// alive?" facts. This is the durable replacement behind the same
// received()/sent()/snapshot() methods: one row per (account, connection),
// upserted on write, with the zero-value shape the in-memory class returns
// when no row exists.
//
// Purely additive: CREATE TABLE IF NOT EXISTS, no data migration, no schema
// version bump, and intentionally outside the writer fence (older writers have
// no code path to this table; see unfencedAdditiveTables). Never carries the
// bot token or the webhook secret — counters and timestamps only.
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const telegramLiveStatusSchema = `
  CREATE TABLE IF NOT EXISTS telegram_live_status (
    account_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    last_update_received_at INTEGER, received_updates INTEGER NOT NULL DEFAULT 0,
    last_send_at INTEGER, last_send_outcome TEXT, last_send_code TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, connection_id)
  );
`;

const zeroShape = () => ({ lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null });
// The channel-sends path records sends against a null connectionId (direct
// sends carry no stored connection), so the key coerces null to "" — one row
// per (account, connection) either way.
const key = (accountId, connectionId) => {
  if (!validId(accountId)) fail(422, "invalid_live_status", "Supply an account.");
  const connection = connectionId == null ? "" : String(connectionId);
  return [accountId, connection];
};
const validAt = at => {
  if (!Number.isSafeInteger(at) || at < 0) fail(422, "invalid_live_status", "Supply a timestamp in ms.");
  return at;
};

export class DurableTelegramLiveStatus {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this table finds nothing and
  // must not migrate, so allowAbsent accepts a wholly missing schema; a
  // partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const actual = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='telegram_live_status'").get()?.sql;
    if (actual === undefined) {
      if (allowAbsent) return false;
      throw new Error("Telegram live status table requires operator reconciliation");
    }
    if (normalize(actual) !== normalize(telegramLiveStatusSchema)) throw new Error("Telegram live status table requires operator reconciliation");
    return true;
  }
  // Offline integrity: counters never go negative, and the send outcome/code
  // never exceed the column bounds the writers enforce.
  verify() {
    return this.store.readTransaction(() => {
      let rows = 0;
      for (const row of this.db.prepare("SELECT * FROM telegram_live_status").all()) {
        if (row.received_updates < 0 || row.updated_at < 0
          || (row.last_update_received_at !== null && row.last_update_received_at < 0)
          || (row.last_send_at !== null && row.last_send_at < 0)
          || (row.last_send_outcome !== null && row.last_send_outcome.length > 32)
          || (row.last_send_code !== null && row.last_send_code.length > 64)) {
          throw new Error("Telegram live status requires operator reconciliation");
        }
        rows++;
      }
      return rows;
    });
  }
  // Record a webhook delivery. Matches the in-memory semantics: last-update
  // time is replaced, the update count accumulates.
  received(accountId, connectionId, { at, count = 1 }) {
    const [account, connection] = key(accountId, connectionId);
    if (!Number.isSafeInteger(count) || count < 0) fail(422, "invalid_live_status", "Supply a non-negative count.");
    return this.store.transaction(() => {
      const now = this.store.now();
      this.db.prepare(`INSERT INTO telegram_live_status
          (account_id, connection_id, last_update_received_at, received_updates, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id, connection_id) DO UPDATE SET
            last_update_received_at = excluded.last_update_received_at,
            received_updates = telegram_live_status.received_updates + excluded.received_updates,
            updated_at = excluded.updated_at`)
        .run(account, connection, validAt(at), count, now);
      return this.snapshot(accountId, connectionId);
    });
  }
  // Record a send result. Matches the in-memory semantics: the latest result
  // replaces the previous one (no history kept — see telegramLiveView).
  sent(accountId, connectionId, { at, outcome, code = null }) {
    const [account, connection] = key(accountId, connectionId);
    if (typeof outcome !== "string" || !outcome) fail(422, "invalid_live_status", "Supply a send outcome.");
    if (code !== null && (typeof code !== "string" || !code)) fail(422, "invalid_live_status", "Supply a send code or null.");
    return this.store.transaction(() => {
      const now = this.store.now();
      this.db.prepare(`INSERT INTO telegram_live_status
          (account_id, connection_id, last_send_at, last_send_outcome, last_send_code, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, connection_id) DO UPDATE SET
            last_send_at = excluded.last_send_at,
            last_send_outcome = excluded.last_send_outcome,
            last_send_code = excluded.last_send_code,
            updated_at = excluded.updated_at`)
        .run(account, connection, validAt(at), outcome.slice(0, 32), code === null ? null : code.slice(0, 64), now);
      return this.snapshot(accountId, connectionId);
    });
  }
  // The card read. Returns the same shape as TelegramLiveStatus#snapshot,
  // including the zero-value shape when no row exists yet.
  snapshot(accountId, connectionId) {
    const [account, connection] = key(accountId, connectionId);
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM telegram_live_status WHERE account_id = ? AND connection_id = ?")
        .get(account, connection);
      if (!row) return zeroShape();
      return {
        lastUpdateReceivedAt: row.last_update_received_at,
        receivedUpdates: row.received_updates,
        lastSendResult: row.last_send_at === null ? null : { at: row.last_send_at, outcome: row.last_send_outcome, code: row.last_send_code }
      };
    });
  }
}
