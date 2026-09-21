// Escrowed bounties, slice 1 (agent work exchange).
//
// A valueless-credit ledger for bounties between the room's agent lanes.
// Credits are pure ledger units: no cash-out, no on-chain touch, no real
// money. The one and only mint is the genesis issuance (100 credits per
// pre-registered lane); every later movement is a zero-sum transfer between
// lot states, so the conservation invariant holds by construction:
//
//   payable + locked + attributed + approved = total_issued
//
// (There is no `settled` state in slice 1 — the payable -> settled exit is
// deliberately unimplemented.)
//
// Lifecycle (Plane-steal triage model):
//   PROPOSED --fund--> FUNDED --claim--> CLAIMED --submit--> SUBMITTED
//     --accept (gated approval)--> ACCEPTED --challenge window--> APPROVED
//     --epoch sweep--> PAID
//   PROPOSED --decline/duplicate--> CANCELLED ; PROPOSED --snooze--> PROPOSED (deferred)
//   FUNDED/CLAIMED --timeout--> REFUNDED ; SUBMITTED/ACCEPTED --dispute--> DISPUTED
//     --RELEASE--> APPROVED | --CANCEL--> REFUNDED
//
// Semantic state groups drive computation (progress, metrics, archival);
// display labels stay inside their group. Query param is ?group=.
// Bounty ids are sequential per room (ROOM-12); the bracketed form [ROOM-12]
// is link-only in slice 1 — no text reference ever triggers a side effect.
//
// Design:
// - Double-entry, append-only journal (`bounty_journal`). Balances are
//   DERIVED from the journal, never stored. Each entry is hash-chained to
//   the account's previous entry, so per-account receipts are tamper-evident.
// - Amounts are integer milli-credits internally (1 credit = 1000); the API
//   speaks credits with at most 3 decimals.
// - Every state transition records actor {kind: human|agent|rule, id} with
//   before/after values; receipts carry attribution; time-in-state is
//   computed on reads.
// - Disputes compose with the existing pure machine in
//   server/bounty-disputes.mjs: this module is the first consumer of its
//   onDisputeFinalized callback. Tier-1 arbitration seats via
//   server/dispute-arbiters.mjs (designated verifier, verifier != executor).
//   Disputes delay, never confiscate.
// - Persistence follows the additive-journal pattern: CREATE TABLE IF NOT
//   EXISTS, no schema version bump, tables registered in
//   unfencedAdditiveTables (server/writer-fence.mjs) so the recovery audit's
//   exact table list keeps passing. The dispute machine's caller-owned Map
//   is hydrated from `bounty_disputes` and written through on every
//   transition, so disputes survive restarts.
//
// Identity: ledger accounts are lane ids (`id:agent/jill`, ...). The HTTP
// layer maps the authenticated member id through canonicalLane().
import { createHash, randomUUID } from "node:crypto";
import { createDisputes, DisputeError } from "./bounty-disputes.mjs";
import { createArbiters } from "./dispute-arbiters.mjs";

export const GENESIS_LANES = Object.freeze([
  "id:agent/jill", "id:agent/instinct", "id:agent/grokbot", "id:agent/codex",
]);
export const GENESIS_CREDITS = 100;
export const MILLIS_PER_CREDIT = 1000;
export const CLAIM_BOND_MILLIS = 1000; // 1 credit anti-flake bond, fixed per room (slice 1)
export const FEE_NUMERATOR = 1;
export const FEE_DENOMINATOR = 100; // 1% of the award to the room pool, on released payouts only
export const DISPUTE_BOND_RATIO = 0.25; // challenger stakes exactly 25% of the bounty (<=25% total dispute cost, per v2)
export const CHALLENGE_WINDOW_SMALL_MS = 24 * 3600 * 1000; // micro-bounties (< 1 credit)
export const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const DISPUTE_TIMEOUT_MS = 14 * 24 * 3600 * 1000; // unresolved disputes default to RELEASE
export const MAX_CREDITS = 1000000;
export const POOL_ACCOUNT = "pool"; // room pool: the 1% fee recipient (the commons, not a participant)
export const RULE_ACTOR = Object.freeze({ kind: "rule", id: "escrow-keeper" }); // mechanical transitions

export const BOUNTY_STATES = Object.freeze([
  "proposed", "funded", "claimed", "submitted", "accepted", "disputed",
  "approved", "paid", "refunded", "cancelled",
]);
// Semantic state groups (canonical; display labels stay inside their group).
export const BOUNTY_GROUPS = Object.freeze(["proposed", "funded", "claimed", "in-review", "paid", "cancelled"]);
export function stateGroup(state) {
  switch (state) {
    case "proposed": return "proposed";
    case "funded": return "funded";
    case "claimed": return "claimed";
    case "submitted": case "disputed": case "accepted": case "approved": return "in-review";
    case "paid": return "paid";
    case "refunded": case "cancelled": return "cancelled";
    default: return null;
  }
}
const LOT_STATES = ["payable", "locked", "attributed", "approved"];
const TERMINAL_STATES = new Set(["paid", "refunded", "cancelled"]);
// Journal kinds that move the AWARD itself (vs. bonds, fees, transfers).
const AWARD_KINDS = new Set(["escrow-lock", "attribute", "approve", "payout", "refund", "fee"]);

export const bountyEscrowSchema = `
  CREATE TABLE IF NOT EXISTS bounty_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    entry_id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    bounty_id TEXT,
    lot_id TEXT,
    amount INTEGER NOT NULL,
    lot_state TEXT NOT NULL CHECK(lot_state IN ('payable','locked','attributed','approved')),
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    memo TEXT,
    actor_kind TEXT,
    actor_id TEXT
  );
  CREATE INDEX IF NOT EXISTS bounty_journal_account ON bounty_journal(room_id, account_id, seq);
  CREATE INDEX IF NOT EXISTS bounty_journal_bounty ON bounty_journal(room_id, bounty_id);
  CREATE TABLE IF NOT EXISTS bounty_records (
    bounty_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL,
    criteria TEXT NOT NULL,
    amount_millis INTEGER NOT NULL CHECK(amount_millis > 0),
    poster TEXT NOT NULL,
    verifier TEXT,
    claimant TEXT,
    state TEXT NOT NULL,
    state_changed_ms INTEGER NOT NULL,
    deadline_ms INTEGER NOT NULL,
    challenge_ends_ms INTEGER,
    dispute_id TEXT,
    dispute_opened_ms INTEGER,
    snoozed_until_ms INTEGER,
    decline_reason TEXT,
    duplicate_of TEXT,
    label TEXT,
    evidence_json TEXT,
    attestation_json TEXT,
    resolution_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bounty_records_room ON bounty_records(room_id, state);
  CREATE TABLE IF NOT EXISTS bounty_disputes (
    dispute_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bounty_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    bounty_id TEXT,
    actor_kind TEXT,
    actor_id TEXT,
    before_state TEXT,
    after_state TEXT,
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX IF NOT EXISTS bounty_events_room ON bounty_events(room_id, seq);
  CREATE TABLE IF NOT EXISTS bounty_idempotency (
    room_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL CHECK(json_valid(response)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(room_id, idem_key)
  );
  CREATE TABLE IF NOT EXISTS bounty_watchers (
    room_id TEXT NOT NULL,
    bounty_id TEXT NOT NULL,
    watcher TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(room_id, bounty_id, watcher)
  );
  CREATE TABLE IF NOT EXISTS bounty_sequences (
    room_id TEXT PRIMARY KEY,
    next_n INTEGER NOT NULL
  );
`;

class EscrowError extends Error {
  constructor(code, message) { super(message); this.name = "EscrowError"; this.code = code; }
}
const fail = (code, message) => { throw new EscrowError(code, message); };
// Assert-style: throws unless the condition holds.
const check = (condition, code, message) => { if (!condition) fail(code, message); };

// Map the authenticated member id to the ledger lane account. `id:agent:<lane>`
// (colon form, validId-shaped) and `id:agent/<lane>` (canonical lane form)
// name the same account; anything else passes through unchanged.
export function canonicalLane(memberId) {
  if (typeof memberId !== "string" || memberId.length === 0) fail("invalid_input", "identity must be a non-empty string");
  if (memberId.startsWith("id:agent/")) return memberId;
  if (memberId.startsWith("id:agent:")) return `id:agent/${memberId.slice("id:agent:".length)}`;
  return memberId;
}

// Normalize an actor to {kind: human|agent|rule, id}. Callers pass an explicit
// actor; when absent it is derived from the acting identity (agent lanes are
// `id:agent/...`, anything else is human). Mechanical transitions use
// RULE_ACTOR explicitly.
const ACTOR_KINDS = new Set(["human", "agent", "rule"]);
export function normalizeActor(actor, fallbackId) {
  if (actor && typeof actor === "object" && typeof actor.kind === "string" && typeof actor.id === "string") {
    check(ACTOR_KINDS.has(actor.kind), "invalid_input", `unknown actor kind "${actor.kind}"`);
    return Object.freeze({ kind: actor.kind, id: actor.id });
  }
  const id = String(fallbackId ?? "unknown");
  return Object.freeze({ kind: id.startsWith("id:agent/") ? "agent" : "human", id });
}

// Credits (float, <= 3 decimals) -> integer milli-credits. Rejects negatives,
// zero, NaN/Infinity, > 3 decimals, and absurd magnitudes.
export function toMillis(amount) {
  check(typeof amount === "number" && Number.isFinite(amount), "invalid_amount", "amount must be a finite number");
  check(amount > 0, "invalid_amount", "amount must be positive");
  check(amount <= MAX_CREDITS, "invalid_amount", `amount exceeds the ${MAX_CREDITS}-credit cap`);
  const millis = Math.round(amount * MILLIS_PER_CREDIT);
  check(Math.abs(amount * MILLIS_PER_CREDIT - millis) < 1e-6, "invalid_amount", "amount supports at most 3 decimals");
  check(millis > 0, "invalid_amount", "amount is below the smallest unit (0.001 credits)");
  return millis;
}
export const toCredits = millis => millis / MILLIS_PER_CREDIT;

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const newId = prefix => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const isoNow = ms => new Date(ms).toISOString();
// Quotable sequential bounty ids per room (e.g. ROOM-12). The bracketed form
// [ROOM-12] is link-only in slice 1: no code path scans text for references,
// so bare or bracketed mentions can never trigger a side effect.
const roomSlug = roomId => roomId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "ROOM";

export class BountyEscrow {
  constructor(store, { now } = {}) {
    this.store = store;
    this.db = store.db;
    this._now = typeof now === "function" ? now : null;
    this._ready = false;
    this._disputes = null; // createDisputes instance, hydrated lazily
    this._disputeRecords = null; // Map(disputeId -> frozen dispute), write-through to bounty_disputes
    this._arbiters = createArbiters();
    this._settlementActor = null; // transient: who the dispute settlement is attributed to
  }

  nowMs() { return this._now ? this._now() : this.store.now(); }

  // Idempotent schema convergence + dispute hydration. Runs at the top of
  // every public method (cheap after the first call).
  _ensure() {
    if (!this._ready) {
      const tables = new Set(this.db.prepare("SELECT name AS n FROM sqlite_master WHERE type='table'").all().map(r => r.n));
      const needed = ["bounty_journal", "bounty_records", "bounty_disputes", "bounty_events",
        "bounty_idempotency", "bounty_watchers", "bounty_sequences"];
      if (needed.some(t => !tables.has(t))) this.db.exec(bountyEscrowSchema);
      else this._migrateColumns();
      this._ready = true;
    }
    if (!this._disputes) {
      const records = new Map();
      try {
        for (const row of this.db.prepare("SELECT dispute_id, body FROM bounty_disputes").all())
          records.set(row.dispute_id, JSON.parse(row.body));
      } catch { /* read-only on a pre-escrow database: no disputes yet */ }
      this._disputeRecords = records;
      this._disputes = createDisputes({ store: records, onDisputeFinalized: packet => this._onDisputeFinalized(packet) });
    }
  }

  // Additive column migration for databases created by the pre-triage schema
  // (unreleased; in practice only dev databases). Fresh databases get the
  // full schema from bountyEscrowSchema above.
  _migrateColumns() {
    const colsOf = table => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    const addCol = (table, ddl) => {
      const name = ddl.split(" ")[0];
      if (!colsOf(table).has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    addCol("bounty_journal", "actor_kind TEXT");
    addCol("bounty_journal", "actor_id TEXT");
    addCol("bounty_events", "actor_kind TEXT");
    addCol("bounty_events", "before_state TEXT");
    addCol("bounty_events", "after_state TEXT");
    addCol("bounty_records", "state_changed_ms INTEGER");
    addCol("bounty_records", "snoozed_until_ms INTEGER");
    addCol("bounty_records", "decline_reason TEXT");
    addCol("bounty_records", "duplicate_of TEXT");
    addCol("bounty_records", "label TEXT");
    this.db.exec(`UPDATE bounty_records SET state_changed_ms =
      CAST(strftime('%s', updated_at) AS INTEGER) * 1000 WHERE state_changed_ms IS NULL`);
  }

  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected)
      if (normalize(actual) !== normalize(sql)) throw new Error("Bounty escrow schema requires operator reconciliation");
    return true;
  }

  // --- journal ------------------------------------------------------------
  _lastHash(roomId, accountId) {
    const row = this.db.prepare(
      "SELECT hash FROM bounty_journal WHERE room_id=? AND account_id=? ORDER BY seq DESC LIMIT 1").get(roomId, accountId);
    return row?.hash ?? "genesis";
  }

  _append({ roomId, accountId, at, kind, bountyId = null, lotId = null, amount, lotState, memo = null, actor = null }) {
    check(LOT_STATES.includes(lotState), "invalid_input", `unknown lot state "${lotState}"`);
    check(Number.isSafeInteger(amount) && amount !== 0, "invalid_amount", "journal amount must be a non-zero integer");
    const entryId = newId("ent_");
    const prevHash = this._lastHash(roomId, accountId);
    const actorKind = actor?.kind ?? null, actorId = actor?.id ?? null;
    const core = [prevHash, entryId, accountId, at, kind, bountyId ?? "", lotId ?? "", String(amount),
      lotState, memo ?? "", actorKind ?? "", actorId ?? ""].join("|");
    const hash = sha256(core);
    this.db.prepare(`INSERT INTO bounty_journal
      (room_id, entry_id, account_id, at, kind, bounty_id, lot_id, amount, lot_state, prev_hash, hash, memo, actor_kind, actor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(roomId, entryId, accountId, at, kind, bountyId, lotId, amount, lotState, prevHash, hash, memo, actorKind, actorId);
    return { entryId, hash, prevHash };
  }

  // One zero-sum movement: debit one (account, lot_state), credit another.
  _move({ roomId, at, from, to, amountMillis, kind, bountyId = null, lotId = null, memo = null, actor = null }) {
    check(Number.isSafeInteger(amountMillis) && amountMillis > 0, "invalid_amount", "movement amount must be positive");
    const debit = this._append({ roomId, accountId: from.account, at, kind, bountyId, lotId, amount: -amountMillis, lotState: from.state, memo, actor });
    const credit = this._append({ roomId, accountId: to.account, at, kind, bountyId, lotId, amount: amountMillis, lotState: to.state, memo, actor });
    return { debitEntryId: debit.entryId, creditEntryId: credit.entryId, lotId };
  }

  _balanceMillis(roomId, accountId, lotState) {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS total FROM bounty_journal WHERE room_id=? AND account_id=? AND lot_state=?")
      .get(roomId, accountId, lotState);
    return row.total;
  }

  _requirePayable(roomId, accountId, amountMillis, what) {
    const payable = this._balanceMillis(roomId, accountId, "payable");
    if (payable < amountMillis)
      fail("insufficient_funds", `${what}: ${accountId} holds ${toCredits(payable)} payable credits, needs ${toCredits(amountMillis)}`);
  }

  // --- events ---------------------------------------------------------------
  // Every state transition records actor {kind, id} with before/after values.
  _event(roomId, type, { bountyId = null, actor = null, before = null, after = null, data = {} } = {}) {
    const at = isoNow(this.nowMs());
    const row = this.db.prepare(
      `INSERT INTO bounty_events (room_id, at, type, bounty_id, actor_kind, actor_id, before_state, after_state, data)
       VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(roomId, at, type, bountyId, actor?.kind ?? null, actor?.id ?? null, before, after, JSON.stringify(data));
    return { seq: Number(row.lastInsertRowid), at, type, bountyId,
      actor: actor ? { kind: actor.kind, id: actor.id } : null, before, after, data };
  }

  // --- genesis ----------------------------------------------------------------
  // The one and only mint: 100 credits per pre-registered lane, recorded as
  // one auditable journal entry per lane (per-account hash chains start
  // here). Idempotent: later calls are no-ops.
  ensureGenesis(roomId) {
    return this.store.transaction(() => {
      this._ensure();
      const minted = this.db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND kind='genesis'").get(roomId).n;
      if (minted > 0) return { issued: false, lanes: [...GENESIS_LANES] };
      const at = isoNow(this.nowMs());
      const millis = GENESIS_CREDITS * MILLIS_PER_CREDIT;
      for (const lane of GENESIS_LANES)
        this._append({ roomId, accountId: lane, at, kind: "genesis", amount: millis, lotState: "payable",
          memo: `genesis issuance: ${GENESIS_CREDITS} credits`, actor: RULE_ACTOR });
      this._event(roomId, "genesis.issued", { actor: RULE_ACTOR, data: { lanes: [...GENESIS_LANES], creditsPerLane: GENESIS_CREDITS } });
      return { issued: true, lanes: [...GENESIS_LANES] };
    });
  }

  // --- sequential bounty ids --------------------------------------------------
  _nextBountyId(roomId) {
    const n = this.db.prepare(`INSERT INTO bounty_sequences(room_id, next_n) VALUES(?, 2)
      ON CONFLICT(room_id) DO UPDATE SET next_n = bounty_sequences.next_n + 1
      RETURNING next_n - 1 AS n`).get(roomId).n;
    return `${roomSlug(roomId)}-${n}`;
  }

  // --- watchers -----------------------------------------------------------------
  // Sticky subscriptions: watching is independent of claiming — unclaiming
  // (claim expiry) never unfollows. Draft (proposed) bounties suppress
  // notification fan-out until funded; the subscription itself is recorded
  // from proposal time so funding can fan out to watchers later.
  _addWatcher(roomId, bountyId, watcher, at) {
    this.db.prepare(`INSERT OR IGNORE INTO bounty_watchers (room_id, bounty_id, watcher, created_at) VALUES (?,?,?,?)`)
      .run(roomId, bountyId, watcher, at);
  }

  _watchersOf(roomId, bountyId) {
    return this.db.prepare("SELECT watcher FROM bounty_watchers WHERE room_id=? AND bounty_id=? ORDER BY rowid")
      .all(roomId, bountyId).map(r => r.watcher);
  }

  watchBounty(roomId, bountyId, { watcher, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = canonicalLane(watcher);
      const row = this.db.prepare("SELECT bounty_id FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const at = isoNow(this.nowMs());
      this._addWatcher(roomId, bountyId, lane, at);
      const act = normalizeActor(actor, lane);
      return { bountyId, watcher: lane, watchers: this._watchersOf(roomId, bountyId),
        receipt: { kind: "watch", bountyId, watcher: lane, at, actor: act } };
    });
  }

  unwatchBounty(roomId, bountyId, { watcher } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = canonicalLane(watcher);
      this.db.prepare("DELETE FROM bounty_watchers WHERE room_id=? AND bounty_id=? AND watcher=?").run(roomId, bountyId, lane);
      return { bountyId, watcher: lane, watchers: this._watchersOf(roomId, bountyId) };
    });
  }

  // --- bounty records -----------------------------------------------------------
  _getBounty(roomId, bountyId) {
    const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
    if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
    return this._viewBounty(row, roomId);
  }

  _viewBounty(row, roomId) {
    const now = this.nowMs();
    return Object.freeze({
      bountyId: row.bounty_id, roomId: row.room_id, title: row.title, criteria: row.criteria,
      amount: toCredits(row.amount_millis), amountMillis: row.amount_millis,
      poster: row.poster, verifier: row.verifier, claimant: row.claimant,
      state: row.state, group: stateGroup(row.state),
      deadline: new Date(row.deadline_ms).toISOString(), deadlineMs: row.deadline_ms,
      challengeEnds: row.challenge_ends_ms === null ? null : new Date(row.challenge_ends_ms).toISOString(),
      challengeEndsMs: row.challenge_ends_ms,
      snoozedUntil: row.snoozed_until_ms === null ? null : new Date(row.snoozed_until_ms).toISOString(),
      snoozedUntilMs: row.snoozed_until_ms,
      declineReason: row.decline_reason, duplicateOf: row.duplicate_of, label: row.label,
      disputeId: row.dispute_id, disputeOpenedMs: row.dispute_opened_ms,
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
      attestation: row.attestation_json ? JSON.parse(row.attestation_json) : null,
      resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null,
      watchers: this._watchersOf(roomId ?? row.room_id, row.bounty_id),
      createdAt: row.created_at, updatedAt: row.updated_at,
      stateChangedAt: new Date(row.state_changed_ms).toISOString(),
      // Time-in-state is computed on reads (drives timeouts and auto-approve windows).
      timeInStateMs: Math.max(0, now - row.state_changed_ms),
    });
  }

  _saveBounty(bounty) {
    const at = isoNow(this.nowMs());
    this.db.prepare(`UPDATE bounty_records SET title=?, criteria=?, amount_millis=?, poster=?, verifier=?,
      claimant=?, state=?, state_changed_ms=?, deadline_ms=?, challenge_ends_ms=?, dispute_id=?, dispute_opened_ms=?,
      snoozed_until_ms=?, decline_reason=?, duplicate_of=?, label=?,
      evidence_json=?, attestation_json=?, resolution_json=?, updated_at=? WHERE bounty_id=?`)
      .run(bounty.title, bounty.criteria, bounty.amountMillis, bounty.poster, bounty.verifier,
        bounty.claimant ?? null, bounty.state, bounty.stateChangedMs, bounty.deadlineMs,
        bounty.challengeEndsMs ?? null, bounty.disputeId ?? null, bounty.disputeOpenedMs ?? null,
        bounty.snoozedUntilMs ?? null, bounty.declineReason ?? null, bounty.duplicateOf ?? null, bounty.label ?? null,
        bounty.evidence ? JSON.stringify(bounty.evidence) : null,
        bounty.attestation ? JSON.stringify(bounty.attestation) : null,
        bounty.resolution ? JSON.stringify(bounty.resolution) : null, at, bounty.bountyId);
  }

  _mutable(row) {
    return {
      bountyId: row.bounty_id, roomId: row.room_id, title: row.title, criteria: row.criteria,
      amountMillis: row.amount_millis, poster: row.poster, verifier: row.verifier, claimant: row.claimant,
      state: row.state, stateChangedMs: row.state_changed_ms, deadlineMs: row.deadline_ms,
      challengeEndsMs: row.challenge_ends_ms, disputeId: row.dispute_id, disputeOpenedMs: row.dispute_opened_ms,
      snoozedUntilMs: row.snoozed_until_ms, declineReason: row.decline_reason,
      duplicateOf: row.duplicate_of, label: row.label,
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
      attestation: row.attestation_json ? JSON.parse(row.attestation_json) : null,
      resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null,
    };
  }

  _transition(bounty, toState) {
    bounty.state = toState;
    bounty.stateChangedMs = this.nowMs();
  }

  // --- triage ---------------------------------------------------------------------
  // POST /bounties creates PROPOSED: a holding state outside the claimable
  // work graph and outside metrics. Submission != commitment: no budget is
  // locked, so posting never needs funds.
  postBounty(roomId, { poster, title, criteria, amount, deadline, verifierId = null, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const lane = canonicalLane(poster);
      const act = normalizeActor(actor, lane);
      check(typeof title === "string" && title.length >= 1 && title.length <= 256, "invalid_input", "title must be 1..256 characters");
      check(typeof criteria === "string" && criteria.length >= 1 && criteria.length <= 2000, "invalid_input", "criteria must be 1..2000 characters");
      const amountMillis = toMillis(amount);
      const deadlineMs = Date.parse(deadline);
      check(Number.isFinite(deadlineMs), "invalid_input", "deadline must be an ISO timestamp");
      check(deadlineMs > this.nowMs(), "invalid_input", "deadline must be in the future");
      let verifier = null;
      if (verifierId !== null && verifierId !== undefined) {
        verifier = canonicalLane(verifierId);
        check(GENESIS_LANES.includes(verifier), "invalid_input", "verifier must be one of the room's agent lanes");
        check(verifier !== lane, "invalid_input", "the verifier must be a third lane, distinct from the poster");
      }
      const at = isoNow(this.nowMs());
      const bountyId = this._nextBountyId(roomId);
      this.db.prepare(`INSERT INTO bounty_records
        (bounty_id, room_id, title, criteria, amount_millis, poster, verifier, claimant, state, state_changed_ms,
         deadline_ms, challenge_ends_ms, dispute_id, dispute_opened_ms, snoozed_until_ms, decline_reason,
         duplicate_of, label, evidence_json, attestation_json, resolution_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(bountyId, roomId, title, criteria, amountMillis, lane, verifier, null, "proposed", this.nowMs(),
          deadlineMs, null, null, null, null, null, null, null, null, null, null, at, at);
      // The poster watches their own bounty from proposal time; fan-out to
      // watchers is suppressed until funded (published).
      this._addWatcher(roomId, bountyId, lane, at);
      const event = this._event(roomId, "bounty.proposed",
        { bountyId, actor: act, before: null, after: "proposed", data: { amount, title } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "propose", bountyId, at, actor: act, event } };
    });
  }

  // Triage decision quartet — poster-only in slice 1 (their budget, their intake).
  _triageBounty(roomId, bountyId, triager, needState = "proposed") {
    const lane = canonicalLane(triager);
    const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
    if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
    const bounty = this._mutable(row);
    check(bounty.state === needState, "invalid_state", `bounty is ${bounty.state}, not open for triage`);
    check(lane === bounty.poster, "not_authorized", "only the poster may triage their bounty");
    return { bounty, lane };
  }

  // Accept the proposal: locks the budget -> FUNDED, the only claimable state.
  fundBounty(roomId, bountyId, { funder, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const { bounty, lane } = this._triageBounty(roomId, bountyId, funder);
      const act = normalizeActor(actor, lane);
      this._requirePayable(roomId, lane, bounty.amountMillis, "fund");
      const at = isoNow(this.nowMs());
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: lane, state: "payable" }, to: { account: lane, state: "locked" },
        amountMillis: bounty.amountMillis, kind: "escrow-lock", bountyId, lotId,
        memo: `escrow for bounty ${bountyId}`, actor: act });
      this._transition(bounty, "funded");
      this._saveBounty(bounty);
      const event = this._event(roomId, "bounty.funded",
        { bountyId, actor: act, before: "proposed", after: "funded", data: { amount: toCredits(bounty.amountMillis) } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "fund", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event } };
    });
  }

  declineBounty(roomId, bountyId, { decliner, reason, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const { bounty, lane } = this._triageBounty(roomId, bountyId, decliner);
      const act = normalizeActor(actor, lane);
      check(typeof reason === "string" && reason.length >= 1 && reason.length <= 2000,
        "invalid_input", "reason must be 1..2000 characters");
      this._transition(bounty, "cancelled");
      bounty.declineReason = reason;
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      const event = this._event(roomId, "bounty.declined",
        { bountyId, actor: act, before: "proposed", after: "cancelled", data: { reason } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "decline", bountyId, at, actor: act, event } };
    });
  }

  // Snooze defers a proposal to a later date — first-class, not a comment.
  // The bounty stays open (proposed); a snooze never resets time-in-state.
  snoozeBounty(roomId, bountyId, { snoozer, until, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const { bounty, lane } = this._triageBounty(roomId, bountyId, snoozer);
      const act = normalizeActor(actor, lane);
      const untilMs = Date.parse(until);
      check(Number.isFinite(untilMs), "invalid_input", "until must be an ISO timestamp");
      check(untilMs > this.nowMs(), "invalid_input", "until must be in the future");
      bounty.snoozedUntilMs = untilMs;
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      const event = this._event(roomId, "bounty.snoozed",
        { bountyId, actor: act, before: "proposed", after: "proposed", data: { until: new Date(untilMs).toISOString() } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "snooze", bountyId, at, actor: act, event } };
    });
  }

  duplicateBounty(roomId, bountyId, { marker, canonicalId, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const { bounty, lane } = this._triageBounty(roomId, bountyId, marker);
      const act = normalizeActor(actor, lane);
      check(typeof canonicalId === "string" && canonicalId.length >= 1, "invalid_input", "canonical_id is required");
      check(canonicalId !== bountyId, "invalid_input", "a bounty cannot duplicate itself");
      const canonical = this.db.prepare("SELECT bounty_id FROM bounty_records WHERE room_id=? AND bounty_id=?")
        .get(roomId, canonicalId);
      if (!canonical) fail("unknown_bounty", `unknown canonical bounty "${canonicalId}"`);
      this._transition(bounty, "cancelled");
      bounty.duplicateOf = canonicalId;
      bounty.label = "Duplicate";
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      const event = this._event(roomId, "bounty.duplicated",
        { bountyId, actor: act, before: "proposed", after: "cancelled", data: { canonicalId } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "duplicate", bountyId, canonicalId, at, actor: act, event } };
    });
  }

  // --- claim / submit / accept --------------------------------------------------------
  claimBounty(roomId, bountyId, { claimant, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const lane = canonicalLane(claimant);
      const act = normalizeActor(actor, lane);
      const bounty = this._mutable(this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId)
        ?? fail("unknown_bounty", `unknown bounty "${bountyId}"`));
      check(bounty.state === "funded" || bounty.state === "claimed", "invalid_state",
        `bounty is ${bounty.state}, not open for claims — only funded bounties are claimable`);
      if (bounty.state === "claimed") fail("already_claimed", "this bounty is already claimed");
      check(this.nowMs() < bounty.deadlineMs, "invalid_state", "the claim window closed at the deadline");
      this._requirePayable(roomId, lane, CLAIM_BOND_MILLIS, "claim bond");
      const at = isoNow(this.nowMs());
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: lane, state: "payable" }, to: { account: lane, state: "locked" },
        amountMillis: CLAIM_BOND_MILLIS, kind: "bond-lock", bountyId, lotId,
        memo: `anti-flake claim bond for ${bountyId}`, actor: act });
      bounty.claimant = lane;
      this._transition(bounty, "claimed");
      this._saveBounty(bounty);
      const event = this._event(roomId, "bounty.claimed",
        { bountyId, actor: act, before: "funded", after: "claimed", data: { bond: toCredits(CLAIM_BOND_MILLIS) } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "bond-lock", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event } };
    });
  }

  submitWork(roomId, bountyId, { claimant, evidence, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = canonicalLane(claimant);
      const act = normalizeActor(actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(bounty.state === "claimed", "invalid_state", `bounty is ${bounty.state}, not awaiting submission`);
      check(bounty.claimant === lane, "not_authorized", "only the claimant may submit");
      check(this.nowMs() < bounty.deadlineMs, "invalid_state", "the submission deadline passed");
      const receipt = this._evidenceOf(evidence, lane);
      bounty.evidence = receipt;
      this._transition(bounty, "submitted");
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      const event = this._event(roomId, "bounty.submitted",
        { bountyId, actor: act, before: "claimed", after: "submitted", data: { evidenceUrl: receipt.evidenceUrl } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "submit", bountyId, evidence: receipt, at, actor: act, event } };
    });
  }

  // Evidence follows the PR #743 work.completed receipt shape: evidenceUrl
  // (https, no credentials), summary, checksClaimed, producer attribution.
  _evidenceOf(evidence, reporter) {
    check(evidence !== null && typeof evidence === "object" && !Array.isArray(evidence), "invalid_input", "evidence must be an object");
    const { evidenceUrl, evidenceKind = null, summary, checksClaimed = [], producerId = null } = evidence;
    check(typeof evidenceUrl === "string" && evidenceUrl.length > 0, "invalid_input", "evidence.evidenceUrl is required");
    try {
      const url = new URL(evidenceUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { fail("invalid_input", "evidenceUrl must be an HTTPS URL without credentials"); }
    if (evidenceKind !== null) check(typeof evidenceKind === "string" && evidenceKind.length <= 64, "invalid_input", "evidenceKind must be at most 64 characters");
    check(typeof summary === "string" && summary.length >= 1 && summary.length <= 2000, "invalid_input", "evidence.summary must be 1..2000 characters");
    check(Array.isArray(checksClaimed) && checksClaimed.length <= 50
      && checksClaimed.every(c => typeof c === "string" && c.length >= 1 && c.length <= 256),
      "invalid_input", "checksClaimed must be an array of at most 50 short strings");
    if (producerId !== null) check(typeof producerId === "string" && producerId.length >= 1 && producerId.length <= 256,
      "invalid_input", "producerId must be 1..256 characters");
    return Object.freeze({ reportedById: reporter, evidenceUrl, evidenceKind, summary,
      checksClaimed: Object.freeze([...checksClaimed]), producerId });
  }

  // Gated accept: the accept is modeled explicitly as an approval event.
  // Only the recorded approval converts the locked lot into an attributed
  // lot owned by the claimant — the escrow release is never an implicit
  // side effect. Review policy: distinct_member (acceptor != claimant).
  acceptWork(roomId, bountyId, { acceptor, verifierAttestation, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = canonicalLane(acceptor);
      const act = normalizeActor(actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(bounty.state === "submitted", "invalid_state", `bounty is ${bounty.state}, not awaiting acceptance`);
      check(lane === bounty.poster || lane === bounty.verifier, "not_authorized", "only the poster or the designated verifier may accept");
      check(lane !== bounty.claimant, "not_authorized", "acceptance must come from an identity distinct from the claimant");
      check(verifierAttestation !== null && typeof verifierAttestation === "object" && !Array.isArray(verifierAttestation)
        && Object.keys(verifierAttestation).length > 0, "invalid_input", "verifierAttestation must be a non-empty object");
      if (verifierAttestation.at !== undefined)
        check(typeof verifierAttestation.at === "string" && Number.isFinite(Date.parse(verifierAttestation.at)),
          "invalid_input", "verifierAttestation.at must be an ISO timestamp");
      const at = isoNow(this.nowMs());
      // 1. Record the approval event first — it is the gate.
      const approval = Object.freeze({ decision: "approved", by: act, at });
      const event = this._event(roomId, "bounty.accepted",
        { bountyId, actor: act, before: "submitted", after: "accepted",
          data: { approval: { decision: approval.decision, by: approval.by, at: approval.at },
            claimant: bounty.claimant, challengeEnds: new Date(this.nowMs() +
              (bounty.amountMillis < MILLIS_PER_CREDIT ? CHALLENGE_WINDOW_SMALL_MS : CHALLENGE_WINDOW_MS)).toISOString() } });
      // 2. The escrow release is the explicit consequence of the approval.
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.claimant, state: "attributed" },
        amountMillis: bounty.amountMillis, kind: "attribute", bountyId, lotId,
        memo: `attributed to ${bounty.claimant} (approval ${event.seq})`, actor: act });
      bounty.attestation = Object.freeze({ ...verifierAttestation, recordedBy: lane, recordedAt: at });
      this._transition(bounty, "accepted");
      bounty.challengeEndsMs = this.nowMs() + (bounty.amountMillis < MILLIS_PER_CREDIT ? CHALLENGE_WINDOW_SMALL_MS : CHALLENGE_WINDOW_MS);
      this._saveBounty(bounty);
      return { bounty: this._getBounty(roomId, bountyId),
        approval,
        attribution: { attributionId: lotId, bountyId, claimant: bounty.claimant, amount: toCredits(bounty.amountMillis), at },
        receipt: { kind: "attribute", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event } };
    });
  }

  // --- disputes -------------------------------------------------------------------
  _persistDispute(roomId, dispute) {
    const at = isoNow(this.nowMs());
    this.db.prepare(`INSERT INTO bounty_disputes (dispute_id, room_id, body, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(dispute_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`)
      .run(dispute.disputeId, roomId, JSON.stringify(dispute), at);
  }

  _laneCards() {
    return GENESIS_LANES.map(lane => ({ lane, trust_level: "standard" }));
  }

  disputeBounty(roomId, bountyId, { challenger, bond, grounds, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const lane = canonicalLane(challenger);
      const act = normalizeActor(actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(!bounty.disputeId, "dispute_exists", "this bounty already has a dispute");
      check(bounty.state === "submitted" || bounty.state === "accepted", "invalid_state", `bounty is ${bounty.state}, not disputable`);
      check(lane !== bounty.claimant, "not_authorized", "the claimant cannot dispute their own submission");
      check(typeof grounds === "string" && grounds.length >= 1 && grounds.length <= 2000, "invalid_input", "grounds must be 1..2000 characters");
      const bondMillis = toMillis(bond);
      // The dispute bond is exactly 25% of the bounty: the >= 25% minimum
      // and the <= 25% total-dispute-cost cap (v2 economics) coincide.
      const required = Math.ceil(bounty.amountMillis * DISPUTE_BOND_RATIO);
      check(bondMillis === required, "invalid_bond",
        `dispute bond must be exactly 25% of the bounty (${toCredits(required)} credits)`);
      this._requirePayable(roomId, lane, bondMillis, "dispute bond");
      const at = isoNow(this.nowMs());
      const disputeId = newId("dsp_");
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: lane, state: "payable" }, to: { account: lane, state: "locked" },
        amountMillis: bondMillis, kind: "bond-lock", bountyId, lotId, memo: `dispute bond for ${disputeId}`, actor: act });
      // Walk the pure machine to adjudication: open -> challenged -> evidence
      // (grounds are the first evidence) -> seat the designated verifier.
      const machine = this._disputes;
      let dispute;
      const fromState = bounty.state;
      try {
        dispute = machine.open({ disputeId, bountyId, bountyAmount: bounty.amountMillis, raisedBy: lane, reason: grounds, kind: "economic", bond: bondMillis });
        this._persistDispute(roomId, dispute);
        dispute = machine.challenge(disputeId, { by: lane });
        this._persistDispute(roomId, dispute);
        dispute = machine.submitEvidence(disputeId, { by: lane, summary: grounds });
        this._persistDispute(roomId, dispute);
        // Seat the decider: the designated third-lane verifier (tier 1) is the
        // only authorized decider in slice 1. Panel-majority voting arrives
        // in a later slice, so without a designated verifier there is no
        // authorized decider: the dispute is marked honestly unavailable and
        // the 14-day timeout default (RELEASE) is the backstop.
        let seating = null;
        if (bounty.verifier)
          seating = this._arbiters.resolveTier1({ verifierId: bounty.verifier,
            executor: { lane: bounty.claimant }, lanes: this._laneCards() });
        if (!seating || seating.unavailable) {
          dispute = machine.markUnavailable(disputeId,
            seating?.reason ?? "no-designated-verifier: panel-majority voting is not in slice 1");
        } else {
          dispute = machine.seatDecider(disputeId, { decider: seating.decider.lane });
        }
        this._persistDispute(roomId, dispute);
      } catch (error) {
        if (error instanceof DisputeError) fail("invalid_input", error.message);
        throw error;
      }
      bounty.disputeId = disputeId; bounty.disputeOpenedMs = this.nowMs();
      this._transition(bounty, "disputed");
      this._saveBounty(bounty);
      const event = this._event(roomId, "bounty.disputed",
        { bountyId, actor: act, before: fromState, after: "disputed",
          data: { disputeId, bond: toCredits(bondMillis), decider: dispute.decider ?? null, unavailable: dispute.unavailable } });
      return { bounty: this._getBounty(roomId, bountyId),
        dispute: { disputeId, state: dispute.state, decider: dispute.decider ?? null, unavailable: dispute.unavailable,
          bond: toCredits(bondMillis), raisedBy: lane },
        receipt: { kind: "bond-lock", bountyId, disputeId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event } };
    });
  }

  decideDispute(roomId, bountyId, { decider, outcome, reasonCodes, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = canonicalLane(decider);
      const act = normalizeActor(actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(bounty.state === "disputed" && bounty.disputeId, "invalid_state", `bounty is ${bounty.state}, no open dispute`);
      const dispute = this._disputes.get(bounty.disputeId);
      check(dispute.decider === lane, "not_authorized", "only the seated decider may rule");
      // Attribute the inline settlement to the decider whose ruling caused it.
      this._settlementActor = act;
      try {
        const decided = this._disputes.decide(bounty.disputeId, { outcome, reasonCodes, decider: lane });
        this._persistDispute(roomId, decided);
        const finalized = this._disputes.finalize(bounty.disputeId); // fires onDisputeFinalized -> escrow settlement
        this._persistDispute(roomId, finalized);
      } catch (error) {
        if (error instanceof DisputeError) fail("invalid_input", error.message);
        throw error;
      } finally {
        this._settlementActor = null;
      }
      const settled = this._mutable(this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId));
      const event = this._event(roomId, "bounty.decided",
        { bountyId, actor: act, before: "disputed", after: settled.state,
          data: { disputeId: bounty.disputeId, outcome, resolution: settled.resolution } });
      return { bounty: this._getBounty(roomId, bountyId), resolution: settled.resolution,
        receipt: { kind: "dispute-settle", bountyId, disputeId: bounty.disputeId, at: isoNow(this.nowMs()), actor: act, event } };
    });
  }

  // The single consumer of the dispute machine's onDisputeFinalized: exactly
  // one settlement per dispute. Disputes delay, never confiscate.
  _onDisputeFinalized(packet) {
    const { bountyId, outcome, terminal } = packet;
    const row = this.db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bountyId);
    if (!row || row.resolution_json) return; // unknown bounty, or already settled (recovery is via finalizeBounty)
    const bounty = this._mutable(row);
    if (bounty.state !== "disputed") return;
    const actor = this._settlementActor ?? RULE_ACTOR;
    this._settleDispute(bounty, { outcome, terminal, bondSnapshot: packet.bondSnapshot, forfeitedBond: packet.forfeitedBond, actor });
  }

  _settleDispute(bounty, { outcome, terminal, bondSnapshot, forfeitedBond, actor }) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    const at = isoNow(this.nowMs());
    const amount = bounty.amountMillis;
    const challenger = this._disputeRecords.get(bounty.disputeId)?.raisedBy;
    const worker = bounty.claimant;
    const lotId = newId("lot_");
    // Where the award currently sits: disputed from `submitted` -> still
    // locked with the poster; disputed from `accepted` -> attributed.
    const awardFrom = this._disputeWasFromSubmitted(bounty)
      ? { account: bounty.poster, state: "locked" } : { account: worker, state: "attributed" };
    const settleKind = outcome === "upheld" ? "cancel" : outcome === "split" ? "split" : "release";
    const forfeited = typeof bondSnapshot === "number" && forfeitedBond >= bondSnapshot;

    if (settleKind === "cancel") {
      // CANCEL: full refund to the poster, challenger's bond returned (they
      // were right), no fee. The claimant's anti-flake bond is slashed to the
      // pool — upheld means the work was judged bad, which is what the bond
      // prices. (The award itself is never confiscated: disputes delay, never
      // confiscate.)
      this._move({ roomId, at, from: awardFrom, to: { account: bounty.poster, state: "payable" },
        amountMillis: amount, kind: "refund", bountyId, lotId, memo: `dispute ${outcome}: refund`, actor });
      if (typeof bondSnapshot === "number")
        this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: challenger, state: "payable" },
          amountMillis: bondSnapshot, kind: "bond-return", bountyId, lotId: newId("lot_"), memo: "dispute bond returned", actor });
      this._settleClaimBond(bounty, at, { forfeit: true, actor });
      this._transition(bounty, "refunded");
    } else if (settleKind === "split") {
      // SPLIT: half the award vests with the worker (fee at sweep), half
      // refunds to the poster, bond returned.
      const workerHalf = Math.floor(amount / 2), posterHalf = amount - workerHalf;
      if (awardFrom.state === "locked")
        this._move({ roomId, at, from: awardFrom, to: { account: worker, state: "attributed" },
          amountMillis: amount, kind: "attribute", bountyId, lotId, memo: "split: attribute before split", actor });
      this._move({ roomId, at, from: { account: worker, state: "attributed" }, to: { account: worker, state: "approved" },
        amountMillis: workerHalf, kind: "approve", bountyId, lotId, memo: "split: worker half vests", actor });
      this._move({ roomId, at, from: { account: worker, state: "attributed" }, to: { account: bounty.poster, state: "payable" },
        amountMillis: posterHalf, kind: "refund", bountyId, lotId, memo: "split: poster half refunds", actor });
      if (typeof bondSnapshot === "number")
        this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: challenger, state: "payable" },
          amountMillis: bondSnapshot, kind: "bond-return", bountyId, lotId: newId("lot_"), memo: "dispute bond returned", actor });
      this._transition(bounty, "approved");
    } else {
      // RELEASE: the award vests with the worker (swept at the epoch, 1% fee
      // then); the challenger's bond compensates the worker for the delay —
      // in full, no fee on penalty compensation. A forfeited bond (frivolous
      // ruling, withdrawn challenge) goes to the room pool instead.
      if (awardFrom.state === "locked")
        this._move({ roomId, at, from: awardFrom, to: { account: worker, state: "attributed" },
          amountMillis: amount, kind: "attribute", bountyId, lotId, memo: "release: attribute after dispute", actor });
      this._move({ roomId, at, from: { account: worker, state: "attributed" }, to: { account: worker, state: "approved" },
        amountMillis: amount, kind: "approve", bountyId, lotId, memo: `dispute ${outcome}: award vests`, actor });
      if (typeof bondSnapshot === "number") {
        if (forfeited)
          this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: POOL_ACCOUNT, state: "payable" },
            amountMillis: bondSnapshot, kind: "bond-forfeit", bountyId, lotId: newId("lot_"), memo: `dispute ${outcome}: bond forfeited to pool`, actor });
        else
          this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: worker, state: "payable" },
            amountMillis: bondSnapshot, kind: "bond-compensate", bountyId, lotId: newId("lot_"), memo: "dispute bond compensates worker for delay", actor });
      }
      this._transition(bounty, "approved");
    }
    bounty.resolution = Object.freeze({ kind: settleKind, outcome, terminal,
      decidedAt: at, bondForfeited: forfeited });
    this._saveBounty(bounty);
    this._event(roomId, settleKind === "cancel" ? "bounty.refunded" : "bounty.released",
      { bountyId, actor, before: "disputed", after: bounty.state, data: { resolution: bounty.resolution } });
  }

  // Whether the dispute froze a pre-accept submission (award still locked)
  // or a post-accept attribution. The journal is the source of truth: if the
  // claimant holds an attributed lot for this bounty, it was post-accept.
  _disputeWasFromSubmitted(bounty) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM bounty_journal
      WHERE room_id=? AND bounty_id=? AND account_id=? AND lot_state='attributed'`)
      .get(bounty.roomId, bounty.bountyId, bounty.claimant);
    return row.total === 0;
  }

  // --- keeper: finalize + epoch ---------------------------------------------------
  // Permissionless and purely mechanical: timeouts refund, challenge windows
  // auto-approve, stale disputes default to RELEASE, approved lots sweep,
  // proposed bounties past deadline expire unfunded. Mechanical transitions
  // are attributed to the rule actor (the human/agent caller who triggered
  // the keeper run is recorded as triggeredBy).
  //
  // The claim bond is an anti-flake lock, not a fee: it returns to the
  // claimant on payout AND on timeout (spec: "bond returned"). It is
  // forfeited to the room pool only when the work was judged bad (dispute
  // upheld). Defensive: a no-op when the bond is not actually locked for
  // this bounty.
  _settleClaimBond(bounty, at, { forfeit, actor }) {
    if (!bounty.claimant) return;
    const locked = this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal
      WHERE room_id=? AND bounty_id=? AND account_id=? AND lot_state='locked'`)
      .get(bounty.roomId, bounty.bountyId, bounty.claimant).t;
    if (locked < CLAIM_BOND_MILLIS) return;
    this._move({ roomId: bounty.roomId, at, from: { account: bounty.claimant, state: "locked" },
      to: forfeit ? { account: POOL_ACCOUNT, state: "payable" } : { account: bounty.claimant, state: "payable" },
      amountMillis: CLAIM_BOND_MILLIS, kind: forfeit ? "bond-forfeit" : "bond-return",
      bountyId: bounty.bountyId, lotId: newId("lot_"), actor,
      memo: forfeit ? "claim bond forfeited to pool (work judged bad)" : "claim bond returned" });
  }

  _timeoutRefund(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    const lotId = newId("lot_");
    this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.poster, state: "payable" },
      amountMillis: bounty.amountMillis, kind: "refund", bountyId, lotId,
      memo: "timeout: award refunded in full, no fee", actor });
    // No submission by the deadline: the award refunds and the claim bond
    // returns to the claimant (spec: "bond returned").
    this._settleClaimBond(bounty, at, { forfeit: false, actor });
    this._transition(bounty, "refunded");
    bounty.resolution = Object.freeze({ kind: "timeout", refundedAt: at });
    this._saveBounty(bounty);
    this._event(roomId, "bounty.refunded",
      { bountyId, actor, before: "claimed", after: "refunded", data: { reason: "timeout", resolution: bounty.resolution } });
  }

  _expireUnfunded(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    this._transition(bounty, "cancelled");
    bounty.declineReason = "expired unfunded";
    bounty.label = "Expired";
    this._saveBounty(bounty);
    this._event(roomId, "bounty.declined",
      { bountyId, actor, before: "proposed", after: "cancelled", data: { reason: "expired unfunded", automatic: true } });
  }

  _approve(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    const lotId = newId("lot_");
    this._move({ roomId, at, from: { account: bounty.claimant, state: "attributed" }, to: { account: bounty.claimant, state: "approved" },
      amountMillis: bounty.amountMillis, kind: "approve", bountyId, lotId,
      memo: "challenge window passed unchallenged", actor });
    this._transition(bounty, "approved");
    bounty.resolution = Object.freeze({ kind: "auto-approve", approvedAt: at });
    this._saveBounty(bounty);
    this._event(roomId, "bounty.approved",
      { bountyId, actor, before: "accepted", after: "approved", data: { resolution: bounty.resolution } });
  }

  _approvedMillis(roomId, accountId, bountyId) {
    return this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal
      WHERE room_id=? AND account_id=? AND bounty_id=? AND lot_state='approved'`).get(roomId, accountId, bountyId).t;
  }

  _sweep(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    // Sweep what is actually approved (a split leaves only the worker's half
    // here); the 1% fee applies only on payouts that actually release.
    const amount = this._approvedMillis(roomId, bounty.claimant, bountyId);
    check(amount > 0, "invalid_state", "nothing approved to sweep");
    const fee = Math.floor(amount * FEE_NUMERATOR / FEE_DENOMINATOR);
    const earner = amount - fee;
    const lotId = newId("lot_");
    this._move({ roomId, at, from: { account: bounty.claimant, state: "approved" }, to: { account: bounty.claimant, state: "payable" },
      amountMillis: earner, kind: "payout", bountyId, lotId, memo: `epoch payout (99% of ${toCredits(amount)})`, actor });
    if (fee > 0)
      this._move({ roomId, at, from: { account: bounty.claimant, state: "approved" }, to: { account: POOL_ACCOUNT, state: "payable" },
        amountMillis: fee, kind: "fee", bountyId, lotId, memo: "1% room-pool fee on released payout", actor });
    // The claim bond was an anti-flake lock, not a fee: it comes home now.
    this._settleClaimBond(bounty, at, { forfeit: false, actor });
    this._transition(bounty, "paid");
    this._saveBounty(bounty);
    this._event(roomId, "bounty.paid",
      { bountyId, actor, before: "approved", after: "paid", data: { earner: bounty.claimant, paid: toCredits(earner), fee: toCredits(fee) } });
    return { paid: toCredits(earner), fee: toCredits(fee) };
  }

  // One mechanical pass over a single bounty; returns the action taken or null.
  _keeperPass(bounty, now, at) {
    const actor = RULE_ACTOR;
    if (bounty.state === "proposed" && now >= bounty.deadlineMs
        && (bounty.snoozedUntilMs === null || now >= bounty.snoozedUntilMs)) {
      this._expireUnfunded(bounty, at, actor); return "expired-unfunded";
    }
    if (bounty.state === "accepted" && bounty.challengeEndsMs !== null && now >= bounty.challengeEndsMs) {
      this._approve(bounty, at, actor); return "approved";
    }
    if ((bounty.state === "funded" || bounty.state === "claimed") && now >= bounty.deadlineMs) {
      this._timeoutRefund(bounty, at, actor); return "refunded";
    }
    if (bounty.state === "disputed" && bounty.disputeId && !bounty.resolution) {
      const dispute = this._disputes.get(bounty.disputeId);
      const terminal = dispute.state === "resolved" || dispute.state === "withdrawn";
      if (terminal) {
        // The onDisputeFinalized callback already ran inline; if the bounty
        // is still unsettled the handler must have thrown — retry now.
        this._settleDispute(bounty, { outcome: dispute.resolution?.outcome ?? null, terminal: dispute.state,
          bondSnapshot: dispute.bondSnapshot, forfeitedBond: dispute.forfeitedBond, actor });
        return bounty.state === "refunded" ? "refunded" : "released";
      }
      if (bounty.disputeOpenedMs !== null && now - bounty.disputeOpenedMs > DISPUTE_TIMEOUT_MS) {
        // Unresolved > 14d: permissionless finalize defaults to RELEASE.
        this._settleDispute(bounty, { outcome: "timeout-default", terminal: "timeout",
          bondSnapshot: dispute.bondSnapshot, forfeitedBond: 0, actor });
        return "released";
      }
    }
    return null;
  }

  finalizeBounty(roomId, bountyId, { caller } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const triggeredBy = caller === undefined ? null : canonicalLane(caller);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      const now = this.nowMs(), at = isoNow(now);
      const action = this._keeperPass(bounty, now, at);
      check(action !== null, "invalid_state", `bounty is ${bounty.state}: nothing to finalize`);
      return { bounty: this._getBounty(roomId, bountyId), action,
        receipt: { kind: "finalize", bountyId, action, at, actor: RULE_ACTOR, triggeredBy } };
    });
  }

  closeEpoch(roomId, { caller } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const triggeredBy = caller === undefined ? null : canonicalLane(caller);
      const now = this.nowMs(), at = isoNow(now);
      const summary = { approved: [], swept: [], refunded: [], released: [], paid: [], expiredUnfunded: [] };
      const rows = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND state IN ('proposed','funded','claimed','accepted','disputed','approved') ORDER BY created_at").all(roomId);
      for (const row of rows) {
        const bounty = this._mutable(row);
        try {
          if (bounty.state === "approved") {
            const { paid, fee } = this._sweep(bounty, at, RULE_ACTOR);
            summary.swept.push(bounty.bountyId); summary.paid.push({ bountyId: bounty.bountyId, paid, fee });
          } else {
            const action = this._keeperPass(bounty, now, at);
            if (action === "approved") summary.approved.push(bounty.bountyId);
            else if (action === "refunded") summary.refunded.push(bounty.bountyId);
            else if (action === "released") summary.released.push(bounty.bountyId);
            else if (action === "expired-unfunded") summary.expiredUnfunded.push(bounty.bountyId);
          }
        } catch (error) {
          // The keeper is mechanical but never half-applies: one bounty
          // failing must not wedge the epoch. Record and continue.
          summary.failed = summary.failed ?? [];
          summary.failed.push({ bountyId: bounty.bountyId, code: error.code ?? "error", message: error.message });
        }
      }
      const event = this._event(roomId, "epoch.closed", { actor: RULE_ACTOR, data: { summary, triggeredBy } });
      return { roomId, at, actor: RULE_ACTOR, triggeredBy, summary, event };
    });
  }

  // --- rage-quit analog: payable -> payable transfers --------------------------------
  transfer(roomId, { from, to, amount, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const sender = canonicalLane(from), recipient = canonicalLane(to);
      const act = normalizeActor(actor, sender);
      check(recipient.length >= 1 && recipient.length <= 256, "invalid_input", "recipient must be 1..256 characters");
      check(sender !== recipient, "invalid_input", "cannot transfer to yourself");
      const amountMillis = toMillis(amount);
      this._requirePayable(roomId, sender, amountMillis, "transfer");
      const at = isoNow(this.nowMs());
      const movement = this._move({ roomId, at, from: { account: sender, state: "payable" }, to: { account: recipient, state: "payable" },
        amountMillis, kind: "transfer", lotId: newId("lot_"), memo: `transfer ${sender} -> ${recipient}`, actor: act });
      const event = this._event(roomId, "credit.transferred",
        { actor: act, data: { from: sender, to: recipient, amount: toCredits(amountMillis) } });
      return { receipt: { kind: "transfer", entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event },
        from: sender, to: recipient, amount: toCredits(amountMillis) };
    });
  }

  // --- reads --------------------------------------------------------------------------
  listBounties(roomId, { group = null } = {}) {
    return this.store.readTransaction(() => {
      this._ensure();
      if (group !== null) check(BOUNTY_GROUPS.includes(group), "invalid_input", `unknown bounty group "${group}"`);
      const rows = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? ORDER BY created_at").all(roomId);
      return rows
        .map(row => this._viewBounty(row, roomId))
        .filter(b => group === null || b.group === group);
    });
  }

  getBounty(roomId, bountyId) {
    return this.store.readTransaction(() => { this._ensure(); return this._getBounty(roomId, bountyId); });
  }

  // Work-graph metrics. Proposed bounties are outside the work graph and
  // outside metrics: they are excluded from every count and total here.
  metrics(roomId) {
    return this.store.readTransaction(() => {
      this._ensure();
      const byGroup = { funded: 0, claimed: 0, "in-review": 0, paid: 0, cancelled: 0 };
      for (const row of this.db.prepare("SELECT state, COUNT(*) AS n FROM bounty_records WHERE room_id=? GROUP BY state").all(roomId)) {
        const g = stateGroup(row.state);
        if (g !== null && g !== "proposed") byGroup[g] += row.n;
      }
      const q = (sql, ...params) => this.db.prepare(sql).get(roomId, ...params);
      const lockedInEscrow = q(`SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal
        WHERE room_id=? AND lot_state='locked' AND bounty_id IN
        (SELECT bounty_id FROM bounty_records WHERE room_id=? AND state NOT IN ('proposed','paid','refunded','cancelled'))`, roomId).t;
      const paidOut = q("SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS t FROM bounty_journal WHERE room_id=? AND kind='payout'").t;
      const poolFees = q("SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS t FROM bounty_journal WHERE room_id=? AND kind='fee'").t;
      return Object.freeze({ roomId, byGroup: Object.freeze({ ...byGroup }),
        openBounties: byGroup.funded + byGroup.claimed + byGroup["in-review"],
        lockedInEscrowCredits: toCredits(lockedInEscrow),
        paidOutCredits: toCredits(paidOut), poolFeesCredits: toCredits(poolFees) });
    });
  }

  balances(roomId, identity) {
    return this.store.readTransaction(() => {
      this._ensure();
      const lane = canonicalLane(identity);
      const byState = {};
      for (const state of LOT_STATES) byState[state] = toCredits(this._balanceMillis(roomId, lane, state));
      const rep = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END),0) AS n,
          COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS earned
        FROM bounty_journal WHERE room_id=? AND account_id=? AND kind='payout'`).get(roomId, lane);
      const cutoff = isoNow(this.nowMs() - 30 * 24 * 3600 * 1000);
      const rep30 = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS earned
        FROM bounty_journal WHERE room_id=? AND account_id=? AND kind='payout' AND at >= ?`).get(roomId, lane, cutoff).earned;
      return Object.freeze({ identity: lane, ...byState,
        total: byState.payable + byState.locked + byState.attributed + byState.approved,
        // Reputation derives ONLY from paid completions (accepted, paid
        // receipts) — never claims, activity, or self-attestation. Derived,
        // non-transferable, room-scoped; the 30d window is slice 1's decay.
        reputation: Object.freeze({ completedBounties: rep.n, earnedCredits: toCredits(rep.earned),
          earnedCredits30d: toCredits(rep30) }) });
    });
  }

  // Credit history as movement-level receipts: each receipt is one zero-sum
  // movement (debit + credit pair), actor-attributed, with before/after
  // (account, lot_state) values. The `state` filter matches the movement's
  // resulting (after) lot state.
  history(roomId, identity, { state = null, since = null } = {}) {
    return this.store.readTransaction(() => {
      this._ensure();
      const lane = canonicalLane(identity);
      if (state !== null) check(LOT_STATES.includes(state), "invalid_input", `unknown lot state "${state}"`);
      let sinceIso = null;
      if (since !== null && since !== undefined) {
        const ms = Date.parse(since);
        check(Number.isFinite(ms), "invalid_input", "since must be an ISO timestamp");
        sinceIso = new Date(ms).toISOString();
      }
      const clauses = ["room_id=?", "account_id=?"];
      const params = [roomId, lane];
      if (sinceIso !== null) { clauses.push("at >= ?"); params.push(sinceIso); }
      const own = this.db.prepare(
        `SELECT * FROM bounty_journal WHERE ${clauses.join(" AND ")} ORDER BY seq`).all(...params);
      // Receipts are movement-level: pull the full movement (both legs) for
      // every movement the account touched, so before/after show the real
      // source and destination accounts.
      const lotIds = [...new Set(own.map(r => r.lot_id).filter(id => id !== null && id !== undefined))];
      const full = lotIds.length === 0 ? [] : this.db.prepare(
        `SELECT * FROM bounty_journal WHERE room_id=? AND lot_id IN (${lotIds.map(() => "?").join(",")}) ORDER BY seq`)
        .all(roomId, ...lotIds);
      const singles = own.filter(r => r.lot_id === null || r.lot_id === undefined);
      const groups = new Map();
      for (const r of full) {
        if (!groups.has(r.lot_id)) groups.set(r.lot_id, []);
        groups.get(r.lot_id).push(r);
      }
      for (const r of singles) groups.set(`entry:${r.entry_id}`, [r]);
      const receipts = [];
      for (const entries of groups.values()) {
        const debit = entries.find(e => e.amount < 0) ?? null;
        const credit = entries.find(e => e.amount > 0) ?? null;
        const first = entries[0];
        const actor = first.actor_kind ? { kind: first.actor_kind, id: first.actor_id } : null;
        const before = debit ? { account: debit.account_id, lotState: debit.lot_state } : null;
        const after = credit ? { account: credit.account_id, lotState: credit.lot_state }
          : { account: first.account_id, lotState: first.lot_state };
        if (state !== null && after.lotState !== state) continue;
        receipts.push(Object.freeze({
          receiptId: first.lot_id ?? first.entry_id, at: first.at, kind: first.kind,
          memo: first.memo, bountyId: first.bounty_id, actor, before, after,
          amount: toCredits(Math.abs((credit ?? first).amount)),
          amountMillis: Math.abs((credit ?? first).amount),
          entries: entries.map(e => e.entry_id),
          hash: first.hash, prevHash: first.prev_hash,
        }));
      }
      return receipts;
    });
  }

  // Conservation invariant: payable + locked + attributed + approved =
  // total_issued (the genesis mint). Checks the global sum, per-account
  // non-negativity, per-bounty award coverage (award lots only — bonds are
  // tracked globally), and every per-account hash chain.
  verifyConservation(roomId) {
    return this.store.readTransaction(() => {
      this._ensure();
      const violations = [];
      const genesis = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id=? AND kind='genesis'")
        .get(roomId).t;
      const total = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id=?").get(roomId).t;
      if (total !== genesis) violations.push(`global sum ${total} != genesis ${genesis}`);
      const byState = {};
      for (const state of LOT_STATES)
        byState[state] = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id=? AND lot_state=?").get(roomId, state).t;
      const statesSum = Object.values(byState).reduce((a, b) => a + b, 0);
      if (statesSum !== total) violations.push(`state buckets sum ${statesSum} != global ${total}`);
      for (const row of this.db.prepare(`SELECT account_id, lot_state, SUM(amount) AS t FROM bounty_journal
        WHERE room_id=? GROUP BY account_id, lot_state HAVING t < 0`).all(roomId))
        violations.push(`negative balance: ${row.account_id}/${row.lot_state} = ${row.t}`);
      // Per-bounty award coverage. Proposed bounties lock nothing (triage
      // holds no budget); terminal bounties must hold nothing at all.
      const awardKinds = [...AWARD_KINDS].map(k => `'${k}'`).join(",");
      for (const b of this.db.prepare("SELECT bounty_id, amount_millis, state, resolution_json FROM bounty_records WHERE room_id=?").all(roomId)) {
        const lots = this.db.prepare(`SELECT lot_state, COALESCE(SUM(amount),0) AS t FROM bounty_journal
          WHERE room_id=? AND bounty_id=? AND kind IN (${awardKinds}) GROUP BY lot_state`).all(roomId, b.bounty_id);
        const bucket = Object.fromEntries(lots.map(r => [r.lot_state, r.t]));
        const escrowed = (bucket.locked ?? 0) + (bucket.attributed ?? 0) + (bucket.approved ?? 0);
        const resolution = b.resolution_json ? JSON.parse(b.resolution_json) : null;
        if (TERMINAL_STATES.has(b.state)) {
          const all = this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS t
            FROM bounty_journal WHERE room_id=? AND bounty_id=? AND lot_state IN ('locked','attributed','approved')`)
            .get(roomId, b.bounty_id).t;
          if (all !== 0) violations.push(`terminal bounty ${b.bounty_id} still holds ${all} in escrow buckets`);
        } else if (b.state === "proposed") {
          const any = this.db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=?")
            .get(roomId, b.bounty_id).n;
          if (any !== 0) violations.push(`proposed bounty ${b.bounty_id} locks budget (${any} journal rows)`);
        } else if (["funded", "claimed", "submitted"].includes(b.state)) {
          if ((bucket.locked ?? 0) !== b.amount_millis) violations.push(`bounty ${b.bounty_id} (${b.state}) locked ${bucket.locked ?? 0} != ${b.amount_millis}`);
        } else if (b.state === "accepted" || (b.state === "disputed" && !b.disputeId)) {
          if ((bucket.attributed ?? 0) !== b.amount_millis) violations.push(`bounty ${b.bounty_id} (${b.state}) attributed ${bucket.attributed ?? 0} != ${b.amount_millis}`);
        } else if (b.state === "approved" || b.state === "disputed") {
          // disputed: award is locked (pre-accept dispute) or attributed/approved (post-accept)
          if (escrowed !== b.amount_millis && !(b.state === "approved" && resolution?.kind === "split"))
            violations.push(`bounty ${b.bounty_id} (${b.state}) escrowed ${escrowed} != ${b.amount_millis}`);
        }
      }
      // Per-account hash chains.
      for (const { account_id } of this.db.prepare("SELECT DISTINCT account_id FROM bounty_journal WHERE room_id=?").all(roomId)) {
        let prev = "genesis";
        for (const e of this.db.prepare("SELECT * FROM bounty_journal WHERE room_id=? AND account_id=? ORDER BY seq").all(roomId, account_id)) {
          if (e.prev_hash !== prev) { violations.push(`hash chain break for ${account_id} at ${e.entry_id}`); break; }
          const core = [e.prev_hash, e.entry_id, e.account_id, e.at, e.kind, e.bounty_id ?? "", e.lot_id ?? "",
            String(e.amount), e.lot_state, e.memo ?? "", e.actor_kind ?? "", e.actor_id ?? ""].join("|");
          if (sha256(core) !== e.hash) { violations.push(`hash mismatch for ${account_id} at ${e.entry_id}`); break; }
          prev = e.hash;
        }
      }
      return { ok: violations.length === 0, violations, totalIssued: toCredits(genesis),
        byState: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, toCredits(v)])) };
    });
  }

  // --- idempotency ----------------------------------------------------------------------
  // All mutating routes are idempotent on a client-supplied key: a replayed
  // key returns the original status + body without re-executing.
  idemExecute(roomId, key, route, status, thunk) {
    if (key === null || key === undefined) return { replayed: false, status, body: thunk() };
    check(typeof key === "string" && key.length >= 1 && key.length <= 128, "invalid_input", "idempotency key must be 1..128 characters");
    return this.store.transaction(() => {
      this._ensure();
      const existing = this.db.prepare("SELECT status, response FROM bounty_idempotency WHERE room_id=? AND idem_key=?").get(roomId, key);
      if (existing) return { replayed: true, status: existing.status, body: JSON.parse(existing.response) };
      const body = thunk();
      this.db.prepare("INSERT INTO bounty_idempotency (room_id, idem_key, route, status, response, created_at) VALUES (?,?,?,?,?,?)")
        .run(roomId, key, route, status, JSON.stringify(body), isoNow(this.nowMs()));
      return { replayed: false, status, body };
    });
  }

  // Read the dispute machine record (for routes/tests).
  getDispute(roomId, disputeId) {
    return this.store.readTransaction(() => {
      this._ensure();
      const dispute = this._disputes.get(disputeId);
      void roomId;
      return dispute;
    });
  }
}

export { EscrowError, DisputeError };
