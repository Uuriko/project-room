// Durable board-v2 registry (SQLite).
//
// Production RoomStore owns this registry; HTTP and room-watch share it.
// Board state survives Worker eviction and deployment.
//
// The BoardV2 class (server/board-v2.mjs) remains the in-memory fixture for
// isolated state-machine tests. This module provides the SQLite-backed
// implementation with the same interface, per docs/BOARD-V2-DESIGN.md §3.
//
// Schema:
// - board_vtwo_claims: materialized claim rows (fast reads)
// - board_vtwo_events: append-only event log (the watermark)
// - board_vtwo_mirror: singleton mirror state
// - board_vtwo_idempotency: idempotency key cache

export const boardV2Schema = `
  CREATE TABLE IF NOT EXISTS board_vtwo_claims (
    task_id     TEXT PRIMARY KEY,
    lane        TEXT NOT NULL,
    files       TEXT NOT NULL,
    lease       TEXT NOT NULL,
    lease_h     INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    state       TEXT NOT NULL,
    claim_seq   INTEGER NOT NULL,
    claim_at    TEXT NOT NULL,
    heartbeat_at TEXT,
    last_seq    INTEGER NOT NULL,
    receipts    TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_events (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    task_id   TEXT,
    lane      TEXT,
    payload   TEXT NOT NULL,
    supersedes INTEGER,
    idempotency_key TEXT,
    mirror_issue   INTEGER,
    mirror_comment INTEGER
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_mirror (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    current_issue  INTEGER NOT NULL,
    issues         TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_idempotency (
    scoped_key TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_board_vtwo_events_kind ON board_vtwo_events(kind);
  CREATE INDEX IF NOT EXISTS idx_board_vtwo_events_task ON board_vtwo_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_board_vtwo_events_lane ON board_vtwo_events(lane);
`;

const parse = (text, what) => {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object") throw new Error("not an object");
    return value;
  } catch (err) {
    throw new Error(`board-v2 row parse failed (${what}): ${err.message}`);
  }
};

export function createDurableBoardV2(db, { now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("a SQLite database handle is required");
  }

  const stmt = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });

  // Claims
  const selectClaim = stmt("SELECT * FROM board_vtwo_claims WHERE task_id = ?");
  const selectClaimsByLane = stmt("SELECT * FROM board_vtwo_claims WHERE lane = ? ORDER BY last_seq ASC");
  const selectAllClaims = stmt("SELECT * FROM board_vtwo_claims ORDER BY last_seq ASC");
  const upsertClaim = stmt(`INSERT INTO board_vtwo_claims
    (task_id, lane, files, lease, lease_h, reason, state, claim_seq, claim_at, heartbeat_at, last_seq, receipts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      lane=excluded.lane, files=excluded.files, lease=excluded.lease,
      lease_h=excluded.lease_h, reason=excluded.reason, state=excluded.state,
      claim_seq=excluded.claim_seq, claim_at=excluded.claim_at,
      heartbeat_at=excluded.heartbeat_at, last_seq=excluded.last_seq,
      receipts=excluded.receipts`);

  // Events
  const insertEvent = stmt(`INSERT INTO board_vtwo_events
    (at, kind, task_id, lane, payload, supersedes, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const selectEvent = stmt("SELECT * FROM board_vtwo_events WHERE seq = ?");
  const selectEvents = stmt("SELECT * FROM board_vtwo_events WHERE seq > ? ORDER BY seq ASC LIMIT ?");
  const selectEventsByKind = stmt("SELECT * FROM board_vtwo_events WHERE kind = ? AND seq > ? ORDER BY seq ASC LIMIT ?");
  const maxSeq = stmt("SELECT MAX(seq) as max_seq FROM board_vtwo_events");

  // Mirror
  const selectMirror = stmt("SELECT * FROM board_vtwo_mirror WHERE id = 1");
  const upsertMirror = stmt(`INSERT INTO board_vtwo_mirror (id, current_issue, issues)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET current_issue=excluded.current_issue, issues=excluded.issues`);
  const selectMirrorEntry = stmt("SELECT seq FROM board_vtwo_events WHERE mirror_issue = ? AND mirror_comment = ? LIMIT 1");
  const updateEventMirror = stmt("UPDATE board_vtwo_events SET mirror_issue = ?, mirror_comment = ? WHERE seq = ?");

  // Idempotency
  const selectIdem = stmt("SELECT * FROM board_vtwo_idempotency WHERE scoped_key = ?");
  const upsertIdem = stmt(`INSERT INTO board_vtwo_idempotency
    (scoped_key, status, body, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scoped_key) DO UPDATE SET
      status=excluded.status, body=excluded.body,
      fingerprint=excluded.fingerprint, created_at=excluded.created_at`);
  const deleteIdem = stmt("DELETE FROM board_vtwo_idempotency WHERE scoped_key = ?");
  const countIdem = stmt("SELECT COUNT(*) as n FROM board_vtwo_idempotency");
  const oldestIdem = stmt("SELECT scoped_key FROM board_vtwo_idempotency ORDER BY created_at ASC LIMIT 1");

  const rowToClaim = row => ({
    task_id: row.task_id,
    lane: row.lane,
    files: parse(row.files, "claim.files"),
    lease: row.lease,
    lease_h: row.lease_h,
    reason: row.reason,
    state: row.state,
    claim_seq: row.claim_seq,
    claim_at_ms: Date.parse(row.claim_at),
    heartbeat_at_ms: row.heartbeat_at ? Date.parse(row.heartbeat_at) : null,
    last_seq: row.last_seq,
    receipts: parse(row.receipts, "claim.receipts"),
  });

  const rowToEvent = row => ({
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    task_id: row.task_id,
    lane: row.lane,
    payload: parse(row.payload, "event.payload"),
    ...(row.supersedes != null ? { supersedes: row.supersedes } : {}),
    ...(row.idempotency_key != null ? { idempotency_key: row.idempotency_key } : {}),
    // RC-2026-09-27-2720: mirror refs are columns, not payload — expose them
    // so the durable state machine can serve mirrorSince()/health() without
    // private SQL. Absent when recordMirror was never called for the event.
    ...(row.mirror_issue != null ? { mirror_issue: row.mirror_issue, mirror_comment: row.mirror_comment } : {}),
  });

  return {
    verifySchema({ allowAbsent = false } = {}) {
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
      const definitions = boardV2Schema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
      const shapes = definitions.map(sql => {
        const m = /CREATE (?:TABLE|INDEX) IF NOT EXISTS ([a-z_0-9]+)/.exec(sql);
        if (!m) return { sql, actual: null, skip: true };
        const name = m[1];
        const isIndex = sql.includes("CREATE INDEX");
        const actual = isIndex
          ? db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql
          : db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
        return { sql, actual };
      }).filter(s => !s.skip);
      if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
      if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) {
        throw new Error("Board-v2 schema requires operator reconciliation");
      }
      return true;
    },

    // --- seq ---
    seq() {
      const row = maxSeq.get();
      return row?.max_seq ?? 0;
    },

    // --- events ---
    appendEvent({ kind, task_id, lane, payload, supersedes = null, idempotencyKey = null }) {
      const at = new Date(now()).toISOString();
      const result = insertEvent.run(
        at, kind, task_id, lane,
        JSON.stringify(payload),
        supersedes, idempotencyKey
      );
      const seq = Number(result.lastInsertRowid);
      return { seq, at };
    },

    getEvent(seq) {
      const row = selectEvent.get(seq);
      return row ? rowToEvent(row) : null;
    },

    listEvents({ since_seq = 0, limit = 50, kind = null } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const since = Number(since_seq) || 0;
      const rows = kind
        ? selectEventsByKind.all(kind, since, lim + 1)
        : selectEvents.all(since, lim + 1);
      const has_more = rows.length > lim;
      return { events: rows.slice(0, lim).map(rowToEvent), has_more };
    },

    // --- claims ---
    getClaim(task_id) {
      const row = selectClaim.get(task_id);
      return row ? rowToClaim(row) : null;
    },

    putClaim(claim) {
      upsertClaim.run(
        claim.task_id, claim.lane,
        JSON.stringify(claim.files),
        claim.lease, claim.lease_h, claim.reason, claim.state,
        claim.claim_seq,
        new Date(claim.claim_at_ms).toISOString(),
        claim.heartbeat_at_ms ? new Date(claim.heartbeat_at_ms).toISOString() : null,
        claim.last_seq,
        JSON.stringify(claim.receipts)
      );
    },

    listClaims({ lane = null } = {}) {
      const rows = lane ? selectClaimsByLane.all(lane) : selectAllClaims.all();
      return rows.map(rowToClaim);
    },

    // --- mirror ---
    getMirror() {
      const row = selectMirror.get();
      if (!row) return null;
      return { current_issue: row.current_issue, issues: parse(row.issues, "mirror.issues") };
    },

    setMirror({ current_issue, issues }) {
      upsertMirror.run(current_issue, JSON.stringify(issues));
    },

    recordMirror({ seq, issue, comment_id }) {
      updateEventMirror.run(issue, comment_id, seq);
    },

    resolveMirror({ issue, comment_id }) {
      const row = selectMirrorEntry.get(issue, comment_id);
      return row ? { seq: row.seq, issue, comment_id } : null;
    },

    // --- idempotency ---
    getIdempotency(lane, key) {
      const scopedKey = `${lane}:${key}`;
      const row = selectIdem.get(scopedKey);
      if (!row) return null;
      return {
        status: row.status,
        body: parse(row.body, "idempotency.body"),
        fingerprint: row.fingerprint,
        created_at: row.created_at,
      };
    },

    putIdempotency(lane, key, { status, body, fingerprint }) {
      const scopedKey = `${lane}:${key}`;
      // Bound the cache: keep only the most recent 1000 keys (secondary to TTL).
      const count = countIdem.get()?.n ?? 0;
      if (count >= 1000) {
        const oldest = oldestIdem.get();
        if (oldest) deleteIdem.run(oldest.scoped_key);
      }
      upsertIdem.run(scopedKey, status, JSON.stringify(body), fingerprint, now());
    },

    deleteIdempotency(lane, key) {
      deleteIdem.run(`${lane}:${key}`);
    },
  };
}
