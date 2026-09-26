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
// Lifecycle: two guarded tracks (integration-map candidate #2). Display
// states are unchanged — the split is in transition legality, and every
// journaled transition records its track.
//
//   Acceptance track (verdict on work, evidence-cited):
//     claimed --submit--> submitted --accept--> accepted --challenge--> approved
//     submitted|accepted --dispute--> disputed --release--> approved | --cancel--> refunded
//   Finality track (credit-lot movements; requires a terminal acceptance verdict):
//     locked --attribute--> attributed --approve--> approved --payout--> paid
//     locked|attributed --refund--> refunded
//
// Disputes hook the acceptance track only and freeze finality while the
// acceptance is re-decided: while a bounty is disputed, no award lot moves
// except the dispute's own settlement, which records the verdict first.
// Intake and triage (proposed/funded/claimed) are pre-lifecycle and governed
// by neither track.
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
import { claimEligibility, reputationSummary, routingVisibility, PROBATION_MAX_CLAIM_CREDITS, PROBATION_MAX_CLAIM_MILLIS } from "./bounty-reputation.mjs";
import { issueBountyReceipt } from "./bounty-receipts.mjs";

export const GENESIS_LANES = Object.freeze([
  "id:agent/jill", "id:agent/instinct", "id:agent/grokbot", "id:agent/codex",
]);
export const GENESIS_CREDITS = 100;
export const MILLIS_PER_CREDIT = 1000;
export const CLAIM_BOND_MILLIS = 1000; // 1 credit anti-flake bond, fixed per room (slice 1)
// Slice 8 (integration map #8): graduated anti-flake ladder. Flake strikes
// decay (always a way back); the rung escalates forfeit -> 2x bond ->
// cooldown. Credits-only: the ladder moves ledger units and gates claims,
// never touches payouts and never bans.
export const FLAKE_DECAY_MS = 30 * 24 * 3600 * 1000; // strikes older than 30d stop counting
export const FLAKE_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // rung 3+: no new claims for 7d
export const FLAKE_BOND_MULTIPLIER = 2; // rung 2+: the claim bond doubles
export const FLAKE_COOLDOWN_RUNG = 3;
export const FEE_NUMERATOR = 1;
export const FEE_DENOMINATOR = 100; // 1% of the award to the room pool, on released payouts only
export const DISPUTE_BOND_RATIO = 0.25; // challenger stakes exactly 25% of the bounty (<=25% total dispute cost, per v2)
export const CHALLENGE_WINDOW_SMALL_MS = 24 * 3600 * 1000; // micro-bounties (< 1 credit)
export const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const DISPUTE_TIMEOUT_MS = 14 * 24 * 3600 * 1000; // unresolved disputes default to RELEASE
export const MAX_CREDITS = 1000000;
export const POOL_ACCOUNT = "pool"; // room pool: the 1% fee recipient (the commons, not a participant)
export const RULE_ACTOR = Object.freeze({ kind: "rule", id: "escrow-keeper" }); // mechanical transitions

// Journal kinds eligible for an Ed25519-signed, externally verifiable
// receipt, mapped to the receipt type issued for them. approve / fee /
// bond-return / bond-forfeit / bond-compensate / transfer / genesis move
// value internally or release bonds, but are not attested transitions —
// they are journal-only.
const SIGNABLE_KINDS = new Map([
  ["escrow-lock", "escrow-locked"],
  ["bond-lock", "bond-locked"],
  ["attribute", "attributed"],
  ["payout", "payout-released"],
  ["refund", "refund-issued"],
]);

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

// --- two-track vocabulary ---------------------------------------------------
// Acceptance = the verdict on work (evidence-cited). Finality = credit-lot
// movements. States stay as display labels; the split is enforced in
// transition legality, and every journaled transition records its track.
export const TRACK_ACCEPTANCE = "acceptance";
export const TRACK_FINALITY = "finality";

// Free-miss settlement vocabulary (docs/FREE-MISS-SETTLEMENT.md): the
// verdict stamped onto every terminal settlement. verified-complete is the
// only settlement that pays the worker; partial is the dispute-split
// exception; failed and unverified settle the worker at zero and return
// the escrow to the poster.
export const SETTLEMENT_KINDS = new Set(["verified-complete", "failed", "unverified", "partial"]);

// Acceptance track: verdict transitions on the bounty record (from-state ->
// legal to-states). Terminal verdicts: accepted (work approved) or rejected
// (work judged bad — the dispute-upheld refund; the display label stays
// "refunded"). Every acceptance transition is evidence-cited.
const ACCEPTANCE_TRACK = new Map([
  ["claimed", new Set(["submitted"])],              // work enters review
  ["submitted", new Set(["accepted", "disputed", "refunded"])], // verdict | challenge | reject
  ["accepted", new Set(["disputed"])],              // challenge within the window
  ["disputed", new Set(["approved", "refunded"])], // release: verdict affirmed; cancel: verdict rejected
]);

// Bounty-record state transitions -> the track that governs them. null =
// intake/triage/commitment: pre-lifecycle, governed by neither track.
const STATE_TRANSITION_TRACK = new Map([
  ["proposed", new Map([["funded", null], ["cancelled", null]])],
  ["funded", new Map([["claimed", null], ["refunded", TRACK_FINALITY]])],
  ["claimed", new Map([["submitted", TRACK_ACCEPTANCE], ["refunded", TRACK_FINALITY]])],
  ["submitted", new Map([["accepted", TRACK_ACCEPTANCE], ["disputed", TRACK_ACCEPTANCE],
    ["refunded", TRACK_ACCEPTANCE]])], // reject: the verdict failed the work (free-miss settlement)
  ["accepted", new Map([["approved", TRACK_FINALITY], ["disputed", TRACK_ACCEPTANCE]])],
  ["disputed", new Map([["approved", TRACK_ACCEPTANCE], ["refunded", TRACK_ACCEPTANCE]])],
  ["approved", new Map([["paid", TRACK_FINALITY]])],
]);

// Journal kind -> track. Award lots ride the finality track
// (locked -> attributed -> paid | refunded); bonds are escrow locks on the
// same track. genesis and payable<->payable transfers are not bounty
// lifecycle transitions (null).
const JOURNAL_KIND_TRACK = new Map([
  ["escrow-lock", TRACK_FINALITY], ["attribute", TRACK_FINALITY],
  ["approve", TRACK_FINALITY], ["payout", TRACK_FINALITY],
  ["refund", TRACK_FINALITY], ["fee", TRACK_FINALITY],
  ["bond-lock", TRACK_FINALITY], ["bond-return", TRACK_FINALITY],
  ["bond-forfeit", TRACK_FINALITY], ["bond-compensate", TRACK_FINALITY],
  ["genesis", null], ["transfer", null],
]);

// Track attribution helpers (exported for tests and future consumers).
export function trackOfJournalKind(kind) {
  return JOURNAL_KIND_TRACK.has(kind) ? JOURNAL_KIND_TRACK.get(kind) : null;
}
export function trackOfStateTransition(from, to) {
  return STATE_TRANSITION_TRACK.get(from)?.get(to) ?? null;
}
export function stateTransitionLegal(from, to) {
  return STATE_TRANSITION_TRACK.get(from)?.has(to) ?? false;
}
export function acceptanceTransitionLegal(from, to) {
  return ACCEPTANCE_TRACK.get(from)?.has(to) ?? false;
}

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
    actor_id TEXT,
    receipt_id TEXT,
    track TEXT
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
    rubric_json TEXT,
    rubric_hash TEXT,
    rubric_version INTEGER,
    submission_hash TEXT,
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
    track TEXT,
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
`
// Slice 6 (integration map #6): pinned versioned rubrics. bounty_records
// carries the CURRENT pin (rubric_json / rubric_hash / rubric_version);
// every past version is preserved in bounty_rubric_versions so arbiters can
// re-check a verdict against the exact version pinned when the work was
// judged. (Kept as a concatenated literal: SQL comments inside the schema
// text would break the strict DDL-text verifySchema, since SQLite strips
// comments from the stored DDL.)
+ `
  CREATE TABLE IF NOT EXISTS bounty_rubric_versions (
    room_id TEXT NOT NULL,
    bounty_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    rubric_hash TEXT NOT NULL,
    rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
    pinned_at TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    PRIMARY KEY(bounty_id, version)
  );
`
// Slice 8 (integration map #8): graduated anti-flake ladder. One row per
// recorded flake (timeout without submitting, or work judged bad on an
// upheld dispute). The rung is derived from strikes inside the decay window;
// decay always offers a way back, so the table is append-only and never
// pruned by the ladder itself.
+ `
  CREATE TABLE IF NOT EXISTS bounty_flakes (
    flake_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    bounty_id TEXT NOT NULL,
    struck_at_ms INTEGER NOT NULL,
    reason TEXT NOT NULL,
    rung INTEGER NOT NULL CHECK(rung >= 1),
    decayed_journaled INTEGER NOT NULL DEFAULT 0,
    cooldown_end_journaled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS bounty_flakes_lane ON bounty_flakes(room_id, lane, struck_at_ms);
`
// Slice 10 (integration map #10): submission fingerprinting + claim-graph
// correlation -> arbiter review packets. The fingerprint is a normalized
// SHA-256 over the canonicalized submission evidence; above-threshold
// correlation (duplicate fingerprints, repeat claimant<->poster pairs)
// creates a packet for HUMAN review. Review-only: packets never auto-ban,
// auto-slash, or touch balances, bonds, or reputation.
+ `
  CREATE TABLE IF NOT EXISTS bounty_review_packets (
    room_id TEXT NOT NULL,
    packet_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    bounty_id TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    signals_json TEXT NOT NULL CHECK(json_valid(signals_json)),
    matched_bounties_json TEXT NOT NULL CHECK(json_valid(matched_bounties_json)),
    graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
  );
  CREATE INDEX IF NOT EXISTS bounty_review_packets_bounty ON bounty_review_packets(room_id, bounty_id);
`
// Slice 10 (integration map #10): the sybil-cluster flag table. One row per
// above-threshold correlated cluster: the correlation signal, the member
// submissions (bounty + lane refs), the frozen evidence packet, and the
// review lifecycle — open -> dismissed (honest coincidence, e.g. the same
// template on a trivial task) or confirmed (an arbiter agrees). REVIEW-ONLY:
// rows here never drive bans, slashes, or balance/bond/reputation movement;
// resolution is a human/arbiter record, not an enforcement action.
+ `
  CREATE TABLE IF NOT EXISTS bounty_sybil_flags (
    room_id TEXT NOT NULL,
    flag_id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    signal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','confirmed')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_reason TEXT,
    submission_hash TEXT NOT NULL,
    member_lanes_json TEXT NOT NULL CHECK(json_valid(member_lanes_json)),
    member_bounties_json TEXT NOT NULL CHECK(json_valid(member_bounties_json)),
    evidence_packet_json TEXT NOT NULL CHECK(json_valid(evidence_packet_json))
  );
  CREATE INDEX IF NOT EXISTS bounty_sybil_flags_room ON bounty_sybil_flags(room_id, status);
  CREATE INDEX IF NOT EXISTS bounty_sybil_flags_cluster ON bounty_sybil_flags(room_id, cluster_id);
`
// Slice 4 (integration-map candidate #4): probation-gate review packets.
// Written when the reputation claim-eligibility gate denies a claim — the
// room's "adverse moves produce review packets for humans/arbiters" rule,
// since bands never auto-suspend. Review-only and immutable once created:
// rows here never drive bans, slashes, or balance/bond/reputation
// movement; they exist so arbiters can see who the gate is hitting and why.
+ `
  CREATE TABLE IF NOT EXISTS bounty_reputation_packets (
    room_id TEXT NOT NULL,
    packet_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    band TEXT NOT NULL,
    score REAL NOT NULL,
    max_claim_millis INTEGER NOT NULL,
    bounty_id TEXT NOT NULL,
    signals_json TEXT NOT NULL CHECK(json_valid(signals_json))
  );
  CREATE INDEX IF NOT EXISTS bounty_reputation_packets_agent ON bounty_reputation_packets(room_id, agent_id);
`;

// Slice 1 (#762) shipped these tables to production before receipt_id /
// track existed (#778, integration-map candidate #2). ALTER TABLE adds the
// columns but cannot rewrite the stored CREATE TABLE text, so the strict
// DDL-text verifySchema would refuse a deployed database ("Bounty escrow
// schema requires operator reconciliation") and take the room down. Rebuild
// the tables whose DDL changed, copying every row verbatim (the new columns
// stay NULL for pre-existing rows; nothing reads them yet). Idempotent:
// converged databases already match the expected DDL and are left alone.
// Runs inside the store's boot transaction, before the writer fence is
// installed (the bounty tables are unfenced).
export function convergeBountyDeployedSchema(db) {
  const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
  const chunks = bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
  const expectedTables = new Map(); // table -> { ddl, norm }
  const tableIndexes = new Map();   // table -> [index ddl, ...]
  for (const sql of chunks) {
    const tableMatch = /^CREATE TABLE ([a-z_]+)/.exec(normalize(sql));
    if (tableMatch) { expectedTables.set(tableMatch[1], { ddl: sql, norm: normalize(sql) }); continue; }
    const indexMatch = /^CREATE INDEX ([a-z_]+) ON ([a-z_]+)/.exec(normalize(sql));
    if (indexMatch) {
      if (!tableIndexes.has(indexMatch[2])) tableIndexes.set(indexMatch[2], []);
      tableIndexes.get(indexMatch[2]).push(sql);
    }
  }
  const tableExists = name =>
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  // 1. Additive tables from later slices that a deployed database never had.
  for (const [table, { ddl }] of expectedTables)
    if (!tableExists(table)) db.exec(ddl);
  // 2. Rebuild tables whose stored DDL drifted (row-preserving), then
  // recreate that table's indexes (ALTER TABLE ... RENAME drops them — the
  // slice-1-era rebuild lost them).
  for (const table of ["bounty_journal", "bounty_records", "bounty_events"]) {
    const actual = tableExists(table)?.sql;
    if (!actual) continue; // Fresh database: created above.
    if (normalize(actual) === expectedTables.get(table).norm) continue; // Already converged.
    const legacy = `${table}_legacy_v762`;
    const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(r => r.name);
    if (tableExists(legacy))
      throw new Error(`Bounty schema convergence blocked: ${legacy} already exists`);
    db.exec(`ALTER TABLE ${table} RENAME TO ${legacy}`);
    db.exec(expectedTables.get(table).ddl);
    const colList = cols.join(", ");
    db.exec(`INSERT INTO ${table} (${colList}) SELECT ${colList} FROM ${legacy}`);
    db.exec(`DROP TABLE ${legacy}`);
    for (const indexDdl of tableIndexes.get(table) ?? []) db.exec(indexDdl);
  }
  // 3. Indexes the slice-1-era rebuild may have dropped: purely additive.
  for (const indexDdls of tableIndexes.values())
    for (const indexDdl of indexDdls) db.exec(indexDdl);
  // 4. Slice 6: pin a v1 rubric (derived from the acceptance criteria) onto
  // every legacy bounty row that predates rubrics, so acceptance citations
  // keep a pinned version to cite against. Deterministic: the same criteria
  // text always yields the same v1 pin.
  _backfillRubricPins(db);
  // 5. 2026-09-23 slug-collision repair: re-key bounty_sequences by room
  // slug (see migrateBountySequencesToSlugKey). Data-only, idempotent.
  migrateBountySequencesToSlugKey(db);
}

// Pin the default derived rubric (v1) onto bounty_records rows that predate
// slice 6, and record each pin in bounty_rubric_versions. Exported for the
// _migrateColumns fallback path (older test doubles); the boot convergence
// above is the production path.
export function _backfillRubricPins(db) {
  const rows = db.prepare(
    "SELECT bounty_id, room_id, criteria, poster, created_at FROM bounty_records WHERE rubric_json IS NULL").all();
  const insert = db.prepare(`INSERT OR IGNORE INTO bounty_rubric_versions
    (room_id, bounty_id, version, rubric_hash, rubric_json, pinned_at, pinned_by) VALUES (?,?,?,?,?,?,?)`);
  const update = db.prepare(
    "UPDATE bounty_records SET rubric_json=?, rubric_hash=?, rubric_version=1 WHERE bounty_id=?");
  for (const row of rows) {
    const criteria = defaultRubricFor(row.criteria);
    const json = JSON.stringify(criteria), hash = rubricHashOf(criteria);
    update.run(json, hash, row.bounty_id);
    insert.run(row.room_id, row.bounty_id, 1, hash, json, row.created_at, row.poster ?? "unknown");
  }
}

// Bounty-id slug-collision repair (2026-09-23 production incident).
//
// bounty_records.bounty_id is a GLOBAL primary key, but _nextBountyId keyed
// the per-id sequence by room_id while minting `${roomSlug(roomId)}-${n}` —
// and roomSlug truncates to 12 alphanumeric characters. Two rooms whose
// slugs collide (e.g. instinct-bp-1790125051 and instinct-bp-1790153495 both
// slug to INSTINCTBP17) each started their own counter at 1, so the second
// room's every propose died with "UNIQUE constraint failed:
// bounty_records.bounty_id" — a permanent 500, since the per-room sequence
// rolled back with the failed transaction and retries never healed. Reads
// kept working, matching the observed signature exactly.
//
// The repair keys the sequence by the slug instead of the room id: ids stay
// in the same quotable `${SLUG}-${n}` shape, stay sequential in the common
// (distinct-slug) case, and can never collide across rooms. Same-slug rooms
// share one counter, so the second room's first bounty is SLUG-2 — slightly
// surprising numbering, infinitely better than a permanent 500.
//
// The sequence table keeps its DDL byte-identical (the strict DDL-text
// verifySchema compares stored DDL verbatim, so no comment or rename may
// touch the schema literal): the `room_id` column now stores the slug key.
// This migration is idempotent and runs both at RoomStore boot
// (convergeBountyDeployedSchema, the production path) and in the
// request-time _ensure() fallback for direct (non-store) construction.
export function migrateBountySequencesToSlugKey(db) {
  const bySlug = new Map(); // slug -> next_n
  // Defense in depth first: a minted bounty row without a sequence row must
  // never let the counter rewind below an id that already exists.
  for (const { bounty_id } of db.prepare("SELECT bounty_id FROM bounty_records").all()) {
    const m = /^([A-Z0-9]{1,12})-(\d+)$/.exec(bounty_id);
    if (!m) continue;
    const n = Number(m[2]);
    if (Number.isSafeInteger(n)) bySlug.set(m[1], Math.max(bySlug.get(m[1]) ?? 0, n + 1));
  }
  const rows = db.prepare("SELECT room_id AS k, next_n AS n FROM bounty_sequences").all();
  for (const { k, n } of rows) {
    const slug = roomSlug(k);
    if (Number.isSafeInteger(n)) bySlug.set(slug, Math.max(bySlug.get(slug) ?? 0, n));
  }
  if (bySlug.size === 0) return;
  // Skip the rewrite when the table is already converged (the common case
  // after the first run): avoids write churn on every boot.
  if (rows.length === bySlug.size && rows.every(({ k, n }) => bySlug.get(k) === n)) return;
  db.exec("DELETE FROM bounty_sequences");
  const insert = db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)");
  for (const [slug, n] of bySlug) insert.run(slug, n);
}

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
// actor; when absent it is derived from the acting identity as a pre-validation
// hint only — the escrow re-derives kind from the room membership record on
// every participant path (server/bounty-escrow.mjs _actorFor), so production
// agent identities (ai_...) are never mislabeled by their string shape.
// Mechanical transitions use RULE_ACTOR explicitly.
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

// Slice 10: sybil-cluster detection thresholds (integration map #10).
// Review-only: crossing a threshold creates an arbiter-review flag — it
// never auto-bans, auto-slashes, or moves balances, bonds, or reputation.
export const SYBIL_COPY_PASTE_MIN_LANES = 2;         // distinct lanes, byte-identical normalized fingerprint
export const SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES = 3;  // one lane's shared fingerprint spans N distinct bounties with another lane

// Slice 4: probation-gate review-packet dedupe window. One packet per lane
// per 24h — a lane retrying a denied claim does not spam the arbiter queue.
export const REPUTATION_PACKET_DEDUPE_MS = 24 * 3600 * 1000;

// Slice 10: normalized text for the submission fingerprint. Deterministic:
// line endings -> \n, horizontal whitespace runs collapse to one space,
// blank-line runs collapse to one newline, ends trimmed. Case is NOT
// folded — case changes are meaningful in code — so "Fix" and "fix" hash
// differently while "did   the thing\n" and "did the thing" hash alike.
const canonText = value => String(value)
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n[ \t]*\n+/g, "\n")
  .trim();

// Slice 10: the normalized submission fingerprint. Canonicalization is
// deterministic — fixed field order, sorted checksClaimed, normalized
// text, no timestamps, no reporter identity — so the same work always
// hashes to the same 64-hex fingerprint regardless of who submits it or
// when.
export function canonicalSubmissionOf(evidence) {
  const pick = {};
  for (const key of ["evidenceKind", "evidenceUrl", "producerId", "summary"])
    if (evidence[key] !== undefined && evidence[key] !== null) pick[key] = canonText(evidence[key]);
  if (Array.isArray(evidence.checksClaimed))
    pick.checksClaimed = [...evidence.checksClaimed].map(canonText).sort();
  return JSON.stringify(pick);
}
export const submissionHashOf = evidence => sha256(canonicalSubmissionOf(evidence));

// Deep-freeze a JSON-shaped value (packets carry nested graph/signal
// structures that a top-level freeze would leave mutable).
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
const newId = prefix => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const isoNow = ms => new Date(ms).toISOString();

// --- slice 6: pinned versioned rubrics -------------------------------------------
// A rubric is a fixed list of acceptance criteria pinned to the bounty at
// post time (v1) and re-pinnable by the poster only while the bounty is
// still PROPOSED (funding pins it). Acceptance verdicts cite {criterionId,
// verdict} against the pinned version; arbiters re-check against the exact
// pinned version from bounty_rubric_versions. Canonical form is sorted by
// criterionId so the hash is stable.
export const RUBRIC_MAX_CRITERIA = 50;
export const CITATION_VERDICTS = Object.freeze(["pass", "fail"]);

export function canonicalRubric(rubric) {
  check(Array.isArray(rubric) && rubric.length >= 1 && rubric.length <= RUBRIC_MAX_CRITERIA,
    "invalid_input", `rubric must be an array of 1..${RUBRIC_MAX_CRITERIA} criteria`);
  const seen = new Set();
  const criteria = rubric.map(criterion => {
    check(criterion !== null && typeof criterion === "object" && !Array.isArray(criterion),
      "invalid_input", "rubric criteria must be objects");
    const { criterionId, description } = criterion;
    check(typeof criterionId === "string" && criterionId.length >= 1 && criterionId.length <= 64,
      "invalid_input", "rubric criterionId must be 1..64 characters");
    check(typeof description === "string" && description.length >= 1 && description.length <= 500,
      "invalid_input", "rubric criterion description must be 1..500 characters");
    check(!seen.has(criterionId), "invalid_input", `duplicate rubric criterionId "${criterionId}"`);
    seen.add(criterionId);
    return { criterionId, description };
  });
  criteria.sort((a, b) => a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0);
  return Object.freeze(criteria);
}

export const rubricHashOf = criteria => sha256(JSON.stringify(criteria));

// Bounties posted without an explicit rubric still get a pinned v1: the
// whole acceptance criteria text as a single criterion.
export function defaultRubricFor(criteriaText) {
  return Object.freeze([{ criterionId: "c1", description: String(criteriaText ?? "").slice(0, 500) || "c1" }]);
}

// Normalize a {criterionId, verdict} citation list against a pinned rubric:
// every cited id must exist, every pinned criterion must be cited, verdicts
// are pass|fail. Returns the frozen citation list.
export function citationsAgainstRubric(citations, rubric) {
  check(Array.isArray(citations) && citations.length >= 1, "missing_citations",
    "acceptance requires citations: one {criterionId, verdict} per pinned rubric criterion");
  const ids = new Set(rubric.criteria.map(c => c.criterionId));
  for (const citation of citations) {
    check(citation !== null && typeof citation === "object" && !Array.isArray(citation),
      "invalid_input", "citations must be {criterionId, verdict} objects");
    check(ids.has(citation.criterionId), "unknown_criterion",
      `criterionId "${citation.criterionId}" is not in the pinned rubric v${rubric.version} (${rubric.hash.slice(0, 12)}…)`);
    check(CITATION_VERDICTS.includes(citation.verdict), "invalid_input",
      `verdict must be one of ${CITATION_VERDICTS.join("|")}`);
  }
  for (const id of ids)
    check(citations.some(c => c.criterionId === id), "missing_citations",
      `pinned rubric criterion "${id}" has no citation`);
  return Object.freeze(citations.map(c => Object.freeze({ criterionId: c.criterionId, verdict: c.verdict })));
}
// Human-readable bounty id prefix per room (e.g. ROOM-12). The bracketed form
// [ROOM-12] is link-only in slice 1: no code path scans text for references,
// so bare or bracketed mentions can never trigger a side effect. NOTE: the
// slug is only 12 alphanumeric characters and is NOT unique per room —
// _nextBountyId keys the sequence by slug (shared counter for colliding
// slugs) because bounty_records.bounty_id is a global primary key
// (2026-09-23 slug-collision repair).
const roomSlug = roomId => roomId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "ROOM";

export class BountyEscrow {
  // `allowLegacyStringLanes` enables the string-only lane mode for pure
  // state-machine unit tests that construct the escrow without a membership
  // source. It is never set in production: the real store always exposes
  // roomAuthority() (server/store.mjs), and both production construction
  // sites pass the real store. Without it, lane assertion fails closed.
  constructor(store, { now, receipts = null, allowLegacyStringLanes = false } = {}) {
    this.store = store;
    this.db = store.db;
    this._now = typeof now === "function" ? now : null;
    this._allowLegacyStringLanes = allowLegacyStringLanes === true;
    this._ready = false;
    this._disputes = null; // createDisputes instance, hydrated lazily
    this._disputeRecords = null; // Map(disputeId -> frozen dispute), write-through to bounty_disputes
    this._arbiters = createArbiters();
    this._settlementActor = null; // transient: who the dispute settlement is attributed to
    this._settlementSigned = null; // transient: signed receipts issued by a dispute settlement
    this._disputeSettling = null; // transient: bounty id whose finality is unfrozen inside its own dispute settlement
    this._rubricCheckTransient = null; // transient: arbiter's rubric re-check, consumed by the dispute settlement's resolution
    // Receipt signer: createReceiptSigner({ seedHex, ref }) from
    // server/bounty-receipts.mjs. When null (the default — production key
    // provisioning is a later slice), transitions return `signed: []` and
    // journal entries are not stamped.
    this._receipts = receipts;
  }

  nowMs() { return this._now ? this._now() : this.store.now(); }

  // --- lane identity: membership validation ---------------------------------
  // A lane id is only meaningful when it names a CURRENT member of the room.
  // canonicalLane() is a pure string normalizer — it never consults
  // membership, so it cannot prove who acted. Every lane-asserting path in
  // this module goes through _requireLane(), which binds the normalized lane
  // to the room's live membership via store.roomAuthority(). When the store
  // exposes no membership source, lane assertion FAILS CLOSED unless the
  // escrow was explicitly constructed with allowLegacyStringLanes (pure
  // state-machine unit tests only — unreachable in production, where the
  // store always exposes roomAuthority()).
  _members(roomId) {
    if (typeof this.store.roomAuthority !== "function") return null;
    const authority = this.store.roomAuthority(roomId);
    return authority && typeof authority.members === "object" ? authority.members : null;
  }

  // The validated membership record for a canonical lane, or null when
  // there is no membership source (legacy string-only test mode).
  _memberOf(roomId, lane) {
    const members = this._members(roomId);
    if (members === null) return null;
    if (Object.hasOwn(members, lane)) return members[lane];
    // Legacy colon form: id:agent:foo names the same member as id:agent/foo.
    if (lane.startsWith("id:agent/")) {
      const colon = `id:agent:${lane.slice("id:agent/".length)}`;
      if (Object.hasOwn(members, colon)) return members[colon];
    }
    return null;
  }

  // Canonical lane ids of the room's current active members, or null when
  // the store exposes no membership source. The reputation projector uses
  // this to refuse reputation to stale or phantom labels.
  memberLaneIds(roomId) {
    const members = this._members(roomId);
    if (members === null) return null;
    const ids = new Set();
    for (const id of Object.keys(members)) {
      const m = members[id];
      if (m && m.active !== false) ids.add(canonicalLane(id));
    }
    return ids;
  }

  // Validate that rawId names a current, active member of roomId. Returns the
  // canonical lane. Fails closed (not_authorized) when the membership source
  // is present and the id is unknown, inactive, or unlinked — and fails
  // closed (internal) when there is no membership source at all unless the
  // legacy string-only test mode was explicitly enabled at construction.
  _requireLane(roomId, rawId, role) {
    const lane = canonicalLane(rawId);
    const members = this._members(roomId);
    if (members === null) {
      check(this._allowLegacyStringLanes === true, "internal",
        "bounty escrow requires a membership source (store.roomAuthority)");
      return lane;
    }
    const member = members[rawId] ?? members[lane];
    if (!member || member.active === false)
      fail("not_authorized", `${role}: "${lane}" is not a current member of this room`);
    return lane;
  }

  // Like _requireLane, but the member must be an agent (kind === "agent").
  // Used for the designated verifier: only an agent lane can verify work.
  _requireAgentLane(roomId, rawId, role) {
    const lane = this._requireLane(roomId, rawId, role);
    const members = this._members(roomId);
    if (members !== null) {
      const member = members[rawId] ?? members[lane];
      if (!member || member.kind !== "agent")
        fail("invalid_input", `${role} must be an agent member of this room`);
    }
    return lane;
  }

  // The transfer recipient must name a current, active member of the room.
  // The pool is the escrow's internal fee sink, not a participant: public
  // transfers cannot target it. Internal settlement paths (fee sweep, bond
  // forfeit) move to the pool via _move directly and never pass through
  // here. Sending to a phantom lane would mint ledger accounts for
  // identities that do not exist, so this fails closed when a membership
  // source is present.
  _requireRecipient(roomId, rawTo) {
    const recipient = canonicalLane(rawTo);
    check(recipient !== POOL_ACCOUNT, "not_authorized",
      "the room pool is escrow-internal and cannot receive participant transfers");
    const members = this._members(roomId);
    if (members === null) {
      check(this._allowLegacyStringLanes === true, "internal",
        "bounty escrow requires a membership source (store.roomAuthority)");
      check(recipient.length >= 1 && recipient.length <= 256, "invalid_input", "recipient must be 1..256 characters");
      return recipient;
    }
    const member = members[rawTo] ?? members[recipient];
    if (!member || member.active === false)
      fail("not_authorized", `transfer recipient "${recipient}" is not a current member of this room`);
    return recipient;
  }

  // Resolve the journal actor for a transition. The actor is ALWAYS derived
  // from the membership-validated lane: kind comes from the member record
  // (agent/human), never from the shape of the lane string — production
  // agent identities are opaque ids (ai_...), not id:agent/... labels. An
  // explicitly supplied actor is honored only as a consistency check (it
  // must name the same lane), never as an independent identity claim. The
  // mechanical rule actor is never a participant identity: participant
  // methods that receive it fail closed. Mechanical paths use RULE_ACTOR
  // directly and never go through here. Anything else fails closed: the
  // journal must never attribute an action to a lane that did not perform it.
  _actorFor(roomId, actor, lane) {
    const member = this._memberOf(roomId, lane);
    const kind = member ? (member.kind === "agent" ? "agent" : "human")
      : (lane.startsWith("id:agent/") ? "agent" : "human");
    if (actor === null || actor === undefined)
      return Object.freeze({ kind, id: lane });
    if (typeof actor === "object" && typeof actor.kind === "string" && typeof actor.id === "string") {
      if (actor.kind !== "rule" && canonicalLane(actor.id) === lane)
        return Object.freeze({ kind, id: lane });
    }
    fail("not_authorized", "actor identity does not match the authenticated lane");
  }

  // Idempotent schema convergence + dispute hydration. Runs at the top of
  // every public method (cheap after the first call).
  //
  // Read-only safety: when called inside a read-only Room transaction
  // (db.readOnlyTransaction — e.g. a fresh Durable Object isolate serving its
  // first read), this method must not write. Schema convergence already ran
  // at RoomStore construction in a write-capable context (convergeBountyDeployedSchema
  // + bountyEscrowSchema exec), so request-time migration here is only a
  // fallback for direct (non-store) construction. Historically the
  // unconditional backfill UPDATE in _migrateColumns ran on read paths and
  // every cold-isolate read 500'd with "Cannot write inside a read-only Room
  // transaction" until the first bounty write warmed the isolate.
  _ensure() {
    if (!this._ready) {
      if (this.db.readOnlyTransaction) {
        // Verify presence only; never write. _ready stays false so the next
        // write-capable call still performs the idempotent migration if one
        // is ever needed (it never is on a converged store).
        this._checkSchemaReadOnly();
      } else {
        const tables = new Set(this.db.prepare("SELECT name AS n FROM sqlite_master WHERE type='table'").all().map(r => r.n));
        const needed = ["bounty_journal", "bounty_records", "bounty_disputes", "bounty_events",
          "bounty_idempotency", "bounty_watchers", "bounty_sequences", "bounty_rubric_versions", "bounty_flakes",
          "bounty_review_packets", "bounty_sybil_flags", "bounty_reputation_packets"];
        if (needed.some(t => !tables.has(t))) this.db.exec(bountyEscrowSchema);
        // Always converge columns after creating missing tables (not
        // either/or): a shard can be missing tables AND carry older columns
        // on the tables it has (e.g. a pre-slice-6 bounty_records without
        // rubric_json). Skipping _migrateColumns() here left exactly that
        // shard state behind, and every propose then 500'd with "table
        // bounty_records has no column named rubric_json" while reads kept
        // working — the 2026-09-22 post-#792 regression.
        this._migrateColumns();
        // 2026-09-23 slug-collision repair (see migrateBountySequencesToSlugKey):
        // the request-time fallback path must converge the sequence key the
        // same way the boot path does.
        migrateBountySequencesToSlugKey(this.db);
        this._ready = true;
      }
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

  // Read-only schema presence check for read-only request paths (see
  // _ensure). Reads (PRAGMA, sqlite_master) are allowed inside read-only
  // transactions; every write is forbidden.
  _checkSchemaReadOnly() {
    const tables = new Set(this.db.prepare("SELECT name AS n FROM sqlite_master WHERE type='table'").all().map(r => r.n));
    const needed = ["bounty_journal", "bounty_records", "bounty_disputes", "bounty_events",
      "bounty_idempotency", "bounty_watchers", "bounty_sequences", "bounty_rubric_versions", "bounty_flakes",
      "bounty_review_packets", "bounty_sybil_flags", "bounty_reputation_packets"];
    const missing = needed.filter(t => !tables.has(t));
    if (missing.length) throw new Error(`Bounty escrow schema not converged on read-only path (missing tables: ${missing.join(", ")})`);
    const colsOf = table => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    const required = {
      bounty_journal: ["actor_kind", "actor_id", "receipt_id", "track"],
      bounty_events: ["actor_kind", "before_state", "after_state", "track"],
      bounty_records: ["state_changed_ms", "snoozed_until_ms", "decline_reason", "duplicate_of", "label",
        "rubric_json", "rubric_hash", "rubric_version"],
    };
    for (const [table, cols] of Object.entries(required)) {
      const have = colsOf(table);
      const absent = cols.filter(c => !have.has(c));
      if (absent.length) throw new Error(`Bounty escrow schema not converged on read-only path (${table} missing columns: ${absent.join(", ")})`);
    }
  }

  // Additive column migration for databases created by the slice-1 schema
  // (#762 shipped to production, so deployed databases predate receipt_id /
  // track). Fresh databases get the full schema from bountyEscrowSchema
  // above; the RoomStore boot convergence rebuilds deployed tables first so
  // the stored DDL text matches for verifySchema.
  _migrateColumns() {
    const colsOf = table => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    let added = false;
    const addCol = (table, ddl) => {
      const name = ddl.split(" ")[0];
      if (!colsOf(table).has(name)) { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); added = true; }
    };
    addCol("bounty_journal", "actor_kind TEXT");
    addCol("bounty_journal", "actor_id TEXT");
    addCol("bounty_journal", "receipt_id TEXT");
    addCol("bounty_journal", "track TEXT");
    addCol("bounty_events", "actor_kind TEXT");
    addCol("bounty_events", "before_state TEXT");
    addCol("bounty_events", "after_state TEXT");
    addCol("bounty_events", "track TEXT");
    // No track backfill for pre-track rows: the journal hash core is the
    // 12-element form when track is NULL, so backfilling would change the
    // verification core and invalidate their stored hashes. NULL track =
    // "written before tracks existed" (or a null-track kind like
    // genesis/transfer); nothing reads the column yet.
    addCol("bounty_records", "state_changed_ms INTEGER");
    addCol("bounty_records", "snoozed_until_ms INTEGER");
    addCol("bounty_records", "decline_reason TEXT");
    addCol("bounty_records", "duplicate_of TEXT");
    addCol("bounty_records", "label TEXT");
    // Slice 6: rubric pinning. Capture whether the rubric columns are new:
    // the pin backfill below is a write and must run only when migration
    // just added the columns (the only NULL source), mirroring the
    // state_changed_ms discipline.
    const hadRubricCols = colsOf("bounty_records").has("rubric_json");
    addCol("bounty_records", "rubric_json TEXT");
    addCol("bounty_records", "rubric_hash TEXT");
    addCol("bounty_records", "rubric_version INTEGER");
    addCol("bounty_records", "submission_hash TEXT");
    // Reuse the exact schema-text chunks: the strict DDL-text verifySchema
    // compares stored DDL verbatim, so a reformatted copy would fail it.
    // A name may own several chunks (table + its indexes), so collect all.
    // All chunks are IF NOT EXISTS: safe no-ops when already present.
    const schemaChunks = name => bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .filter(sql => sql.includes(name));
    for (const name of ["bounty_rubric_versions", "bounty_flakes", "bounty_review_packets", "bounty_sybil_flags",
      "bounty_reputation_packets"])
      for (const ddl of schemaChunks(name)) this.db.exec(ddl);
    // Legacy rows (NULL rubric): pin the default derived v1, same as the
    // boot convergence backfill.
    if (!hadRubricCols) _backfillRubricPins(this.db);
    // The backfill is a write: run it only when migration actually added a
    // column (first migration). New rows always set state_changed_ms at
    // INSERT, so a converged database can never accumulate new NULLs; the
    // only NULL source is the ALTER above, which coincides with added=true.
    if (added) this.db.exec(`UPDATE bounty_records SET state_changed_ms =
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
    check(JOURNAL_KIND_TRACK.has(kind), "invalid_input", `unknown journal kind "${kind}"`);
    const entryId = newId("ent_");
    const prevHash = this._lastHash(roomId, accountId);
    const actorKind = actor?.kind ?? null, actorId = actor?.id ?? null;
    // Track attribution is tamper-evident: it joins the hash core, but only
    // when non-null. Pre-track rows (and null-track kinds like
    // genesis/transfer) keep the original 12-element core so their stored
    // hashes keep verifying.
    const track = trackOfJournalKind(kind);
    const coreParts = [prevHash, entryId, accountId, at, kind, bountyId ?? "", lotId ?? "", String(amount),
      lotState, memo ?? "", actorKind ?? "", actorId ?? ""];
    if (track != null) coreParts.push(track);
    const core = coreParts.join("|");
    const hash = sha256(core);
    this.db.prepare(`INSERT INTO bounty_journal
      (room_id, entry_id, account_id, at, kind, bounty_id, lot_id, amount, lot_state, prev_hash, hash, memo, actor_kind, actor_id, track)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(roomId, entryId, accountId, at, kind, bountyId, lotId, amount, lotState, prevHash, hash, memo, actorKind, actorId, track);
    return { entryId, hash, prevHash };
  }

  // One zero-sum movement: debit one (account, lot_state), credit another.
  // `receipt: { type, payload }` requests an Ed25519-signed, externally
  // verifiable receipt for the movement (bounty-receipts.mjs). Only journal
  // kinds in SIGNABLE_KINDS may carry one; when no signer is configured the
  // receipt comes back null and the movement proceeds unsigned.
  _move({ roomId, at, from, to, amountMillis, kind, bountyId = null, lotId = null, memo = null, actor = null, receipt = null }) {
    check(Number.isSafeInteger(amountMillis) && amountMillis > 0, "invalid_amount", "movement amount must be positive");
    const debit = this._append({ roomId, accountId: from.account, at, kind, bountyId, lotId, amount: -amountMillis, lotState: from.state, memo, actor });
    const credit = this._append({ roomId, accountId: to.account, at, kind, bountyId, lotId, amount: amountMillis, lotState: to.state, memo, actor });
    const movement = { debitEntryId: debit.entryId, creditEntryId: credit.entryId, lotId, receipt: null };
    if (receipt !== null && receipt !== undefined) {
      const expected = SIGNABLE_KINDS.get(kind);
      check(expected !== undefined, "invalid_input", `signed receipts are not issued for journal kind "${kind}"`);
      check(receipt.type === expected, "invalid_input", `receipt type "${receipt.type}" does not match journal kind "${kind}"`);
      check(actor !== null && typeof actor === "object", "invalid_input", "signed receipts require an actor");
      movement.receipt = this._issueReceipt({ type: receipt.type, payload: receipt.payload ?? {},
        roomId, bountyId, lotId, amountMillis, actor, at,
        entries: [debit.entryId, credit.entryId] });
    }
    return movement;
  }

  // Issue a signed receipt for a completed movement, stamp both journal
  // entries with its receiptId, and return it. Returns null when no signer
  // is configured (production key provisioning is a later slice).
  _issueReceipt({ type, payload, roomId, bountyId, lotId, amountMillis, actor, at, entries }) {
    if (!this._receipts) return null;
    const hashes = new Map(this.db.prepare(
      "SELECT entry_id, hash FROM bounty_journal WHERE room_id=? AND entry_id IN (?,?)")
      .all(roomId, entries[0], entries[1]).map(r => [r.entry_id, r.hash]));
    for (const id of entries)
      if (!hashes.has(id)) throw new EscrowError("internal", `journal entry ${id} not found`);
    const receipt = issueBountyReceipt({ type, roomId, bountyId, lotId, amountMillis, actor,
      entries, entryHashes: entries.map(id => hashes.get(id)),
      payload, issuer: { pubkey: this._receipts.pubkeyHex, role: "escrow-keeper", ref: this._receipts.ref },
      issuedAt: at, seedHex: this._receipts.seedHex });
    this.db.prepare("UPDATE bounty_journal SET receipt_id=? WHERE room_id=? AND entry_id IN (?,?)")
      .run(receipt.receiptId, roomId, entries[0], entries[1]);
    return receipt;
  }

  // Spread into a transition receipt: { signed: [...] } — empty when the
  // movement is unsigned (no signer configured).
  _signed(movement) { return { signed: movement.receipt ? [movement.receipt] : [] }; }

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
  // Track is derived from the transition when both states are present
  // (acceptance verdicts vs finality moves); an explicit track overrides.
  _event(roomId, type, { bountyId = null, actor = null, before = null, after = null, data = {}, track = null } = {}) {
    const at = isoNow(this.nowMs());
    const resolvedTrack = track ?? (before !== null && after !== null ? trackOfStateTransition(before, after) : null);
    const row = this.db.prepare(
      `INSERT INTO bounty_events (room_id, at, type, bounty_id, actor_kind, actor_id, before_state, after_state, track, data)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(roomId, at, type, bountyId, actor?.kind ?? null, actor?.id ?? null, before, after, resolvedTrack, JSON.stringify(data));
    return { seq: Number(row.lastInsertRowid), at, type, bountyId,
      actor: actor ? { kind: actor.kind, id: actor.id } : null, before, after, track: resolvedTrack, data };
  }

  // --- genesis ----------------------------------------------------------------
  // The one and only mint: 100 credits per CURRENT active room member,
  // recorded as one auditable journal entry per member (per-account hash
  // chains start here). Idempotent per member: members who join later are
  // provisioned on the next call; members who left keep their balance.
  // Genesis never issues to synthetic lane labels — the recipient set is
  // always the room's live membership. Without a membership source
  // (legacy string-only test mode), the historical fixed lane list is used.
  ensureGenesis(roomId) {
    return this.store.transaction(() => {
      this._ensure();
      const at = isoNow(this.nowMs());
      const millis = GENESIS_CREDITS * MILLIS_PER_CREDIT;
      const members = this._members(roomId);
      let recipients;
      if (members === null) {
        check(this._allowLegacyStringLanes === true, "internal",
          "bounty escrow requires a membership source (store.roomAuthority)");
        recipients = [...GENESIS_LANES];
      } else {
        recipients = [];
        for (const id of Object.keys(members)) {
          const m = members[id];
          if (m && m.active !== false) recipients.push(canonicalLane(id));
        }
      }
      const issued = new Set(this.db.prepare(
        "SELECT DISTINCT account_id AS a FROM bounty_journal WHERE room_id=? AND kind='genesis'")
        .all(roomId).map(r => r.a));
      const lanes = [];
      for (const lane of recipients) {
        if (issued.has(lane)) continue;
        this._append({ roomId, accountId: lane, at, kind: "genesis", amount: millis, lotState: "payable",
          memo: `genesis issuance: ${GENESIS_CREDITS} credits`, actor: RULE_ACTOR });
        issued.add(lane);
        lanes.push(lane);
      }
      if (lanes.length > 0)
        this._event(roomId, "genesis.issued", { actor: RULE_ACTOR, data: { lanes, creditsPerLane: GENESIS_CREDITS } });
      return { issued: lanes.length > 0, lanes };
    });
  }

  // --- sequential bounty ids --------------------------------------------------
  // Quotable sequential ids per room slug (e.g. ROOM-12). The sequence is
  // keyed by the 12-char slug, NOT the room id: bounty_records.bounty_id is
  // a global primary key, so two rooms whose slugs collide must share one
  // counter or the second room's every propose 500s on UNIQUE constraint
  // failure (2026-09-23 incident). Same-slug rooms therefore share
  // numbering; distinct slugs are unaffected.
  _nextBountyId(roomId) {
    const slug = roomSlug(roomId);
    const n = this.db.prepare(`INSERT INTO bounty_sequences(room_id, next_n) VALUES(?, 2)
      ON CONFLICT(room_id) DO UPDATE SET next_n = bounty_sequences.next_n + 1
      RETURNING next_n - 1 AS n`).get(slug).n;
    return `${slug}-${n}`;
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
      const lane = this._requireLane(roomId, watcher, "watcher");
      const row = this.db.prepare("SELECT bounty_id FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const at = isoNow(this.nowMs());
      this._addWatcher(roomId, bountyId, lane, at);
      const act = this._actorFor(roomId, actor, lane);
      return { bountyId, watcher: lane, watchers: this._watchersOf(roomId, bountyId),
        receipt: { kind: "watch", bountyId, watcher: lane, at, actor: act } };
    });
  }

  unwatchBounty(roomId, bountyId, { watcher } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = this._requireLane(roomId, watcher, "watcher");
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

  // The pinned rubric for a bounty row: { version, hash, criteria }. Legacy
  // rows that predate slice 6 (NULL columns — e.g. a test double that never
  // ran convergence) fall back to the default derived v1, so citation checks
  // always have a pinned version to validate against.
  _rubricOfRow(row) {
    if (row.rubric_json) {
      return Object.freeze({ version: row.rubric_version ?? 1, hash: row.rubric_hash,
        criteria: Object.freeze(JSON.parse(row.rubric_json).map(c => Object.freeze({ ...c }))) });
    }
    const criteria = defaultRubricFor(row.criteria);
    return Object.freeze({ version: 1, hash: rubricHashOf(criteria), criteria });
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
      rubric: this._rubricOfRow(row),
      submissionHash: row.submission_hash ?? null,
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
      evidence_json=?, attestation_json=?, resolution_json=?,
      rubric_json=?, rubric_hash=?, rubric_version=?, submission_hash=?, updated_at=? WHERE bounty_id=?`)
      .run(bounty.title, bounty.criteria, bounty.amountMillis, bounty.poster, bounty.verifier,
        bounty.claimant ?? null, bounty.state, bounty.stateChangedMs, bounty.deadlineMs,
        bounty.challengeEndsMs ?? null, bounty.disputeId ?? null, bounty.disputeOpenedMs ?? null,
        bounty.snoozedUntilMs ?? null, bounty.declineReason ?? null, bounty.duplicateOf ?? null, bounty.label ?? null,
        bounty.evidence ? JSON.stringify(bounty.evidence) : null,
        bounty.attestation ? JSON.stringify(bounty.attestation) : null,
        bounty.resolution ? JSON.stringify(bounty.resolution) : null,
        bounty.rubric ? JSON.stringify(bounty.rubric.criteria) : null,
        bounty.rubric ? bounty.rubric.hash : null,
        bounty.rubric ? bounty.rubric.version : null,
        bounty.submissionHash ?? null, at, bounty.bountyId);
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
      rubric: this._rubricOfRow(row),
      submissionHash: row.submission_hash ?? null,
    };
  }

  _transition(bounty, toState) {
    bounty.state = toState;
    bounty.stateChangedMs = this.nowMs();
  }

  // --- two-track guards ---------------------------------------------------------
  // Acceptance track guard: the verdict transition must be legal on the
  // acceptance track and evidence-cited. Method-level authorization checks
  // stay where they are; this is the legality layer underneath them.
  _acceptanceTransition(bounty, to, { evidence } = {}) {
    if (!acceptanceTransitionLegal(bounty.state, to))
      fail("illegal_transition", `acceptance track: ${bounty.state} -> ${to} is not a legal verdict transition`);
    check(evidence !== undefined && evidence !== null, "missing_evidence",
      `acceptance track: ${bounty.state} -> ${to} requires cited evidence`);
  }

  // Finality track guard: award lot movements require a terminal acceptance
  // verdict. Exceptions: the intake lock (fund: proposed -> funded, which
  // starts the finality track) and the timeout refund (work never entered
  // the acceptance track). While a bounty is disputed, finality is frozen —
  // only the dispute's own settlement may move the award, and only after it
  // records the acceptance verdict (this._disputeSettling).
  _requireFinalityMove(bounty, kind) {
    check(AWARD_KINDS.has(kind), "internal", `finality guard called for non-award kind "${kind}"`);
    if (bounty.state === "disputed" && this._disputeSettling !== bounty.bountyId)
      fail("finality_frozen", `bounty ${bounty.bountyId} is disputed: finality is frozen while acceptance is re-decided`);
    const verdictOk = (() => {
      switch (kind) {
        case "escrow-lock": return bounty.state === "proposed"; // intake lock
        case "attribute": return bounty.state === "submitted" || this._disputeSettling === bounty.bountyId;
        case "approve": return bounty.state === "accepted" || this._disputeSettling === bounty.bountyId;
        case "payout": case "fee": return bounty.state === "approved";
        case "refund": return bounty.state === "funded" || bounty.state === "claimed" || bounty.state === "submitted"
          || this._disputeSettling === bounty.bountyId;
        default: return false;
      }
    })();
    if (!verdictOk)
      fail("missing_verdict", `finality track: ${kind} requires a terminal acceptance verdict (bounty is ${bounty.state})`);
  }

  // --- triage ---------------------------------------------------------------------
  // POST /bounties creates PROPOSED: a holding state outside the claimable
  // work graph and outside metrics. Submission != commitment: no budget is
  // locked, so posting never needs funds.
  postBounty(roomId, { poster, title, criteria, amount, deadline, verifierId = null, rubric = null, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const lane = this._requireLane(roomId, poster, "poster");
      const act = this._actorFor(roomId, actor, lane);
      check(typeof title === "string" && title.length >= 1 && title.length <= 256, "invalid_input", "title must be 1..256 characters");
      check(typeof criteria === "string" && criteria.length >= 1 && criteria.length <= 2000, "invalid_input", "criteria must be 1..2000 characters");
      const amountMillis = toMillis(amount);
      const deadlineMs = Date.parse(deadline);
      check(Number.isFinite(deadlineMs), "invalid_input", "deadline must be an ISO timestamp");
      check(deadlineMs > this.nowMs(), "invalid_input", "deadline must be in the future");
      let verifier = null;
      if (verifierId !== null && verifierId !== undefined) {
        // The designated verifier must be a CURRENT agent member of the
        // room — never a hardcoded lane list. A verifier who leaves (or
        // never was a member) cannot be seated later; the dispute path then
        // reports honestly-unavailable instead of seating a phantom.
        const members = this._members(roomId);
        verifier = members === null
          ? canonicalLane(verifierId)
          : this._requireAgentLane(roomId, verifierId, "verifier");
        if (members === null)
          check(GENESIS_LANES.includes(verifier), "invalid_input", "verifier must be one of the room's agent lanes");
        check(verifier !== lane, "invalid_input", "the verifier must be a third lane, distinct from the poster");
      }
      // Slice 6: pin the rubric at v1. No explicit rubric -> derive the
      // default single-criterion pin from the acceptance criteria text.
      const pinned = rubric === null || rubric === undefined ? defaultRubricFor(criteria) : canonicalRubric(rubric);
      const rubricHash = rubricHashOf(pinned), rubricJson = JSON.stringify(pinned);
      const at = isoNow(this.nowMs());
      const bountyId = this._nextBountyId(roomId);
      this.db.prepare(`INSERT INTO bounty_records
        (bounty_id, room_id, title, criteria, amount_millis, poster, verifier, claimant, state, state_changed_ms,
         deadline_ms, challenge_ends_ms, dispute_id, dispute_opened_ms, snoozed_until_ms, decline_reason,
         duplicate_of, label, evidence_json, attestation_json, resolution_json,
         rubric_json, rubric_hash, rubric_version, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(bountyId, roomId, title, criteria, amountMillis, lane, verifier, null, "proposed", this.nowMs(),
          deadlineMs, null, null, null, null, null, null, null, null, null, null,
          rubricJson, rubricHash, 1, at, at);
      this.db.prepare(`INSERT INTO bounty_rubric_versions
        (room_id, bounty_id, version, rubric_hash, rubric_json, pinned_at, pinned_by)
        VALUES (?,?,?,?,?,?,?)`).run(roomId, bountyId, 1, rubricHash, rubricJson, at, lane);
      // The poster watches their own bounty from proposal time; fan-out to
      // watchers is suppressed until funded (published).
      this._addWatcher(roomId, bountyId, lane, at);
      const event = this._event(roomId, "bounty.proposed",
        { bountyId, actor: act, before: null, after: "proposed",
          data: { amount, title, rubricVersion: 1, rubricHash } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "propose", bountyId, at, actor: act, event } };
    });
  }

  // Slice 6: re-pin the rubric (v+1). Poster-only, and only while PROPOSED —
  // funding pins the rubric for the rest of the lifecycle, so every
  // acceptance citation and every arbiter re-check names the version that
  // governed the work. Every version is preserved in
  // bounty_rubric_versions.
  updateRubric(roomId, bountyId, { poster, rubric, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const { bounty, lane } = this._triageBounty(roomId, bountyId, poster);
      const act = this._actorFor(roomId, actor, lane);
      const pinned = canonicalRubric(rubric);
      const rubricHash = rubricHashOf(pinned), rubricJson = JSON.stringify(pinned);
      const version = (bounty.rubric?.version ?? 0) + 1;
      check(rubricHash !== bounty.rubric?.hash, "invalid_input", "the rubric is unchanged");
      bounty.rubric = Object.freeze({ version, hash: rubricHash, criteria: pinned });
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      this.db.prepare(`INSERT INTO bounty_rubric_versions
        (room_id, bounty_id, version, rubric_hash, rubric_json, pinned_at, pinned_by)
        VALUES (?,?,?,?,?,?,?)`).run(roomId, bountyId, version, rubricHash, rubricJson, at, lane);
      const event = this._event(roomId, "bounty.rubric-updated",
        { bountyId, actor: act, before: "proposed", after: "proposed", data: { rubricVersion: version, rubricHash } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "rubric-update", bountyId, rubricVersion: version, rubricHash, at, actor: act, event } };
    });
  }

  // Read one pinned rubric version (for arbiter re-checks). Defaults to the
  // current pin.
  getRubricVersion(roomId, bountyId, version = null) {
    return this.store.readTransaction(() => {
      this._ensure();
      const row = version === null || version === undefined
        ? this.db.prepare(`SELECT version, rubric_hash, rubric_json FROM bounty_rubric_versions
            WHERE room_id=? AND bounty_id=? ORDER BY version DESC LIMIT 1`).get(roomId, bountyId)
        : this.db.prepare(`SELECT version, rubric_hash, rubric_json FROM bounty_rubric_versions
            WHERE room_id=? AND bounty_id=? AND version=?`).get(roomId, bountyId, version);
      if (!row) fail(version === null || version === undefined ? "unknown_bounty" : "unknown_rubric_version",
        version === null || version === undefined ? `unknown bounty "${bountyId}"` : `bounty ${bountyId} has no rubric v${version}`);
      return Object.freeze({ bountyId, version: row.version, hash: row.rubric_hash,
        criteria: Object.freeze(JSON.parse(row.rubric_json)) });
    });
  }

  // Triage decision quartet — poster-only in slice 1 (their budget, their intake).
  _triageBounty(roomId, bountyId, triager, needState = "proposed") {
    const lane = this._requireLane(roomId, triager, "poster");
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
      const act = this._actorFor(roomId, actor, lane);
      this._requirePayable(roomId, lane, bounty.amountMillis, "fund");
      const at = isoNow(this.nowMs());
      const lotId = newId("lot_");
      // Finality track starts here: the intake lock (proposed -> funded).
      this._requireFinalityMove(bounty, "escrow-lock");
      const movement = this._move({ roomId, at, from: { account: lane, state: "payable" }, to: { account: lane, state: "locked" },
        amountMillis: bounty.amountMillis, kind: "escrow-lock", bountyId, lotId,
        memo: `escrow for bounty ${bountyId}`, actor: act,
        receipt: { type: "escrow-locked", payload: { fromAccount: lane, fromLotState: "payable" } } });
      this._transition(bounty, "funded");
      this._saveBounty(bounty);
      const event = this._event(roomId, "bounty.funded",
        { bountyId, actor: act, before: "proposed", after: "funded", data: { amount: toCredits(bounty.amountMillis) } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "fund", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event,
          ...this._signed(movement) } };
    });
  }

  declineBounty(roomId, bountyId, { decliner, reason, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const { bounty, lane } = this._triageBounty(roomId, bountyId, decliner);
      const act = this._actorFor(roomId, actor, lane);
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
      const act = this._actorFor(roomId, actor, lane);
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
      const act = this._actorFor(roomId, actor, lane);
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

  // --- slice 8: graduated anti-flake ladder -------------------------------------
  // Flake strikes decay (always a way back); the rung escalates
  // forfeit -> 2x bond -> cooldown. Derived on read from the append-only
  // bounty_flakes table; every step is journaled as a bounty_events row.
  _flakeStrikes(roomId, lane, now) {
    return this.db.prepare(`SELECT struck_at_ms FROM bounty_flakes
      WHERE room_id=? AND lane=? AND struck_at_ms > ? ORDER BY struck_at_ms DESC`)
      .all(roomId, lane, now - FLAKE_DECAY_MS).map(r => r.struck_at_ms);
  }

  // The lane's ladder position: { strikes, rung, bondMultiplier,
  // cooldownUntilMs }. rung 0 = clean, 1 = forfeit-on-flake, 2 = double
  // bond, 3+ = cooldown. Pure read — the escalation is deterministic.
  _flakeState(roomId, lane) {
    const now = this.nowMs();
    const strikes = this._flakeStrikes(roomId, lane, now);
    const rung = Math.min(strikes.length, FLAKE_COOLDOWN_RUNG);
    const rawCooldown = rung >= FLAKE_COOLDOWN_RUNG && strikes.length > 0
      ? strikes[0] + FLAKE_COOLDOWN_MS : null;
    return {
      strikes: strikes.length, rung,
      bondMultiplier: rung >= 2 ? FLAKE_BOND_MULTIPLIER : 1,
      cooldownUntilMs: rawCooldown !== null && now < rawCooldown ? rawCooldown : null,
    };
  }

  // Record one flake strike (timeout without submitting, or work judged bad
  // on an upheld dispute) and journal the ladder step. Returns the lane's
  // new ladder position.
  _recordFlake(roomId, lane, bountyId, reason) {
    const now = this.nowMs();
    const rung = Math.min(this._flakeStrikes(roomId, lane, now).length + 1, FLAKE_COOLDOWN_RUNG);
    const flakeId = newId("flk_");
    this.db.prepare(`INSERT INTO bounty_flakes (flake_id, room_id, lane, bounty_id, struck_at_ms, reason, rung)
      VALUES (?,?,?,?,?,?,?)`).run(flakeId, roomId, lane, bountyId, now, reason, rung);
    const state = this._flakeState(roomId, lane);
    const event = this._event(roomId, "flake.recorded",
      { bountyId, actor: RULE_ACTOR,
        data: { lane, reason, strikes: state.strikes, rung: state.rung,
          bondMultiplier: state.bondMultiplier,
          cooldownUntil: state.cooldownUntilMs === null ? null : new Date(state.cooldownUntilMs).toISOString() } });
    return { ...state, event };
  }

  // Journal decay and cooldown-end transitions. Decay is derived on read
  // (expired strikes stop counting immediately), but the transition itself
  // is journaled lazily the first time a write path observes it — there is
  // no keeper for the ladder, so claim time is the deterministic point of
  // observation. Each transition journals exactly once per strike row.
  _journalDecay(roomId, lane) {
    const now = this.nowMs();
    const ended = this.db.prepare(`SELECT rowid, struck_at_ms FROM bounty_flakes
      WHERE room_id=? AND lane=? AND rung >= ? AND struck_at_ms + ? <= ? AND cooldown_end_journaled=0`)
      .all(roomId, lane, FLAKE_COOLDOWN_RUNG, FLAKE_COOLDOWN_MS, now);
    for (const row of ended) {
      this.db.prepare(`UPDATE bounty_flakes SET cooldown_end_journaled=1 WHERE rowid=?`).run(row.rowid);
      this._event(roomId, "flake.cooldown-ended",
        { actor: RULE_ACTOR,
          data: { lane, cooldownUntil: new Date(row.struck_at_ms + FLAKE_COOLDOWN_MS).toISOString() } });
    }
    const decayed = this.db.prepare(`SELECT rowid FROM bounty_flakes
      WHERE room_id=? AND lane=? AND struck_at_ms <= ? AND decayed_journaled=0`)
      .all(roomId, lane, now - FLAKE_DECAY_MS);
    if (decayed.length > 0) {
      const ids = decayed.map(r => r.rowid);
      this.db.prepare(`UPDATE bounty_flakes SET decayed_journaled=1 WHERE rowid IN (${ids.map(() => "?").join(",")})`).run(...ids);
      this._event(roomId, "flake.decayed",
        { actor: RULE_ACTOR, data: { lane, strikesDecayed: ids.length } });
    }
  }

  // --- claim / submit / accept --------------------------------------------------------
  claimBounty(roomId, bountyId, { claimant, actor } = {}) {
    this._ensure();
    const lane = this._requireLane(roomId, claimant, "claimant");
    // Slice 4: the reputation claim gate runs BEFORE the write transaction.
    // The denial is the room's one automated adverse move, so it produces a
    // review packet for humans/arbiters — written in its own transaction so
    // the packet survives the claim's rollback (nesting a transaction inside
    // the claim's write transaction is not guaranteed). Bands gate claim
    // eligibility only: scores never touch payout amounts and never ban —
    // decay always offers a way back.
    const amountMillis = this.store.readTransaction(() => {
      this._ensure();
      const row = this.db.prepare(`SELECT amount_millis FROM bounty_records WHERE room_id=? AND bounty_id=?`)
        .get(roomId, bountyId) ?? fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      return row.amount_millis;
    });
    const eligibility = claimEligibility(this, roomId, lane, amountMillis);
    if (!eligibility.allowed) {
      this.store.transaction(() => {
        this._ensure();
        this._storeReputationPacket(roomId, lane, bountyId, eligibility);
      });
      fail("reputation_probation", `probation reputation band: may only claim bounties up to ${PROBATION_MAX_CLAIM_CREDITS} credits`);
    }
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const act = this._actorFor(roomId, actor, lane);
      const bounty = this._mutable(this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId)
        ?? fail("unknown_bounty", `unknown bounty "${bountyId}"`));
      check(bounty.state === "funded" || bounty.state === "claimed", "invalid_state",
        `bounty is ${bounty.state}, not open for claims — only funded bounties are claimable`);
      if (bounty.state === "claimed") fail("already_claimed", "this bounty is already claimed");
      check(this.nowMs() < bounty.deadlineMs, "invalid_state", "the claim window closed at the deadline");
      // Slice 8: graduated anti-flake ladder. Rung 3+ lanes sit out a
      // cooldown; rung 2+ lanes post a double bond. The bond is forfeited
      // (not returned) on the next flake — see _timeoutRefund.
      // Decay/cooldown-end transitions journal lazily here (the
      // deterministic observation point — there is no ladder keeper).
      this._journalDecay(roomId, lane);
      const flake = this._flakeState(roomId, lane);
      if (flake.cooldownUntilMs !== null)
        fail("claim_cooldown", `anti-flake cooldown: no new claims until ${new Date(flake.cooldownUntilMs).toISOString()}`);
      const bondMillis = CLAIM_BOND_MILLIS * flake.bondMultiplier;
      this._requirePayable(roomId, lane, bondMillis, "claim bond");
      const at = isoNow(this.nowMs());
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: lane, state: "payable" }, to: { account: lane, state: "locked" },
        amountMillis: bondMillis, kind: "bond-lock", bountyId, lotId,
        memo: `anti-flake claim bond for ${bountyId}${flake.bondMultiplier > 1 ? ` (${flake.bondMultiplier}x ladder)` : ""}`, actor: act,
        receipt: { type: "bond-locked", payload: { bondKind: "claim", fromAccount: lane } } });
      bounty.claimant = lane;
      this._transition(bounty, "claimed");
      this._saveBounty(bounty);
      const event = this._event(roomId, "bounty.claimed",
        { bountyId, actor: act, before: "funded", after: "claimed",
          data: { bond: toCredits(bondMillis), bondMultiplier: flake.bondMultiplier, flakeRung: flake.rung } });
      return { bounty: this._getBounty(roomId, bountyId),
        receipt: { kind: "bond-lock", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event,
          ...this._signed(movement) } };
    });
  }

  submitWork(roomId, bountyId, { claimant, evidence, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = this._requireLane(roomId, claimant, "claimant");
      const act = this._actorFor(roomId, actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(bounty.state === "claimed", "invalid_state", `bounty is ${bounty.state}, not awaiting submission`);
      check(bounty.claimant === lane, "not_authorized", "only the claimant may submit");
      check(this.nowMs() < bounty.deadlineMs, "invalid_state", "the submission deadline passed");
      const receipt = this._evidenceOf(evidence, lane);
      // Acceptance track: the work enters review, evidence-cited.
      this._acceptanceTransition(bounty, "submitted", { evidence: receipt });
      bounty.evidence = receipt;
      // Slice 10: the normalized submission fingerprint, pinned before the
      // save so correlation reads the stored value.
      bounty.submissionHash = submissionHashOf(receipt);
      this._transition(bounty, "submitted");
      this._saveBounty(bounty);
      const at = isoNow(this.nowMs());
      const event = this._event(roomId, "bounty.submitted",
        { bountyId, actor: act, before: "claimed", after: "submitted", data: { evidenceUrl: receipt.evidenceUrl } });
      // Slice 10: claim-graph correlation -> review packet; above-threshold
      // clusters -> sybil flags for the arbiter review queue. Review-only:
      // packets and flags never change bounty state, balances, bonds, or
      // reputation — no auto-ban, no auto-slash.
      const { packet, flags } = this._analyzeSubmissionCorrelation(roomId, bounty, bounty.submissionHash, receipt);
      return { bounty: this._getBounty(roomId, bountyId), packet, flags,
        receipt: { kind: "submit", bountyId, evidence: receipt, at, actor: act, event } };
    });
  }

  // --- slice 10: claim-graph correlation -> arbiter review packets -----------
  // Deterministic, room-scoped signals:
  //   - duplicate-submission: another bounty carries the same fingerprint
  //     (identical canonicalized evidence).
  //   - repeat-claimant-poster: this claimant already claimed from this
  //     poster before (a repeat pairing — productive lane or collusion,
  //     for a human to decide).
  //   - copy-paste: >= SYBIL_COPY_PASTE_MIN_LANES distinct lanes submitted
  //     the byte-identical normalized fingerprint (copy-paste / sockpuppet
  //     ring). The room lifecycle admits one submission per bounty, so the
  //     distinct-lane form is the operational reading of "supposedly
  //     independent lanes, identical work".
  //   - claim-graph: another lane's submissions carry this fingerprint on
  //     >= SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES distinct bounties (a lane pair
  //     sharing submitters/evidence fingerprints across bounties).
  // Any signal stores one review packet; the copy-paste / claim-graph
  // signals additionally raise a sybil flag — one per signal — for the
  // arbiter review queue. REVIEW-ONLY: packets and flags are stored and
  // journaled; nothing else moves — no auto-ban, no auto-slash, no
  // balance/bond/reputation change.
  _analyzeSubmissionCorrelation(roomId, bounty, fingerprint, evidence) {
    const signals = [];
    const matched = new Map(); // bountyId -> matched bounty summary
    const noteMatch = row => {
      if (row.bounty_id === bounty.bountyId || matched.has(row.bounty_id)) return;
      matched.set(row.bounty_id, {
        bountyId: row.bounty_id, claimant: row.claimant, poster: row.poster,
        verifier: row.verifier, state: row.state, submissionHash: row.submission_hash,
        submittedAt: new Date(row.state_changed_ms).toISOString(),
      });
    };
    // Every submission carrying this fingerprint (the current one included):
    // the spec thresholds read off this set.
    const shared = this.db.prepare(`SELECT bounty_id, claimant, poster, verifier, state,
        submission_hash, state_changed_ms FROM bounty_records
      WHERE room_id=? AND submission_hash=?`).all(roomId, fingerprint);
    const other = shared.filter(r => r.bounty_id !== bounty.bountyId);
    const toMember = r => ({ bountyId: r.bounty_id, lane: r.claimant,
      submittedAt: new Date(r.state_changed_ms).toISOString() });
    for (const row of other) noteMatch(row);
    if (other.length > 0)
      signals.push({ type: "duplicate-submission",
        detail: `${other.length} other submission(s) carry the identical fingerprint`,
        matchedBountyIds: other.map(r => r.bounty_id) });
    const repeats = this.db.prepare(`SELECT * FROM bounty_records
      WHERE room_id=? AND claimant=? AND poster=? AND bounty_id<>? AND claimant IS NOT NULL`)
      .all(roomId, bounty.claimant, bounty.poster, bounty.bountyId);
    for (const row of repeats) noteMatch(row);
    if (repeats.length > 0)
      signals.push({ type: "repeat-claimant-poster",
        detail: `claimant ${bounty.claimant} previously claimed ${repeats.length} bounty/bounties from poster ${bounty.poster}`,
        matchedBountyIds: repeats.map(r => r.bounty_id) });
    // Spec thresholds (integration map #10): named constants, deterministic.
    const specSignals = [];
    const lanes = new Set(shared.map(r => r.claimant).filter(Boolean));
    if (lanes.size >= SYBIL_COPY_PASTE_MIN_LANES)
      specSignals.push({ type: "copy-paste",
        detail: `${lanes.size} distinct lanes submitted the byte-identical normalized fingerprint`,
        matchedBountyIds: shared.map(r => r.bounty_id),
        lanes: [...lanes].sort(), members: shared.map(toMember) });
    const byLane = new Map(); // other lane -> its rows with this fingerprint
    for (const row of other) {
      if (!row.claimant || row.claimant === bounty.claimant) continue;
      const list = byLane.get(row.claimant) ?? [];
      if (!list.some(r => r.bounty_id === row.bounty_id)) list.push(row);
      byLane.set(row.claimant, list);
    }
    for (const [lane, rows] of byLane)
      if (rows.length >= SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES)
        specSignals.push({ type: "claim-graph",
          detail: `lane ${lane} shares the identical fingerprint on ${rows.length} distinct bounties with ${bounty.claimant}`,
          matchedBountyIds: [bounty.bountyId, ...rows.map(r => r.bounty_id)],
          lanes: [bounty.claimant, lane].sort(),
          members: [toMember(shared.find(r => r.bounty_id === bounty.bountyId)), ...rows.map(toMember)] });
    for (const s of specSignals) signals.push(s);
    if (signals.length === 0) return { packet: null, flags: [] };
    // Claim graph: lanes as nodes (poster/claimant/verifier roles), the
    // claim/post/verify relationships as edges, over this submission and
    // every matched one.
    const nodes = new Map(), edges = [];
    const touch = (lane, roles) => {
      if (lane === null || lane === undefined) return;
      const n = nodes.get(lane) ?? { lane, roles: [] };
      for (const role of roles) if (!n.roles.includes(role)) n.roles.push(role);
      nodes.set(lane, n);
    };
    const link = b => {
      touch(b.poster, ["poster"]); touch(b.claimant, ["claimant"]); touch(b.verifier, ["verifier"]);
      edges.push({ from: b.claimant, to: b.poster, kind: "claimed-from", bountyId: b.bountyId });
      edges.push({ from: b.poster, to: b.claimant, kind: "posted-for", bountyId: b.bountyId });
      if (b.verifier) edges.push({ from: b.verifier, to: b.claimant, kind: "verifies", bountyId: b.bountyId });
    };
    link(bounty);
    for (const m of matched.values()) link(m);
    const frozen = value => deepFreeze(JSON.parse(JSON.stringify(value)));
    const packet = {
      packetId: newId("rpkt_"), roomId, createdAt: isoNow(this.nowMs()),
      bountyId: bounty.bountyId, submissionHash: fingerprint,
      signals: frozen(signals),
      matchedBounties: frozen([...matched.values()]),
      graph: frozen({ nodes: [...nodes.values()], edges }),
      evidence: frozen({ ...evidence }),
    };
    this.db.prepare(`INSERT INTO bounty_review_packets
      (room_id, packet_id, created_at, bounty_id, submission_hash,
       signals_json, matched_bounties_json, graph_json, evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(roomId, packet.packetId, packet.createdAt, packet.bountyId, fingerprint,
        JSON.stringify(packet.signals), JSON.stringify(packet.matchedBounties),
        JSON.stringify(packet.graph), JSON.stringify(packet.evidence));
    this._event(roomId, "review.packet-created",
      { bountyId: bounty.bountyId, actor: RULE_ACTOR,
        data: { packetId: packet.packetId, submissionHash: fingerprint,
          signalTypes: signals.map(s => s.type), matchedBountyIds: [...matched.keys()] } });
    // Above-threshold clusters -> one sybil flag per spec signal, for the
    // arbiter review queue. Review-only: the flag is stored and journaled;
    // bounty state, balances, bonds, and reputation are untouched.
    const flags = specSignals.map(s => this._flagSybilCluster(roomId, bounty, fingerprint, s, packet));
    return { packet: deepFreeze(packet), flags };
  }

  // Slice 10: raise one sybil flag per above-threshold cluster signal. The
  // flag is a review-queue record — open until an arbiter dismisses (honest
  // coincidence) or confirms it. It never touches bounty state, balances,
  // bonds, or reputation.
  _flagSybilCluster(roomId, bounty, fingerprint, signal, packet) {
    const flagId = newId("sybf_"), clusterId = newId("sycl_");
    const createdAt = isoNow(this.nowMs());
    const memberLanes = [...(signal.lanes ?? [])];
    const memberBounties = [...(signal.members ?? [])];
    this.db.prepare(`INSERT INTO bounty_sybil_flags
      (room_id, flag_id, cluster_id, signal, status, created_at, submission_hash,
       member_lanes_json, member_bounties_json, evidence_packet_json)
      VALUES (?,?,?,?, 'open',?,?,?,?,?)`)
      .run(roomId, flagId, clusterId, signal.type, createdAt, fingerprint,
        JSON.stringify(memberLanes), JSON.stringify(memberBounties), JSON.stringify(packet));
    this._event(roomId, "sybil.flag-created",
      { bountyId: bounty.bountyId, actor: RULE_ACTOR,
        data: { flagId, clusterId, signal: signal.type, submissionHash: fingerprint,
          memberLanes, memberBountyIds: memberBounties.map(m => m.bountyId), packetId: packet.packetId } });
    return Object.freeze({
      flagId, clusterId, roomId, signal: signal.type, status: "open",
      createdAt, resolvedAt: null, resolvedBy: null, resolutionReason: null,
      submissionHash: fingerprint,
      memberLanes: Object.freeze(memberLanes),
      memberBounties: Object.freeze(memberBounties.map(m => Object.freeze({ ...m }))),
      evidencePacket: packet,
    });
  }

  _flagOf(row) {
    return Object.freeze({
      flagId: row.flag_id, clusterId: row.cluster_id, roomId: row.room_id,
      signal: row.signal, status: row.status,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by, resolutionReason: row.resolution_reason,
      submissionHash: row.submission_hash,
      memberLanes: Object.freeze(JSON.parse(row.member_lanes_json)),
      memberBounties: Object.freeze(JSON.parse(row.member_bounties_json).map(m => Object.freeze({ ...m }))),
      evidencePacket: deepFreeze(JSON.parse(row.evidence_packet_json)),
    });
  }

  // Slice 10: arbiter inspection of sybil flags — the review queue.
  // Room-scoped read; ?status= filters to open / dismissed / confirmed.
  getSybilFlags(roomId, { status = null } = {}) {
    return this.store.readTransaction(() => {
      this._ensure();
      if (status !== null) check(["open", "dismissed", "confirmed"].includes(status),
        "invalid_input", "status must be one of open, dismissed, confirmed");
      const rows = status === null
        ? this.db.prepare(`SELECT * FROM bounty_sybil_flags WHERE room_id=? ORDER BY created_at`).all(roomId)
        : this.db.prepare(`SELECT * FROM bounty_sybil_flags WHERE room_id=? AND status=? ORDER BY created_at`)
          .all(roomId, status);
      return rows.map(row => this._flagOf(row));
    });
  }

  // Slice 10: arbiter resolution of a sybil flag — dismissed (honest
  // coincidence: the same template, the same trivial task) or confirmed
  // (the arbiter agrees the cluster is correlated). A reason is required
  // either way. REVIEW-ONLY: resolution records the verdict; it never
  // moves bounty state, balances, bonds, or reputation — no auto-ban,
  // no auto-slash.
  resolveSybilFlag(roomId, flagId, { resolution, reason, resolver } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      check(resolution === "dismissed" || resolution === "confirmed", "invalid_input",
        `resolution must be "dismissed" or "confirmed"`);
      check(typeof reason === "string" && reason.trim().length >= 1 && reason.length <= 500, "invalid_input",
        "resolution reason is required (1..500 characters)");
      const row = this.db.prepare(`SELECT * FROM bounty_sybil_flags WHERE room_id=? AND flag_id=?`)
        .get(roomId, flagId);
      if (!row) fail("unknown_flag", `unknown sybil flag "${flagId}"`);
      check(row.status === "open", "invalid_state", `flag is ${row.status}, not open`);
      const by = this._requireLane(roomId, resolver, "resolver");
      const resolvedAt = isoNow(this.nowMs());
      const trimmed = reason.trim();
      this.db.prepare(`UPDATE bounty_sybil_flags SET status=?, resolved_at=?, resolved_by=?, resolution_reason=?
        WHERE room_id=? AND flag_id=?`).run(resolution, resolvedAt, by, trimmed, roomId, flagId);
      this._event(roomId, "sybil.flag-resolved",
        { actor: this._actorFor(roomId, null, by),
          data: { flagId, clusterId: row.cluster_id, signal: row.signal, resolution, reason: trimmed,
            // Slice #4: the reputation projector reads memberLanes to apply
            // sybil_confirmed to each member lane on "confirmed".
            memberLanes: JSON.parse(row.member_lanes_json) } });
      return this._flagOf({ ...row, status: resolution, resolved_at: resolvedAt,
        resolved_by: by, resolution_reason: trimmed });
    });
  }

  // Slice 4: probation-gate review packets. When the reputation claim gate
  // denies a lane, arbiters get a packet with the lane's decayed score,
  // band, and the signals that built it — review-only, immutable, never a
  // suspension or a ban. Deduped to one packet per lane per 24h so a lane
  // retrying a claim does not spam the queue.
  _storeReputationPacket(roomId, lane, bountyId, eligibility) {
    const cutoff = new Date(this.nowMs() - REPUTATION_PACKET_DEDUPE_MS).toISOString();
    const recent = this.db.prepare(`SELECT packet_id FROM bounty_reputation_packets
      WHERE room_id=? AND agent_id=? AND created_at >= ? LIMIT 1`).get(roomId, lane, cutoff);
    if (recent) return null;
    const summary = reputationSummary(this, roomId, lane, { nowMs: this.nowMs() });
    const packetId = newId("rpkt_"), createdAt = isoNow(this.nowMs());
    const signals = summary.signals.map(s => ({ seq: s.seq, at: s.at, type: s.type }));
    this.db.prepare(`INSERT INTO bounty_reputation_packets
      (room_id, packet_id, created_at, agent_id, band, score, max_claim_millis, bounty_id, signals_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(roomId, packetId, createdAt, lane, summary.band, summary.score,
        eligibility.maxClaimMillis ?? PROBATION_MAX_CLAIM_MILLIS, bountyId, JSON.stringify(signals));
    this._event(roomId, "reputation.packet-created",
      { bountyId, actor: RULE_ACTOR,
        data: { packetId, agentId: lane, band: summary.band, score: summary.score,
          maxClaimMillis: eligibility.maxClaimMillis ?? PROBATION_MAX_CLAIM_MILLIS } });
    return Object.freeze({ packetId, roomId, createdAt, agentId: lane, band: summary.band,
      score: summary.score, maxClaimMillis: eligibility.maxClaimMillis ?? PROBATION_MAX_CLAIM_MILLIS,
      bountyId, signals: Object.freeze(signals.map(s => Object.freeze({ ...s }))) });
  }

  // Slice 4: arbiter/human inspection of probation-gate review packets.
  // Room-scoped read; packets are immutable once created.
  getReputationPackets(roomId) {
    return this.store.readTransaction(() => {
      this._ensure();
      return this.db.prepare(`SELECT * FROM bounty_reputation_packets WHERE room_id=? ORDER BY created_at`)
        .all(roomId).map(row => Object.freeze({
          packetId: row.packet_id, roomId: row.room_id, createdAt: row.created_at,
          agentId: row.agent_id, band: row.band, score: row.score,
          maxClaimMillis: row.max_claim_millis, bountyId: row.bounty_id,
          signals: Object.freeze(JSON.parse(row.signals_json).map(s => Object.freeze({ ...s }))),
        }));
    });
  }

  // Slice 10: arbiter inspection of review packets. Room-scoped read;
  // packets are immutable once created.
  getReviewPackets(roomId, { bountyId = null } = {}) {
    return this.store.readTransaction(() => {
      this._ensure();
      const rows = bountyId === null
        ? this.db.prepare(`SELECT * FROM bounty_review_packets WHERE room_id=? ORDER BY created_at`).all(roomId)
        : this.db.prepare(`SELECT * FROM bounty_review_packets WHERE room_id=? AND bounty_id=? ORDER BY created_at`)
          .all(roomId, bountyId);
      return rows.map(row => Object.freeze({
        packetId: row.packet_id, roomId: row.room_id, createdAt: row.created_at,
        bountyId: row.bounty_id, submissionHash: row.submission_hash,
        signals: Object.freeze(JSON.parse(row.signals_json)),
        matchedBounties: Object.freeze(JSON.parse(row.matched_bounties_json)),
        graph: Object.freeze(JSON.parse(row.graph_json)),
        evidence: Object.freeze(JSON.parse(row.evidence_json)),
      }));
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
      const lane = this._requireLane(roomId, acceptor, "acceptor");
      const act = this._actorFor(roomId, actor, lane);
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
      // Slice 6: the acceptance verdict must cite every pinned rubric
      // criterion with a pass|fail verdict. The citations name the rubric
      // version that governed the work, so arbiters can re-check against it.
      const citations = citationsAgainstRubric(verifierAttestation.citations, bounty.rubric);
      const at = isoNow(this.nowMs());
      // Acceptance track: the verdict (evidence = the verifier attestation).
      // The finality move below (attribute) is gated on this verdict.
      this._acceptanceTransition(bounty, "accepted", { evidence: verifierAttestation });
      // 1. Record the approval event first — it is the gate.
      const approval = Object.freeze({ decision: "approved", by: act, at });
      const event = this._event(roomId, "bounty.accepted",
        { bountyId, actor: act, before: "submitted", after: "accepted",
          data: { approval: { decision: approval.decision, by: approval.by, at: approval.at },
            claimant: bounty.claimant, challengeEnds: new Date(this.nowMs() +
              (bounty.amountMillis < MILLIS_PER_CREDIT ? CHALLENGE_WINDOW_SMALL_MS : CHALLENGE_WINDOW_MS)).toISOString() } });
      // 2. The escrow release is the explicit consequence of the approval:
      // finality (attribute) requires the terminal acceptance verdict above.
      const lotId = newId("lot_");
      this._requireFinalityMove(bounty, "attribute");
      const movement = this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.claimant, state: "attributed" },
        amountMillis: bounty.amountMillis, kind: "attribute", bountyId, lotId,
        memo: `attributed to ${bounty.claimant} (approval ${event.seq})`, actor: act,
        receipt: { type: "attributed", payload: { claimant: bounty.claimant, eventSeq: String(event.seq) } } });
      bounty.attestation = Object.freeze({ ...verifierAttestation, citations,
        rubricVersion: bounty.rubric.version, rubricHash: bounty.rubric.hash,
        recordedBy: lane, recordedAt: at });
      this._transition(bounty, "accepted");
      bounty.challengeEndsMs = this.nowMs() + (bounty.amountMillis < MILLIS_PER_CREDIT ? CHALLENGE_WINDOW_SMALL_MS : CHALLENGE_WINDOW_MS);
      this._saveBounty(bounty);
      return { bounty: this._getBounty(roomId, bountyId),
        approval,
        attribution: { attributionId: lotId, bountyId, claimant: bounty.claimant, amount: toCredits(bounty.amountMillis), at },
        receipt: { kind: "attribute", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event,
          ...this._signed(movement) } };
    });
  }

  // --- free-miss settlement (docs/FREE-MISS-SETTLEMENT.md) -----------------------------
  // Failed or unverified work settles at zero; agents earn only on verified
  // completion. A settlement is recorded once per escrow lock: the monetary
  // legs move through bounty_journal with the existing kinds
  // (refund/payout/fee/bond-*), and the verdict itself is stamped onto
  // resolution_json plus an immutable bounty.settled event. "Settles at
  // zero" is the absence of a worker payout leg — the journal forbids
  // zero-amount rows by construction, so no zero-amount journal kind is
  // introduced.
  _settledVerdict(bounty) {
    return bounty.resolution?.settlement ?? null;
  }

  // Idempotent settlement record: stamps the verdict onto resolution_json
  // (preserving any existing resolution fields) and emits the immutable
  // bounty.settled event. A second call on an already-settled bounty is a
  // no-op returning the stored verdict with alreadySettled: true.
  _recordSettlement(bounty, { kind, workerMillis, refundMillis, reason, actor }) {
    check(SETTLEMENT_KINDS.has(kind), "invalid_input", `unknown settlement kind "${kind}"`);
    check(Number.isSafeInteger(workerMillis) && workerMillis >= 0, "invalid_amount",
      "settlement workerMillis must be a non-negative integer");
    check(Number.isSafeInteger(refundMillis) && refundMillis >= 0, "invalid_amount",
      "settlement refundMillis must be a non-negative integer");
    check(typeof reason === "string" && reason.length >= 1 && reason.length <= 500, "invalid_input",
      "settlement reason must be 1..500 characters");
    const existing = this._settledVerdict(bounty);
    if (existing) return { settlement: existing, event: null, alreadySettled: true };
    const at = isoNow(this.nowMs());
    const settlement = Object.freeze({ kind,
      workerMillis, workerCredits: toCredits(workerMillis),
      refundMillis, refundCredits: toCredits(refundMillis),
      reason, settledAt: at,
      settledBy: actor ? Object.freeze({ kind: actor.kind, id: actor.id }) : null });
    bounty.resolution = Object.freeze({ ...(bounty.resolution ?? {}), settlement });
    this._saveBounty(bounty);
    const event = this._event(bounty.roomId, "bounty.settled",
      { bountyId: bounty.bountyId, actor, data: { settlement: { ...settlement } } });
    return { settlement, event, alreadySettled: false };
  }

  // Reject submitted work (failed verification): a first-party verdict by
  // the poster or the designated verifier, distinct from the claimant. The
  // award — still locked with the poster, never attributed — refunds to the
  // poster in full with no fee; the worker settles at zero. "Work judged
  // bad" forfeits the claim bond to the pool and records a flake strike, the
  // same treatment as a dispute-upheld cancel. Idempotent: a second call
  // replays the stored verdict without new journal movement.
  rejectWork(roomId, bountyId, { rejector, reason, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = this._requireLane(roomId, rejector, "rejector");
      const act = this._actorFor(roomId, actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      // Authorization precedes the idempotency replay: only the poster or
      // the designated verifier (never the claimant) may settle a
      // rejection — including a replayed one.
      check(lane === bounty.poster || lane === bounty.verifier, "not_authorized",
        "only the poster or the designated verifier may reject");
      check(lane !== bounty.claimant, "not_authorized",
        "rejection must come from an identity distinct from the claimant");
      const settled = this._settledVerdict(bounty);
      if (settled) {
        return { bounty: this._getBounty(roomId, bountyId), settlement: settled, alreadySettled: true,
          receipt: { kind: "reject", bountyId, at: isoNow(this.nowMs()), actor: act, replayed: true } };
      }
      check(bounty.state === "submitted", "invalid_state", `bounty is ${bounty.state}, not awaiting verification`);
      check(typeof reason === "string" && reason.length >= 1 && reason.length <= 500, "invalid_input",
        "reason must be 1..500 characters");
      const at = isoNow(this.nowMs());
      // 1. Acceptance track: record the rejection verdict first (evidence = the reason).
      this._acceptanceTransition(bounty, "refunded",
        { evidence: { decision: "rejected", reason, rejectedBy: lane } });
      const rejectEvent = this._event(roomId, "bounty.rejected",
        { bountyId, actor: act, before: "submitted", after: "refunded", data: { reason, rejectedBy: lane } });
      // 2. Finality: the award was never attributed — refund the poster's
      // lock to the poster (never to the worker, never burned), no fee.
      this._requireFinalityMove(bounty, "refund");
      const lotId = newId("lot_");
      const movement = this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.poster, state: "payable" },
        amountMillis: bounty.amountMillis, kind: "refund", bountyId, lotId,
        memo: `free-miss: verification rejected by ${lane} — escrow returned to poster, worker settles 0`, actor: act,
        receipt: { type: "refund-issued", payload: { reason: "verification-rejected", refundTo: bounty.poster } } });
      // 3. Anti-flake: work judged bad forfeits the claim bond to the pool
      // and records a strike — the same treatment as a dispute-upheld cancel.
      const flake = this._recordFlake(roomId, bounty.claimant, bountyId, "verification-rejected");
      this._settleClaimBond(bounty, at, { forfeit: true, actor: act });
      this._transition(bounty, "refunded");
      bounty.resolution = Object.freeze({ kind: "rejected", rejectedBy: lane, rejectedAt: at, reason,
        flake: { strikes: flake.strikes, rung: flake.rung } });
      this._saveBounty(bounty);
      // 4. The immutable settlement record: failed, worker 0, escrow to poster.
      const { settlement } = this._recordSettlement(bounty, { kind: "failed", workerMillis: 0,
        refundMillis: bounty.amountMillis, reason, actor: act });
      return { bounty: this._getBounty(roomId, bountyId), settlement, alreadySettled: false, flake,
        receipt: { kind: "reject", bountyId, lotId, entries: [movement.debitEntryId, movement.creditEntryId],
          at, actor: act, event: rejectEvent, ...this._signed(movement) } };
    });
  }

  // Keeper settlement for submitted work the reviewer never verified: past
  // the deadline with no verdict, the work settles at zero and the escrow
  // returns to the poster. The worker submitted on time, so unlike a failed
  // verification the claim bond RETURNS and no flake strike is recorded —
  // the miss is on the reviewer, not the worker.
  _settleUnverified(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    this._requireFinalityMove(bounty, "refund");
    const lotId = newId("lot_");
    const movement = this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.poster, state: "payable" },
      amountMillis: bounty.amountMillis, kind: "refund", bountyId, lotId,
      memo: "free-miss: submitted work never verified — escrow returned to poster, worker settles 0", actor,
      receipt: { type: "refund-issued", payload: { reason: "unverified", refundTo: bounty.poster } } });
    this._settleClaimBond(bounty, at, { forfeit: false, actor });
    this._transition(bounty, "refunded");
    bounty.resolution = Object.freeze({ kind: "unverified", settledAt: at });
    this._saveBounty(bounty);
    this._event(roomId, "bounty.refunded",
      { bountyId, actor, before: "submitted", after: "refunded",
        data: { reason: "unverified", resolution: bounty.resolution, claimant: bounty.claimant } });
    this._recordSettlement(bounty, { kind: "unverified", workerMillis: 0,
      refundMillis: bounty.amountMillis, reason: "submitted work never received a verification verdict", actor });
    return movement.receipt ? [movement.receipt] : [];
  }

  // --- disputes -------------------------------------------------------------------
  _persistDispute(roomId, dispute) {
    const at = isoNow(this.nowMs());
    this.db.prepare(`INSERT INTO bounty_disputes (dispute_id, room_id, body, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(dispute_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`)
      .run(dispute.disputeId, roomId, JSON.stringify(dispute), at);
  }

  // Arbitrator cards are drawn from CURRENT room membership — never a
  // hardcoded lane list. A lane that leaves (or never joined) cannot be
  // seated; the dispute path then reports honestly-unavailable.
  _laneCards(roomId) {
    const members = this._members(roomId);
    if (members === null) {
      check(this._allowLegacyStringLanes === true, "internal",
        "bounty escrow requires a membership source (store.roomAuthority)");
      return GENESIS_LANES.map(lane => ({ lane, trust_level: "standard" }));
    }
    return Object.entries(members)
      .filter(([, m]) => m && m.active !== false && m.kind === "agent")
      .map(([id]) => ({ lane: canonicalLane(id), trust_level: "standard" }));
  }

  disputeBounty(roomId, bountyId, { challenger, bond, grounds, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const lane = this._requireLane(roomId, challenger, "challenger");
      const act = this._actorFor(roomId, actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(!bounty.disputeId, "dispute_exists", "this bounty already has a dispute");
      check(bounty.state === "submitted" || bounty.state === "accepted", "invalid_state", `bounty is ${bounty.state}, not disputable`);
      check(lane !== bounty.claimant, "not_authorized", "the claimant cannot dispute their own submission");
      check(typeof grounds === "string" && grounds.length >= 1 && grounds.length <= 2000, "invalid_input", "grounds must be 1..2000 characters");
      // Acceptance track: the challenge re-opens the verdict, evidence = grounds.
      this._acceptanceTransition(bounty, "disputed", { evidence: grounds });
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
        amountMillis: bondMillis, kind: "bond-lock", bountyId, lotId, memo: `dispute bond for ${disputeId}`, actor: act,
        receipt: { type: "bond-locked", payload: { bondKind: "dispute", fromAccount: lane } } });
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
            executor: { lane: bounty.claimant }, lanes: this._laneCards(roomId) });
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
        receipt: { kind: "bond-lock", bountyId, disputeId, lotId, entries: [movement.debitEntryId, movement.creditEntryId], at, actor: act, event,
          ...this._signed(movement) } };
    });
  }

  decideDispute(roomId, bountyId, { decider, outcome, reasonCodes, rubricCheck = null, actor } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const lane = this._requireLane(roomId, decider, "decider");
      const act = this._actorFor(roomId, actor, lane);
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      check(bounty.state === "disputed" && bounty.disputeId, "invalid_state", `bounty is ${bounty.state}, no open dispute`);
      const dispute = this._disputes.get(bounty.disputeId);
      check(dispute.decider === lane, "not_authorized", "only the seated decider may rule");
      // Slice 6: the arbiter may re-check the work against the pinned
      // rubric version. When supplied, the citations are validated against
      // the pin before the ruling lands, and recorded on the resolution.
      let checkedRubric = null;
      if (rubricCheck !== null && rubricCheck !== undefined) {
        const citations = citationsAgainstRubric(rubricCheck.citations ?? rubricCheck, bounty.rubric);
        checkedRubric = Object.freeze({ citations, rubricVersion: bounty.rubric.version,
          rubricHash: bounty.rubric.hash, by: lane });
      }
      // Attribute the inline settlement to the decider whose ruling caused it.
      this._settlementActor = act;
      this._settlementSigned = [];
      this._rubricCheckTransient = checkedRubric;
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
        this._rubricCheckTransient = null;
      }
      const signed = this._settlementSigned ?? [];
      this._settlementSigned = null;
      const settled = this._mutable(this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId));
      const event = this._event(roomId, "bounty.decided",
        { bountyId, actor: act, before: "disputed", after: settled.state,
          data: { disputeId: bounty.disputeId, outcome, resolution: settled.resolution,
            // Reputation projection reads these (server/bounty-reputation.mjs).
            claimant: bounty.claimant,
            challenger: this._disputeRecords.get(bounty.disputeId)?.raisedBy ?? null,
            // Slice #4 + #6: the verifier whose pinned-rubric acceptance is
            // on trial — an "upheld" outcome overturns it (acceptance_overturned).
            verifier: bounty.attestation?.recordedBy ?? null } });
      return { bounty: this._getBounty(roomId, bountyId), resolution: settled.resolution,
        receipt: { kind: "dispute-settle", bountyId, disputeId: bounty.disputeId, at: isoNow(this.nowMs()), actor: act, event, signed } };
    });
  }

  // The single consumer of the dispute machine's onDisputeFinalized: exactly
  // one settlement per dispute. The dispute machine hooks the acceptance
  // track only — its packet is always an acceptance verdict, asserted here
  // before anything settles. Disputes delay, never confiscate.
  _onDisputeFinalized(packet) {
    const { bountyId, outcome, terminal } = packet;
    check(packet.track === TRACK_ACCEPTANCE, "internal",
      "dispute finalized packet is not an acceptance-track verdict");
    const row = this.db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bountyId);
    if (!row || row.resolution_json) return; // unknown bounty, or already settled (recovery is via finalizeBounty)
    const bounty = this._mutable(row);
    if (bounty.state !== "disputed") return;
    const actor = this._settlementActor ?? RULE_ACTOR;
    this._settlementSigned = this._settleDispute(bounty, { outcome, terminal,
      reasonCodes: packet.reasonCodes ?? [], bondSnapshot: packet.bondSnapshot,
      forfeitedBond: packet.forfeitedBond, actor }) ?? [];
  }

  _settleDispute(bounty, { outcome, terminal, reasonCodes = [], bondSnapshot, forfeitedBond, actor }) {
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
    const signed = [];
    const collect = movement => { if (movement.receipt) signed.push(movement.receipt); };
    let splitWorkerMillis = 0, splitRefundMillis = 0; // free-miss record inputs, assigned in the split branch

    // Phase 1 — acceptance track: record the verdict first (evidence = the
    // dispute resolution). Finality stays frozen until this lands.
    const verdictTo = settleKind === "cancel" ? "refunded" : "approved";
    this._acceptanceTransition(bounty, verdictTo,
      { evidence: { outcome, reasonCodes, terminal, disputeId: bounty.disputeId } });

    // Phase 2 — finality track: the settlement's own award movements, gated
    // on the recorded verdict. The freeze is lifted only for this bounty,
    // only inside this settlement.
    this._disputeSettling = bountyId;
    try {
      if (settleKind === "cancel") {
        // CANCEL: full refund to the poster, challenger's bond returned (they
        // were right), no fee. The claimant's anti-flake bond is slashed to the
        // pool — upheld means the work was judged bad, which is what the bond
        // prices. (The award itself is never confiscated: disputes delay, never
        // confiscate.)
        this._requireFinalityMove(bounty, "refund");
        collect(this._move({ roomId, at, from: awardFrom, to: { account: bounty.poster, state: "payable" },
          amountMillis: amount, kind: "refund", bountyId, lotId, memo: `dispute ${outcome}: refund`, actor,
          receipt: { type: "refund-issued", payload: { reason: "dispute-cancel", refundTo: bounty.poster } } }));
        if (typeof bondSnapshot === "number")
          this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: challenger, state: "payable" },
            amountMillis: bondSnapshot, kind: "bond-return", bountyId, lotId: newId("lot_"), memo: "dispute bond returned", actor });
        this._settleClaimBond(bounty, at, { forfeit: true, actor });
        // Slice 8: work judged bad is a flake strike — the bond forfeit
        // above is the rung-1 consequence, journaled alongside.
        if (worker) this._recordFlake(roomId, worker, bountyId, "dispute-upheld");
      } else if (settleKind === "split") {
        // SPLIT: half the award vests with the worker (fee at sweep), half
        // refunds to the poster, bond returned.
        const workerHalf = Math.floor(amount / 2), posterHalf = amount - workerHalf;
        splitWorkerMillis = workerHalf; splitRefundMillis = posterHalf;
        if (awardFrom.state === "locked") {
          this._requireFinalityMove(bounty, "attribute");
          collect(this._move({ roomId, at, from: awardFrom, to: { account: worker, state: "attributed" },
            amountMillis: amount, kind: "attribute", bountyId, lotId, memo: "split: attribute before split", actor,
            receipt: { type: "attributed", payload: { claimant: worker } } }));
        }
        this._requireFinalityMove(bounty, "approve");
        this._move({ roomId, at, from: { account: worker, state: "attributed" }, to: { account: worker, state: "approved" },
          amountMillis: workerHalf, kind: "approve", bountyId, lotId, memo: "split: worker half vests", actor });
        this._requireFinalityMove(bounty, "refund");
        collect(this._move({ roomId, at, from: { account: worker, state: "attributed" }, to: { account: bounty.poster, state: "payable" },
          amountMillis: posterHalf, kind: "refund", bountyId, lotId, memo: "split: poster half refunds", actor,
          receipt: { type: "refund-issued", payload: { reason: "split", refundTo: bounty.poster } } }));
        if (typeof bondSnapshot === "number")
          this._move({ roomId, at, from: { account: challenger, state: "locked" }, to: { account: challenger, state: "payable" },
            amountMillis: bondSnapshot, kind: "bond-return", bountyId, lotId: newId("lot_"), memo: "dispute bond returned", actor });
      } else {
        // RELEASE: the award vests with the worker (swept at the epoch, 1% fee
        // then); the challenger's bond compensates the worker for the delay —
        // in full, no fee on penalty compensation. A forfeited bond (frivolous
        // ruling, withdrawn challenge) goes to the room pool instead.
        if (awardFrom.state === "locked") {
          this._requireFinalityMove(bounty, "attribute");
          collect(this._move({ roomId, at, from: awardFrom, to: { account: worker, state: "attributed" },
            amountMillis: amount, kind: "attribute", bountyId, lotId, memo: "release: attribute after dispute", actor,
            receipt: { type: "attributed", payload: { claimant: worker } } }));
        }
        this._requireFinalityMove(bounty, "approve");
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
      }
    } finally {
      this._disputeSettling = null;
    }
    this._transition(bounty, verdictTo);
    bounty.resolution = Object.freeze({ kind: settleKind, outcome, terminal,
      decidedAt: at, bondForfeited: forfeited,
      ...(this._rubricCheckTransient ? { rubricCheck: this._rubricCheckTransient } : {}) });
    this._saveBounty(bounty);
    // Free-miss settlement record: the dispute's own verdict is the
    // settlement verdict — cancel = failed (worker 0, escrow to poster),
    // split = partial (the one explicit exception), release =
    // verified-complete (the award vests with the worker).
    this._recordSettlement(bounty, {
      kind: settleKind === "cancel" ? "failed" : settleKind === "split" ? "partial" : "verified-complete",
      workerMillis: settleKind === "split" ? splitWorkerMillis : settleKind === "cancel" ? 0 : amount,
      refundMillis: settleKind === "split" ? splitRefundMillis : settleKind === "cancel" ? amount : 0,
      reason: `dispute ${outcome}: ${
        settleKind === "cancel" ? "work judged bad — escrow returned to poster, worker settles 0"
        : settleKind === "split" ? "half the award vests with the worker, half refunds to the poster"
        : "award vests with the worker"}`,
      actor });
    this._event(roomId, settleKind === "cancel" ? "bounty.refunded" : "bounty.released",
      { bountyId, actor, before: "disputed", after: bounty.state, data: { resolution: bounty.resolution } });
    return signed;
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
  // The claim bond is an anti-flake lock, not a fee. Slice 8: the ladder
  // forfeits the bond to the pool on a flake (timeout without submitting)
  // and returns it when the submission went through review and the award
  // refunded through no fault of the claimant. The settlement moves the
  // ACTUAL locked amount — rung 2+ claims locked a double bond, and that
  // doubled amount is what returns or forfeits. Defensive: a no-op when
  // the bond is not actually locked for this bounty.
  _settleClaimBond(bounty, at, { forfeit, actor }) {
    if (!bounty.claimant) return;
    const locked = this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal
      WHERE room_id=? AND bounty_id=? AND account_id=? AND lot_state='locked'`)
      .get(bounty.roomId, bounty.bountyId, bounty.claimant).t;
    if (locked <= 0) return;
    this._move({ roomId: bounty.roomId, at, from: { account: bounty.claimant, state: "locked" },
      to: forfeit ? { account: POOL_ACCOUNT, state: "payable" } : { account: bounty.claimant, state: "payable" },
      amountMillis: locked, kind: forfeit ? "bond-forfeit" : "bond-return",
      bountyId: bounty.bountyId, lotId: newId("lot_"), actor,
      memo: forfeit ? "claim bond forfeited to pool (anti-flake ladder)" : "claim bond returned" });
  }

  _timeoutRefund(bounty, at, actor) {
    const roomId = bounty.roomId, bountyId = bounty.bountyId;
    const lotId = newId("lot_");
    // Finality: the timeout refund needs no acceptance verdict — the work
    // never entered the acceptance track.
    this._requireFinalityMove(bounty, "refund");
    const movement = this._move({ roomId, at, from: { account: bounty.poster, state: "locked" }, to: { account: bounty.poster, state: "payable" },
      amountMillis: bounty.amountMillis, kind: "refund", bountyId, lotId,
      memo: "timeout: award refunded in full, no fee", actor,
      receipt: { type: "refund-issued", payload: { reason: "timeout", refundTo: bounty.poster } } });
    // Slice 8: no submission by the deadline is a flake. The strike is
    // journaled, the rung escalates (forfeit -> 2x bond -> cooldown), and
    // the bond is forfeited to the pool (ladder rung 1 consequence).
    const flake = bounty.claimant
      ? this._recordFlake(roomId, bounty.claimant, bountyId, "timeout-no-submit") : null;
    this._settleClaimBond(bounty, at, { forfeit: flake !== null, actor });
    this._transition(bounty, "refunded");
    bounty.resolution = Object.freeze({ kind: "timeout", refundedAt: at,
      flake: flake === null ? null : { strikes: flake.strikes, rung: flake.rung } });
    this._saveBounty(bounty);
    // Free-miss settlement record: unverified — the work never received a
    // verdict, so the worker settles at zero and the escrow returns to the
    // poster. (A timeout-no-submit flake strike, when recorded above, is the
    // anti-flake ladder's business; the settlement verdict stays unverified.)
    this._recordSettlement(bounty, { kind: "unverified", workerMillis: 0, refundMillis: bounty.amountMillis,
      reason: flake === null ? "timeout: work never completed — escrow returned to poster"
        : `timeout: no submission by the deadline — escrow returned to poster (flake rung ${flake.rung})`, actor });
    this._event(roomId, "bounty.refunded",
      { bountyId, actor, before: "claimed", after: "refunded",
        data: { reason: "timeout", resolution: bounty.resolution, claimant: bounty.claimant,
          flake: flake === null ? null : { strikes: flake.strikes, rung: flake.rung, bondMultiplier: flake.bondMultiplier } } });
    return movement.receipt ? [movement.receipt] : [];
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
    // Finality: vesting requires the terminal acceptance verdict — the
    // challenge window passed unchallenged on an accepted bounty.
    this._requireFinalityMove(bounty, "approve");
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
    // Finality: payout requires the bounty to sit in approved (vested).
    this._requireFinalityMove(bounty, "payout");
    const movement = this._move({ roomId, at, from: { account: bounty.claimant, state: "approved" }, to: { account: bounty.claimant, state: "payable" },
      amountMillis: earner, kind: "payout", bountyId, lotId, memo: `epoch payout (99% of ${toCredits(amount)})`, actor,
      receipt: { type: "payout-released", payload: { netAmountMillis: String(earner), feeAmountMillis: String(fee),
        grossAmountMillis: String(amount), paidTo: bounty.claimant, poolAccount: POOL_ACCOUNT } } });
    if (fee > 0) {
      this._requireFinalityMove(bounty, "fee");
      this._move({ roomId, at, from: { account: bounty.claimant, state: "approved" }, to: { account: POOL_ACCOUNT, state: "payable" },
        amountMillis: fee, kind: "fee", bountyId, lotId, memo: "1% room-pool fee on released payout", actor });
    }
    // The claim bond was an anti-flake lock, not a fee: it comes home now.
    this._settleClaimBond(bounty, at, { forfeit: false, actor });
    // Free-miss settlement record: verified-complete — the only settlement
    // that pays the worker (net of the 1% room-pool fee on released payout).
    this._recordSettlement(bounty, { kind: "verified-complete", workerMillis: earner, refundMillis: 0,
      reason: `verified work paid out: ${toCredits(earner)} to ${bounty.claimant}, ${toCredits(fee)} room-pool fee`, actor });
    this._transition(bounty, "paid");
    this._saveBounty(bounty);
    this._event(roomId, "bounty.paid",
      { bountyId, actor, before: "approved", after: "paid", data: { earner: bounty.claimant, paid: toCredits(earner), fee: toCredits(fee) } });
    return { paid: toCredits(earner), fee: toCredits(fee), signed: movement.receipt ? [movement.receipt] : [] };
  }

  // One mechanical pass over a single bounty; returns { action, signed } or null.
  _keeperPass(bounty, now, at) {
    const actor = RULE_ACTOR;
    if (bounty.state === "proposed" && now >= bounty.deadlineMs
        && (bounty.snoozedUntilMs === null || now >= bounty.snoozedUntilMs)) {
      this._expireUnfunded(bounty, at, actor); return { action: "expired-unfunded", signed: [] };
    }
    if (bounty.state === "accepted" && bounty.challengeEndsMs !== null && now >= bounty.challengeEndsMs) {
      this._approve(bounty, at, actor); return { action: "approved", signed: [] };
    }
    // Free-miss: submitted work the reviewer never verified settles at zero —
    // the escrow returns to the poster, the worker earns nothing.
    if (bounty.state === "submitted" && now >= bounty.deadlineMs) {
      const signed = this._settleUnverified(bounty, at, actor); return { action: "refunded", signed };
    }
    if ((bounty.state === "funded" || bounty.state === "claimed") && now >= bounty.deadlineMs) {
      const signed = this._timeoutRefund(bounty, at, actor); return { action: "refunded", signed };
    }
    if (bounty.state === "disputed" && bounty.disputeId && !bounty.resolution) {
      const dispute = this._disputes.get(bounty.disputeId);
      const terminal = dispute.state === "resolved" || dispute.state === "withdrawn";
      if (terminal) {
        // The onDisputeFinalized callback already ran inline; if the bounty
        // is still unsettled the handler must have thrown — retry now.
        const signed = this._settleDispute(bounty, { outcome: dispute.resolution?.outcome ?? null, terminal: dispute.state,
          reasonCodes: dispute.resolution?.reasonCodes ?? [],
          bondSnapshot: dispute.bondSnapshot, forfeitedBond: dispute.forfeitedBond, actor });
        return { action: bounty.state === "refunded" ? "refunded" : "released", signed };
      }
      if (bounty.disputeOpenedMs !== null && now - bounty.disputeOpenedMs > DISPUTE_TIMEOUT_MS) {
        // Unresolved > 14d: permissionless finalize defaults to RELEASE.
        const signed = this._settleDispute(bounty, { outcome: "timeout-default", terminal: "timeout",
          bondSnapshot: dispute.bondSnapshot, forfeitedBond: 0, actor });
        return { action: "released", signed };
      }
    }
    return null;
  }

  finalizeBounty(roomId, bountyId, { caller } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      const triggeredBy = caller === undefined ? null : this._requireLane(roomId, caller, "caller");
      const row = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(roomId, bountyId);
      if (!row) fail("unknown_bounty", `unknown bounty "${bountyId}"`);
      const bounty = this._mutable(row);
      const now = this.nowMs(), at = isoNow(now);
      const pass = this._keeperPass(bounty, now, at);
      check(pass !== null, "invalid_state", `bounty is ${bounty.state}: nothing to finalize`);
      return { bounty: this._getBounty(roomId, bountyId), action: pass.action,
        receipt: { kind: "finalize", bountyId, action: pass.action, at, actor: RULE_ACTOR, triggeredBy, signed: pass.signed } };
    });
  }

  closeEpoch(roomId, { caller } = {}) {
    return this.store.transaction(() => {
      this._ensure();
      this.ensureGenesis(roomId);
      const triggeredBy = caller === undefined ? null : this._requireLane(roomId, caller, "caller");
      const now = this.nowMs(), at = isoNow(now);
      const summary = { approved: [], swept: [], refunded: [], released: [], paid: [], expiredUnfunded: [] };
      const rows = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND state IN ('proposed','funded','claimed','accepted','disputed','approved') ORDER BY created_at").all(roomId);
      for (const row of rows) {
        const bounty = this._mutable(row);
        try {
          if (bounty.state === "approved") {
            const { paid, fee, signed } = this._sweep(bounty, at, RULE_ACTOR);
            summary.swept.push(bounty.bountyId); summary.paid.push({ bountyId: bounty.bountyId, paid, fee });
            if (signed.length) { summary.signedReceipts ??= {}; summary.signedReceipts[bounty.bountyId] = signed; }
          } else {
            const pass = this._keeperPass(bounty, now, at);
            const action = pass?.action ?? null;
            if (action === "approved") summary.approved.push(bounty.bountyId);
            else if (action === "refunded") summary.refunded.push(bounty.bountyId);
            else if (action === "released") summary.released.push(bounty.bountyId);
            else if (action === "expired-unfunded") summary.expiredUnfunded.push(bounty.bountyId);
            if (pass?.signed?.length) { summary.signedReceipts ??= {}; summary.signedReceipts[bounty.bountyId] = pass.signed; }
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
      const sender = this._requireLane(roomId, from, "sender");
      const recipient = this._requireRecipient(roomId, to);
      const act = this._actorFor(roomId, actor, sender);
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
  listBounties(roomId, { group = null, viewer = null } = {}) {
    return this.store.readTransaction(() => {
      this._ensure();
      if (group !== null) check(BOUNTY_GROUPS.includes(group), "invalid_input", `unknown bounty group "${group}"`);
      const rows = this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? ORDER BY created_at").all(roomId);
      // Slice 4: optional per-viewer routing visibility. When a viewer lane
      // is given, each bounty view carries the routing layer's band-derived
      // answer for that viewer ({ band, maxClaimMillis, claimable }).
      // Visibility only — bounties are never hidden, amounts never change,
      // and the claim gate remains the sole enforcement point.
      const routing = viewer === null || viewer === undefined ? null
        : routingVisibility(this, roomId, canonicalLane(viewer));
      return rows
        .map(row => {
          const view = this._viewBounty(row, roomId);
          if (routing === null) return view;
          return Object.freeze({ ...view,
            viewerRouting: Object.freeze({ band: routing.band, maxClaimMillis: routing.maxClaimMillis,
              claimable: routing.claimable(row.amount_millis) }) });
        })
        .filter(b => group === null || b.group === group);
    });
  }

  getBounty(roomId, bountyId) {
    return this.store.readTransaction(() => { this._ensure(); return this._getBounty(roomId, bountyId); });
  }

  // Work-graph metrics. Proposed bounties are outside the work graph and
  // outside metrics: they are excluded from every count and total here.
  // Raw bounty event stream for a room, in seq order. The reputation
  // projector (server/bounty-reputation.mjs) folds this; any future
  // consumer that needs the uninterpreted history reads here.
  // Deliberately transaction-free: a single SELECT is atomic on its own,
  // and the claim path calls this from inside a write transaction where
  // nesting another transaction is not guaranteed.
  listEvents(roomId, { sinceSeq = 0 } = {}) {
    this._ensure();
    check(Number.isInteger(sinceSeq) && sinceSeq >= 0, "invalid_input", "sinceSeq must be a non-negative integer");
    const rows = this.db.prepare(`SELECT seq, at, type, bounty_id AS bountyId,
        actor_kind AS actorKind, actor_id AS actorId,
        before_state AS beforeState, after_state AS afterState, track, data
      FROM bounty_events WHERE room_id=? AND seq > ? ORDER BY seq ASC`).all(roomId, sinceSeq);
    return rows.map(r => Object.freeze({ seq: r.seq, at: r.at, type: r.type, bountyId: r.bountyId,
      actor: r.actorKind === null && r.actorId === null ? null
        : Object.freeze({ kind: r.actorKind, id: r.actorId }),
      before: r.beforeState, after: r.afterState, track: r.track,
      data: JSON.parse(r.data) }));
  }

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
      // Slice 8: the graduated anti-flake ladder, derived from strikes
      // inside the decay window — the cooldown (rung 3+) is visible on the
      // identity card so lanes know when they may claim again.
      const flake = this._flakeState(roomId, lane);
      return Object.freeze({ identity: lane, ...byState,
        total: byState.payable + byState.locked + byState.attributed + byState.approved,
        flake: Object.freeze({ strikes: flake.strikes, rung: flake.rung,
          bondMultiplier: flake.bondMultiplier,
          cooldownUntil: flake.cooldownUntilMs === null ? null : new Date(flake.cooldownUntilMs).toISOString() }),
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
          signedReceiptIds: Object.freeze([...new Set(entries.map(e => e.receipt_id).filter(Boolean))]),
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
      for (const b of this.db.prepare("SELECT bounty_id, amount_millis, state, dispute_id, resolution_json FROM bounty_records WHERE room_id=?").all(roomId)) {
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
        } else if (b.state === "accepted" || (b.state === "disputed" && !b.dispute_id)) {
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
          // Mirror _append: the track element joins the core only when the
          // row carries one, so pre-track rows verify against their original
          // 12-element core.
          const coreParts = [e.prev_hash, e.entry_id, e.account_id, e.at, e.kind, e.bounty_id ?? "", e.lot_id ?? "",
            String(e.amount), e.lot_state, e.memo ?? "", e.actor_kind ?? "", e.actor_id ?? ""];
          if (e.track != null) coreParts.push(e.track);
          const core = coreParts.join("|");
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
