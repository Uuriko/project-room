// Durable persistence for the /feedback store (docs/feedback-endpoint.md
// OPEN ITEM: "durable SQLite persistence").
//
// Before this, a room's feedback lived in a process-level Map: anything filed
// but not yet triaged onto the claims board was lost on restart, and with it
// the filer's Mark debit — the anti-spam ledger charged agents for filings
// that silently vanished. That is the failure this closes.
//
// Shape: one row per room holding the store's snapshot. The store is small
// and bounded by construction (CLUSTER_FILEDAT_CAP caps per-cluster
// timestamps; notifications drain on read), so a whole-snapshot write per
// mutation is cheaper than a row-per-entity schema and is atomic by default —
// no half-written triage verdict, no cluster whose count disagrees with its
// items. If the store ever outgrows that, the seam to split is here, not in
// the pure module.
//
// Failure policy: persistence must never take the endpoint down. A read that
// cannot be understood (corrupt row, newer snapshot version) starts empty
// rather than throwing; a write that fails is reported through onError and
// swallowed, so a full disk degrades the room to in-memory behaviour instead
// of 500ing every filing. Silence would be worse than either, hence onError.

import { createFeedbackStore, SNAPSHOT_VERSION } from "./feedback-store.mjs";

export const FEEDBACK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback_state (
    room_id    TEXT PRIMARY KEY,
    version    INTEGER NOT NULL,
    snapshot   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export function ensureFeedbackSchema(db) {
  db.exec(FEEDBACK_SCHEMA);
}

export function loadSnapshot(db, roomId) {
  const row = db.prepare("SELECT version, snapshot FROM feedback_state WHERE room_id=?").get(roomId);
  if (!row) return null;
  // A snapshot written by a newer server is not ours to guess at.
  if (row.version !== SNAPSHOT_VERSION) return null;
  try {
    const parsed = JSON.parse(row.snapshot);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // corrupt row: start empty rather than refuse to serve
  }
}

export function saveSnapshot(db, roomId, snapshot, at) {
  db.prepare(
    `INSERT INTO feedback_state (room_id, version, snapshot, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET
       version=excluded.version, snapshot=excluded.snapshot, updated_at=excluded.updated_at`,
  ).run(roomId, SNAPSHOT_VERSION, JSON.stringify(snapshot), at);
}

// Mutating surface of the store: every call that can change state persists
// after it returns. drainNotifications is here deliberately — it clears the
// lane's queue, so losing that write would redeliver notifications a lane has
// already seen.
const MUTATORS = Object.freeze([
  "submit", "triage", "appeal", "decideAppeal", "recordOutcome",
  "settleVerdicts", "drainNotifications",
]);

// Wraps a feedback store so it survives restarts. Same API as
// createFeedbackStore: callers (and every existing test) cannot tell the
// difference apart from the durability.
export function createPersistentFeedbackStore({ db, roomId, now, onError, isReviewer, isReleaseAuthority, verifyMergeRef } = {}) {
  const clock = now ?? (() => Date.now());
  ensureFeedbackSchema(db);
  const inner = createFeedbackStore({ now, state: loadSnapshot(db, roomId), isReviewer, isReleaseAuthority, verifyMergeRef });

  const persist = () => {
    try {
      saveSnapshot(db, roomId, inner.snapshot(), clock());
    } catch (e) {
      // Degrade to in-memory rather than failing the agent's request.
      onError?.(e);
    }
  };

  const wrapped = {};
  for (const [name, value] of Object.entries(inner)) {
    wrapped[name] = typeof value === "function" && MUTATORS.includes(name)
      ? (...args) => { const out = value(...args); persist(); return out; }
      : value;
  }
  wrapped.persist = persist;
  return Object.freeze(wrapped);
}
