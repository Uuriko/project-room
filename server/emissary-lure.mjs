// server/emissary-lure.mjs
// Emissary growth layer — Slice 2: outbound lure generation.
//
// Three generation primitives, exposed as hosted MCP tools:
//   emissary_drop      — venue-formatted recruitment post text
//   emissary_pitch     — proof-backed direct pitch text
//   human_invite_mint  — single-use #join/ invite link for a real human
//
// Hard invariants:
// - This module never posts, sends, dispatches, or transports anything.
//   It returns text / URLs for the member to copy and carry by hand.
//   There is no network I/O in this file: no fetch, no http, no net,
//   no WebSocket. (Guarded by tests/emissary-lure.test.js.)
// - Human invites reuse the existing ShareLinks mint path unchanged:
//   owner / delegated-admin authority is preserved, expiry stays inside
//   the path's 7-day cap, and the raw 43-char token is returned once and
//   never persisted — only its sha256 hash lands in
//   emissary_invite_attribution.
// - Pitches cite only verified Slice 1 external receipts (kinds work,
//   jury, oracle). An unverifiable proof_ref fails closed with
//   emissary_proof_unverified; the member's focus is used verbatim and
//   the whole pitch still passes the lure lint.
// - Tables are created lazily via ensureEmissaryLureSchema(db): the
//   store's schema version is untouched and no store.mjs edit is needed.

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { validId } from "../src/events.js";

// Local error carrying status+code, identical in shape to the room's
// ServiceError (server/store.mjs). The MCP failureValue accepts any error
// with an integer status and string code, so these surface through
// tools/call exactly like store errors. Defined locally so this module
// does not import the store (the store must never import this module).
export class EmissaryLureError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "EmissaryLureError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new EmissaryLureError(status, code, message); };

// Additive tables. Every table created here is registered in
// server/writer-fence.mjs (unfencedAdditiveTables) and covered by the
// recovery fixture. The schema literal ends with a real statement —
// Cloudflare Workers' SQLite exec() rejects a trailing comment chunk.
// room_id is on every table: room sovereignty, same as the rest of the schema.
export const EMISSARY_LURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS emissary_drops (
  drop_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  issuer_member_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  title TEXT NOT NULL,
  terms TEXT NOT NULL,
  deadline_at INTEGER NULL,
  artifact_text TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'default-unverified',
  idempotency_key TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_drops_room_venue_day ON emissary_drops(room_id, venue, created_at);
CREATE INDEX IF NOT EXISTS emissary_drops_idem ON emissary_drops(room_id, idempotency_key);
CREATE TABLE IF NOT EXISTS emissary_invite_attribution (
  attribution_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  issuer_member_id TEXT NOT NULL,
  invite_token_hash TEXT NOT NULL,
  note TEXT NULL,
  minted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_invite_attribution_issuer_day ON emissary_invite_attribution(room_id, issuer_member_id, minted_at);
CREATE TABLE IF NOT EXISTS emissary_idempotency (
  room_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS emissary_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  subject_id TEXT NULL,
  details_json TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_journal_room_kind ON emissary_journal(room_id, kind, seq);`;

const ensuredDbs = new WeakSet();
export function ensureEmissaryLureSchema(db) {
  if (ensuredDbs.has(db)) return;
  db.exec(EMISSARY_LURE_SCHEMA);
  ensuredDbs.add(db);
}

// Wire-format id prefixes. emd1. (drop) and eia1. (invite attribution)
// were collision-checked against main 2026-09-28: no existing uses.
const hexId = (prefix, bytes = 16) => `${prefix}.${randomBytes(bytes).toString("hex")}`;
export const mintDropId = () => hexId("emd1");
export const mintAttributionId = () => hexId("eia1");
export const DROP_ID_PATTERN = /^emd1\.[0-9a-f]{32}$/;
export const ATTRIBUTION_ID_PATTERN = /^eia1\.[0-9a-f]{32}$/;

// Venue caps. Values marked "verified" were checked against the venue's
// own docs/limits 2026-09-28; "default-unverified" are common platform
// limits the builder records for later verification. Keys other than
// `thread` select the artifact variant; a venue without the requested
// variant falls back to `thread`.
export const LURE_VENUES = Object.freeze(["sssnack", "colony", "tantive", "agentboard", "x", "generic"]);
export const VENUE_LIMITS = Object.freeze({
  sssnack: Object.freeze({ thread: 2000, reply: 800, subject: 120, source: "verified" }),
  colony: Object.freeze({ thread: 1000, source: "default-unverified" }),
  tantive: Object.freeze({ thread: 2000, reply: 800, source: "default-unverified" }),
  agentboard: Object.freeze({ thread: 2000, source: "default-unverified" }),
  x: Object.freeze({ thread: 280, source: "default-unverified" }),
  generic: Object.freeze({ thread: 2000, source: "default-unverified" }),
});
export const LURE_VARIANTS = Object.freeze(["thread", "reply", "subject"]);

// Forbidden-content lint. Every entry needs a stable id: the validator
// reports the id so the member knows which rule fired. Patterns reject
// earnings guarantees, risk-free claims, and crypto-moon language; the
// list is frozen at module load so runtime code cannot widen or narrow it.
export const FORBIDDEN_PATTERNS = Object.freeze([
  { id: "guaranteed-returns", pattern: /guaranteed\s+(earnings|income|returns?|profits?|payouts?|money|apr|apy|yield)/i },
  { id: "risk-free", pattern: /risk[\s-]?free/i },
  { id: "no-risk", pattern: /\bno\s+risk\b/i },
  { id: "zero-risk", pattern: /\bzero\s+risk\b/i },
  { id: "cant-lose", pattern: /\bcan'?t\s+lose\b|\bcannot\s+lose\b/i },
  { id: "passive-income", pattern: /passive\s+income/i },
  { id: "easy-money", pattern: /\beasy\s+money\b/i },
  { id: "get-rich", pattern: /\bget[\s-]?rich(\s+quick)?\b/i },
  { id: "double-your-money", pattern: /\bdouble\s+your\s+(money|investment|crypto|tokens?|eth|sol|btc)\b/i },
  { id: "moon-multiple", pattern: /\b\d{3,}x\b/ },
  { id: "to-the-moon", pattern: /\bto\s+the\s+moon\b|\bmoon\s*shot\b/i },
  { id: "prints-money", pattern: /\bprints?\s+money\b/i },
  // "this is financial advice" is a claim; "this is not financial advice"
  // is the standard disclaimer and must not trip the lint.
  { id: "financial-advice-claim", pattern: /(?<!\bnot\s+)financial\s+advice/i },
]);

// Pure lint: returns the ids of every forbidden pattern the text trips.
// Does not throw — validateLureTemplate is the throwing gate.
export function runLureLint(text) {
  const hits = [];
  for (const { id, pattern } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) hits.push(id);
  }
  return hits;
}

export function validateLureTemplate(text) {
  if (typeof text !== "string" || text.length === 0) fail(400, "emissary_lure_empty_text", "Lure text must be a non-empty string");
  const violations = runLureLint(text);
  if (violations.length > 0) {
    fail(400, "emissary_lure_forbidden_content",
      `Lure text trips forbidden-content rules: ${violations.join(", ")}. Rewrite without earnings guarantees, risk-free claims, or moon language.`);
  }
  return true;
}

// Venue artifact skeletons. Every skeleton renders only member-supplied
// facts (title, terms, deadline, attempts, code) plus fixed neutral
// framing. Skeletons are data, not code paths: formatDrop renders them,
// then validateLureTemplate proves the rendered artifact passes the lint.
// If a skeleton ever tripped the lint, generation would fail closed.
function renderSkeleton({ variant, title, terms, deadlineIso, attemptsLine, codeLine }) {
  if (variant === "subject") return title;
  if (variant === "reply") {
    return [ `${title} — ${terms}`, ``, `Deadline: ${deadlineIso}`, attemptsLine, codeLine ]
      .filter(line => line !== null).join("\n");
  }
  return [
    title, ``,
    terms, ``,
    `Deadline: ${deadlineIso}`,
    attemptsLine, codeLine, ``,
    `Copy-paste ready — the member who shares this can answer questions in the room.`,
  ].filter(line => line !== null).join("\n");
}

// formatDrop renders the venue artifact and fits it to the venue cap.
// Contract:
// - `terms` shrinks to fit; the required factual block (title, deadline,
//   framing) never shrinks. A skeleton that alone exceeds the cap throws
//   emissary_lure_skeleton_too_long (fail-closed).
// - Truncation cuts at a word boundary and appends the explicit
//   `… [cut to fit <venue>]` marker — never a silent mid-word cut.
// - The rendered artifact always passes validateLureTemplate, because the
//   skeletons carry no forbidden language and member inputs are validated
//   by generateDrop before formatting.
export function formatDrop({ venue, variant = "thread", title, terms, deadline = null, attemptsRemaining = null, code = null }) {
  if (!LURE_VENUES.includes(venue)) fail(400, "emissary_lure_unknown_venue", `Unknown venue: ${venue}`);
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 120) {
    fail(400, "emissary_lure_bad_title", "title must be a non-empty string of at most 120 characters");
  }
  if (typeof terms !== "string" || terms.trim().length === 0 || terms.length > 2000) {
    fail(400, "emissary_lure_bad_terms", "terms must be a non-empty string of at most 2000 characters");
  }
  if (!LURE_VARIANTS.includes(variant)) fail(400, "emissary_lure_bad_variant", `variant must be one of ${LURE_VARIANTS.join(", ")}`);
  const limits = VENUE_LIMITS[venue];
  const cap = limits[variant] ?? limits.thread;

  let deadlineIso = "none stated";
  if (deadline !== null && deadline !== undefined) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) fail(400, "emissary_lure_bad_deadline", "deadline must be epoch-ms as a safe integer");
    deadlineIso = new Date(deadline).toISOString();
  }
  let attemptsLine = null;
  if (attemptsRemaining !== null && attemptsRemaining !== undefined) {
    if (!Number.isSafeInteger(attemptsRemaining) || attemptsRemaining < 0) {
      fail(400, "emissary_lure_bad_attempts", "attemptsRemaining must be an integer >= 0");
    }
    attemptsLine = `Attempts remaining: ${attemptsRemaining}`;
  }
  let codeLine = null;
  if (code !== null && code !== undefined) {
    if (typeof code !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(code)) {
      fail(400, "emissary_lure_bad_code", "code must be 1-32 chars of [A-Za-z0-9-]");
    }
    codeLine = `Code: ${code}`;
  }

  const render = shortTerms => renderSkeleton({ variant, title, terms: shortTerms, deadlineIso, attemptsLine, codeLine });
  const full = render(terms);
  if (full.length <= cap) {
    validateLureTemplate(full);
    return { text: full, truncated: false };
  }
  const overhead = render("").length;
  const marker = `… [cut to fit ${venue}]`;
  const available = cap - overhead - marker.length;
  if (available < 24) {
    fail(400, "emissary_lure_skeleton_too_long",
      `The ${venue}/${variant} skeleton alone exceeds the ${cap}-char cap; refusing to shrink the required factual block`);
  }
  let cut = terms.slice(0, available);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 8) cut = cut.slice(0, lastSpace);
  const text = render(cut) + marker;
  validateLureTemplate(text);
  return { text, truncated: true };
}

const DAY_MS = 86400000;
const utcDayStart = nowMs => Math.floor(nowMs / DAY_MS) * DAY_MS;
export const DROP_DAILY_LIMIT = 10;
export const INVITE_DAILY_LIMIT = 20;

function countDropsToday(db, roomId, memberId, venue, nowMs) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM emissary_drops WHERE room_id=? AND issuer_member_id=? AND venue=? AND created_at>=?"
  ).get(roomId, memberId, venue, utcDayStart(nowMs)).n;
}

function countInvitesToday(db, roomId, memberId, nowMs) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM emissary_invite_attribution WHERE room_id=? AND issuer_member_id=? AND minted_at>=?"
  ).get(roomId, memberId, utcDayStart(nowMs)).n;
}

function checkIdempotency(db, roomId, key, tool) {
  if (!key) return null;
  // validId shape: the key doubles as the ShareLinks requestId on the
  // invite path, so it must satisfy the share-link id contract up front.
  if (typeof key !== "string" || !validId(key)) {
    fail(400, "emissary_lure_bad_idempotency_key", "idempotency_key must be a valid id (1-128 chars of [A-Za-z0-9_.:-])");
  }
  const row = db.prepare("SELECT tool, result_json FROM emissary_idempotency WHERE room_id=? AND idempotency_key=?").get(roomId, key);
  if (!row) return null;
  if (row.tool !== tool) {
    fail(409, "emissary_lure_idempotency_conflict",
      `idempotency_key was already used for ${row.tool}; it cannot be reused for ${tool}`);
  }
  return { ...JSON.parse(row.result_json), duplicate: true };
}

function storeIdempotency(db, roomId, key, tool, result, nowMs) {
  if (!key) return;
  db.prepare("INSERT OR IGNORE INTO emissary_idempotency (room_id, idempotency_key, tool, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(roomId, key, tool, JSON.stringify(result), nowMs);
}

export const EMISSARY_JOURNAL_KINDS = Object.freeze([
  "emissary.drop_generated",
  "emissary.pitch_generated",
  "emissary.human_invite_minted",
]);

function journalEvent(db, { roomId, kind, actorMemberId, subjectId = null, details = null, nowMs }) {
  db.prepare(`INSERT INTO emissary_journal (event_id, room_id, kind, actor_member_id, subject_id, details_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), roomId, kind, actorMemberId, subjectId, details == null ? null : JSON.stringify(details), nowMs);
}

// generateDrop: validate -> idempotency -> rate limit -> format+lint ->
// persist -> journal. Returns { drop_id, text, truncated, duplicate }.
export function generateDrop(db, roomId, memberId, input, opts = {}) {
  ensureEmissaryLureSchema(db);
  const nowMs = opts.nowMs ?? Date.now();
  const { venue, variant, title, terms, deadline, attemptsRemaining, code, idempotencyKey } = input ?? {};
  const replay = checkIdempotency(db, roomId, idempotencyKey, "emissary_drop");
  if (replay) return replay;
  if (typeof memberId !== "string" || memberId.length === 0) fail(400, "emissary_lure_bad_member", "memberId is required");

  if (countDropsToday(db, roomId, memberId, venue, nowMs) >= DROP_DAILY_LIMIT) {
    fail(429, "emissary_drop_rate_limited", `Drop limit reached: ${DROP_DAILY_LIMIT} per member per venue per day`);
  }
  const { text, truncated } = formatDrop({ venue, variant, title, terms, deadline, attemptsRemaining, code });
  const dropId = mintDropId();
  db.prepare(`INSERT INTO emissary_drops
      (drop_id, room_id, issuer_member_id, venue, title, terms, deadline_at, artifact_text, artifact_sha256, truncated, source, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(dropId, roomId, memberId, venue, title, terms, deadline ?? null, text,
      createHash("sha256").update(text).digest("hex"), truncated ? 1 : 0,
      VENUE_LIMITS[venue].source, idempotencyKey ?? null, nowMs);
  journalEvent(db, {
    roomId, kind: "emissary.drop_generated", actorMemberId: memberId, subjectId: dropId,
    details: { venue, variant: variant ?? "thread", truncated, artifact_sha256: createHash("sha256").update(text).digest("hex") }, nowMs,
  });
  const result = { drop_id: dropId, text, truncated, duplicate: false };
  storeIdempotency(db, roomId, idempotencyKey, "emissary_drop", result, nowMs);
  return result;
}

// Proof resolution for pitches. Reads the Slice 1 external_receipts table
// when it exists (created by the Slice 1/1a work); when the table is
// absent — or the ref is unknown or not a citable kind — the pitch fails
// closed with emissary_proof_unverified. Citable kinds are the Slice 1
// receipt kinds that attest to completed work.
export const CITABLE_PROOF_KINDS = Object.freeze(["work", "jury", "oracle"]);
export const PROOF_REF_PATTERN = /^ert1\.[0-9a-f]{32}$/;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function resolveProofRef(db, roomId, proofRef) {
  if (typeof proofRef !== "string" || !PROOF_REF_PATTERN.test(proofRef)) {
    fail(400, "emissary_pitch_bad_proof_ref", `proof_ref must look like ert1.<32 hex chars>: ${proofRef}`);
  }
  if (!tableExists(db, "external_receipts")) {
    fail(400, "emissary_proof_unverified", `Proof ${proofRef} cannot be verified: no receipt ledger is present in this room`);
  }
  const row = db.prepare("SELECT receipt_id, kind, created_at FROM external_receipts WHERE room_id=? AND receipt_id=?").get(roomId, proofRef);
  if (!row) fail(400, "emissary_proof_unverified", "Proof is not a known receipt");
  if (!CITABLE_PROOF_KINDS.includes(row.kind)) {
    fail(400, "emissary_proof_unverified", "Proof is not a citable receipt kind");
  }
  return { id: row.receipt_id, kind: row.kind, recordedAt: row.created_at };
}

// generatePitch: the member's focus verbatim, plus a proof: block citing
// only verified receipts. The whole pitch passes the lure lint — a focus
// carrying forbidden language is rejected, never laundered.
export function generatePitch(db, roomId, memberId, input, opts = {}) {
  ensureEmissaryLureSchema(db);
  const nowMs = opts.nowMs ?? Date.now();
  const { focus, proof_refs, idempotencyKey } = input ?? {};
  const replay = checkIdempotency(db, roomId, idempotencyKey, "emissary_pitch");
  if (replay) return replay;
  if (typeof memberId !== "string" || memberId.length === 0) fail(400, "emissary_lure_bad_member", "memberId is required");
  if (typeof focus !== "string" || focus.trim().length === 0 || focus.length > 200) {
    fail(400, "emissary_pitch_bad_focus", "focus must be a non-empty string of at most 200 characters");
  }
  if (!Array.isArray(proof_refs) || proof_refs.length > 5) {
    fail(400, "emissary_pitch_bad_proof_refs", "proof_refs must be an array of at most 5 receipt ids");
  }
  const proofs = proof_refs.map(ref => resolveProofRef(db, roomId, ref));
  const lines = [focus.trim(), ``, `proof:`];
  for (const proof of proofs) {
    lines.push(`- ${proof.id} (${proof.kind}, recorded ${new Date(proof.recordedAt).toISOString()})`);
  }
  const text = lines.join("\n");
  validateLureTemplate(text);
  journalEvent(db, {
    roomId, kind: "emissary.pitch_generated", actorMemberId: memberId, subjectId: null,
    details: { proof_refs: proofs.map(p => p.id) }, nowMs,
  });
  const result = { text, duplicate: false };
  storeIdempotency(db, roomId, idempotencyKey, "emissary_pitch", result, nowMs);
  return result;
}

// Human share-link door. Mirrors server/share-links.mjs's public door and
// room-deep-link.js's #join/<token> shape; the base is duplicated here so
// this module does not import client code.
export const PUBLIC_ROOM_DOOR = "https://www.getdasha.com/room";
export const HUMAN_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// ShareLinks.create caps expiry at 7 days; a longer request is rejected,
// never silently clamped, so the member sees the real constraint.
export const HUMAN_INVITE_MAX_EXPIRY_DAYS = 7;
export const MAX_JOINS_PER_INVITE = 1;

const mintInviteToken = () => randomBytes(32).toString("base64url");

// mintHumanInvite mints ONE single-use human #join/ link through the
// unchanged ShareLinks path (owner / delegated-admin authority preserved
// by ShareLinks.create itself) and records attribution.
//
// The raw token is returned to the member once and never persisted: only
// its sha256 hash lands in emissary_invite_attribution, and the
// idempotency record stores the replay-safe form (no URL, no token).
// A replayed idempotency_key returns the existing attribution with
// duplicate: true — the URL is not re-issued.
export function mintHumanInvite(db, roomId, memberId, input, deps = {}, opts = {}) {
  ensureEmissaryLureSchema(db);
  const nowMs = opts.nowMs ?? Date.now();
  const { expires_in_days = 7, note = null, idempotencyKey = null } = input ?? {};
  const replay = checkIdempotency(db, roomId, idempotencyKey, "human_invite_mint");
  if (replay) return replay;
  if (typeof memberId !== "string" || memberId.length === 0) fail(400, "emissary_lure_bad_member", "memberId is required");
  if (!Number.isSafeInteger(expires_in_days) || expires_in_days < 1 || expires_in_days > HUMAN_INVITE_MAX_EXPIRY_DAYS) {
    fail(400, "emissary_invite_bad_expiry",
      `expires_in_days must be an integer from 1 to ${HUMAN_INVITE_MAX_EXPIRY_DAYS} (the share-link path caps expiry at 7 days)`);
  }
  if (note !== null && note !== undefined && (typeof note !== "string" || note.length > 140)) {
    fail(400, "emissary_invite_bad_note", "note must be a string of at most 140 characters");
  }
  if (typeof deps.createShareLink !== "function") {
    fail(500, "emissary_invite_no_mint_path", "No share-link mint path was provided");
  }
  if (countInvitesToday(db, roomId, memberId, nowMs) >= INVITE_DAILY_LIMIT) {
    fail(429, "emissary_invite_rate_limited", `Invite limit reached: ${INVITE_DAILY_LIMIT} per member per day`);
  }

  const token = mintInviteToken();
  if (!HUMAN_INVITE_TOKEN_PATTERN.test(token)) fail(500, "emissary_invite_token_shape", "Minted token failed its shape check");
  const expiresAt = nowMs + expires_in_days * DAY_MS;
  const requestId = idempotencyKey ?? randomUUID();
  const attributionId = mintAttributionId();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  // M-10: attribution + idempotency are persisted BEFORE the live link is
  // minted — a mint failure must never leave a redeemable link with no
  // attribution/journal/idempotency, and a retry must not mint a second link.
  db.prepare(`INSERT INTO emissary_invite_attribution
      (attribution_id, room_id, issuer_member_id, invite_token_hash, note, minted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(attributionId, roomId, memberId, tokenHash, note ?? null, nowMs, expiresAt);
  const minting = { attribution_id: attributionId, expires_at: expiresAt, status: "minting", duplicate: false };
  storeIdempotency(db, roomId, idempotencyKey, "human_invite_mint", minting, nowMs);
  let minted;
  try {
    minted = deps.createShareLink({
      requestId,
      linkToken: token,
      expiresAt,
      maxJoins: MAX_JOINS_PER_INVITE,
      expectedMemberRevision: deps.memberRevision ?? null,
    });
  } catch (error) {
    // No link was minted: drop the "minting" marker so a retry re-attempts
    // the mint instead of replaying a link-less record.
    if (idempotencyKey) db.prepare("DELETE FROM emissary_idempotency WHERE room_id=? AND idempotency_key=?")
      .run(roomId, idempotencyKey);
    throw error;
  }
  if (!minted || typeof minted !== "object") {
    if (idempotencyKey) db.prepare("DELETE FROM emissary_idempotency WHERE room_id=? AND idempotency_key=?")
      .run(roomId, idempotencyKey);
    fail(500, "emissary_invite_mint_failed", "Share-link mint returned no link");
  }
  journalEvent(db, {
    roomId, kind: "emissary.human_invite_minted", actorMemberId: memberId, subjectId: attributionId,
    details: { attribution_id: attributionId, expires_at: expiresAt }, nowMs,
  });

  const stored = { attribution_id: attributionId, expires_at: expiresAt, status: "minted", duplicate: false };
  if (idempotencyKey) db.prepare("UPDATE emissary_idempotency SET result_json=? WHERE room_id=? AND idempotency_key=?")
    .run(JSON.stringify(stored), roomId, idempotencyKey);
  return { ...stored, url: `${PUBLIC_ROOM_DOOR}/#join/${token}` };
}

// MCP entry point. Authenticates the caller, applies the member-only gate
// (guest agents denied; t1_readonly denied via the autonomy tier), then
// dispatches to the generator. The store's own ServiceError from
// authenticate flows through unchanged.
export const EMISSARY_TOOL_NAMES = Object.freeze(["emissary_drop", "emissary_pitch", "human_invite_mint"]);

export function handleEmissaryTool(store, secret, name, args, deps = {}) {
  if (!EMISSARY_TOOL_NAMES.includes(name)) fail(400, "unknown_tool", `Unknown emissary tool: ${name}`);
  const roomId = args?.roomId;
  if (typeof roomId !== "string" || roomId.length === 0) fail(400, "invalid_arguments", "roomId is required");
  const auth = store.authenticate(secret, roomId);
  const member = auth.member;
  if (isGuestAgentMemberId(member.id)) {
    fail(403, "guest_scope_denied", "Guest agents cannot use emissary tools");
  }
  enforceAutonomyTierForAction({
    db: store.db, roomId, state: store.room(roomId).state, actor: member, action: name,
    fail: (status, code, message) => { throw new EmissaryLureError(status, code, message); },
  });
  const db = store.db;
  const nowMs = deps.nowMs;
  if (name === "emissary_drop") {
    return generateDrop(db, roomId, member.id, {
      venue: args.venue, variant: args.variant, title: args.title, terms: args.terms,
      deadline: args.deadline, attemptsRemaining: args.attempts_remaining, code: args.code,
      idempotencyKey: args.idempotency_key,
    }, { nowMs });
  }
  if (name === "emissary_pitch") {
    return generatePitch(db, roomId, member.id, { focus: args.focus, proof_refs: args.proof_refs, idempotencyKey: args.idempotency_key }, { nowMs });
  }
  return mintHumanInvite(db, roomId, member.id,
    { expires_in_days: args.expires_in_days, note: args.note, idempotencyKey: args.idempotency_key },
    {
      memberRevision: member.revision ?? null,
      createShareLink: details => store.shareLinks.create(secret, roomId, details, null).link,
    },
    { nowMs });
}
