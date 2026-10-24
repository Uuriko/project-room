// Room-native spend grants: per-agent capability="spend" edges with caps
// denominated in cents, plus the charge-then-forward trust boundary for
// priced MCP tools.
//
// Design: ~/workspace/research_notes/spend-primitive-design-2026-10-04.md
// (§3a–§3c, MVP items 1–3 and 5). Cents-denominated, fully reversible:
// removing every priced tool from PRICED_MCP_TOOLS returns the room to
// exactly its previous behavior.
//
// The decisive property (stolen from x402): the tool is never invoked until
// payment has settled against the grant. Charge-then-forward:
//   1. unpriced tool → forwarded, free, unchanged
//   2. priced tool without grant headroom → honest 402-style refusal naming
//      the price (structured detail AND text); the tool is never called
//   3. priced tool with headroom → reserve → invoke → settle → receipt
// Invalid input is refused before payment (the MCP router validates args
// before dispatch); a failed or unconfirmed tool call is voided, never
// charged. A duplicate idempotent retry (duplicate: true) is voided too —
// the original call already paid.
//
// Composition (same shape as server/grants.mjs):
//   - tiers stay the coarse gate: t1_readonly can never hold a spend grant,
//     checked at issuance AND re-checked on every authorization
//   - guests can never hold spend grants (issuance refused outright)
//   - humans and the room owner are never charged
//   - per-agent grant nests UNDER the room-level spend allowance
//     (server/spend-allowance.mjs): effective bound = min(grant remaining,
//     room headroom) when an allowance is set
//   - a member holding no spend grant at all (no edge row — never issued)
//     authorizes against the room's member spend default (ruling 29b): a
//     lifetime floor per member, owner-set per room via
//     room.spend_default_set (src/events.js memberSpendDefaultCents), 25c
//     when unset, 0 restores the zero-grant refusal exactly. ANY edge —
//     live, revoked, or expired — supersedes the purse, so an owner's
//     grant action on a member is never silently undone by the default;
//     purse charges write the same spend_authorizations rows and nest
//     under the room allowance the same way
//   - fresh resolution per request: no cached caps; revocation bites on the
//     agent's next call
//   - SQLite-transaction serialization of check+reserve: cap races fail
//     closed even across processes; the room allowance is enforced
//     cumulatively the same way (in-flight room reservations narrow the
//     projection snapshot inside the same BEGIN IMMEDIATE)
//   - single-use grants admit at most one in-flight authorization: the
//     one-shot slot is claimed atomically in authorizeSpend
//   - replay-safe nonces: a re-presented (grant, nonce) never charges
//     twice — 'settled' returns its receipt, 'reserved' returns the live
//     authorization (crash recovery within the lease), only 'voided' stays
//     consumed; a re-presented nonce whose reservation was reaped past
//     its lease must retry with a fresh nonce (409 duplicate_nonce)
//   - reserves carry a lease: expires_at = created_at + RESERVE_LEASE_MS.
//     A process crash between reserve and settle/void can no longer
//     permanently consume grant cap or room allowance —
//     reapExpiredSpendAuthorizations voids authorizations orphaned past
//     the lease and releases their room reservations. It runs
//     opportunistically at the top of authorizeSpend's transaction, so
//     the cap math always sees live reservations; no separate reaper
//     process is needed (#1525). The settle paths enforce the lease in
//     the transition itself (#3268): a post-lease settle deterministically
//     records no charge whether or not the reaper has run yet — the row
//     stays 'reserved' for the reaper (or a void) to release, exactly as
//     a crashed caller's orphan does.
//
// Money is integer cents as TEXT (string-decimal, no floats, D12). Only the
// "cents" denomination exists in v1; "usdc" issuance is refused fail-closed.
// (#3305: the unit was always integer cents — the pre-rename label for this
// denomination was "credits", which collided with the bounty ledger's
// credit (1 credit = 1000 milli-credits). No conversion exists between the
// two units and none is implied by the rename; stored "credits" labels are
// converged to "cents" in ensureSpendGrantsSchema.)
//
// Tables are registered in server/writer-fence.mjs and the schema is ensured
// from the writer boot path next to ensureGrantsSchema. This module does not
// import server/store.mjs (store imports it); errors carry status and code
// like ServiceError and the router reads them as such.
import { randomUUID } from "node:crypto";
import { issueGrant, revokeGrant, resolveGrants, requireGrantManagement } from "./grants.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { getTier, DEFAULT_AUTONOMY_TIER } from "./autonomy-tiers.mjs";
import { spendAllowanceReport } from "./spend-allowance.mjs";
import { ownMember, spendPricingEnabled, memberSpendDefaultCents, MEMBER_SPEND_DEFAULT_CENTS, SPEND_ALLOWANCE_LIMITS, validId, EVENT_TYPES as T } from "../src/events.js";

export { MEMBER_SPEND_DEFAULT_CENTS };

export const SPEND_CAPABILITY = "spend";
export const SPEND_DENOMINATION = "cents";

// Priced MCP tools, integer cents per call. The price ALSO lives in each
// tool's public description ("[paid: room-cents] N cents per call") —
// the description is advertising, the runtime charge here is authoritative
// (the x402 doctrine). Removing a tool from this map un-prices it
// completely: no other code path charges.
export const PRICED_MCP_TOOLS = Object.freeze({
  // 1 MiB staged bytes: real storage cost per call.
  room_put_file: 5,
  // Bounty posting: creates downstream economic activity; the design's
  // named first candidate (OQ2).
  bounty_post: 10,
  // GitHub reads (head, mergeable, check rollup) per add: real external cost.
  add_land_item: 1,
});

export function priceForTool(name, state = null) {
  // The spend-pricing kill switch (room.spend_pricing_set): while the owner
  // has pricing disabled, every tool is unpriced — pre-gate behaviour, no
  // charges possible even with grants in existence. Absent state means
  // enabled. The one-arg form keeps the static catalog for allowlist
  // validation and the 422 "not a priced tool" checks.
  if (state !== null && !spendPricingEnabled(state)) return null;
  return typeof name === "string" && Object.hasOwn(PRICED_MCP_TOOLS, name)
    ? PRICED_MCP_TOOLS[name]
    : null;
}

export const SPEND_GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_grant_terms (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  denomination TEXT NOT NULL DEFAULT 'cents',
  cap_cents TEXT NOT NULL,
  per_tx_cap_cents TEXT NOT NULL,
  allowlist TEXT NULL,
  single_use INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS spend_authorizations (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  price_cents TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  settled_at INTEGER NULL,
  -- #1525: lease expiry on reserves. A reservation that is still
  -- 'reserved' past expires_at belongs to a caller that is gone
  -- (crashed between reserve and settle/void) and is voided by the
  -- reaper. Rows written before this fix backfill NULL; the reaper
  -- computes their deadline from created_at instead.
  expires_at INTEGER NULL,
  PRIMARY KEY (room_id, agent_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_spend_authorizations_agent
  ON spend_authorizations (room_id, agent_id, status);
-- Room-allowance reservations: the cumulative enforcement backstop for the
-- room-level spend allowance. authorizeSpend inserts one row per priced
-- call inside the same BEGIN IMMEDIATE as the grant reservation and
-- releases it on settle/void, so concurrent calls serialize against the
-- allowance instead of racing a static projection snapshot.
CREATE TABLE IF NOT EXISTS spend_room_reservations (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  amount_cents TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_spend_room_reservations_active
  ON spend_room_reservations (room_id, status);
`;

export function ensureSpendGrantsSchema(db) {
  db.exec(SPEND_GRANTS_SCHEMA);
  // #3305: pre-rename grant rows stored the denomination label "credits"
  // for what was always integer cents. Converge the LABEL only — no cap,
  // price, or authorization changes meaning. Idempotent: once converged
  // this matches zero rows.
  db.exec(`UPDATE spend_grant_terms SET denomination = 'cents' WHERE denomination = 'credits'`);
  // #1525: lease expiry on reserves — additive column, following the
  // codebase's column-migration pattern (agent-identities, credentials):
  // existing databases converge via ALTER TABLE, rows written before the
  // fix backfill NULL and the reaper reads their deadline from created_at.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('spend_authorizations') WHERE name='expires_at'`).get())
    db.exec("ALTER TABLE spend_authorizations ADD COLUMN expires_at INTEGER");
  // #3376/#3383: room reservations are per-agent state, keyed exactly like
  // the authorizations they back. The original (room_id, nonce) PK let two
  // agents collide on one nonce (raw constraint error) and let one agent's
  // settle/void release another's reservation. Rebuild pre-fix tables in
  // place, rows preserved; a fresh table already has the widened PK. The
  // rebuild follows the codebase's rename-aside pattern (share_links
  // _legacy_v34 and siblings): the old table is renamed away and the
  // canonical table name is recreated, so no transient table name ever
  // enters the DDL the application-table registry scans.
  const reservationsSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend_room_reservations'`).get()?.sql ?? "";
  if (reservationsSql && !/PRIMARY KEY\s*\(\s*room_id\s*,\s*agent_id\s*,\s*nonce\s*\)/.test(reservationsSql)) {
    db.exec(`ALTER TABLE spend_room_reservations RENAME TO spend_room_reservations_pre3376;
    CREATE TABLE spend_room_reservations (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      amount_cents TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, agent_id, nonce)
    );
    INSERT INTO spend_room_reservations
      (room_id, agent_id, nonce, amount_cents, status, created_at)
      SELECT room_id, agent_id, nonce, amount_cents, status, created_at FROM spend_room_reservations_pre3376;
    DROP TABLE spend_room_reservations_pre3376;
    CREATE INDEX IF NOT EXISTS idx_spend_room_reservations_active
      ON spend_room_reservations (room_id, status);`);
  }
}

// #1525: the reservation lease. Ten minutes is comfortably longer than
// any priced MCP tool call in PRICED_MCP_TOOLS (a 1 MiB file stage, a
// bounty post, a GitHub read) and bounded, so a crashed caller's cap is
// released automatically by the reaper instead of held forever.
export const RESERVE_LEASE_MS = 10 * 60 * 1000;

export class SpendGrantError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (detail !== null && detail !== undefined) this.detail = detail;
  }
}
const refuse = (status, code, message, detail) => { throw new SpendGrantError(status, code, message, detail); };

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validMemberId = id => typeof id === "string" && MEMBER_ID_PATTERN.test(id);
// getTier returns a row object (or null when the member was never tiered —
// enrollment default is t2_standard).
const tierOf = (db, roomId, agentId) => getTier(db, roomId, agentId)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER;
// Transactions go through the store's platform transaction (store.transaction),
// never raw BEGIN/COMMIT: the Durable Object wrapper cannot execute raw
// transaction SQL, so a raw BEGIN here turned a 402 into a 500 on that runtime.
// RoomStore registers its runner for its database at construction; callers
// already inside a transaction (db.isTransaction) just run fn.
const transactionRunners = new WeakMap();
export function registerTransactionRunner(db, run) { transactionRunners.set(db, run); }
function transact(db, fn) {
  if (db.isTransaction) return fn();
  const run = transactionRunners.get(db);
  if (typeof run !== "function") throw new Error("spend-grants: no store transaction is registered for this database");
  return run(fn);
}
// Integer cents as text: no floats, no negatives, no leading zeros, bounded.
const CENTS_PATTERN = /^(0|[1-9][0-9]{0,8})$/;
const validCentsText = value => typeof value === "string" && CENTS_PATTERN.test(value);
const centsToInt = text => {
  if (!validCentsText(text)) refuse(422, "invalid_spend_grant", "cents must be a non-negative integer string, at most 999999999");
  const n = Number(text);
  if (!Number.isSafeInteger(n)) refuse(422, "invalid_spend_grant", "cents must be a safe integer");
  return n;
};
const intToCents = n => {
  if (!Number.isSafeInteger(n) || n < 0) refuse(422, "invalid_spend_grant", "cents must be a non-negative safe integer");
  return String(n);
};

function validAllowlist(allowlist) {
  if (allowlist === null || allowlist === undefined) return true;
  return Array.isArray(allowlist) && allowlist.length > 0
    && allowlist.every(name => priceForTool(name) !== null);
}

function rowToTerms(row) {
  if (!row) return null;
  return Object.freeze({
    roomId: row.room_id,
    agentId: row.agent_id,
    denomination: row.denomination,
    capCents: row.cap_cents,
    perTxCapCents: row.per_tx_cap_cents,
    allowlist: row.allowlist === null ? null : Object.freeze(JSON.parse(row.allowlist)),
    singleUse: row.single_use === 1,
    createdAt: row.created_at,
  });
}

// The live spend grant for an agent: a live capability edge (unrevoked,
// unexpired — grants.mjs resolves fresh every call) AND a terms row. Either
// missing means no grant. With includeInactive, the edge is returned even
// when revoked/expired so callers can name the exact reason (used by
// authorizeSpend for honest refusals).
export function resolveSpendGrant(db, roomId, agentId, { nowMs = Date.now(), includeInactive = false } = {}) {
  if (!db || typeof roomId !== "string" || !validMemberId(agentId)) return null;
  const edges = resolveGrants(db, roomId, agentId, nowMs);
  let edge = edges.find(grant => grant.capability === SPEND_CAPABILITY) ?? null;
  if (includeInactive && !edge) {
    // Raw row: normalize to the rowToGrant shape (grants.mjs) so liveness
    // checks below read the same fields.
    const raw = db.prepare(`SELECT * FROM agent_capability_grants WHERE room_id = ? AND agent_id = ? AND capability = ?`)
      .get(roomId, agentId, SPEND_CAPABILITY);
    if (raw) edge = {
      roomId: raw.room_id, agentId: raw.agent_id, capability: raw.capability,
      grantedBy: raw.granted_by, scope: raw.scope ?? null,
      expiresAt: raw.expires_at ?? null, revokedAt: raw.revoked_at ?? null,
      createdAt: raw.created_at,
    };
  }
  const live = edge && edge.revokedAt === null && (edge.expiresAt === null || edge.expiresAt > nowMs);
  if (!edge || (!includeInactive && !live)) return null;
  const terms = rowToTerms(db.prepare(
    `SELECT * FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`
  ).get(roomId, agentId));
  if (!terms) return null;
  return Object.freeze({ edge, terms, live });
}

// Any spend edge row at all for the member — live, revoked, expired, or an
// edge whose terms row is missing. The member spend default applies only
// when NO edge exists (the member was never issued a grant in this room);
// every edge state keeps the grant path's own behaviour and refusals.
function spendEdgeExists(db, roomId, agentId) {
  return !!db.prepare(`SELECT 1 FROM agent_capability_grants WHERE room_id = ? AND agent_id = ? AND capability = ?`)
    .get(roomId, agentId, SPEND_CAPABILITY);
}

function authorizationsTotal(db, roomId, agentId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total
     FROM spend_authorizations
     WHERE room_id = ? AND agent_id = ? AND status IN ('reserved', 'settled')`
  ).get(roomId, agentId);
  return Number(row?.total ?? 0);
}

// #3302: settled priced-tool charges inside the allowance period. The
// projection ledger behind spendAllowanceReport counts work-session
// spend only; tool charges live in spend_authorizations, and the room
// reservation that represented a charge in flight is released at
// settle — so without this sum a settled charge stopped counting
// against the room allowance the moment it landed, and sequential
// charges accumulated without bound. Windowed by settled_at at/after
// the period start, matching spendLedger's rolling-period semantics.
function settledToolChargesCents(db, roomId, sinceMs) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total
     FROM spend_authorizations
     WHERE room_id = ? AND status = 'settled' AND settled_at >= ?`
  ).get(roomId, sinceMs);
  return Number(row?.total ?? 0);
}

export function remainingSpendCents(db, roomId, agentId) {
  const grant = resolveSpendGrant(db, roomId, agentId);
  if (!grant) return 0;
  return Math.max(0, centsToInt(grant.terms.capCents) - authorizationsTotal(db, roomId, agentId));
}

// Agent-visible summary: cap, per-tx cap, remaining, expiry, allowlist.
// Withhold, never refuse: guests and grant-less agents get { spend: null }
// from the route, never a 403. No funding secret is ever exposed — there is
// none; the grant IS the funding. A member holding no grant falls back to
// the member spend default summary (source: "room_default") when the caller
// supplies the room's default cents — see readSpendGrantRoute.
export function spendGrantSummary(db, roomId, agentId, { nowMs = Date.now(), defaultCents = null } = {}) {
  const grant = resolveSpendGrant(db, roomId, agentId, { nowMs });
  if (!grant) return memberSpendDefaultSummary(db, roomId, agentId, { defaultCents });
  return Object.freeze({
    denomination: grant.terms.denomination,
    capCents: grant.terms.capCents,
    perTxCapCents: grant.terms.perTxCapCents,
    remainingCents: intToCents(Math.max(0, centsToInt(grant.terms.capCents) - authorizationsTotal(db, roomId, agentId))),
    expiresAt: grant.edge.expiresAt,
    allowlist: grant.terms.allowlist,
    singleUse: grant.terms.singleUse,
  });
}

// The member spend default as a summary, in the grant summary's shape plus
// source: "room_default". The purse has no expiry, allowlist, or single-use;
// its per-call bound is the purse itself (a charge can never exceed the
// remaining purse, checked at authorize time). Returns null whenever no
// purse applies: no default in force, any spend edge exists (every grant
// state supersedes the purse), or the member is a guest / t1_readonly —
// authorizeSpend refuses both outright, so showing them a purse would lie.
export function memberSpendDefaultSummary(db, roomId, agentId, { defaultCents = null } = {}) {
  if (!db || typeof roomId !== "string" || !validMemberId(agentId)) return null;
  if (!Number.isSafeInteger(defaultCents) || defaultCents <= 0) return null;
  if (isGuestAgentMemberId(agentId)) return null;
  if (tierOf(db, roomId, agentId) === "t1_readonly") return null;
  if (spendEdgeExists(db, roomId, agentId)) return null;
  return Object.freeze({
    denomination: SPEND_DENOMINATION,
    capCents: intToCents(defaultCents),
    perTxCapCents: intToCents(defaultCents),
    remainingCents: intToCents(Math.max(0, defaultCents - authorizationsTotal(db, roomId, agentId))),
    expiresAt: null,
    allowlist: null,
    singleUse: false,
    source: "room_default",
  });
}

// Issue (or re-issue) a spend grant. Privileged: callers gate with
// requireGrantManagement first. Re-issue upserts terms and clears any
// revocation on the edge (explicit un-revoke), mirroring grants.mjs.
// t1_readonly agents can never hold a spend grant — refused here and
// re-checked on every authorization.
export function issueSpendGrant(db, roomId, agentId, {
  grantedBy, capCents, perTxCapCents, allowlist = null, singleUse = false,
  denomination = SPEND_DENOMINATION, expiresAt = null, nowMs = Date.now(),
} = {}) {
  if (!db || typeof roomId !== "string") refuse(422, "invalid_spend_grant", "roomId must be a string");
  if (!validMemberId(agentId)) refuse(422, "invalid_spend_grant", "agentId must be a room member id");
  if (isGuestAgentMemberId(agentId))
    refuse(422, "spend_grant_guest_forbidden", "Spend grants cannot widen guest passes; upgrade the pass instead");
  if (tierOf(db, roomId, agentId) === "t1_readonly")
    refuse(422, "spend_grant_tier_forbidden", "t1_readonly agents can never hold a spend grant");
  if (!validMemberId(grantedBy)) refuse(422, "invalid_spend_grant", "grantedBy must be a room member id");
  if (denomination !== SPEND_DENOMINATION)
    refuse(422, "spend_grant_denomination_unsupported", `Only the "${SPEND_DENOMINATION}" denomination exists; "${denomination}" issuance is refused`);
  const cap = centsToInt(capCents);
  const perTx = centsToInt(perTxCapCents);
  if (cap <= 0) refuse(422, "invalid_spend_grant", "capCents must be positive");
  if (perTx <= 0) refuse(422, "invalid_spend_grant", "perTxCapCents must be positive");
  if (perTx > cap) refuse(422, "invalid_spend_grant", "perTxCapCents cannot exceed capCents");
  if (!validAllowlist(allowlist))
    refuse(422, "invalid_spend_grant", "allowlist must be null or a non-empty array of priced tool names");
  if (expiresAt !== null && !(Number.isSafeInteger(expiresAt) && expiresAt > nowMs))
    refuse(422, "invalid_spend_grant", "expiresAt must be a future unix-ms timestamp or null");
  issueGrant(db, roomId, agentId, SPEND_CAPABILITY, { grantedBy, scope: null, expiresAt, nowMs });
  db.prepare(`INSERT INTO spend_grant_terms
      (room_id, agent_id, denomination, cap_cents, per_tx_cap_cents, allowlist, single_use, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET
        denomination=excluded.denomination, cap_cents=excluded.cap_cents,
        per_tx_cap_cents=excluded.per_tx_cap_cents, allowlist=excluded.allowlist,
        single_use=excluded.single_use`)
    .run(roomId, agentId, denomination, intToCents(cap), intToCents(perTx),
      allowlist === null || allowlist === undefined ? null : JSON.stringify(allowlist),
      singleUse ? 1 : 0, nowMs);
  return spendGrantSummary(db, roomId, agentId, { nowMs });
}

// Revoke a spend grant: stamps revoked_at on the edge (audit trail, bites on
// the agent's next call). Idempotent.
export function revokeSpendGrant(db, roomId, agentId, { nowMs = Date.now() } = {}) {
  if (!db || typeof roomId !== "string") refuse(422, "invalid_spend_grant", "roomId must be a string");
  if (!validMemberId(agentId)) refuse(422, "invalid_spend_grant", "agentId must be a room member id");
  return revokeGrant(db, roomId, agentId, SPEND_CAPABILITY, { nowMs });
}

function paymentRefusal({ roomId, agentId, toolName, priceCents, reason, extra = {} }) {
  const price = `${priceCents} cent${priceCents === 1 ? "" : "s"}`;
  const obtain = `Ask the room owner for a spend grant (POST /api/rooms/${roomId}/spend-grants).`;
  const messages = {
    no_spend_grant: `Payment required: ${toolName} costs ${price} per call and ${agentId} holds no live spend grant. ${obtain} No call was made and nothing was charged.`,
    grant_expired: `Payment required: ${toolName} costs ${price} per call and ${agentId}'s spend grant has expired. ${obtain} No call was made and nothing was charged.`,
    grant_revoked: `Payment required: ${toolName} costs ${price} per call and ${agentId}'s spend grant was revoked. ${obtain} No call was made and nothing was charged.`,
    cap_exceeded: `Payment required: ${toolName} costs ${price} per call but ${agentId}'s spend grant has ${extra.remainingCents} cents remaining. Ask the room owner to raise the cap. No call was made and nothing was charged.`,
    default_allowance_exceeded: `Payment required: ${toolName} costs ${price} per call but ${agentId} holds no spend grant and the room's member spend default has ${extra.remainingCents} cents remaining for them. Ask the room owner for a spend grant (POST /api/rooms/${roomId}/spend-grants) or to raise the default (POST /api/rooms/${roomId}/spend-default). No call was made and nothing was charged.`,
    per_tx_cap_exceeded: `Payment required: ${toolName} costs ${price} per call, above ${agentId}'s per-call cap of ${extra.perTxCapCents} cents. Ask the room owner to raise the per-call cap. No call was made and nothing was charged.`,
    room_allowance_exceeded: `Payment required: ${toolName} costs ${price} per call but the room's spend allowance has ${extra.roomHeadroomCents} cents of headroom left. Ask the room owner to raise the allowance. No call was made and nothing was charged.`,
  };
  return refuse(402, "payment_required", messages[reason] ?? messages.no_spend_grant, {
    tool: toolName, priceCents, denomination: SPEND_DENOMINATION, reason,
    agentId, roomId, ...extra,
  });
}

// The charge: check-then-reserve inside one SQLite transaction so two
// concurrent calls cannot both spend the same cap. Returns a handle with
// settle()/void(); the caller settles after the tool succeeds and voids on
// any failure. Throws SpendGrantError (402/403/409) — the tool is never
// invoked when this throws.
//
// Concurrency properties (qaD-fix-spend-race):
// - the room allowance is enforced cumulatively: roomAllowanceCents /
//   roomCommittedCents (the projection snapshot) form the base and every
//   in-flight row in spend_room_reservations narrows it, all inside the
//   same BEGIN IMMEDIATE as the grant reservation. roomHeadroomCents is
//   the legacy static-snapshot fallback.
// - single-use grants admit at most one in-flight authorization: the slot
//   is claimed here, atomically, not in settle() after the tool ran.
// - replay: a re-presented nonce never creates a second charge. 'settled'
//   returns its receipt (exactly-once), 'reserved' returns the live
//   authorization (crash recovery: the caller may still settle or void
//   it); only 'voided' stays consumed (409).
export function authorizeSpend(db, { roomId, agentId, toolName, priceCents, nonce,
  roomHeadroomCents = null, roomAllowanceCents = null, roomCommittedCents = null,
  roomDefaultCents = null, nowMs = Date.now() } = {}) {
  if (!db || typeof roomId !== "string") refuse(422, "invalid_spend_grant", "roomId must be a string");
  if (!validMemberId(agentId)) refuse(422, "invalid_spend_grant", "agentId must be a room member id");
  if (priceForTool(toolName) === null) refuse(422, "invalid_spend_grant", `${toolName} is not a priced tool`);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0)
    refuse(422, "invalid_spend_grant", "priceCents must be a positive safe integer");
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128)
    refuse(422, "invalid_spend_grant", "nonce must be a non-empty string, at most 128 chars");
  if (isGuestAgentMemberId(agentId))
    refuse(403, "spend_grant_denied", "Guest passes cannot hold spend grants");
  if (tierOf(db, roomId, agentId) === "t1_readonly")
    refuse(403, "spend_grant_denied", "t1_readonly agents cannot hold spend grants");

  // #1525 + #3377: crash recovery. Void reservations orphaned past their
  // lease (a caller crashed between reserve and settle/void) BEFORE the cap
  // math below, so they can never permanently consume grant cap or room
  // allowance. Runs on every authorization — the next priced call after a
  // crash reaps what the crashed one left behind. The reap runs in its OWN
  // transaction, ahead of the authorization transaction: every refusal
  // below throws, and a throw inside the shared transaction rolled the
  // reap back with it, stranding the headroom until some later authorize
  // happened to commit (a revoked grant refused forever and never reaped
  // at all). The voided-replay path below already follows this rule —
  // recovery commits before any refusal is raised.
  reapExpiredSpendAuthorizations(db, { roomId, nowMs });

  const outcome = transact(db, () => {
    // Replay first: a re-presented nonce never authorizes twice, no matter
    // the cap state. 'settled' returns its receipt (exactly-once charging
    // for completed-request replay, no fresh headroom needed); 'reserved'
    // returns the live authorization (crash recovery); 'voided' stays
    // consumed. The UNIQUE constraint on the INSERT below is the race
    // backstop for two first-time presenters; this read makes the replay
    // path deterministic.
    const existing = db.prepare(`SELECT status, price_cents, tool_name FROM spend_authorizations
      WHERE room_id = ? AND agent_id = ? AND nonce = ?`).get(roomId, agentId, nonce);
    if (existing) {
      if (existing.status === "settled")
        return { replay: "settled", priceCents: Number(existing.price_cents), toolName: existing.tool_name };
      if (existing.status === "reserved")
        return { replay: "reserved", priceCents: Number(existing.price_cents), toolName: existing.tool_name };
      // Commit the expired-reservation recovery before refusing this consumed
      // nonce. Throwing here rolls the reaper back and strands the headroom
      // when the client only retries its original request.
      return { replay: "voided" };
    }
    const grant = resolveSpendGrant(db, roomId, agentId, { nowMs, includeInactive: true });
    let remaining;
    if (grant) {
      if (grant.edge.revokedAt !== null)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "grant_revoked" });
      if (grant.edge.expiresAt !== null && grant.edge.expiresAt <= nowMs)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "grant_expired" });
      const terms = grant.terms;
      if (terms.allowlist !== null && !terms.allowlist.includes(toolName))
        refuse(403, "spend_tool_not_allowlisted", `${toolName} is not in ${agentId}'s spend grant allowlist; no call was made and nothing was charged`, {
          tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId,
        });
      const perTx = centsToInt(terms.perTxCapCents);
      if (priceCents > perTx)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "per_tx_cap_exceeded", extra: { perTxCapCents: terms.perTxCapCents } });
      // Single-use admission: at most one in-flight authorization per grant,
      // decided atomically here. Revoking in settle() is too late — two
      // overlapping calls with different nonces would both authorize.
      // A voided attempt frees the slot; the call never happened.
      if (terms.singleUse) {
        const inFlight = db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations
          WHERE room_id = ? AND agent_id = ? AND status = 'reserved'`).get(roomId, agentId).n;
        if (Number(inFlight) > 0)
          refuse(409, "single_use_in_flight",
            "This single-use spend grant already has an in-flight authorization; overlapping calls are refused, no call was made and nothing was charged", {
              tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId,
            });
      }
      remaining = Math.max(0, centsToInt(terms.capCents) - authorizationsTotal(db, roomId, agentId));
      if (priceCents > remaining)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "cap_exceeded", extra: { remainingCents: intToCents(remaining) } });
    } else if (Number.isSafeInteger(roomDefaultCents) && roomDefaultCents > 0 && !spendEdgeExists(db, roomId, agentId)) {
      // Member spend default (ruling 29b): the member has never held a spend
      // grant in this room, so they authorize against the room's default
      // purse — a lifetime floor on the same authorization trail. No terms
      // row exists, so the grant-only concepts (allowlist, per-tx cap,
      // single-use) do not apply; the remaining check subsumes a per-tx
      // bound because remaining never exceeds the purse.
      remaining = Math.max(0, roomDefaultCents - authorizationsTotal(db, roomId, agentId));
      if (priceCents > remaining)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "default_allowance_exceeded", extra: { remainingCents: intToCents(remaining) } });
    } else {
      paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "no_spend_grant" });
    }
    // Room allowance, enforced cumulatively inside this transaction: the
    // projection snapshot (allowance minus committed) is the base, and
    // every in-flight room reservation narrows it, so two concurrent
    // calls serialize against the allowance instead of racing a static
    // headroom number.
    let roomReserved = 0;
    if (roomAllowanceCents !== null && Number.isSafeInteger(roomAllowanceCents)) {
      const committed = Number.isSafeInteger(roomCommittedCents) ? roomCommittedCents : 0;
      const inFlightRoom = db.prepare(`SELECT COALESCE(SUM(CAST(amount_cents AS INTEGER)), 0) AS total
        FROM spend_room_reservations WHERE room_id = ? AND status = 'active'`).get(roomId).total;
      const headroom = roomAllowanceCents - committed - Number(inFlightRoom);
      if (priceCents > headroom)
        paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "room_allowance_exceeded",
          extra: { roomHeadroomCents: intToCents(Math.max(0, headroom)) } });
      roomReserved = priceCents;
    } else if (roomHeadroomCents !== null && Number.isSafeInteger(roomHeadroomCents) && priceCents > roomHeadroomCents)
      paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "room_allowance_exceeded", extra: { roomHeadroomCents: intToCents(roomHeadroomCents) } });
    try {
      db.prepare(`INSERT INTO spend_authorizations
          (room_id, agent_id, nonce, tool_name, price_cents, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`)
        .run(roomId, agentId, nonce, toolName, intToCents(priceCents), nowMs, nowMs + RESERVE_LEASE_MS);
      if (roomReserved > 0)
        db.prepare(`INSERT INTO spend_room_reservations
            (room_id, agent_id, nonce, amount_cents, status, created_at)
            VALUES (?, ?, ?, ?, 'active', ?)`)
          .run(roomId, agentId, nonce, intToCents(roomReserved), nowMs);
    } catch (error) {
      // #3383: recognize constraint violations on both driver shapes —
      // better-sqlite3-style SQLITE_CONSTRAINT* codes, and node:sqlite's
      // ERR_SQLITE_ERROR, which carries the detail only in the message.
      // Checking the code for "SQLITE_CONSTRAINT" alone left this 409
      // conversion dead on node:sqlite and the raw database error escaped.
      const errorCode = String(error?.code ?? "");
      const isConstraint = errorCode.includes("SQLITE_CONSTRAINT")
        || (errorCode === "ERR_SQLITE_ERROR" && /constraint failed/i.test(String(error?.message ?? "")));
      if (isConstraint)
        refuse(409, "duplicate_nonce", "This spend authorization was already recorded; no double charge", {
          tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId, nonce,
        });
      throw error;
    }
    return { remainingAfter: remaining - priceCents };
  });

  if (outcome.replay === "voided") {
    refuse(409, "duplicate_nonce", "This spend authorization was already recorded and voided; a new attempt needs a fresh nonce", {
      tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId, nonce,
    });
  }

  // The settle transition lives in settleAuthorization below — one
  // implementation shared by this handle and the standalone settleSpend
  // (#3390). Only the void transition remains local: void is NOT
  // lease-gated (releasing an expired reservation is cleanup, never a
  // charge — #3268), so it differs from settle in exactly that guard.
  const voidTransition = () => {
    const info = db.prepare(`UPDATE spend_authorizations SET status = 'voided', settled_at = NULL
      WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
      .run(roomId, agentId, nonce);
    return info.changes > 0;
  };
  const releaseRoomReservation = () => releaseRoomReservationRow(db, roomId, agentId, nonce);
  const remainingNowCents = () => {
    const grant = resolveSpendGrant(db, roomId, agentId, { nowMs: Date.now() });
    if (grant) return intToCents(Math.max(0, centsToInt(grant.terms.capCents) - authorizationsTotal(db, roomId, agentId)));
    if (Number.isSafeInteger(roomDefaultCents) && roomDefaultCents > 0 && !spendEdgeExists(db, roomId, agentId))
      return intToCents(Math.max(0, roomDefaultCents - authorizationsTotal(db, roomId, agentId)));
    return "0";
  };
  if (outcome.replay === "settled") {
    // Exactly-once: the receipt already exists. Return it without charging
    // again and without demanding fresh headroom — the money moved already.
    return Object.freeze({
      nonce,
      toolName: outcome.toolName,
      priceCents: outcome.priceCents,
      remainingAfterCents: remainingNowCents(),
      replayed: "settled",
      settle() { releaseRoomReservation(); return true; },
      void() { return false; },
    });
  }
  const replayedReserved = outcome.replay === "reserved";
  return Object.freeze({
    nonce,
    toolName: replayedReserved ? outcome.toolName : toolName,
    priceCents: replayedReserved ? outcome.priceCents : priceCents,
    remainingAfterCents: replayedReserved ? remainingNowCents() : intToCents(outcome.remainingAfter),
    ...(replayedReserved ? { replayed: "reserved" } : {}),
    settle(nowMs = Date.now()) {
      // #3268: the settle instant is the lease check, so it is injectable
      // like authorizeSpend's nowMs; production callers pass nothing. The
      // body is settleAuthorization — shared with the standalone form.
      const at = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
      return settleAuthorization(db, { roomId, agentId, nonce, at });
    },
    void() {
      return transact(db, () => {
        const moved = voidTransition();
        releaseRoomReservation();
        return moved;
      });
    },
  });
}

// Room-allowance reservations are released on settle AND on void: the
// allowance is only consumed by settled charges. Idempotent. The release
// is scoped to the authorization's own agent (#3376): a reservation backs
// exactly one agent's authorization, and only that agent's settle/void (or
// the reaper acting on that agent's expired row) may release it — keyed
// (room_id, nonce) alone, one agent could free another's allowance.
function releaseRoomReservationRow(db, roomId, agentId, nonce) {
  db.prepare(`UPDATE spend_room_reservations SET status = 'released'
    WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'active'`).run(roomId, agentId, nonce);
}

// #1525: the reaper. A reservation that is still 'reserved' past its lease
// (COALESCE to created_at + lease for rows written before the fix)
// belongs to a caller that is gone — a process crash between reserve and
// settle/void. Leaving it would permanently consume grant cap (the
// authorizationsTotal query counts 'reserved' rows) and room allowance
// (the 'active' room reservation row), so void it and release the room
// reservation, atomically. Orphaned rows are 'voided', never 'settled':
// the crashed call's tool never confirmed, so no charge is recorded, and
// a late re-presentation of the nonce hits the 409 duplicate_nonce path
// and must retry with a fresh nonce. Idempotent; returns the count voided.
export function reapExpiredSpendAuthorizations(db, { roomId, nowMs = Date.now() } = {}) {
  if (!db || typeof roomId !== "string" || !Number.isSafeInteger(nowMs)) return 0;
  return transact(db, () => {
    const expired = db.prepare(
      `SELECT room_id, agent_id, nonce FROM spend_authorizations
       WHERE room_id = ? AND status = 'reserved'
         AND COALESCE(expires_at, created_at + ?) <= ?`)
      .all(roomId, RESERVE_LEASE_MS, nowMs);
    for (const row of expired) {
      db.prepare(`UPDATE spend_authorizations SET status = 'voided'
        WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
        .run(row.room_id, row.agent_id, row.nonce);
      releaseRoomReservationRow(db, row.room_id, row.agent_id, row.nonce);
    }
    return expired.length;
  });
}

// #2959 + #3268 + #3390: the ONE settle implementation, shared by the
// authorize handle's settle() and the standalone settleSpend below — the
// two public forms must never carry different money semantics.
// - #3268: the transition is lease-aware, with the reaper's exact
//   deadline — COALESCE(expires_at, created_at + lease) for pre-#1525
//   rows — and its exact boundary (a reservation at its deadline is
//   expired), evaluated at the settle instant `at`. A post-lease settle
//   returns false and leaves the row 'reserved' for the reaper or a
//   void, whether or not the reaper has already run.
// - #2959: the transition, the room-reservation release, and the
//   single-use revocation are one atomic unit. Splitting them left a
//   settled authorization whose room reservation stayed 'active'
//   forever (the reaper only voids still-'reserved' rows) — or a
//   settled single-use grant that was never revoked — if the process
//   died or a write failed between the steps.
// - #3390: single-use consumption (read the CURRENT terms, revoke the
//   edge on a real transition) used to live only in the handle's
//   settle(), so a single-use grant settled through this standalone
//   form stayed live and reusable. Release and consumption happen only
//   on a real transition: a settle that did not move the row changes
//   nothing else.
function settleAuthorization(db, { roomId, agentId, nonce, at }) {
  return transact(db, () => {
    const info = db.prepare(`UPDATE spend_authorizations SET status = 'settled', settled_at = ?
      WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'
        AND COALESCE(expires_at, created_at + ?) > ?`)
      .run(at, roomId, agentId, nonce, RESERVE_LEASE_MS, at);
    const moved = info.changes > 0;
    if (moved) releaseRoomReservationRow(db, roomId, agentId, nonce);
    if (moved) {
      const terms = rowToTerms(db.prepare(
        `SELECT * FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`).get(roomId, agentId));
      if (terms?.singleUse) revokeGrant(db, roomId, agentId, SPEND_CAPABILITY);
    }
    return moved;
  });
}

export function settleSpend(db, { roomId, agentId, nonce, nowMs = Date.now() } = {}) {
  const at = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  return settleAuthorization(db, { roomId, agentId, nonce, at });
}

export function voidSpend(db, { roomId, agentId, nonce } = {}) {
  return transact(db, () => {
    const info = db.prepare(`UPDATE spend_authorizations SET status = 'voided'
      WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
      .run(roomId, agentId, nonce);
    if (info.changes > 0) releaseRoomReservationRow(db, roomId, agentId, nonce);
    return info.changes > 0;
  });
}

// The trust-boundary entry point for MCP dispatch. Returns null when no
// charge applies (unpriced tool, human caller, room owner). Throws
// SpendGrantError on refusal — the caller must not invoke the tool.
// Otherwise returns the authorizeSpend handle: settle after the tool
// succeeds, void on any failure.
export function chargeSpendBeforeCall(store, secret, name, args) {
  if (priceForTool(name) === null) return null; // unpriced tools never charge
  const roomId = args?.roomId;
  if (typeof roomId !== "string" || roomId.length === 0) return null;
  const auth = store.authenticate(secret, roomId);
  const member = auth.member;
  if (!member || member.kind !== "agent") return null; // humans are never charged
  const room = store.room(roomId);
  if (member.id === room.state.room.ownerId) return null; // ownership implies full authority
  // Kill switch: disabled pricing un-prices every tool at the trust boundary,
  // before any grant is consulted — the tool forwards free, no rows written.
  const priceCents = priceForTool(name, room.state);
  if (priceCents === null) return null;
  const nowMs = store.now();
  // #3377: reap BEFORE the projection snapshot and the charge transaction
  // below. This wrapper's store.transaction is the outermost transaction
  // on the production path — a reap left inside authorizeSpend's own
  // transaction scope would still share it and roll back with a refused
  // charge. Reaping here commits independently (the reaper transacts on
  // its own) and the snapshot then prices against the reaped state.
  reapExpiredSpendAuthorizations(store.db, { roomId, nowMs });
  const report = spendAllowanceReport(room.state, nowMs);
  // The check+reserve MUST run inside the store's platform transaction.
  // authorizeSpend's transact() now delegates to the store's platform
  // transaction itself (it used to issue raw BEGIN IMMEDIATE, which the
  // Durable Object wrapper cannot execute: qa4-fix-spend-do-txn-jill,
  // live-verified 2026-10-05). Wrapping here keeps the projection read in
  // the same transaction as the reservation.
  return store.transaction(() => authorizeSpend(store.db, {
    roomId,
    agentId: member.id,
    toolName: name,
    priceCents,
    nonce: randomUUID(),
    // Cumulative enforcement: the committed base (session spend from the
    // projection PLUS settled tool charges in the period, #3302) is the
    // base and authorizeSpend serializes every in-flight room reservation
    // against it in the same transaction as the grant reservation.
    roomAllowanceCents: report.allowance ? report.allowance.allowanceCents : null,
    roomCommittedCents: report.allowance
      ? report.committedCents + settledToolChargesCents(store.db, roomId, Date.parse(report.period.since))
      : report.committedCents,
    // The member spend default (ruling 29b): read fresh from the projection
    // per call, like the allowance above — an owner change bites on the
    // member's next call.
    roomDefaultCents: memberSpendDefaultCents(room.state),
    nowMs,
  }));
}

// #3269: the ONE charge-then-forward path every transport runs a priced
// operation through. Before this helper, the charge lived only in the MCP
// profiles' dispatch wrappers, so the REST twins of bounty_post /
// room_put_file / add_land_item executed free and ungated — the spend
// grant's permission, per-agent cap, room allowance, and single-use
// consumption were all void at the REST door. Semantics (identical at every
// door): charge before the operation runs; settle after success; void on
// any failure; void when the result is an idempotent replay/duplicate (the
// original call already paid). A null secret (non-room credential modes:
// account sessions, browser cookies) or a null charge (unpriced tool,
// human, room owner, pricing disabled) runs the operation untouched.
// opts.unwrap maps a transport's outcome envelope to the operation value
// (hosted stdio returns { value, isError }); opts.isErrorOutcome marks an
// envelope as failed; opts.isReplay marks an envelope as a replay.
export async function withSpendCharge(store, secret, name, args, operation, opts = {}) {
  if (typeof secret !== "string" || secret.length === 0) return operation();
  const spend = chargeSpendBeforeCall(store, secret, name, args);
  if (!spend) return operation();
  let result;
  try {
    result = await operation();
  } catch (error) { spend.void(); throw error; }
  const value = opts.unwrap ? opts.unwrap(result) : result;
  if (opts.isErrorOutcome && opts.isErrorOutcome(result)) spend.void();
  else if (opts.isReplay && opts.isReplay(result)) spend.void();
  else if (value && typeof value === "object" && (value.duplicate === true || value.idempotentReplay === true)) spend.void();
  else spend.settle();
  return result;
}

// --- HTTP management routes (mirroring server/grants.mjs) ---

// POST /api/rooms/:roomId/spend-grants — body { agentId, capCents,
// perTxCapCents, allowlist?, singleUse?, expiresAt? }. Owner or
// grants:issue delegate (tier-gated, guest-denied). Agents request spend;
// a grants:issue delegate can never self-issue (403); the room owner holds
// full authority and may.
export function issueSpendGrantRoute(store, token, roomId, request, expectedSessionBinding = null) {
  if (!request || Array.isArray(request) || typeof request !== "object")
    refuse(422, "invalid_spend_grant", "Supply { agentId, capCents, perTxCapCents, allowlist?, singleUse?, expiresAt? }");
  const { agentId, capCents, perTxCapCents, allowlist = null, singleUse = false, expiresAt = null } = request;
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    requireGrantManagement({ db: store.db, roomId, state: room.state, actor: auth.member, nowMs });
    if (!ownMember(room.state.members, agentId)) refuse(404, "member_not_found", `No member ${agentId} in this room`);
    // #1521: this call mints money — a grants:issue delegate cannot issue
    // a spend grant to themselves (a reproduced 1,000,000-cent self-issued
    // grant row was the proof). The room owner is full authority
    // (chargeSpendBeforeCall and requireGrantManagement treat ownership
    // the same way) and may self-issue; everyone else must be issued by
    // someone else.
    const isOwner = auth.member.id === room.state?.room?.ownerId;
    if (!isOwner && agentId === auth.member.id)
      refuse(403, "spend_grant_self_issue_forbidden",
        "grants:issue delegates cannot issue spend grants to themselves; ask the room owner", {
          agentId, roomId,
        });
    const summary = issueSpendGrant(store.db, roomId, agentId, {
      grantedBy: auth.member.id, capCents, perTxCapCents, allowlist,
      singleUse: singleUse === true, expiresAt, nowMs,
    });
    return { roomId, agentId, spend: summary, evaluatedThrough: store.room(roomId).sequence };
  });
}

// DELETE /api/rooms/:roomId/spend-grants/:agentId — revoke. Owner or
// grants:issue delegate. Idempotent.
export function revokeSpendGrantRoute(store, token, roomId, agentId, expectedSessionBinding = null) {
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    requireGrantManagement({ db: store.db, roomId, state: room.state, actor: auth.member, nowMs });
    if (!ownMember(room.state.members, agentId)) refuse(404, "member_not_found", `No member ${agentId} in this room`);
    const revoked = revokeSpendGrant(store.db, roomId, agentId, { nowMs });
    return { roomId, agentId, revoked, evaluatedThrough: store.room(roomId).sequence };
  });
}

// GET /api/rooms/:roomId/spend-grant — the caller's own spend summary.
// Withhold, never refuse: guests and grant-less members with no default
// purse get { spend: null }; a grant-less member with a purse in force gets
// the purse summary (source: "room_default").
export function readSpendGrantRoute(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    const memberId = auth.member.id;
    const guest = auth.member.kind === "agent" && isGuestAgentMemberId(memberId);
    return {
      roomId,
      memberId,
      // The purse is an agent-member floor: humans and the owner are never
      // charged, so their summary stays grant-or-null.
      spend: guest ? null : spendGrantSummary(store.db, roomId, memberId, {
        nowMs,
        defaultCents: auth.member.kind === "agent" ? memberSpendDefaultCents(room.state) : null,
      }),
      evaluatedThrough: room.sequence,
    };
  });
}

// GET /api/rooms/:roomId/spend-default — every member may read it: the
// effective purse is room policy members already feel at the charge gate.
// The response carries the stored setting plus per-member consumption of
// the purse (spend_authorizations rows by members holding no spend edge):
// the owner sees every purse consumer; anyone else sees at most their own
// row — other members' spend stays theirs.
export function readSpendDefaultRoute(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const stored = room.state.room.spendDefault ?? null;
    const cents = memberSpendDefaultCents(room.state);
    const isOwner = auth.member.id === room.state.room.ownerId;
    const consumption = [];
    if (cents > 0) {
      const rows = store.db.prepare(
        `SELECT agent_id, COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS spent
         FROM spend_authorizations
         WHERE room_id = ? AND status IN ('reserved', 'settled')
         GROUP BY agent_id`).all(roomId);
      for (const row of rows) {
        if (spendEdgeExists(store.db, roomId, row.agent_id)) continue;
        if (!isOwner && row.agent_id !== auth.member.id) continue;
        const spent = Number(row.spent ?? 0);
        consumption.push(Object.freeze({
          agentId: row.agent_id,
          spentCents: intToCents(spent),
          remainingCents: intToCents(Math.max(0, cents - spent)),
        }));
      }
      // A purse holder with no charges yet still sees their own fresh purse.
      const own = auth.member.kind === "agent"
        ? memberSpendDefaultSummary(store.db, roomId, auth.member.id, { defaultCents: cents })
        : null;
      if (own && !consumption.some(entry => entry.agentId === auth.member.id))
        consumption.push(Object.freeze({
          agentId: auth.member.id,
          spentCents: intToCents(Number(own.capCents) - Number(own.remainingCents)),
          remainingCents: own.remainingCents,
        }));
    }
    return {
      roomId,
      cents,
      defaultCents: MEMBER_SPEND_DEFAULT_CENTS,
      revision: stored?.revision ?? 0,
      setById: stored?.setById ?? null,
      setAt: stored?.setAt ?? null,
      consumption,
      evaluatedThrough: room.sequence,
    };
  });
}

// POST /api/rooms/:roomId/spend-default — owner only (403 for everyone else,
// checked here before the request shape is parsed so a non-owner learns
// nothing about accepted fields from a malformed write). Body:
// { cents, requestId? }; cents null restores the built-in default, 0
// disables the purse (grantless members are refused exactly as before it
// existed).
export function setSpendDefaultRoute(store, token, roomId, request, expectedSessionBinding = null) {
  store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    if (auth.member.id !== room.state.room.ownerId) refuse(403, "owner_required", "Only the room owner can set the member spend default");
  });
  if (!request || Array.isArray(request) || typeof request !== "object")
    refuse(422, "invalid_spend_default", "Supply { cents } and an optional requestId");
  const keys = Object.keys(request);
  if (!keys.includes("cents") || keys.some(key => !["cents", "requestId"].includes(key)))
    refuse(422, "invalid_spend_default", "Supply cents (integer cents, or null to restore the built-in default) and an optional requestId");
  const { cents } = request;
  if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0 || cents > SPEND_ALLOWANCE_LIMITS.allowanceCents))
    refuse(422, "invalid_spend_default", `cents must be an integer of cents from 0 to ${SPEND_ALLOWANCE_LIMITS.allowanceCents}, or null to restore the built-in default`);
  if (request.requestId !== undefined && !validId(request.requestId))
    refuse(422, "invalid_spend_default", "requestId must be a valid identifier");
  return store.command(token, roomId, {
    id: request.requestId ?? randomUUID(),
    type: T.ROOM_SPEND_DEFAULT_SET,
    data: { cents },
  }, expectedSessionBinding);
}
