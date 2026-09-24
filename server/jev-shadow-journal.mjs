// Durable shadow-decision journal for the Jev harness (docs/JEV-GATES.md).
//
// Both Jev gates run in shadow mode: they score, they log, they never
// enforce. This module is the log — one row per scored decision, restart-
// safe, with the score, the would-be decision, and the contributing
// signals. Hand review reads it through GET /api/rooms/{roomId}/jev-shadow
// (owner-only) and `scripts/room jev-shadow`.
//
// Purely additive, like spam_quarantine: no schema version bump, no
// writer-fence impact — a pre-journal writer has no code path to this
// table. All writes go through the store transaction. Rows are append-only:
// shadow decisions are measurements, never mutated after the fact.

import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const jevShadowLimits = Object.freeze({
  roomIdChars: 384, identityIdChars: 256, subjectChars: 256, ipHashChars: 128,
  pathChars: 128, decisionChars: 32, signalsBytes: 16384, batch: 500,
});
export const jevShadowGates = Object.freeze(["admission", "receipt"]);
// Would-be decisions, per gate. Admission: admit|review|reject (see
// server/jev-admission.mjs). Receipt: accept|request-changes|escalate
// (see server/jev-receipts.mjs).
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

const view = row => ({ id: row.id, gate: row.gate, roomId: row.room_id,
  identityId: row.identity_id ?? null, subject: row.subject ?? null, ipHash: row.ip_hash ?? null,
  path: row.path, score: row.score, decision: row.decision, escalate: row.escalate === 1,
  signals: JSON.parse(row.signals), recordedAt: row.recorded_at });

const textOf = (value, limit, field, { optional = false } = {}) => {
  if (value === null || value === undefined) {
    if (optional) return null;
    fail(422, "invalid_jev_shadow", `${field} is required`);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    fail(422, "invalid_jev_shadow", `${field} must be a 1..${limit} character string`);
  return value;
};

const signalsOf = signals => {
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

export class JevShadowJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly
  // missing schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='jev_shadow_decisions'").get()?.sql;
    const byRoom = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='jev_shadow_by_room'").get()?.sql;
    const velocity = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='jev_shadow_velocity'").get()?.sql;
    if (allowAbsent && table === undefined && byRoom === undefined && velocity === undefined) return false;
    if (table === undefined || byRoom === undefined || velocity === undefined)
      throw new Error("Jev shadow journal schema requires operator reconciliation");
    const expectedTable = jevShadowSchema.trim().split(";")[0];
    if (normalize(table) !== normalize(expectedTable))
      throw new Error("Jev shadow journal schema requires operator reconciliation");
    for (const [name, columns] of [["jev_shadow_by_room", "(room_id, recorded_at)"], ["jev_shadow_velocity", "(recorded_at, identity_id, ip_hash)"]]) {
      const actual = name === "jev_shadow_by_room" ? byRoom : velocity;
      if (normalize(actual) !== normalize(`CREATE INDEX ${name} ON jev_shadow_decisions${columns}`))
        throw new Error("Jev shadow journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: ids are gate-prefixed counters, scores are 0..1,
  // gates/decisions come from the fixed vocabularies, signals round-trip
  // as the {key, weight, value, detail} list, rows are append-only.
  verify() {
    return this.store.readTransaction(() => {
      const counts = { admission: 0, receipt: 0, escalate: 0 };
      for (const row of this.db.prepare("SELECT * FROM jev_shadow_decisions").all()) {
        if (!/^(jad|jrd)-[1-9][0-9]*$/.test(row.id)
          || !jevShadowGates.includes(row.gate)
          || !jevShadowDecisions.includes(row.decision)
          || typeof row.score !== "number" || row.score < 0 || row.score > 1
          || ![0, 1].includes(row.escalate)
          || row.recorded_at <= 0) throw new Error("Jev shadow journal requires operator reconciliation");
        if ((row.gate === "admission") !== row.id.startsWith("jad-"))
          throw new Error("Jev shadow journal requires operator reconciliation");
        let signals; try { signals = JSON.parse(row.signals); } catch { throw new Error("Jev shadow journal requires operator reconciliation"); }
        signalsOf(signals);
        counts[row.gate]++;
        if (row.escalate === 1) counts.escalate++;
      }
      return counts;
    });
  }
  // File one shadow decision. gate is admission|receipt; decision is the
  // would-be decision (admit|review|reject or accept|request-changes|
  // escalate); escalate flags entries that want a human look. Ids are
  // jad-<n> / jrd-<n> with per-gate counters derived from existing rows,
  // so they stay stable and unique across restarts.
  record({ gate, roomId, identityId = null, subject = null, ipHash = null, path,
    score, decision, escalate = false, signals = [], at = null }) {
    if (!jevShadowGates.includes(gate)) fail(422, "invalid_jev_shadow", "gate must be admission or receipt");
    textOf(roomId, jevShadowLimits.roomIdChars, "roomId");
    if (identityId !== null && identityId !== undefined) textOf(identityId, jevShadowLimits.identityIdChars, "identityId");
    if (subject !== null && subject !== undefined) textOf(subject, jevShadowLimits.subjectChars, "subject");
    if (ipHash !== null && ipHash !== undefined) textOf(ipHash, jevShadowLimits.ipHashChars, "ipHash");
    textOf(path, jevShadowLimits.pathChars, "path");
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)
      fail(422, "invalid_jev_shadow", "score must be 0..1");
    if (!jevShadowDecisions.includes(decision)) fail(422, "invalid_jev_shadow", `decision must be one of ${jevShadowDecisions.join(", ")}`);
    if (typeof escalate !== "boolean") fail(422, "invalid_jev_shadow", "escalate must be a boolean");
    signalsOf(signals);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_jev_shadow", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const prefix = gate === "admission" ? "jad-" : "jrd-";
      const next = this.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,5) AS INTEGER)),0) next FROM jev_shadow_decisions WHERE id LIKE ?")
        .get(`${prefix}%`).next + 1;
      const id = `${prefix}${next}`;
      this.db.prepare(`INSERT INTO jev_shadow_decisions
        (id,gate,room_id,identity_id,subject,ip_hash,path,score,decision,escalate,signals,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, gate, roomId, identityId ?? null, subject ?? null, ipHash ?? null, path,
          score, decision, escalate ? 1 : 0, JSON.stringify(signals), now);
      return view(this.db.prepare("SELECT * FROM jev_shadow_decisions WHERE id=?").get(id));
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_jev_shadow", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM jev_shadow_decisions WHERE id=?").get(id);
      return row ? view(row) : null;
    });
  }
  // The shadow-review listing: newest first. escalate:true filters to the
  // entries that want a human look (the attention rollup's feed).
  list({ gate = null, roomId = null, escalate = null, limit = 50 } = {}) {
    if (gate !== null && !jevShadowGates.includes(gate)) fail(422, "invalid_jev_shadow", "gate must be admission or receipt");
    if (roomId !== null) textOf(roomId, jevShadowLimits.roomIdChars, "roomId");
    if (escalate !== null && typeof escalate !== "boolean") fail(422, "invalid_jev_shadow", "escalate must be a boolean or null");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > jevShadowLimits.batch)
      fail(422, "invalid_jev_shadow", `limit must be 1..${jevShadowLimits.batch}`);
    return this.store.readTransaction(() => this.db.prepare(
      `SELECT * FROM jev_shadow_decisions
       WHERE (? IS NULL OR gate=?) AND (? IS NULL OR room_id=?) AND (? IS NULL OR escalate=?)
       ORDER BY recorded_at DESC, id DESC LIMIT ?`)
      .all(gate, gate, roomId, roomId, escalate === null ? null : 1, escalate === null ? null : (escalate ? 1 : 0), limit)
      .map(view));
  }
  counts({ roomId = null } = {}) {
    if (roomId !== null) textOf(roomId, jevShadowLimits.roomIdChars, "roomId");
    return this.store.readTransaction(() => {
      const counts = { admission: 0, receipt: 0, escalate: 0 };
      for (const row of this.db.prepare(
        `SELECT gate,escalate,count(*) n FROM jev_shadow_decisions WHERE (? IS NULL OR room_id=?) GROUP BY gate,escalate`)
        .all(roomId, roomId)) {
        counts[row.gate] += row.n;
        if (row.escalate === 1) counts.escalate += row.n;
      }
      return counts;
    });
  }
  // Join-velocity feed for the admission gate: how many joins this identity
  // / IP hash made inside the window. The gate's pure scorer takes the
  // counts; the journal owns the counting.
  recentJoinCount({ identityId = null, ipHash = null, windowMs }) {
    if (identityId === null && ipHash === null) fail(422, "invalid_jev_shadow", "identityId or ipHash is required");
    if (identityId !== null) textOf(identityId, jevShadowLimits.identityIdChars, "identityId");
    if (ipHash !== null) textOf(ipHash, jevShadowLimits.ipHashChars, "ipHash");
    if (!Number.isFinite(windowMs) || windowMs <= 0) fail(422, "invalid_jev_shadow", "windowMs must be a positive duration");
    return this.store.readTransaction(() => {
      const since = this.store.now() - windowMs;
      const row = this.db.prepare(
        `SELECT count(*) n FROM jev_shadow_decisions
         WHERE gate='admission' AND recorded_at>=? AND ((? IS NOT NULL AND identity_id=?) OR (? IS NOT NULL AND ip_hash=?))`)
        .get(since, identityId, identityId, ipHash, ipHash);
      return row.n;
    });
  }
}

function requireOwner(store, auth, roomId) {
  // Mirrors the diagnostics-export owner gate (server/owner-attention.mjs).
  if (auth.member.kind !== "human" || auth.member.id !== store.room(roomId).state.room.ownerId
    || !auth.member.permissions.includes("manage_members")) {
    fail(403, "owner_required", "Only the room owner can review shadow decisions");
  }
}

// Owner-only, read-only shadow-review surface for
// GET /api/rooms/{roomId}/jev-shadow. Shadow data is measurement, not
// membership: the listing never mutates anything.
export function jevShadowReport(deps, token, roomId, { gate = null, escalate = null, limit = 50 } = {},
  expectedSessionBinding = null, nowMs = Date.now()) {
  const { store } = deps;
  if (!store || !store.jevShadow) fail(500, "misconfigured", "Shadow journal is not wired");
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  requireOwner(store, auth, roomId);
  const entries = store.jevShadow.list({ gate, roomId, escalate, limit });
  return Object.freeze({
    roomId,
    viewerId: auth.member.id,
    evaluatedAt: new Date(nowMs).toISOString(),
    counts: store.jevShadow.counts({ roomId }),
    entries: Object.freeze(entries),
  });
}
