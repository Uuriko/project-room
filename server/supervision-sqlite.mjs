// Herdr session + supervision-card storage layer.
//
// Project Room x herdr redesign (Phase 3, lane B5 tables; Phase 2 design D4
// inbox wiring). Owns six additive tables, all registered in
// server/writer-fence.mjs `unfencedAdditiveTables` and intentionally outside
// the writer fence: older writers have no code path to them.
//
//   herdr_sessions             fork session id <-> room/member/claim linkage, backend marker
//   herdr_session_journal      append-only: create | attach | heartbeat | detach | fallback
//   herdr_lane_optin           per-lane sessionBackend opt-in markers (Phase B gating)
//   herdr_backend_state        fork health / last error (fail-closed evidence)
//   private_supervision_cards  v1 triage inbox cards (D4)
//   private_supervision_card_history  append-only card state transitions (D4)
//
// The supervision API (lane B6) builds on this module. It is Worker-safe:
// only db.prepare/get/all/run/exec are used, no node: imports.
//
// Honesty rules baked in:
// - herdr `done` != claim `done`: detach() timestamps the row, it never deletes it.
// - The journals are append-only: the store exposes no update/delete path for
//   journal rows, and dismiss is a card state, never a delete.
// - Occupant pinning: attach() records a pin token; checkOccupant() rejects
//   stale tokens. Groundwork for the adapter's OccupantChangedError.

export const HERDR_JOURNAL_EVENTS = Object.freeze(["create", "attach", "heartbeat", "detach", "fallback"]);
export const HERDR_SESSION_STATES = Object.freeze(["working", "blocked", "idle", "done", "unknown"]);
export const HERDR_BACKENDS = Object.freeze(["herdr", "legacy"]);

// D4 inbox wiring: card taxonomy is closed in v1.
export const SUPERVISION_CARD_KINDS = Object.freeze(["review_request", "blocked_lane", "done_receipt"]);
export const SUPERVISION_CARD_STATES = Object.freeze([
  "new", "seen", "acting", "pending_undo", "dispatched", "resolved", "dismissed", "snoozed", "stale",
]);
export const SUPERVISION_REVIEW_VERDICTS = Object.freeze(["approve", "changes_requested", "comment"]);

// Cloudflare Workers' SQLite exec() rejects a trailing chunk after the final
// semicolon that holds no statement, so this literal ends on a real statement
// and carries no comments inside (repo lesson, PR #825).
export const herdrSessionSchema = `
  CREATE TABLE IF NOT EXISTS herdr_sessions (
    session_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    fork_session_id TEXT NOT NULL,
    member_id TEXT,
    claim_id TEXT,
    backend TEXT NOT NULL DEFAULT 'herdr',
    occupant_token TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'unknown',
    resume_json TEXT,
    created_at INTEGER NOT NULL,
    attached_at INTEGER,
    detached_at INTEGER,
    last_heartbeat_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (fork_session_id)
  );
  CREATE TABLE IF NOT EXISTS herdr_session_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS herdr_lane_optin (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    backend TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS herdr_backend_state (
    room_id TEXT PRIMARY KEY,
    reachable INTEGER NOT NULL DEFAULT 1,
    last_error_json TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS private_supervision_cards (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'new',
    actor_id TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    claim_id TEXT,
    pr_ref TEXT,
    head_sha TEXT,
    review_verdict TEXT,
    priority INTEGER NOT NULL,
    source_seq INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    undo_deadline INTEGER,
    undoable INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    suggested TEXT NOT NULL,
    picked_action TEXT,
    receipt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (room_id, operator_id, kind, claim_id, source_seq)
  );
  CREATE TABLE IF NOT EXISTS private_supervision_card_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES private_supervision_cards(id),
    at INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    by TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_herdr_sessions_room_member ON herdr_sessions(room_id, member_id);
  CREATE INDEX IF NOT EXISTS idx_herdr_sessions_room_claim ON herdr_sessions(room_id, claim_id);
  CREATE INDEX IF NOT EXISTS idx_herdr_session_journal_session ON herdr_session_journal(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_supervision_cards_operator ON private_supervision_cards(room_id, operator_id, priority);
  CREATE INDEX IF NOT EXISTS idx_supervision_card_history_card ON private_supervision_card_history(card_id, seq);
`;

const schemaDefinitions = () => herdrSessionSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
const definitionName = sql => /CREATE\s+(?:TABLE|INDEX)\s+IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/i.exec(sql)?.[1];
const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");

// Fail-closed schema check (work-claim-sqlite.mjs precedent): drift throws
// "requires operator reconciliation" instead of silently reading a foreign shape.
export function verifyHerdrSessionSchema(db, { allowAbsent = false } = {}) {
  const shapes = schemaDefinitions().map(sql => ({
    sql,
    actual: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(definitionName(sql))?.sql,
  }));
  if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
  if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) {
    throw new Error("Herdr session schema requires operator reconciliation");
  }
  return true;
}

export function ensureHerdrSessionSchema(db) {
  db.exec(herdrSessionSchema);
  return verifyHerdrSessionSchema(db);
}

const oneOf = (name, value, list) => {
  if (!list.includes(value)) throw new Error(`herdr supervision: invalid ${name} ${JSON.stringify(value)}`);
};
const encodeJson = value => (value === undefined || value === null ? null : JSON.stringify(value));
const decodeJson = (text, fallback = null) => (text === null || text === undefined ? fallback : JSON.parse(text));

const decodeSession = row => row ? {
  sessionId: row.session_id,
  roomId: row.room_id,
  forkSessionId: row.fork_session_id,
  memberId: row.member_id,
  claimId: row.claim_id,
  backend: row.backend,
  occupantToken: row.occupant_token,
  state: row.state,
  resume: decodeJson(row.resume_json),
  createdAt: row.created_at,
  attachedAt: row.attached_at,
  detachedAt: row.detached_at,
  lastHeartbeatAt: row.last_heartbeat_at,
  updatedAt: row.updated_at,
} : null;

const decodeOptIn = row => row ? {
  roomId: row.room_id, memberId: row.member_id, backend: row.backend,
  setBy: row.set_by, setAt: row.set_at, updatedAt: row.updated_at,
} : null;

const decodeHealth = row => row ? {
  roomId: row.room_id,
  reachable: row.reachable,
  lastError: decodeJson(row.last_error_json),
  consecutiveFailures: row.consecutive_failures,
  updatedAt: row.updated_at,
} : null;

const decodeCard = row => row ? {
  id: row.id,
  roomId: row.room_id,
  operatorId: row.operator_id,
  kind: row.kind,
  state: row.state,
  actorId: row.actor_id,
  actorLabel: row.actor_label,
  claimId: row.claim_id,
  prRef: row.pr_ref,
  headSha: row.head_sha,
  reviewVerdict: row.review_verdict,
  priority: row.priority,
  sourceSeq: row.source_seq,
  sourceType: row.source_type,
  summary: row.summary,
  undoDeadline: row.undo_deadline,
  undoable: row.undoable === 1,
  snoozedUntil: row.snoozed_until,
  suggested: decodeJson(row.suggested, []),
  pickedAction: decodeJson(row.picked_action),
  receipt: row.receipt,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

const CARD_ID_RE = /^tc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateCard(card) {
  if (!card || typeof card !== "object") throw new TypeError("herdr supervision: card must be an object");
  if (!CARD_ID_RE.test(card.id ?? "")) throw new Error(`herdr supervision: invalid card id ${JSON.stringify(card.id)} (want tc_<uuid>)`);
  oneOf("card kind", card.kind, SUPERVISION_CARD_KINDS);
  if (card.state !== undefined) oneOf("card state", card.state, SUPERVISION_CARD_STATES);
  if (card.reviewVerdict !== undefined && card.reviewVerdict !== null) {
    oneOf("review verdict", card.reviewVerdict, SUPERVISION_REVIEW_VERDICTS);
  }
  if (!Number.isInteger(card.priority) || card.priority < 0 || card.priority > 100) {
    throw new Error(`herdr supervision: invalid card priority ${JSON.stringify(card.priority)} (want 0..100)`);
  }
  if (typeof card.summary !== "string" || [...card.summary].length > 140) {
    throw new Error("herdr supervision: card summary must be a string of at most 140 chars");
  }
  if (!Array.isArray(card.suggested) || card.suggested.length > 2) {
    throw new Error("herdr supervision: card suggested must be an array of 0..2 suggestions");
  }
  for (const key of ["roomId", "operatorId", "actorId", "actorLabel", "sourceType"]) {
    if (typeof card[key] !== "string" || card[key] === "") throw new Error(`herdr supervision: card ${key} is required`);
  }
  if (!Number.isInteger(card.sourceSeq)) throw new Error("herdr supervision: card sourceSeq must be an integer");
}

// Columns B6 may maintain outside a state transition (the pick flow sets
// picked_action/undo_deadline alongside the acting/pending_undo transition).
const CARD_UPDATABLE_COLUMNS = {
  pickedAction: { column: "picked_action", encode: encodeJson },
  receipt: { column: "receipt" },
  undoDeadline: { column: "undo_deadline" },
  undoable: { column: "undoable", encode: v => (v ? 1 : 0) },
  snoozedUntil: { column: "snoozed_until" },
  reviewVerdict: { column: "review_verdict", validate: v => v == null || oneOf("review verdict", v, SUPERVISION_REVIEW_VERDICTS) },
  headSha: { column: "head_sha" },
  prRef: { column: "pr_ref" },
  actorLabel: { column: "actor_label" },
  priority: { column: "priority", validate: v => {
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error(`herdr supervision: invalid card priority ${JSON.stringify(v)}`);
  } },
  summary: { column: "summary", validate: v => {
    if (typeof v !== "string" || [...v].length > 140) throw new Error("herdr supervision: card summary must be a string of at most 140 chars");
  } },
  suggested: { column: "suggested", encode: encodeJson, validate: v => {
    if (!Array.isArray(v) || v.length > 2) throw new Error("herdr supervision: card suggested must be an array of 0..2 suggestions");
  } },
};

export function createHerdrSessionStore(db, { now = () => Date.now(), transaction = fn => fn(), onChange = null } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("herdr supervision: a SQLite database handle is required");
  }
  // The module verifies (and creates) its own schema on open; older writers
  // have no code path to these tables, so eager CREATE TABLE IF NOT EXISTS
  // is safe and idempotent (compat-plan §4).
  ensureHerdrSessionSchema(db);

  const statement = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });
  const changed = roomId => { if (typeof onChange === "function" && roomId) onChange(roomId); };

  // ---- herdr_sessions ----
  const insertSession = statement(`INSERT INTO herdr_sessions
    (session_id, room_id, fork_session_id, member_id, claim_id, backend, occupant_token, state, resume_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectSession = statement("SELECT * FROM herdr_sessions WHERE session_id=?");
  const selectByFork = statement("SELECT * FROM herdr_sessions WHERE fork_session_id=?");
  const selectByClaim = statement(`SELECT * FROM herdr_sessions WHERE room_id=? AND claim_id=?
    ORDER BY detached_at IS NULL DESC, COALESCE(attached_at, 0) DESC LIMIT 1`);
  const selectActive = statement("SELECT * FROM herdr_sessions WHERE room_id=? AND detached_at IS NULL ORDER BY updated_at DESC");
  const selectByMember = statement("SELECT * FROM herdr_sessions WHERE room_id=? AND member_id=? ORDER BY updated_at DESC");
  const updateAttach = statement(`UPDATE herdr_sessions SET member_id=?, claim_id=?, occupant_token=?,
    attached_at=?, updated_at=? WHERE session_id=?`);
  const updateDetach = statement("UPDATE herdr_sessions SET detached_at=?, updated_at=? WHERE session_id=?");
  const updateHeartbeat = statement(`UPDATE herdr_sessions SET last_heartbeat_at=?, state=COALESCE(?, state),
    updated_at=? WHERE session_id=?`);
  const updateSessionState = statement("UPDATE herdr_sessions SET state=?, updated_at=? WHERE session_id=?");

  // ---- herdr_session_journal (append-only: no update/delete statements exist) ----
  const insertJournal = statement(`INSERT INTO herdr_session_journal
    (session_id, room_id, event, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`);
  const selectJournal = statement("SELECT * FROM herdr_session_journal WHERE session_id=? ORDER BY seq ASC");
  const selectJournalLimit = statement("SELECT * FROM herdr_session_journal WHERE session_id=? ORDER BY seq ASC LIMIT ?");

  // ---- herdr_lane_optin ----
  const upsertOptIn = statement(`INSERT INTO herdr_lane_optin
    (room_id, member_id, backend, set_by, set_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, member_id) DO UPDATE SET backend=excluded.backend, set_by=excluded.set_by, updated_at=excluded.updated_at`);
  const selectOptIn = statement("SELECT * FROM herdr_lane_optin WHERE room_id=? AND member_id=?");
  const selectOptIns = statement("SELECT * FROM herdr_lane_optin WHERE room_id=? ORDER BY member_id ASC");

  // ---- herdr_backend_state ----
  const selectHealth = statement("SELECT * FROM herdr_backend_state WHERE room_id=?");
  const insertHealth = statement(`INSERT INTO herdr_backend_state
    (room_id, reachable, last_error_json, consecutive_failures, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const updateHealth = statement(`UPDATE herdr_backend_state SET reachable=?, last_error_json=?,
    consecutive_failures=?, updated_at=? WHERE room_id=?`);

  // ---- private_supervision_cards ----
  // Dedupe key per D4: (room_id, operator_id, kind, claim_id, source_seq).
  // COALESCE(claim_id,'') because SQLite UNIQUE treats NULLs as distinct —
  // the app-level guard is the real dedupe; the DDL UNIQUE documents the key.
  const insertCard = statement(`INSERT INTO private_supervision_cards
    (id, room_id, operator_id, kind, state, actor_id, actor_label, claim_id, pr_ref, head_sha,
     review_verdict, priority, source_seq, source_type, summary, undo_deadline, undoable,
     snoozed_until, suggested, picked_action, receipt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const refreshCard = statement(`UPDATE private_supervision_cards SET summary=?, priority=?,
    source_type=?, suggested=?, pr_ref=?, head_sha=?, updated_at=? WHERE id=?`);
  const selectCard = statement("SELECT * FROM private_supervision_cards WHERE id=?");
  const selectCardByUnique = statement(`SELECT * FROM private_supervision_cards
    WHERE room_id=? AND operator_id=? AND kind=? AND COALESCE(claim_id,'')=? AND source_seq=?`);
  const updateCardState = statement("UPDATE private_supervision_cards SET state=?, updated_at=? WHERE id=?");
  const insertCardHistory = statement(`INSERT INTO private_supervision_card_history
    (card_id, at, from_state, to_state, by, note) VALUES (?, ?, ?, ?, ?, ?)`);
  const selectCardHistory = statement("SELECT * FROM private_supervision_card_history WHERE card_id=? ORDER BY seq ASC");

  const requireSession = sessionId => {
    const row = selectSession.get(sessionId);
    if (!row) throw new Error(`herdr supervision: unknown session ${sessionId}`);
    return row;
  };
  const requireCard = id => {
    const row = selectCard.get(id);
    if (!row) throw new Error(`herdr supervision: unknown card ${id}`);
    return row;
  };
  const appendJournal = (sessionId, roomId, event, detail) => {
    oneOf("journal event", event, HERDR_JOURNAL_EVENTS);
    insertJournal.run(sessionId, roomId, event, encodeJson(detail), now());
  };

  return {
    transaction,
    verifySchema: (opts = {}) => verifyHerdrSessionSchema(db, opts),
    ensureSchema: () => ensureHerdrSessionSchema(db),

    // ---- sessions ----
    createSession({ sessionId, roomId, forkSessionId, memberId = null, claimId = null,
      backend = "herdr", occupantToken, state = "unknown", resume = null, createDetail = null } = {}) {
      if (!sessionId || !roomId || !forkSessionId) throw new TypeError("herdr supervision: sessionId, roomId and forkSessionId are required");
      if (!occupantToken) throw new TypeError("herdr supervision: occupantToken is required (sendText/sendKeys are occupant-pinned)");
      oneOf("backend", backend, HERDR_BACKENDS);
      oneOf("session state", state, HERDR_SESSION_STATES);
      const at = now();
      transaction(() => {
        insertSession.run(sessionId, roomId, forkSessionId, memberId, claimId, backend,
          occupantToken, state, encodeJson(resume), at, at);
        appendJournal(sessionId, roomId, "create", createDetail);
      });
      changed(roomId);
      return decodeSession(selectSession.get(sessionId));
    },
    getSession: sessionId => decodeSession(selectSession.get(sessionId)),
    getByForkSessionId: forkSessionId => decodeSession(selectByFork.get(forkSessionId)),
    sessionForClaim: (roomId, claimId) => decodeSession(selectByClaim.get(roomId, claimId)),
    listActive: roomId => selectActive.all(roomId).map(decodeSession),
    listByMember: (roomId, memberId) => selectByMember.all(roomId, memberId).map(decodeSession),
    attachSession(sessionId, { memberId = null, claimId = null, occupantToken } = {}) {
      const current = requireSession(sessionId);
      if (!occupantToken) throw new TypeError("herdr supervision: occupantToken is required on attach (pin rotation)");
      const at = now();
      transaction(() => {
        updateAttach.run(memberId, claimId, occupantToken, at, at, sessionId);
        appendJournal(sessionId, current.room_id, "attach", { memberId, claimId });
      });
      changed(current.room_id);
      return decodeSession(selectSession.get(sessionId));
    },
    detachSession(sessionId, { reason = null } = {}) {
      const current = requireSession(sessionId);
      const at = now();
      transaction(() => {
        updateDetach.run(at, at, sessionId);
        appendJournal(sessionId, current.room_id, "detach", { reason });
      });
      changed(current.room_id);
      return decodeSession(selectSession.get(sessionId));
    },
    heartbeat(sessionId, { state = null } = {}) {
      const current = requireSession(sessionId);
      if (state !== null) oneOf("session state", state, HERDR_SESSION_STATES);
      const at = now();
      transaction(() => {
        updateHeartbeat.run(at, state, at, sessionId);
        appendJournal(sessionId, current.room_id, "heartbeat", { state });
      });
      changed(current.room_id);
      return decodeSession(selectSession.get(sessionId));
    },
    reportSessionState(sessionId, state, detail = null) {
      const current = requireSession(sessionId);
      oneOf("session state", state, HERDR_SESSION_STATES);
      const at = now();
      updateSessionState.run(state, at, sessionId);
      changed(current.room_id);
      return decodeSession(selectSession.get(sessionId));
    },
    // Occupant pinning groundwork for the adapter's OccupantChangedError:
    // a stale supervisor handle never verifies against a re-occupied pane.
    checkOccupant: (sessionId, token) => selectSession.get(sessionId)?.occupant_token === token,

    // ---- journal (append-only) ----
    appendJournal({ sessionId, roomId, event, detail = null } = {}) {
      if (!sessionId || !roomId) throw new TypeError("herdr supervision: journal needs sessionId and roomId");
      requireSession(sessionId);
      appendJournal(sessionId, roomId, event, detail);
      changed(roomId);
    },
    journalFor(sessionId, { limit = 0 } = {}) {
      const rows = limit > 0 ? selectJournalLimit.all(sessionId, limit) : selectJournal.all(sessionId);
      return rows.map(row => ({
        seq: row.seq,
        sessionId: row.session_id,
        roomId: row.room_id,
        event: row.event,
        detail: decodeJson(row.detail_json),
        createdAt: row.created_at,
      }));
    },

    // ---- lane opt-in (Phase B gating) ----
    setOptIn({ roomId, memberId, backend, setBy } = {}) {
      if (!roomId || !memberId || !setBy) throw new TypeError("herdr supervision: opt-in needs roomId, memberId and setBy");
      oneOf("backend", backend, HERDR_BACKENDS);
      const at = now();
      const existing = selectOptIn.get(roomId, memberId);
      upsertOptIn.run(roomId, memberId, backend, setBy, existing?.set_at ?? at, at);
      changed(roomId);
      return decodeOptIn(selectOptIn.get(roomId, memberId));
    },
    getOptIn: (roomId, memberId) => decodeOptIn(selectOptIn.get(roomId, memberId)),
    listOptIns: roomId => selectOptIns.all(roomId).map(decodeOptIn),

    // ---- backend health (fail-closed evidence) ----
    recordHealth({ roomId, reachable, error = null } = {}) {
      if (!roomId) throw new TypeError("herdr supervision: health needs roomId");
      const at = now();
      transaction(() => {
        const current = selectHealth.get(roomId);
        const failures = reachable ? 0 : (current?.consecutive_failures ?? 0) + 1;
        if (current) updateHealth.run(reachable ? 1 : 0, encodeJson(error), failures, at, roomId);
        else insertHealth.run(roomId, reachable ? 1 : 0, encodeJson(error), failures, at);
      });
      changed(roomId);
      return decodeHealth(selectHealth.get(roomId));
    },
    getHealth: roomId => decodeHealth(selectHealth.get(roomId)),

    // ---- supervision cards (D4) ----
    // Idempotent: the same event re-ticked never spawns a second card — the
    // UNIQUE(room_id, operator_id, kind, claim_id, source_seq) key dedupes and
    // the existing row gets its excerpt/priority refreshed.
    upsertCard(card) {
      validateCard(card);
      return transaction(() => {
        const at = now();
        const key = card.claimId ?? "";
        const existing = selectCardByUnique.get(card.roomId, card.operatorId, card.kind, key, card.sourceSeq);
        if (existing) {
          // Re-derivation refreshes the excerpt/priority — never the state.
          refreshCard.run(card.summary, card.priority, card.sourceType, JSON.stringify(card.suggested),
            card.prRef ?? null, card.headSha ?? null, at, existing.id);
          changed(card.roomId);
          return { card: decodeCard(selectCard.get(existing.id)), created: false };
        }
        insertCard.run(card.id, card.roomId, card.operatorId, card.kind, card.state ?? "new",
          card.actorId, card.actorLabel, card.claimId ?? null, card.prRef ?? null,
          card.headSha ?? null, card.reviewVerdict ?? null, card.priority, card.sourceSeq,
          card.sourceType, card.summary, card.undoDeadline ?? null, card.undoable ? 1 : 0,
          card.snoozedUntil ?? null, JSON.stringify(card.suggested),
          encodeJson(card.pickedAction), card.receipt ?? null, at, at);
        changed(card.roomId);
        return { card: decodeCard(selectCard.get(card.id)), created: true };
      });
    },
    getCard: id => decodeCard(selectCard.get(id)),
    listCards(roomId, operatorId, { includeSnoozed = false, since = 0 } = {}) {
      const at = now();
      const rows = statement(`SELECT * FROM private_supervision_cards
        WHERE room_id=? AND operator_id=? AND updated_at>? AND (? OR NOT (state='snoozed' AND snoozed_until > ?))
        ORDER BY priority DESC, updated_at DESC`).all(roomId, operatorId, since, includeSnoozed ? 1 : 0, at);
      return rows.map(decodeCard);
    },
    // The single state-mutation path: every transition is journaled to
    // private_supervision_card_history. Nothing is ever deleted.
    transitionCard(id, toState, { by = "system", note = null } = {}) {
      oneOf("card state", toState, SUPERVISION_CARD_STATES);
      if (!by) throw new TypeError("herdr supervision: card transitions need a by actor");
      return transaction(() => {
        const current = requireCard(id);
        const at = now();
        insertCardHistory.run(id, at, current.state, toState, by, note);
        updateCardState.run(toState, at, id);
        changed(current.room_id);
        return decodeCard(selectCard.get(id));
      });
    },
    // Field maintenance outside state transitions (e.g. the pick flow sets
    // picked_action + undo_deadline next to the pending_undo transition).
    updateCardFields(id, fields = {}) {
      const current = requireCard(id);
      const sets = [];
      const args = [];
      for (const [key, value] of Object.entries(fields)) {
        const spec = CARD_UPDATABLE_COLUMNS[key];
        if (!spec) throw new Error(`herdr supervision: card field ${JSON.stringify(key)} is not updatable`);
        spec.validate?.(value);
        sets.push(`${spec.column}=?`);
        args.push(spec.encode ? spec.encode(value) : value);
      }
      if (sets.length === 0) throw new Error("herdr supervision: updateCardFields needs at least one field");
      const at = now();
      statement(`UPDATE private_supervision_cards SET ${sets.join(", ")}, updated_at=? WHERE id=?`).run(...args, at, id);
      changed(current.room_id);
      return decodeCard(selectCard.get(id));
    },
    cardHistory(cardId) {
      return selectCardHistory.all(cardId).map(row => ({
        seq: row.seq,
        cardId: row.card_id,
        at: row.at,
        fromState: row.from_state,
        toState: row.to_state,
        by: row.by,
        note: row.note,
      }));
    },
  };
}
