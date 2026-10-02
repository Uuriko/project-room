// Append-only operator audit. Created on store open (IF NOT EXISTS, outside
// the writer fence) the same way as agent_autonomy_tiers. Ordinary UPDATE and
// DELETE abort. Rows carry ids, counts, and the reason the operator typed.
// They do not carry message text, display names, or secrets.

import { randomBytes } from "node:crypto";

export const OPERATOR_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS operator_actions (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  reason TEXT,
  plan_hash TEXT,
  counts_json TEXT,
  result TEXT NOT NULL,
  request_id TEXT
);
CREATE TRIGGER IF NOT EXISTS operator_actions_append_only_update
  BEFORE UPDATE ON operator_actions
  BEGIN SELECT RAISE(ABORT, 'operator audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS operator_actions_append_only_delete
  BEFORE DELETE ON operator_actions
  BEGIN SELECT RAISE(ABORT, 'operator audit is append-only'); END;
`;

export function ensureOperatorActionsSchema(db) {
  db.exec(OPERATOR_ACTIONS_SCHEMA);
}

const COLUMNS = Object.freeze([
  "id", "at", "action", "target_kind", "target_id", "reason", "plan_hash", "counts_json", "result", "request_id"
]);

export function appendOperatorAction(store, row) {
  const write = () => {
    const id = `oa_${randomBytes(9).toString("base64url")}`;
    const counts = row.counts == null ? null : JSON.stringify(row.counts);
    store.db.prepare(`INSERT INTO operator_actions
      (id, at, action, target_kind, target_id, reason, plan_hash, counts_json, result, request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      store.now(),
      row.action,
      row.targetKind ?? null,
      row.targetId ?? null,
      row.reason ?? null,
      row.planHash ?? null,
      counts,
      row.result,
      row.requestId ?? null
    );
    return id;
  };
  if (store.db.isTransaction) return write();
  return store.transaction(write);
}

export function listOperatorActions(store, limit = 50) {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = store.db.prepare(`SELECT ${COLUMNS.join(", ")} FROM operator_actions ORDER BY at DESC, id DESC LIMIT ?`).all(capped);
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    reason: row.reason,
    planHash: row.plan_hash,
    counts: row.counts_json ? JSON.parse(row.counts_json) : null,
    result: row.result,
    requestId: row.request_id
  }));
}
