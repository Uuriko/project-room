// Work-claim HTTP routes (task RC-2026-09-18-041; receipts RC-2026-09-24-205).
//
// Room-scoped handlers mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks — the
// same mounting pattern as server/inbox-collab-routes.mjs. Claim operations
// live under /api/rooms/{roomId}/work-claims/*; the receipts search surface
// (done work items projected as receipts) lives at
// /api/rooms/{roomId}/receipts. All are documented in docs/openapi.yaml
// (the route-docs gate requires it).
//
// Identity: the caller is the authenticated room member (auth.member.id).
// Claim/update/release/reassign are owner-gated by the pure state machine;
// review attestations are caller-bound (any member may attest; the record
// always names the caller). The done transition additionally enforces the
// item's review policy via canCloseWork (independent_principal consults the
// room's live membership for the verify permission), and for non-self
// policies requires a recorded attestation from the named reviewer —
// naming a reviewer who never attested is rejected (QA-Sec 2026-09-19).
//
// Production uses the store-owned SQLite registry. The in-memory registry
// remains a pure-test fixture only. Lease expiry is evaluated
// on every request, so reads never show stale claims and expired claims
// auto-release with a stamped history entry even if nobody calls /sweep.
// Per-room lease/policy defaults are configured through the registry
// (configureRoom); the documented config hook is roomWorkClaimConfig in
// server/work-claims.mjs — a future slice can source it from stored room
// config instead of this registry.
//
// Error contract: the pure module throws ClaimError (code
// invalid_claim_input, no HTTP status); claimHttpError maps it to 422.
// Ownership and policy refusals are raised directly as 403 via reject();
// conflicts (double create, claim on claimed work, update of done work) as
// 409; unknown ids as 404. Unknown errors are rethrown for the generic 500
// path — never wrapped, so no internal detail leaks.
import {
  createWork, claimWork, updateWork, appendWorkPullRequest, attestWork, recordReview, reassignWork, releaseExpired, canCloseWork,
  renewWork, roomWorkClaimConfig, closeWhenLive, isReceiptTag, ClaimError, REVIEW_POLICIES, CLAIM_KINDS,
  claimUpdatedAt, ACTIVE_CLAIM_STATES, MAX_LEASE_HOURS, STATES, summarizeClaimHistory,
} from "./work-claims.mjs";
import { findDuplicates, DuplicateError } from "./work-duplicates.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { evaluateReceipt } from "./jev-receipts.mjs";
import { findClaimCollisions } from "./claim-collisions.mjs";
import { emitWorkClaimEvent, enqueueClaimWake } from "./work-claim-events.mjs";
import { noteReadyWork } from "./work-wants.mjs"; // BOARD-WAKE-2
import { isFirstContribution, retentionAck } from "./retention-response.mjs";
import { ROOM_GUIDE_ID } from "./room-guide.mjs";
import { fileLeaseConflictBody, fileLeaseConflicts, holdForRateLimit, readyClaims } from "./claim-coordination.mjs";
import { collectPullRequestLookups, commitPullRequestLookup, readClaimPullBudget, writeClaimPullBudget } from "./claim-pr-sync.mjs";
import {
  assertBoardEventBudget, assertBoardLeaseHours, assertDependsOnKnown, boardText, boardTextFields, clientPullRequestInput,
  readBoardDeployStatus, roomEventsRemaining, DONE_WINDOW_MS, LIST_HISTORY_ENTRIES,
} from "./work-claim-integrity.mjs";
import { stampClaim, stampClaimPage, stampReceipts, withContentTrust } from "./content-trust.mjs";
import { agentErrorBody } from "../src/agent-error.mjs";
import { SOURCE_REVISION } from "./version.mjs";
import { ServiceError } from "./service-error.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { isRoomArchived } from "../src/events.js";

const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Per-room registry: roomId -> { items: Map(id -> work item), config: { defaultLeaseHours?, reviewPolicy? } }.
export function createWorkClaimRegistry() {
  const rooms = new Map();
  const room = roomId => {
    let entry = rooms.get(roomId);
    if (!entry) { entry = { items: new Map(), config: {} }; rooms.set(roomId, entry); }
    return entry;
  };
  return {
    get(roomId, id) { return room(roomId).items.get(id) ?? null; },
    set(roomId, item) { room(roomId).items.set(item.id, item); return item; },
    list(roomId) { return [...room(roomId).items.values()]; },
    has(roomId, id) { return room(roomId).items.has(id); },
    configure(roomId, config) {
      const entry = room(roomId);
      if (config !== undefined && config !== null) {
        if (typeof config !== "object" || Array.isArray(config)) throw new Error("room work-claim config must be an object");
        entry.config = { ...entry.config, ...config };
      }
      return roomWorkClaimConfig({ workClaims: entry.config });
    },
    configFor(roomId) { return roomWorkClaimConfig({ workClaims: room(roomId).config }); },
    rawConfig(roomId) { return { ...room(roomId).config }; },
  };
}

// Active claims in this room that declare files the given claim also
// declares. Returns [{ file, heldBy: [{ id, owner }] }] sorted by file.
const WARN_STATES = ["claimed", "in_progress", "blocked"];
export function fileWarningsFor(items, claimed) {
  if (!Array.isArray(claimed.files) || claimed.files.length === 0) return [];
  const active = items.filter(item => WARN_STATES.includes(item.state) && Array.isArray(item.files) && item.files.length > 0);
  const owners = new Map(active.map(item => [item.id, item.owner]));
  return findClaimCollisions(active.map(item => ({ id: item.id, lane: item.owner ?? undefined, status: item.state, files: item.files })))
    .filter(collision => collision.claims.includes(claimed.id))
    .map(collision => ({ file: collision.file, heldBy: collision.claims.filter(id => id !== claimed.id).map(id => ({ id, owner: owners.get(id) ?? null })) }));
}

const defaultRegistry = createWorkClaimRegistry();
export const workClaimRegistry = defaultRegistry;

// Strict body shapes: every required key present, no unknown keys.
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

const invalidInput = (reject, expected) => reject(422, "invalid_claim_input", `Expected ${expected}.`);

const claimIdOf = (reject, id) => {
  if (typeof id !== "string" || !CLAIM_ID_PATTERN.test(id)) invalidInput(reject, "a work id matching [A-Za-z0-9_-]{1,128}");
  return id;
};

// W1 (QA 2026-09-28): `data.leaseHours ?? undefined` converts an explicit
// null into "not provided", silently applying the 24h default. The pure
// machine treats null as "opt out of leases entirely" (leaseHoursOf), so the
// route must preserve the distinction between "key absent" (default) and
// "explicitly null" (no lease).
const leaseHoursOfBody = data => ("leaseHours" in data ? data.leaseHours : undefined);

// Writes (create, claim, renew, update) need a contribute, review, or
// collaborate profile, the room owner, or a human who holds contribute
// rights. Reading stays open to every member. A room that names no owner
// does not open the board: only an explicit member with one of those
// profiles can mutate.
const WORK_CLAIM_PROFILES = Object.freeze({
  contribute: ["accept_work", "complete_work"],
  review: ["verify"],
  collaborate: ["steer", "accept_work", "complete_work", "verify"],
});
const BOARD_LIMIT_DEFAULT = 50;
const BOARD_LIMIT_MAX = 200;
const BOARD_QUERY = new Set(["queue", "auth", "limit", "cursor", "state", "view"]);

// QA7-13: compact per-claim projection for ?view=summary — the fields a
// board overview needs (id, title, state, owner, lease expiry) without the
// heavy per-claim payload (history, description, notes, files, tags,
// reviews, attestations, dependsOn). Trust markers stamped before the
// projection survive, so member-authored titles stay marked untrusted.
function summarizeBoardClaim(item) {
  const summary = {
    id: item.id,
    title: item.title ?? item.id,
    state: item.state,
    owner: item.owner ?? null,
    leaseExpiresAt: item.leaseExpiresAt ?? null,
  };
  if (item.untrusted === true) summary.untrusted = true;
  return summary;
}

function resolveWorkClaimAccess(store, roomId, auth) {
  let authority = null;
  if (typeof store?.roomAuthority === "function") {
    try { authority = store.roomAuthority(roomId); } catch { authority = null; }
  }
  const ownerId = typeof authority?.ownerId === "string" && authority.ownerId.length > 0 ? authority.ownerId : null;
  const members = authority?.members;
  const memberId = auth?.member?.id;
  const listed = members && typeof members === "object" && typeof memberId === "string"
    && Object.hasOwn(members, memberId) && members[memberId];
  const member = listed && typeof listed === "object"
    ? {
      ...auth.member,
      ...listed,
      id: memberId,
      permissions: Array.isArray(listed.permissions) ? listed.permissions : (auth.member.permissions ?? []),
    }
    : null;
  return { authority, ownerId, member };
}

function holdsProfile(permissions, profile) {
  return WORK_CLAIM_PROFILES[profile].every(name => permissions.has(name));
}

export function mayWriteWorkClaims(access) {
  const member = access.member;
  if (!member || member.active === false) return false;
  if (access.ownerId && member.id === access.ownerId) return true;
  const permissions = new Set(member.permissions ?? []);
  if (member.kind === "human") return permissions.has("accept_work") || permissions.has("complete_work");
  return holdsProfile(permissions, "contribute") || holdsProfile(permissions, "review") || holdsProfile(permissions, "collaborate");
}

// Reviewing does not grant Board write access. A human with the existing
// verify right can record a verdict just like an agent review profile.
function mayReviewWorkClaims(access) {
  return Boolean(access.member && access.member.active !== false
    && (mayWriteWorkClaims(access) || (access.member.permissions ?? []).includes("verify")));
}

const reviewersOf = (store, roomId) => {
  const authority = store.roomAuthority(roomId);
  return Object.values(authority.members).filter(member => mayReviewWorkClaims({ ownerId: authority.ownerId, member })).map(member => member.id);
};

function mayManageAnyClaim(access) {
  const member = access.member;
  if (!member || member.active === false) return false;
  if (access.ownerId && member.id === access.ownerId) return true;
  return (member.permissions ?? []).includes("manage_claims");
}

function mayOptOutOfLease(access) {
  return mayManageAnyClaim(access);
}

// SEC-2: a review note (attestation) comes from the claim's reviewers: the
// room owner, members holding verify (the review profile), or manage_claims
// holders. A note never approves work; verdict reviews keep their own rule.
function mayAttestWorkClaims(access) {
  const member = access.member;
  if (!member || member.active === false) return false;
  if (access.ownerId && member.id === access.ownerId) return true;
  const permissions = member.permissions ?? [];
  return permissions.includes("verify") || permissions.includes("manage_claims");
}

// SEC-2: a sweep polls GitHub and releases lapsed leases. Board writers,
// manage_claims holders and the room owner may trigger it; the scheduled
// job runs the same lookup without a member.
function maySweepWorkClaims(access) {
  return mayWriteWorkClaims(access) || mayManageAnyClaim(access);
}

function refuseBoardAction(message, hint) {
  const error = new Error(message);
  error.status = 403;
  error.code = "work_claims_not_permitted";
  error.body = { error: { code: "work_claims_not_permitted", message }, hint, next: [{ command: hint }] };
  throw error;
}

const refuseAttest = () => refuseBoardAction(
  "Review notes on a claim come from the room owner, a member with the review profile, or a claim manager.",
  "Post your note in the room instead, or ask the room owner for a review invite.");
const refuseSweep = () => refuseBoardAction(
  "Sweeping the Board needs a contribute, review, or collaborate profile, claim management, or the room owner.",
  "Ask the room owner or a claim manager to sweep the Board.");

function refuseWorkClaims() {
  const message = "Creating, claiming, renewing, or updating work claims needs a contribute, review, or collaborate profile.";
  const hint = "Ask the room owner for a contribute invite.";
  const error = new Error(message);
  error.status = 403;
  error.code = "work_claims_not_permitted";
  error.body = {
    error: { code: "work_claims_not_permitted", message },
    hint,
    next: [{ command: hint }],
  };
  throw error;
}

function refuseCap(code, message, hint) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  error.body = { error: { code, message }, hint, next: [{ command: hint }] };
  throw error;
}

const boardLimitOf = (reject, raw) => {
  if (raw === null || raw === undefined) return BOARD_LIMIT_DEFAULT;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > BOARD_LIMIT_MAX) {
    invalidInput(reject, `limit as an integer 1..${BOARD_LIMIT_MAX}`);
  }
  return Number(raw);
};

const boardCursorOf = (reject, raw) => {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.q === "ready" && typeof parsed.i === "string") return parsed;
      if (typeof parsed.u === "string" && typeof parsed.i === "string" && parsed.q === undefined) return parsed;
    }
  } catch { /* rejected below */ }
  invalidInput(reject, "cursor as the opaque nextCursor from a prior work-claims page");
};

const boardCursorEncode = value => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function compareBoard(a, b) {
  const au = claimUpdatedAt(a);
  const bu = claimUpdatedAt(b);
  if (au !== bu) return au < bu ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function pageBoard(items, limit, cursor) {
  const sorted = [...items].sort(compareBoard);
  let start = 0;
  if (cursor) {
    start = sorted.findIndex(item => {
      const updatedAt = claimUpdatedAt(item);
      return updatedAt < cursor.u || (updatedAt === cursor.u && item.id > cursor.i);
    });
    if (start < 0) start = sorted.length;
  }
  const claims = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = claims[claims.length - 1];
  return {
    claims,
    hasMore,
    nextCursor: hasMore && last ? boardCursorEncode({ u: claimUpdatedAt(last), i: last.id }) : null,
  };
}

function pageReady(items, limit, cursor) {
  let start = 0;
  if (cursor) {
    start = items.findIndex(item => item.id > cursor.i);
    if (start < 0) start = items.length;
  }
  const claims = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const last = claims[claims.length - 1];
  return {
    claims,
    hasMore,
    nextCursor: hasMore && last ? boardCursorEncode({ q: "ready", i: last.id }) : null,
  };
}

// Evaluate lease expiry across the room's items; expired claims auto-release
// (owner cleared, history stamped by releaseExpired). Returns the ids that
// were released by this sweep.
function sweepRoom(registry, roomId, nowMs, onRelease = () => {}) {
  // SEC-2: only claims whose lease has already lapsed go through the state
  // machine; reading a large Board must not re-validate every done claim.
  const entry = registry.list(roomId).filter(item => ACTIVE_CLAIM_STATES.includes(item.state)
    && typeof item.leaseExpiresAt === "string" && Date.parse(item.leaseExpiresAt) <= nowMs);
  if (entry.length === 0) return [];
  const swept = releaseExpired(entry, nowMs);
  const released = [];
  // releaseExpired returns a normalized copy of every item, expired or not,
  // so compare states: only a claim that actually lapsed counts as swept.
  swept.forEach((item, index) => {
    if (item.state === "unclaimed" && entry[index].state !== "unclaimed") {
      registry.set(roomId, item); released.push(item.id); onRelease(item, entry[index]);
    }
  });
  return released;
}

const verifiersOf = (store, roomId) => {
  const members = store.roomAuthority(roomId).members;
  return Object.values(members)
    .filter(member => member && member.active !== false && (member.permissions ?? []).includes("verify"))
    .map(member => member.id);
};

const runPure = (reject, fn) => {
  try { return fn(); }
  catch (error) {
    if (error instanceof ClaimError) reject(422, error.code, error.message);
    throw error;
  }
};

// Receipts (RC-2026-09-24-205): the "what has this room already solved"
// surface. Done work items projected as receipts — `receiptId` is the
// stable projection `"rc_" + workItemId` — searchable by exact tag (AND)
// and case-insensitive substring over title + history notes. Summaries +
// blob pointers only; full bodies stay on the existing work-item read
// route. Sorted most-recently-completed first, offset-paginated with an
// opaque base64url cursor.
const RECEIPT_QUERY_PARAMS = ["q", "tag", "limit", "cursor"];
const RECEIPTS_DEFAULT_LIMIT = 20;
const RECEIPTS_MAX_LIMIT = 50;
const RECEIPT_SUMMARY_CHARS = 240;
const RECEIPT_MAX_Q = 500;

// The done transition stamps action "state:done" (see withHistory in
// server/work-claims.mjs); its `at` is the completion timestamp and its
// `note` is the completion note. Done is immutable, so there is exactly one.
const doneStampOf = item => [...item.history].reverse().find(entry => entry.action === "state:done") ?? null;
const doneAtMsOf = item => { const stamp = doneStampOf(item); return stamp ? Date.parse(stamp.at) : 0; };

const receiptOf = item => {
  const stamp = doneStampOf(item);
  const note = stamp?.note;
  const text = typeof note === "string" && note.trim().length > 0 ? note : (item.title ?? item.id);
  return Object.freeze({
    receiptId: `rc_${item.id}`,
    workItemId: item.id,
    tags: Object.freeze([...(item.tags ?? [])]),
    summary: text.slice(0, RECEIPT_SUMMARY_CHARS),
    createdBy: item.owner,
    createdAt: doneAtMsOf(item),
    blobs: Object.freeze([...(item.blobs ?? [])]),
  });
};

const receiptsQueryOf = (reject, params) => {
  if ([...params.keys()].some(key => !RECEIPT_QUERY_PARAMS.includes(key))) {
    reject(422, "invalid_receipt_query", "q, tag, limit and cursor are the accepted query parameters");
  }
  for (const key of ["q", "limit", "cursor"]) {
    if (params.getAll(key).length > 1) reject(422, "invalid_receipt_query", `${key} must appear at most once`);
  }
  const q = params.get("q");
  if (q !== null && q.length > RECEIPT_MAX_Q) reject(422, "invalid_receipt_query", `q must be at most ${RECEIPT_MAX_Q} characters`);
  const tags = params.getAll("tag");
  for (const tag of tags) {
    if (!isReceiptTag(tag)) reject(422, "invalid_receipt_query", `tag "${tag}" must match [A-Za-z0-9_-]{1,32}`);
  }
  const limitParam = params.get("limit");
  const limit = limitParam === null ? RECEIPTS_DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECEIPTS_MAX_LIMIT) {
    reject(422, "invalid_receipt_query", `limit must be 1..${RECEIPTS_MAX_LIMIT}`);
  }
  return { q, tags, limit, cursor: params.get("cursor") };
};

const cursorEncode = offset => Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
const cursorDecode = (reject, value) => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) return parsed.offset;
  } catch { /* fall through to the rejection below */ }
  reject(400, "bad_cursor", "cursor must be the opaque nextCursor from a prior receipts response");
};

// REST and hosted MCP share this owner-only mutation, including a fresh
// authorization and claim read inside the registry transaction. This does not
// sweep or settle other work, renew the lease, or synchronously contact GitHub.
export function linkWorkClaimPullRequest({ store, roomId, auth, claimId, data, registry = store.workClaims, reauthorize }) {
  const reject = (status, code, message) => { throw new ServiceError(status, code, message); };
  const run = () => {
    const current = reauthorize ? reauthorize() : auth;
    if (!current?.member?.id) reject(401, "unauthenticated", "Room authentication is required");
    if (current.member.id !== auth?.member?.id) reject(403, "access_denied", "The acting identity changed");
    if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1)))) {
      reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
    }
    if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    const access = resolveWorkClaimAccess(store, roomId, current);
    if (!mayWriteWorkClaims(access)) refuseWorkClaims();
    enforceAutonomyTierForAction({ db: store.db, roomId, state: { room: { ownerId: access.ownerId } },
      actor: access.member, action: "POST work-claim update", fail: reject });
    if (isRoomArchived(store.room(roomId).state)) reject(409, "room_archived", "This room is archived; no PR link was recorded");
    assertBoardEventBudget(access.authority?.sequence, { privileged: mayManageAnyClaim(access) });
    claimIdOf(reject, claimId);
    refuseRoomGuideOffStarter(registry, roomId, current, claimId, "POST", reject);
    if (!shape(data, { required: ["appendPullRequest", "expectedClaimedAt", "expectedHistoryLength"] })) {
      invalidInput(reject, "{appendPullRequest, expectedClaimedAt, expectedHistoryLength} without other update fields");
    }
    const item = registry.get(roomId, claimId);
    if (!item) reject(404, "work_claim_not_found", `No work claim "${claimId}" in this room`);
    const now = typeof store.now === "function" ? store.now() : Date.now();
    let linked;
    try {
      linked = appendWorkPullRequest(item, current.member.id, { pullRequest: data.appendPullRequest,
        expectedClaimedAt: data.expectedClaimedAt, expectedHistoryLength: data.expectedHistoryLength, now });
    } catch (error) {
      if (!(error instanceof ClaimError)) throw error;
      const status = error.code === "work_not_owner" ? 403 : error.code === "invalid_claim_input" ? 422 : 409;
      const refusal = new ServiceError(status, error.code, error.message);
      if (status !== 422) {
        const href = `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}`;
        const hint = "Read the current claim and check its owner, round and URL before retrying. Do not release or reacquire it.";
        refusal.body = { ...agentErrorBody({ httpStatus: status, code: error.code, message: error.message, roomId, workItemId: claimId }),
          hint, next: [{ path: href }, { command: hint }] };
      }
      throw refusal;
    }
    if (linked === item) return item;
    registry.set(roomId, linked);
    emitWorkClaimEvent(store, roomId, { actorId: current.member.id, item: linked, action: "state_changed", atMs: now });
    return linked;
  };
  return registry.transaction ? registry.transaction(run) : run();
}

// Consume the body before opening SQLite's synchronous transaction. The read,
// state transition and write then share one transaction; send the response only
// after commit, so a storage refusal cannot be reported as a successful claim.
export async function handleWorkClaims(options) {
  const { req, res, helpers, reauthorize } = options;
  const registry = options.registry ?? options.store.workClaims ?? defaultRegistry;
  const requestData = req.method === "POST" ? await helpers.body(req) : undefined;
  // The append alternative has one shared transaction across both transports.
  if (options.workClaimRoute === "update" && req.method === "POST"
    && requestData && typeof requestData === "object" && Object.hasOwn(requestData, "appendPullRequest")) {
    try {
      const item = linkWorkClaimPullRequest({ store: options.store, roomId: options.roomId,
        auth: options.auth, claimId: options.workClaimId, data: requestData, registry, reauthorize });
      return helpers.json(res, 200, item);
    } catch (error) {
      if (Number.isInteger(error?.status) && error.body && error.code) return helpers.json(res, error.status, error.body);
      throw error;
    }
  }
  // Pull-request lookups happen before the claim transaction so a GitHub
  // round trip never holds the room write lock. No webhook receiver is
  // mounted; sweep is the member-triggered poll, and the cron uses the same
  // lookup. An empty room, or a sweep with nothing due, does not call fetch.
  let pullBatch = { results: [], rateLimitedUntil: null, skipped: false };
  let deployStatus = null;
  if (options.workClaimRoute === "status" && req.method === "GET") {
    const credential = options.githubToken !== undefined
      ? options.githubToken
      : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null);
    // SEC-2 / Q3-A: every member reads the shared cached status; only a
    // Board writer's ?refresh=1 skips the 60 s cache.
    const access = resolveWorkClaimAccess(options.store, options.roomId, options.auth);
    const force = options.url?.searchParams?.get("refresh") === "1" && maySweepWorkClaims(access);
    deployStatus = await readBoardDeployStatus(options.store, {
      fetchImpl: options.fetchPullRequest ?? fetch,
      token: credential || null,
      nowMs: Date.now(),
      force,
    });
  }
  if (options.workClaimRoute === "sweep" && req.method === "POST"
    && !maySweepWorkClaims(resolveWorkClaimAccess(options.store, options.roomId, reauthorize ? reauthorize() : options.auth))) {
    // Refuse before any GitHub lookup; the transaction checks again.
    try { refuseSweep(); } catch (error) { return helpers.json(res, error.status, error.body); }
  }
  if (options.workClaimRoute === "sweep") {
    const nowMs = Date.now();
    const budget = readClaimPullBudget(options.store);
    if (budget > nowMs) {
      pullBatch = { results: [], rateLimitedUntil: budget, skipped: true };
    } else {
      const credential = options.githubToken !== undefined
        ? options.githubToken
        : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null);
      pullBatch = await collectPullRequestLookups(registry.list(options.roomId), {
        fetchImpl: options.fetchPullRequest ?? fetch,
        token: credential || null,
        nowMs
      });
    }
  }
  const run = () => handleWorkClaimsCore({ ...options, registry, pullBatch, deployStatus,
    auth: reauthorize ? reauthorize() : options.auth,
    helpers: { ...helpers, body: () => requestData, json: (_res, status, value) => ({ status, value }) },
  });
  try {
    const result = registry.transaction ? registry.transaction(run) : run();
    return helpers.json(res, result.status, result.value);
  } catch (error) {
    if (error?.code === "file_lease_conflict" && error.body) return helpers.json(res, 409, error.body);
    if (Number.isInteger(error?.status) && error.body && error.code) return helpers.json(res, error.status, error.body);
    throw error;
  }
}

// ACT-1a: Room Guide may claim and close only claims tagged starter. This is
// the HTTP choke point (the handler cannot be wrapped, and server/http.mjs is
// out of scope). It runs before the owner check so a non-starter claim is
// guide_starter_only, not work_not_owner. C's capability check, when it lands,
// should keep this refusal.
function refuseRoomGuideOffStarter(registry, roomId, auth, workClaimId, method, reject) {
  if (method === "GET" || method === "HEAD") return;
  if (auth?.member?.id !== ROOM_GUIDE_ID) return;
  const item = typeof workClaimId === "string" ? registry.get(roomId, workClaimId) : null;
  if (!item?.tags?.includes("starter")) {
    reject(403, "guide_starter_only", "Room Guide can only claim and close starter tasks.");
  }
}

// One decoded room list per request: the sweep, live-claim closing and the
// list page share it until a write invalidates it.
function memoizeList(registry) {
  const cache = new Map();
  return Object.assign(Object.create(registry), {
    list(roomId) {
      if (!cache.has(roomId)) cache.set(roomId, registry.list(roomId));
      return cache.get(roomId);
    },
    set(roomId, item) { cache.delete(roomId); return registry.set(roomId, item); },
    delete(roomId, id) { cache.delete(roomId); return registry.delete(roomId, id); },
  });
}

function handleWorkClaimsCore({ req, res, url, store, roomId, auth, workClaimRoute, workClaimId, helpers, registry: sourceRegistry, pullBatch = { results: [], rateLimitedUntil: null, skipped: false }, deployStatus = null }) {
  const { json, reject, body } = helpers;
  const registry = memoizeList(sourceRegistry);
  if (req.method !== "GET" && req.method !== "HEAD") enforceAutonomyTierForAction({
    db: store.db, roomId, state: { room: { ownerId: store.roomAuthority?.(roomId)?.ownerId } },
    actor: auth.member, action: `${req.method} work-claim ${workClaimRoute}`, fail: reject });
  refuseRoomGuideOffStarter(registry, roomId, auth, workClaimId, req.method, reject);
  const nowMs = typeof store.now === "function" ? store.now() : Date.now();
  const caller = auth.member.id;
  // Every committed claim change appends one work_claim.updated room event
  // inside this transaction (server/work-claim-events.mjs).
  const commit = (item, action, extra = {}) => {
    // A release clears files on the item. Read the held paths first so the
    // receipt names the lane that opened, then write the claim and the event
    // in this same transaction. A pull request that closes does the same.
    const prior = action === "released" || action === "pr_closed" ? registry.get(roomId, item.id) : null;
    registry.set(roomId, item);
    const receipt = emitWorkClaimEvent(store, roomId, {
      actorId: extra.actorId ?? caller,
      item,
      action,
      previousOwnerId: extra.previousOwnerId ?? null,
      atMs: nowMs,
      paths: action === "released" || action === "pr_closed" ? (prior?.files ?? []) : undefined,
      pullRequest: extra.pullRequest,
      reason: extra.reason,
      ciState: extra.ciState,
      verdict: extra.verdict,
      attention: extra.attention,
      attentionMemberId: extra.attentionMemberId,
      coalesce: extra.coalesce === true
    });
    if (extra.wakeMemberId && extra.wakeReason) {
      const stamp = extra.wakeStamp ?? receipt?.sequence ?? nowMs;
      enqueueClaimWake(store, roomId, extra.wakeMemberId,
        `work-claim:${item.id}:${extra.wakeReason}:${stamp}`,
        { reason: extra.wakeReason, actorId: extra.actorId ?? caller });
    }
    // BOARD-WAKE-2: an unassigned create or a release is new ready work for
    // agents that opted in (server/work-wants.mjs). Default off; never throws.
    if (action === "created" || action === "released") noteReadyWork(store, roomId, item, { actorId: extra.actorId ?? caller, now: nowMs });
    return item;
  };
  const closeLiveClaims = () => {
    const closed = [];
    for (const item of registry.list(roomId)) {
      if ((item.kind !== "land" && item.kind !== "deploy") || item.state === "done") continue;
      const next = closeWhenLive(item, SOURCE_REVISION, nowMs);
      if (!next) continue;
      commit(next, "state_changed");
      closed.push(next.id);
    }
    return closed;
  };
  const sweptIds = sweepRoom(registry, roomId, nowMs, (item, before) => {
    const receipt = emitWorkClaimEvent(store, roomId, {
      actorId: before.owner, item, action: "lease_expired", previousOwnerId: before.owner,
      atMs: nowMs, paths: before.files ?? []
    });
    // One wake per expiry. The message id includes the lapsed lease time, so
    // a later claim that expires again wakes again, and a repeat sweep of
    // this lapse coalesces.
    enqueueClaimWake(store, roomId, before.owner,
      `work-claim:${item.id}:lease_expired:${before.leaseExpiresAt ?? receipt?.sequence ?? nowMs}`,
      { reason: "lease_expired", actorId: before.owner });
  });
  const config = registry.configFor(roomId);
  const roomLike = { workClaims: registry.rawConfig(roomId) };
  const access = resolveWorkClaimAccess(store, roomId, auth);
  const requireWriter = () => { if (!mayWriteWorkClaims(access)) refuseWorkClaims(); };
  // Q3-A: with under 10% of the room's event budget left, Board writes from
  // members without claim authority get 409 room_event_budget_low.
  const requireEventBudget = () => assertBoardEventBudget(access.authority?.sequence, { privileged: mayManageAnyClaim(access) });
  const text = (field, value, options) => boardText(reject, field, value, options);
  const assertLeaseChoice = data => {
    if (!data || !("leaseHours" in data) || data.leaseHours !== null || mayOptOutOfLease(access)) return;
    invalidInput(reject, `leaseHours greater than 0 and at most ${MAX_LEASE_HOURS}; null is only for the room owner or manage_claims`);
  };

  const load = id => {
    const item = registry.get(roomId, id);
    if (!item) reject(404, "work_claim_not_found", `No work claim "${id}" in this room`);
    return item;
  };
  // Returns true when the caller is the room owner or holds manage_claims
  // and is acting on someone else's claim. The claim holder takes the
  // ordinary path. Fixtures that do not name an owner stay holder-only.
  const authorityOver = item => {
    if (item.owner === caller) return false;
    if (mayManageAnyClaim(access)) return true;
    reject(403, "work_not_owner", `Work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can change it`);
  };

  if (workClaimRoute === "status" && req.method === "GET") {
    closeLiveClaims();
    const status = deployStatus ?? { live: SOURCE_REVISION, main: null, behind: null, checkedAt: null };
    return json(res, 200, { live: status.live, main: status.main, behind: status.behind, checkedAt: status.checkedAt,
      stale: status.stale === true, ...(status.heldUntil ? { heldUntil: status.heldUntil } : {}),
      eventsRemaining: roomEventsRemaining(access.authority?.sequence) });
  }
  if (workClaimRoute === "list" && req.method === "GET") {
    closeLiveClaims();
    const params = url?.searchParams ?? new URLSearchParams();
    for (const key of params.keys()) {
      if (!BOARD_QUERY.has(key) || params.getAll(key).length !== 1) {
        invalidInput(reject, "a single queue, state, limit, cursor, or view query parameter");
      }
    }
    const limit = boardLimitOf(reject, params.get("limit"));
    const cursor = params.has("cursor") ? boardCursorOf(reject, params.get("cursor")) : null;
    const view = params.get("view");
    if (view !== null && view !== "summary") invalidInput(reject, "view=summary");
    // SEC-2: list pages carry each claim's newest history entries, with the
    // rest counted in historyOmitted; the single-claim read has the stored
    // history. Member-authored text is marked untrusted for the reader.
    const present = page => stampClaimPage({ ...page, claims: page.claims.map(item => summarizeClaimHistory(item, LIST_HISTORY_ENTRIES)) }, caller);
    // QA7-13: ?view=summary keeps the same items, paging envelope, and trust
    // stamps as the default view, but projects each claim to the compact
    // board shape. The stamps run before the projection so an
    // undeterminable author still marks the summary untrusted.
    const presentSummary = page => withContentTrust({ ...page, claims: page.claims.map(item =>
      summarizeBoardClaim(stampClaim(summarizeClaimHistory(item, LIST_HISTORY_ENTRIES), caller))) });
    const render = view === "summary" ? presentSummary : present;
    if (params.has("queue")) {
      if (params.get("queue") !== "ready") invalidInput(reject, "queue=ready");
      if (params.has("state")) invalidInput(reject, "either queue=ready or state, not both");
      if (cursor && cursor.q !== "ready") invalidInput(reject, "a cursor from a queue=ready page");
      const page = pageReady(readyClaims(registry.list(roomId)), limit, cursor);
      return json(res, 200, { roomId, queue: "ready", swept: sweptIds, ...render(page) });
    }
    if (cursor?.q === "ready") invalidInput(reject, "a cursor from a work-claims page");
    const items = registry.list(roomId);
    if (params.has("state")) {
      const state = params.get("state");
      if (!STATES.includes(state)) invalidInput(reject, `state one of ${STATES.join(", ")}`);
      const page = pageBoard(items.filter(item => item.state === state), limit, cursor);
      return json(res, 200, { roomId, state, swept: sweptIds, ...render(page) });
    }
    // SEC-2: the default list shows done claims from the last 7 days (the
    // Landed column) and any done claim an open claim depends on. Older done
    // claims page through ?state=done.
    const since = nowMs - DONE_WINDOW_MS;
    const needed = new Set(items.filter(item => item.state !== "done").flatMap(item => item.dependsOn ?? []));
    const recent = item => item.state !== "done" || needed.has(item.id) || Date.parse(claimUpdatedAt(item)) >= since;
    const visible = items.filter(recent);
    const olderDone = items.length - visible.length;
    const page = pageBoard(visible, limit, cursor);
    return json(res, 200, { roomId, swept: sweptIds, ...render(page), ...(olderDone > 0 ? { olderDone, olderDoneQuery: "state=done" } : {}) });
  }
  if (workClaimRoute === "receipts" && req.method === "GET") {
    // RC-2026-09-24-205: receipts search. The room block already rejected
    // unauthenticated callers (401); this names the member contract —
    // authenticated non-members get 403 not_member. Reads stay open to
    // guest agents, like every other GET on this family.
    const members = store.roomAuthority(roomId).members ?? {};
    const member = members[caller];
    if (!member || member.active === false) {
      reject(403, "not_member", `Member "${caller}" is not a member of room "${roomId}"`);
    }
    const { q, tags, limit, cursor } = receiptsQueryOf(reject, url.searchParams);
    const offset = cursor === null ? 0 : cursorDecode(reject, cursor);
    const needle = q === null ? null : q.toLowerCase();
    const matches = item => {
      if (tags.length > 0 && !tags.every(tag => (item.tags ?? []).includes(tag))) return false;
      if (needle !== null) {
        const haystack = [item.title ?? "", ...item.history.map(entry => entry.note ?? "")]
          .join("\n").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    };
    const ranked = registry.list(roomId)
      .filter(item => item.state === "done")
      .filter(matches)
      .sort((a, b) => doneAtMsOf(b) - doneAtMsOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = ranked.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return json(res, 200, stampReceipts({
      receipts: page.map(receiptOf),
      nextCursor: nextOffset < ranked.length ? cursorEncode(nextOffset) : null,
    }, caller));
  }
  if (workClaimRoute === "sweep" && req.method === "POST") {
    if (!maySweepWorkClaims(access)) refuseSweep();
    const data = body(req);
    if (!shape(data, {})) invalidInput(reject, "an empty JSON object");
    let updated = 0;
    let checked = 0;
    const rateLimited = pullBatch.skipped || pullBatch.rateLimitedUntil != null;
    for (const result of pullBatch.results) {
      if (result.kind === "rateLimited") continue;
      const current = registry.get(roomId, result.claimId);
      checked += 1;
      if (commitPullRequestLookup(store, registry, roomId, current, result, nowMs)) updated += 1;
    }
    if (pullBatch.rateLimitedUntil && !pullBatch.skipped) {
      for (const item of registry.list(roomId)) {
        if (!item.pullRequest?.url || item.pullRequest.outcome) continue;
        if (!["claimed", "in_progress", "blocked"].includes(item.state)) continue;
        registry.set(roomId, holdForRateLimit(registry.get(roomId, item.id), nowMs, pullBatch.rateLimitedUntil));
      }
      writeClaimPullBudget(store, pullBatch.rateLimitedUntil, nowMs);
    }
    return json(res, 200, {
      roomId, released: sweptIds, sweptAt: new Date(nowMs).toISOString(),
      pullRequests: { checked, updated, ...(rateLimited ? { rateLimited: true } : {}) }
    });
  }
  if (workClaimRoute === "duplicates" && req.method === "GET") {
    // Linear-style "similar issues": fuzzy match over the room's claim
    // registry. Read-only — suggests candidates, never merges or closes.
    const params = url.searchParams;
    for (const key of params.keys()) {
      if (!["q", "limit"].includes(key) || params.getAll(key).length !== 1) {
        invalidInput(reject, "only single q and limit query parameters");
      }
    }
    const q = params.get("q");
    if (typeof q !== "string" || q.length === 0 || q.length > 512) {
      invalidInput(reject, "a q query parameter of 1..512 characters");
    }
    let limit = 5;
    if (params.has("limit")) {
      const raw = params.get("limit");
      if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 20) invalidInput(reject, "limit as an integer 1..20");
      limit = Number(raw);
    }
    let duplicates;
    try {
      duplicates = findDuplicates(registry.list(roomId), q, { limit });
    } catch (error) {
      if (error instanceof DuplicateError) reject(422, error.code, error.message);
      throw error;
    }
    return json(res, 200, { roomId, query: q, duplicates });
  }
  if (workClaimRoute === "create" && req.method === "POST") {
    const raw = body(req);
    if (!shape(raw, { required: ["id"], optional: ["title", "reviewPolicy", "note", "tags", "files", "dependsOn", "pullRequest", "pullRequests", "repo", "branch", "kind", "revision", "assignee"] })) invalidInput(reject, "{id, title?, reviewPolicy?, note?, tags?, files?, dependsOn?, pullRequest?, pullRequests?, repo?, branch?, kind?, revision?, assignee?}");
    requireWriter();
    requireEventBudget();
    const id = claimIdOf(reject, raw.id);
    const data = clientPullRequestInput(reject, boardTextFields(reject, raw, { title: {}, note: { multiline: true } }));
    assertDependsOnKnown(reject, data, { selfId: id, has: other => registry.has(roomId, other) });
    if (registry.has(roomId, id)) reject(409, "work_claim_exists", `Work claim "${id}" already exists in this room`);
    const open = registry.list(roomId).filter(item => item.state !== "done").length;
    if (open >= config.maxOpenClaims) {
      refuseCap("work_board_full",
        `This room already has ${config.maxOpenClaims} open claims. Close stale claims before opening another.`,
        "Close stale claims before opening another.");
    }
    if (data.reviewPolicy !== undefined && !REVIEW_POLICIES.includes(data.reviewPolicy)) invalidInput(reject, `reviewPolicy one of ${REVIEW_POLICIES.join(", ")}`);
    if (data.kind !== undefined && !CLAIM_KINDS.includes(data.kind)) invalidInput(reject, `kind one of ${CLAIM_KINDS.join(", ")}`);
    const assignee = data.assignee;
    if (assignee !== undefined) {
      const members = store.roomAuthority(roomId).members ?? {};
      const member = typeof assignee === "string" ? members[assignee] : null;
      if (!member || member.active === false) {
        reject(422, "work_assignee_unknown_member",
          `assignee "${typeof assignee === "string" ? assignee : "?"}" is not an active member of this room`);
      }
    }
    let item = runPure(reject, () => createWork({ id, title: data.title, reviewPolicy: data.reviewPolicy, note: data.note, tags: data.tags, files: data.files, dependsOn: data.dependsOn, pullRequest: data.pullRequest, pullRequests: data.pullRequests, repo: data.repo, branch: data.branch, kind: data.kind, revision: data.revision }, { now: nowMs, agentId: caller }));
    if (assignee) {
      const held = registry.list(roomId).filter(entry => entry.owner === assignee && ACTIVE_CLAIM_STATES.includes(entry.state)).length;
      if (held >= config.maxMemberOpenClaims) {
        refuseCap("too_many_open_claims",
          `${assignee} already holds ${config.maxMemberOpenClaims} open claims. Release or finish one before assigning another.`,
          "Release or finish an open claim before assigning another.");
      }
      item = runPure(reject, () => claimWork(item, assignee, {
        note: data.note ?? `assigned by ${caller}`, room: roomLike, now: nowMs
      }));
      // Retention ack (research brief 2026-09-28, mechanic #2): every claim
      // gets the bot's immediate structured receipt, so no contribution sits
      // at zero replies from t=0. First-time contributors carry the 24h
      // verdict SLA in the ack note. One commit, one room event.
      const firstAssignee = isFirstContribution(registry.list(roomId), assignee);
      const ackedAssignee = retentionAck(item, { now: nowMs, first: firstAssignee, agentId: assignee });
      commit(ackedAssignee, "claimed", {
        attention: "assigned", attentionMemberId: assignee,
        wakeMemberId: assignee, wakeReason: "assigned"
      });
      return json(res, 201, ackedAssignee);
    }
    commit(item, "created");
    return json(res, 201, item);
  }
  if (workClaimRoute === "read" && req.method === "GET") {
    closeLiveClaims();
    // SEC-2: member-authored text is marked untrusted for the reader.
    return json(res, 200, withContentTrust(stampClaim(load(claimIdOf(reject, workClaimId)), caller)));
  }
  if (workClaimRoute === "claim" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["note", "leaseHours", "files", "advisory", "dependsOn", "pullRequest", "pullRequests", "repo", "branch"] })) invalidInput(reject, "{note?, leaseHours?, files?, advisory?, dependsOn?, pullRequest?, pullRequests?, repo?, branch?}");
    if ("advisory" in data && typeof data.advisory !== "boolean") invalidInput(reject, "advisory true or false");
    const item = load(claimIdOf(reject, workClaimId));
    if (item.state !== "unclaimed") reject(409, "work_claim_conflict", `Work "${item.id}" is already ${item.state} — release it first`);
    requireWriter();
    requireEventBudget();
    assertLeaseChoice(data);
    assertBoardLeaseHours(reject, data);
    assertDependsOnKnown(reject, data, { selfId: item.id, has: other => registry.has(roomId, other) });
    Object.assign(data, clientPullRequestInput(reject, boardTextFields(reject, data, { note: { multiline: true } })));
    const held = registry.list(roomId).filter(entry => entry.owner === caller && ACTIVE_CLAIM_STATES.includes(entry.state)).length;
    if (held >= config.maxMemberOpenClaims) {
      refuseCap("too_many_open_claims",
        `You already hold ${config.maxMemberOpenClaims} open claims. Release or finish one before claiming another.`,
        "Release or finish an open claim before claiming another.");
    }
    const claimed = runPure(reject, () => claimWork(item, caller, {
      note: data.note, leaseHours: leaseHoursOfBody(data), files: data.files,
      dependsOn: data.dependsOn, pullRequest: data.pullRequest, pullRequests: data.pullRequests,
      repo: data.repo, branch: data.branch, room: roomLike, now: nowMs
    }));
    // Exclusive file lease. Overlap with another live claim is a 409 that
    // names the holder, the files, and when that lease ends. advisory: true
    // keeps the older warn-and-proceed behavior.
    const conflicts = fileLeaseConflicts(registry.list(roomId), claimed);
    if (conflicts.length > 0 && data.advisory !== true) {
      const conflict = fileLeaseConflictBody(claimed, conflicts);
      const body = {
        ...agentErrorBody({ httpStatus: 409, code: "file_lease_conflict", message: conflict.error.message, roomId, workItemId: claimed.id }),
        ...conflict
      };
      const error = new Error(body.error.message);
      error.code = "file_lease_conflict";
      error.body = body;
      throw error;
    }
    // Retention ack (research brief 2026-09-28, mechanic #2): every claim gets
    // the bot's immediate structured receipt, so no contribution sits at zero
    // replies from t=0. First-time contributors carry the 24h verdict SLA in
    // the ack note. Firstness is read from the pre-claim registry state
    // excluding the item being claimed: a member who creates an item and
    // claims it in the same flow is still a first-time contributor — the
    // created stamp is not a prior contribution. The ack rides the same
    // commit, so this stays one room event.
    const first = isFirstContribution(registry.list(roomId).filter(entry => entry.id !== item.id), caller);
    const acked = retentionAck(claimed, { now: nowMs, first, agentId: caller });
    commit(acked, "claimed");
    return json(res, 200, { ...acked, fileWarnings: data.advisory === true ? fileWarningsFor(registry.list(roomId), acked) : [] });
  }
  if (workClaimRoute === "update" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["state", "note", "deliveryMode", "reviewedBy", "tags", "blobs"] })) invalidInput(reject, "{state?, note?, deliveryMode?, reviewedBy?, tags?, blobs?}");
    if (data.state === undefined && data.note === undefined) invalidInput(reject, "a state transition or a note");
    const item = load(claimIdOf(reject, workClaimId));
    if (item.owner !== caller) reject(403, "work_not_owner", `Work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can change it`);
    requireWriter();
    requireEventBudget();
    if (Object.hasOwn(data, "note")) data.note = text("note", data.note, { multiline: true });
    if (data.state === "done") {
      // QA-Sec 2026-09-19: the reviewer must be authenticated. For
      // self_attested the reviewer is the owner (the caller). For the
      // stronger policies the named reviewer must have recorded an
      // attestation from their own session via the review route — naming
      // another member without their attestation is rejected (confused
      // deputy). canCloseWork then applies the policy (distinct member /
      // verify permission) to the attested reviewer.
      const policy = item.reviewPolicy ?? config.reviewPolicy;
      if (policy === "self_attested") {
        const reviewer = data.reviewedBy ?? caller;
        if (reviewer !== caller) {
          reject(403, "work_review_rejected",
            `Review policy "self_attested" not satisfied for "${item.id}": only the owner may attest this work`);
        }
      } else {
        const reviewer = data.reviewedBy;
        if (typeof reviewer !== "string" || reviewer.length === 0 || reviewer.length > 128) {
          reject(403, "work_review_rejected",
            `Review policy "${policy}" not satisfied for "${item.id}": reviewedBy must name the member who attested this work`);
        }
        const attested = (item.attestations ?? []).some(entry => entry.memberId === reviewer);
        if (!attested) {
          reject(403, "work_review_rejected",
            `Review policy "${policy}" not satisfied for "${item.id}": no review attestation recorded by ${reviewer}`);
        }
        const verifiers = verifiersOf(store, roomId);
        if (!canCloseWork(item, reviewer, { policy, verifyMembers: verifiers, reviewMembers: reviewersOf(store, roomId) })) {
          reject(403, "work_review_rejected",
            `Review policy "${policy}" not satisfied for "${item.id}": a current affirmative review by an authorized reviewer is required`);
        }
      }
    }
    const updated = runPure(reject, () => updateWork(item, caller,
      { state: data.state, note: data.note, deliveryMode: data.deliveryMode, reviewedBy: data.reviewedBy,
        tags: data.tags, blobs: data.blobs, now: nowMs }));
    if (data.state === "done") {
      // Jev-harness receipt-acceptance gate, shadow mode (docs/JEV-GATES.md):
      // score the receipt, journal the would-be verdict (flagging
      // low-confidence accepts for a human look), then accept anyway —
      // shadow mode never changes the outcome. Never throws: a scoring or
      // journal failure cannot break the done transition.
      try {
        const policy = updated.reviewPolicy ?? config.reviewPolicy;
        const reviewer = policy === "self_attested" ? (data.reviewedBy ?? caller) : data.reviewedBy;
        const receiptDecision = evaluateReceipt({
          workId: updated.id, ownerId: updated.owner ?? null,
          reviewPolicy: policy,
          attestations: updated.attestations ?? [],
          reviewerIsVerifier: typeof reviewer === "string" && verifiersOf(store, roomId).includes(reviewer),
          deliveryMode: updated.deliveryMode ?? null,
          note: typeof data.note === "string" ? data.note : null,
          claimedAtMs: updated.claimedAt ? Date.parse(updated.claimedAt) : null,
          doneAtMs: nowMs, at: nowMs,
        });
        store.jevShadow.record({ gate: "receipt", roomId, identityId: updated.owner ?? null,
          subject: updated.id, path: "work-claim:done",
          score: receiptDecision.quality, decision: receiptDecision.verdict,
          escalate: receiptDecision.escalate, signals: receiptDecision.signals, at: nowMs });
      } catch { /* shadow-only: never break the done transition */ }
    }
    // Q3-A: a note-only update coalesces with this claim's last room event.
    commit(updated, "state_changed", { coalesce: data.state === undefined || data.state === item.state });
    return json(res, 200, updated);
  }
  if (workClaimRoute === "review" && req.method === "POST") {
    // A verdict review is a record from someone other than the owner who
    // holds contribute or review rights. The older {note} body stays an
    // caller-bound note; it does not satisfy reviewed completion.
    const data = body(req);
    const verdictReview = data && typeof data === "object" && !Array.isArray(data) && ("verdict" in data || "summary" in data || "url" in data);
    if (verdictReview) {
      if (!shape(data, { required: ["verdict", "summary"], optional: ["url"] })) invalidInput(reject, "{verdict, summary, url?}");
      if (!mayReviewWorkClaims(access)) refuseWorkClaims();
      requireEventBudget();
      data.summary = text("summary", data.summary, { multiline: true });
      const item = load(claimIdOf(reject, workClaimId));
      if (item.owner === caller) reject(403, "work_review_rejected", "The owner cannot review their own claim");
      const reviewed = runPure(reject, () => recordReview(item, caller, { verdict: data.verdict, summary: data.summary, url: data.url, now: nowMs }));
      const duplicate = reviewed.history === item.history;
      if (!duplicate) commit(reviewed, "reviewed", { reason: "reviewed", verdict: data.verdict });
      if (!duplicate && data.verdict === "changes_requested") {
        enqueueClaimWake(store, roomId, item.owner, `work-claim:${item.id}:review:${caller}:${nowMs}`, { reason: "review", actorId: caller });
      }
      return json(res, 200, duplicate ? item : reviewed);
    }
    if (!shape(data, { optional: ["note"] })) invalidInput(reject, "{note?} or {verdict, summary, url?}");
    if (!mayAttestWorkClaims(access)) refuseAttest();
    requireEventBudget();
    const note = text("note", data.note, { multiline: true });
    const item = load(claimIdOf(reject, workClaimId));
    const attested = runPure(reject, () => attestWork(item, caller, { note, now: nowMs }));
    if (attested.history !== item.history) {
      // A new attestation: one history entry, and at most one room event per
      // claim per 60 s for review notes.
      commit(attested, "reviewed", { coalesce: true });
      return json(res, 200, attested);
    }
    const before = item.attestations.find(entry => entry.memberId === caller);
    const after = attested.attestations.find(entry => entry.memberId === caller);
    // SEC-2: a repeat note from this reviewer on the same claim round and
    // revision replaces the stored note without a history entry or event.
    if (before?.note !== after?.note) { registry.set(roomId, attested); return json(res, 200, attested); }
    return json(res, 200, item);
  }
  if (workClaimRoute === "release" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["note", "reason"] })) invalidInput(reject, "{reason?, note?}");
    let item = load(claimIdOf(reject, workClaimId));
    const authority = authorityOver(item);
    requireEventBudget();
    const reason = text(Object.hasOwn(data, "reason") ? "reason" : "note", data.reason ?? data.note, { multiline: true });
    // W2 (QA 2026-09-28): /release used to 422 on in_progress claims with no
    // recovery path. The pure machine's release path is claimed -> unclaimed,
    // so route an active claim through the pause transition internally —
    // both steps are stamped in history — instead of refusing.
    if (item.state === "in_progress" || item.state === "blocked") {
      item = runPure(reject, () => updateWork(item, caller, { state: "claimed", note: "paused for release", now: nowMs, authority }));
      registry.set(roomId, item);
    }
    const released = runPure(reject, () => updateWork(item, caller, { state: "unclaimed", note: reason, now: nowMs, authority }));
    commit(released, "released");
    return json(res, 200, released);
  }
  if (workClaimRoute === "reassign" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { required: ["newOwner"], optional: ["note"] })) invalidInput(reject, "{newOwner, note?}");
    const item = load(claimIdOf(reject, workClaimId));
    const authority = authorityOver(item);
    // W3 (QA 2026-09-28): /reassign used to accept any newOwner string, so a
    // typo stranded the claim on a nonexistent member (owner-only routes
    // then 403 for everyone until the lease swept). Validate against live
    // room membership: the new owner must be a current, active member.
    const members = store.roomAuthority(roomId).members ?? {};
    const target = data.newOwner;
    const targetMember = typeof target === "string" ? members[target] : null;
    if (!targetMember || targetMember.active === false) {
      reject(422, "work_reassign_unknown_member",
        `newOwner "${typeof target === "string" ? target : "?"}" is not an active member of this room — reassign names a current memberId`);
    }
    requireEventBudget();
    const previousOwnerId = item.owner;
    const note = text("note", data.note, { multiline: true });
    const reassigned = runPure(reject, () => reassignWork(item, caller, target, { note, now: nowMs, authority, room: roomLike }));
    commit(reassigned, "reassigned", {
      previousOwnerId,
      attention: "assigned", attentionMemberId: target,
      wakeMemberId: target, wakeReason: "assigned"
    });
    return json(res, 200, reassigned);
  }
  if (workClaimRoute === "renew" && req.method === "POST") {
    // Lease-renewal check-ins: the owner extends their claim's lease only by
    // citing their own public progress message, posted in this room after
    // the current lease window began. Renewals are discussed in the channel —
    // a stale holder can't hold work indefinitely without showing progress.
    const data = body(req);
    if (!shape(data, { optional: ["progressMessageId", "note", "leaseHours"] })) invalidInput(reject, "{progressMessageId?, note?, leaseHours?}");
    const item = load(claimIdOf(reject, workClaimId));
    // W4 (QA 2026-09-28): a lapsed lease auto-releases the claim (owner
    // cleared), so the ownership check below would misdiagnose it as an
    // access problem ("owned by nobody — ask the owner for a guest invite").
    // Name the real recovery instead: the lease lapsed, claim it again.
    if (item.state === "unclaimed") {
      const lapsed = item.history.some(entry => entry.action === "lease_expired");
      reject(409, "claim_lease_lapsed", lapsed
        ? `Work "${item.id}" is unclaimed: its lease lapsed and the claim auto-released — claim it again to continue the work`
        : `Work "${item.id}" is not claimed — claim it first, then renew`);
    }
    if (item.owner !== caller) reject(403, "work_not_owner", `Work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can change it`);
    requireWriter();
    requireEventBudget();
    assertLeaseChoice(data);
    assertBoardLeaseHours(reject, data);
    if (Object.hasOwn(data, "note")) data.note = text("note", data.note, { multiline: true });
    const progressId = data.progressMessageId;
    if (progressId !== undefined && (typeof progressId !== "string" || !progressId.trim())) invalidInput(reject, "progressMessageId as a message id when citing evidence");
    const messages = progressId ? (store.room(roomId).state.messages ?? []) : [];
    const message = progressId ? messages.find(entry => entry.id === progressId) : null;
    if (progressId) {
      if (!message || message.deletedAt) {
        reject(422, "claim_renewal_source_required",
          "Post a progress update in the room first, then renew the claim with its message id");
      }
      if (message.toMemberId) {
        reject(422, "claim_renewal_source_required",
          "The progress update must be a public room message, not a DM — post it in the room first");
      }
      if (message.authorId !== caller) {
        reject(403, "claim_renewal_source_foreign",
          "The progress update must be your own message — only the claim holder's check-in renews the lease");
      }
      const leaseStart = item.leaseStartAt ?? item.claimedAt;
      if (!(Date.parse(message.createdAt) > Date.parse(leaseStart))) {
        reject(422, "claim_renewal_source_stale",
          "The progress update must be newer than the current lease start — post a fresh update in the room first");
      }
    }
    const renewed = runPure(reject, () => renewWork(item, caller,
      { note: data.note, leaseHours: leaseHoursOfBody(data), room: roomLike, now: nowMs }));
    commit(renewed, "renewed", { coalesce: true });
    return json(res, 200, renewed);
  }
  if (workClaimRoute === "config" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "GET") return json(res, 200, { roomId, ...config });
    const data = body(req);
    if (!shape(data, { required: ["maxMemberOpenClaims"] })) invalidInput(reject, "{maxMemberOpenClaims}");
    const ownerId = typeof access.authority?.ownerId === "string" && access.authority.ownerId.length > 0
      ? access.authority.ownerId : null;
    if (ownerId !== caller) reject(403, "work_claims_not_permitted", "Only the room owner can set the per-member claim cap.");
    if (!Number.isSafeInteger(data.maxMemberOpenClaims) || data.maxMemberOpenClaims < 1 || data.maxMemberOpenClaims > 10000) {
      invalidInput(reject, "maxMemberOpenClaims as an integer 1..10000");
    }
    const saved = registry.configure(roomId, { maxMemberOpenClaims: data.maxMemberOpenClaims });
    return json(res, 200, { roomId, ...saved });
  }
  // RFC 9110: a 405 names the resource's valid methods. The route table above
  // is the source of truth; an unknown route has no meaningful Allow value.
  const WORK_CLAIM_METHODS = {
    list: "GET", receipts: "GET", sweep: "POST", duplicates: "GET", status: "GET", config: "GET, POST", create: "POST",
    read: "GET", claim: "POST", update: "POST", review: "POST", release: "POST",
    reassign: "POST", renew: "POST",
  };
  const allowedMethod = WORK_CLAIM_METHODS[workClaimRoute];
  reject(405, "method_not_allowed", "Method not allowed",
    allowedMethod ? { Allow: allowedMethod } : undefined);
}
