// Room-native spend grants: per-agent capability="spend" edges with credit
// caps, plus the charge-then-forward trust boundary for priced MCP tools.
//
// Design: ~/workspace/research_notes/spend-primitive-design-2026-10-04.md
// (§3a–§3c, MVP items 1–3 and 5). Credits-denominated, fully reversible:
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
//     process is needed (#1525).
//
// Money is integer cents as TEXT (string-decimal, no floats, D12). Only the
// "credits" denomination exists in v1; "usdc" issuance is refused fail-closed.
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
import { spendPricingEnabled } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

export const SPEND_CAPABILITY = "spend";
export const SPEND_DENOMINATION = "credits";

// Priced MCP tools, integer cents per call. The price ALSO lives in each
// tool's public description ("[paid: room-credits] N credits per call") —
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
  denomination TEXT NOT NULL DEFAULT 'credits',
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
  PRIMARY KEY (room_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_spend_room_reservations_active
  ON spend_room_reservations (room_id, status);
`;

export function ensureSpendGrantsSchema(db) {
  db.exec(SPEND_GRANTS_SCHEMA);
  // #1525: lease expiry on reserves — additive column, following the
  // codebase's column-migration pattern (agent-identities, credentials):
  // existing databases converge via ALTER TABLE, rows written before the
  // fix backfill NULL and the reaper reads their deadline from created_at.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('spend_authorizations') WHERE name='expires_at'`).get())
    db.exec("ALTER TABLE spend_authorizations ADD COLUMN expires_at INTEGER");
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
// node:sqlite's DatabaseSync has no .transaction() helper: serialize the
// check+reserve with explicit BEGIN IMMEDIATE, nesting-safe via isTransaction
// (the store's own transaction() uses the same shape).
function transact(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
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

function authorizationsTotal(db, roomId, agentId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total
     FROM spend_authorizations
     WHERE room_id = ? AND agent_id = ? AND status IN ('reserved', 'settled')`
  ).get(roomId, agentId);
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
// none; the grant IS the funding.
export function spendGrantSummary(db, roomId, agentId, { nowMs = Date.now() } = {}) {
  const grant = resolveSpendGrant(db, roomId, agentId, { nowMs });
  if (!grant) return null;
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
  const price = `${priceCents} credit${priceCents === 1 ? "" : "s"}`;
  const obtain = `Ask the room owner for a spend grant (POST /api/rooms/${roomId}/spend-grants).`;
  const messages = {
    no_spend_grant: `Payment required: ${toolName} costs ${price} per call and ${agentId} holds no live spend grant. ${obtain} No call was made and nothing was charged.`,
    grant_expired: `Payment required: ${toolName} costs ${price} per call and ${agentId}'s spend grant has expired. ${obtain} No call was made and nothing was charged.`,
    grant_revoked: `Payment required: ${toolName} costs ${price} per call and ${agentId}'s spend grant was revoked. ${obtain} No call was made and nothing was charged.`,
    cap_exceeded: `Payment required: ${toolName} costs ${price} per call but ${agentId}'s spend grant has ${extra.remainingCents} credits remaining. Ask the room owner to raise the cap. No call was made and nothing was charged.`,
    per_tx_cap_exceeded: `Payment required: ${toolName} costs ${price} per call, above ${agentId}'s per-call cap of ${extra.perTxCapCents} credits. Ask the room owner to raise the per-call cap. No call was made and nothing was charged.`,
    room_allowance_exceeded: `Payment required: ${toolName} costs ${price} per call but the room's spend allowance has ${extra.roomHeadroomCents} credits of headroom left. Ask the room owner to raise the allowance. No call was made and nothing was charged.`,
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
  roomHeadroomCents = null, roomAllowanceCents = null, roomCommittedCents = null, nowMs = Date.now() } = {}) {
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

  const outcome = transact(db, () => {
    // #1525: crash recovery. Void reservations orphaned past their lease
    // (a caller crashed between reserve and settle/void) BEFORE the cap
    // math below, so they can never permanently consume grant cap or room
    // allowance. Runs on every authorization — the next priced call after
    // a crash reaps what the crashed one left behind.
    reapExpiredSpendAuthorizations(db, { roomId, nowMs });
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
      refuse(409, "duplicate_nonce", "This spend authorization was already recorded and voided; a new attempt needs a fresh nonce", {
        tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId, nonce,
      });
    }
    const grant = resolveSpendGrant(db, roomId, agentId, { nowMs, includeInactive: true });
    if (!grant) paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "no_spend_grant" });
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
    const remaining = Math.max(0, centsToInt(terms.capCents) - authorizationsTotal(db, roomId, agentId));
    if (priceCents > remaining)
      paymentRefusal({ roomId, agentId, toolName, priceCents, reason: "cap_exceeded", extra: { remainingCents: intToCents(remaining) } });
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
      if (String(error?.code).includes("SQLITE_CONSTRAINT"))
        refuse(409, "duplicate_nonce", "This spend authorization was already recorded; no double charge", {
          tool: toolName, priceCents, denomination: SPEND_DENOMINATION, agentId, roomId, nonce,
        });
      throw error;
    }
    return { remainingAfter: remaining - priceCents };
  });

  const transition = (to, settledAt) => {
    const info = db.prepare(`UPDATE spend_authorizations SET status = ?, settled_at = ?
      WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
      .run(to, settledAt, roomId, agentId, nonce);
    return info.changes > 0;
  };
  const releaseRoomReservation = () => releaseRoomReservationRow(db, roomId, nonce);
  const remainingNowCents = () => {
    const grant = resolveSpendGrant(db, roomId, agentId, { nowMs: Date.now() });
    if (!grant) return "0";
    return intToCents(Math.max(0, centsToInt(grant.terms.capCents) - authorizationsTotal(db, roomId, agentId)));
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
    settle() {
      const moved = transition("settled", Date.now());
      releaseRoomReservation();
      // Single-use grants are consumed by their first settled call.
      if (moved) {
        const terms = rowToTerms(db.prepare(
          `SELECT * FROM spend_grant_terms WHERE room_id = ? AND agent_id = ?`).get(roomId, agentId));
        if (terms?.singleUse) revokeGrant(db, roomId, agentId, SPEND_CAPABILITY);
      }
      return moved;
    },
    void() { const moved = transition("voided", null); releaseRoomReservation(); return moved; },
  });
}

// Room-allowance reservations are released on settle AND on void: the
// allowance is only consumed by settled charges. Idempotent.
function releaseRoomReservationRow(db, roomId, nonce) {
  db.prepare(`UPDATE spend_room_reservations SET status = 'released'
    WHERE room_id = ? AND nonce = ? AND status = 'active'`).run(roomId, nonce);
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
      releaseRoomReservationRow(db, row.room_id, row.nonce);
    }
    return expired.length;
  });
}

export function settleSpend(db, { roomId, agentId, nonce } = {}) {
  const info = db.prepare(`UPDATE spend_authorizations SET status = 'settled', settled_at = ?
    WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
    .run(Date.now(), roomId, agentId, nonce);
  if (info.changes > 0) releaseRoomReservationRow(db, roomId, nonce);
  return info.changes > 0;
}

export function voidSpend(db, { roomId, agentId, nonce } = {}) {
  const info = db.prepare(`UPDATE spend_authorizations SET status = 'voided'
    WHERE room_id = ? AND agent_id = ? AND nonce = ? AND status = 'reserved'`)
    .run(roomId, agentId, nonce);
  if (info.changes > 0) releaseRoomReservationRow(db, roomId, nonce);
  return info.changes > 0;
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
  const report = spendAllowanceReport(room.state, nowMs);
  // The check+reserve MUST run inside the store's platform transaction.
  // authorizeSpend's module-local transact() issues raw BEGIN IMMEDIATE /
  // COMMIT / ROLLBACK, which node:sqlite accepts but the Durable Object
  // wrapper (cloudflare/storage.mjs DurableDatabase) cannot execute — on
  // the DO the BEGIN throws a non-ServiceError, so every priced-tool call
  // by a non-owner 500s instead of 402ing (qa4-fix-spend-do-txn-jill,
  // live-verified 2026-10-05). store.transaction() routes through the
  // platform abstraction on every runtime; transact() then nests safely
  // via db.isTransaction and issues no raw SQL of its own.
  return store.transaction(() => authorizeSpend(store.db, {
    roomId,
    agentId: member.id,
    toolName: name,
    priceCents,
    nonce: randomUUID(),
    // Cumulative enforcement: the projection snapshot is the base and
    // authorizeSpend serializes every in-flight room reservation against
    // it in the same transaction as the grant reservation.
    roomAllowanceCents: report.allowance ? report.allowance.allowanceCents : null,
    roomCommittedCents: report.committedCents,
    nowMs,
  }));
}

// REST twins of priced MCP tools must charge exactly like the MCP route
// (REST POST /files, POST /add_land_item). Same trust-boundary check, same
// settle/void handling: a duplicate replay is voided, a throw is voided.
export async function runWithSpend(store, secret, name, roomId, run) {
  let spend;
  try { spend = chargeSpendBeforeCall(store, secret, name, { roomId }); }
  catch (error) {
    // REST callers get the same typed refusal the MCP route returns (402 payment_required).
    if (error instanceof SpendGrantError) throw new ServiceError(error.status, error.code, error.message);
    throw error;
  }
  if (!spend) return run();
  let value;
  try { value = await run(); } catch (error) { spend.void(); throw error; }
  if (value && typeof value === "object" && value.duplicate === true) spend.void();
  else spend.settle();
  return value;
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
    if (!room.state.members?.[agentId]) refuse(404, "member_not_found", `No member ${agentId} in this room`);
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
    if (!room.state.members?.[agentId]) refuse(404, "member_not_found", `No member ${agentId} in this room`);
    const revoked = revokeSpendGrant(store.db, roomId, agentId, { nowMs });
    return { roomId, agentId, revoked, evaluatedThrough: store.room(roomId).sequence };
  });
}

// GET /api/rooms/:roomId/spend-grant — the caller's own spend summary.
// Withhold, never refuse: guests and grant-less members get { spend: null }.
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
      spend: guest ? null : spendGrantSummary(store.db, roomId, memberId, { nowMs }),
      evaluatedThrough: room.sequence,
    };
  });
}
