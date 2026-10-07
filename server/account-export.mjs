// H3 privacy audit (2026-10-07): self-serve user data export.
//
// GET /api/account/export answers "what do you hold on me?" with every
// account-keyed row the service stores for the authenticated account. The
// table list comes from server/purge-registry.mjs — the same registry
// account deletion purges — so the export and the deletion inventory can
// never silently disagree about scope. Secret-bearing columns are redacted,
// never exported. Past the row cap the export fails loudly (413) instead
// of silently truncating.

import { PURGE_TABLES } from "./purge-registry.mjs";
import { RETENTION_POLICY } from "./account-deletion.mjs";
import { ServiceError } from "./service-error.mjs";

export const ACCOUNT_EXPORT_MAX_ROWS = 10000;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// table.column pairs whose values could authenticate, decrypt, or mint:
// credential hashes, verifiers, encrypted blobs, and provider token
// payloads. Integrity hashes (body_hash, stitch_key, email_hash,
// prev_hash) name data without unlocking it and are exported as-is.
const REDACTED_COLUMNS = new Set([
  "account_credentials.hash",
  "account_login_methods.verifier",
  "account_magic_codes.code_hash",
  "account_recovery_codes.code_hash",
  "account_session_slots.hash",
  "account_session_slots.parent_credential_hash",
  "credentials.hash",
  "credentials.parent_hash",
  "credentials.identity_secret_hash",
  "gmail_linked_mailboxes.encrypted",
  "gmail_mailboxes.encrypted",
  "gmail_pending.encrypted",
  "gmail_pending.state_hash",
  "private_email_connections.data_json",
]);

const REDACTED_VALUE = "[redacted]";

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
}

// Every registry table keyed by account_id, delete or retain: the export
// shows retained audit rows too (they are the user's data), with the
// retention reason attached per table.
function exportableTables() {
  return PURGE_TABLES.filter(entry => (entry.match?.account ?? []).includes("account_id"));
}

export function exportAccountData(store, accountId) {
  if (typeof accountId !== "string" || accountId.length === 0) {
    fail(422, "invalid_account", "Invalid account id");
  }
  const db = store.db;
  const tables = {};
  const counts = {};
  const redactedColumns = [...REDACTED_COLUMNS].sort();
  let total = 0;
  for (const entry of exportableTables()) {
    const table = entry.table;
    if (!tableExists(db, table)) continue;
    const columns = columnsOf(db, table);
    if (!columns.includes("account_id")) continue;
    const redacted = columns.filter(column => REDACTED_COLUMNS.has(`${table}.${column}`));
    const selected = columns.map(column =>
      redacted.includes(column) ? `'${REDACTED_VALUE}' AS "${column}"` : `"${column}"`).join(", ");
    const rows = db.prepare(`SELECT ${selected} FROM ${table} WHERE account_id=?`).all(accountId);
    total += rows.length;
    if (total > ACCOUNT_EXPORT_MAX_ROWS) {
      fail(413, "export_too_large",
        `Account export exceeds ${ACCOUNT_EXPORT_MAX_ROWS} rows; narrow the account data and retry`);
    }
    tables[table] = rows;
    counts[table] = rows.length;
  }
  const profile = db.prepare(
    "SELECT id, active, display_name, avatar_url, origin, created_at, onboarded FROM accounts WHERE id=?"
  ).get(accountId) ?? null;
  return {
    accountId,
    exportedAt: new Date(typeof store.now === "function" ? store.now() : Date.now()).toISOString(),
    profile,
    retention: RETENTION_POLICY,
    redactedColumns,
    counts,
    tables,
  };
}
