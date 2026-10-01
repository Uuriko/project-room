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
  createWork, claimWork, updateWork, attestWork, reassignWork, releaseExpired, canCloseWork,
  renewWork, roomWorkClaimConfig, isReceiptTag, ClaimError, REVIEW_POLICIES,
} from "./work-claims.mjs";
import { findDuplicates, DuplicateError } from "./work-duplicates.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { evaluateReceipt } from "./jev-receipts.mjs";
import { findClaimCollisions } from "./claim-collisions.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";
import { fileLeaseConflictBody, fileLeaseConflicts, holdForRateLimit, readyClaims } from "./claim-coordination.mjs";
import { collectPullRequestLookups, commitPullRequestLookup, readClaimPullBudget, writeClaimPullBudget } from "./claim-pr-sync.mjs";
import { agentErrorBody } from "../src/agent-error.mjs";

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

// Evaluate lease expiry across the room's items; expired claims auto-release
// (owner cleared, history stamped by releaseExpired). Returns the ids that
// were released by this sweep.
function sweepRoom(registry, roomId, nowMs, onRelease = () => {}) {
  const entry = registry.list(roomId);
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

// Consume the body before opening SQLite's synchronous transaction. The read,
// state transition and write then share one transaction; send the response only
// after commit, so a storage refusal cannot be reported as a successful claim.
export async function handleWorkClaims(options) {
  const { req, res, helpers, reauthorize } = options;
  const registry = options.registry ?? options.store.workClaims ?? defaultRegistry;
  const requestData = req.method === "POST" ? await helpers.body(req) : undefined;
  // Pull-request lookups happen before the claim transaction so a GitHub
  // round trip never holds the room write lock. No webhook receiver is
  // mounted; sweep is the member-triggered poll, and the cron uses the same
  // lookup. An empty room, or a sweep with nothing due, does not call fetch.
  let pullBatch = { results: [], rateLimitedUntil: null, skipped: false };
  if (options.workClaimRoute === "sweep") {
    const nowMs = Date.now();
    const budget = readClaimPullBudget(options.store);
    if (budget > nowMs) {
      pullBatch = { results: [], rateLimitedUntil: budget, skipped: true };
    } else {
      const token = options.githubToken === undefined
        ? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null)
        : options.githubToken;
      pullBatch = await collectPullRequestLookups(registry.list(options.roomId), {
        fetchImpl: options.fetchPullRequest ?? fetch,
        token: token || null,
        nowMs
      });
    }
  }
  const run = () => handleWorkClaimsCore({ ...options, registry, pullBatch,
    auth: reauthorize ? reauthorize() : options.auth,
    helpers: { ...helpers, body: () => requestData, json: (_res, status, value) => ({ status, value }) },
  });
  try {
    const result = registry.transaction ? registry.transaction(run) : run();
    return helpers.json(res, result.status, result.value);
  } catch (error) {
    if (error?.code === "file_lease_conflict" && error.body) return helpers.json(res, 409, error.body);
    throw error;
  }
}

function handleWorkClaimsCore({ req, res, url, store, roomId, auth, workClaimRoute, workClaimId, helpers, registry, pullBatch = { results: [], rateLimitedUntil: null, skipped: false } }) {
  const { json, reject, body } = helpers;
  if (req.method !== "GET" && req.method !== "HEAD") enforceAutonomyTierForAction({
    db: store.db, roomId, state: { room: { ownerId: store.roomAuthority?.(roomId)?.ownerId } },
    actor: auth.member, action: `${req.method} work-claim ${workClaimRoute}`, fail: reject });
  const nowMs = Date.now();
  const caller = auth.member.id;
  // Every committed claim change appends one work_claim.updated room event
  // inside this transaction (server/work-claim-events.mjs).
  const commit = (item, action, extra = {}) => {
    // A release clears files on the item. Read the held paths first so the
    // receipt names the lane that opened, then write the claim and the event
    // in this same transaction. A pull request that closes does the same.
    const prior = action === "released" || action === "pr_closed" ? registry.get(roomId, item.id) : null;
    registry.set(roomId, item);
    emitWorkClaimEvent(store, roomId, {
      actorId: extra.actorId ?? caller,
      item,
      action,
      previousOwnerId: extra.previousOwnerId ?? null,
      atMs: nowMs,
      paths: action === "released" || action === "pr_closed" ? (prior?.files ?? []) : undefined,
      pullRequest: extra.pullRequest
    });
    return item;
  };
  const sweptIds = sweepRoom(registry, roomId, nowMs,
    (item, before) => emitWorkClaimEvent(store, roomId, {
      actorId: before.owner, item, action: "lease_expired", previousOwnerId: before.owner,
      atMs: nowMs, paths: before.files ?? []
    }));
  const config = registry.configFor(roomId);
  const roomLike = { workClaims: registry.rawConfig(roomId) };

  const load = id => {
    const item = registry.get(roomId, id);
    if (!item) reject(404, "work_claim_not_found", `No work claim "${id}" in this room`);
    return item;
  };
  const own = item => {
    if (item.owner !== caller) reject(403, "work_not_owner", `Work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can change it`);
  };

  if (workClaimRoute === "list" && req.method === "GET") {
    const params = url?.searchParams ?? new URLSearchParams();
    for (const key of params.keys()) {
      if (!["queue", "auth"].includes(key) || params.getAll(key).length !== 1) {
        invalidInput(reject, "only a single queue query parameter");
      }
    }
    if (params.has("queue")) {
      if (params.get("queue") !== "ready") invalidInput(reject, "queue=ready");
      return json(res, 200, { roomId, queue: "ready", swept: sweptIds, claims: readyClaims(registry.list(roomId)) });
    }
    return json(res, 200, { roomId, swept: sweptIds, claims: registry.list(roomId) });
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
    return json(res, 200, {
      receipts: page.map(receiptOf),
      nextCursor: nextOffset < ranked.length ? cursorEncode(nextOffset) : null,
    });
  }
  if (workClaimRoute === "sweep" && req.method === "POST") {
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
    const data = body(req);
    if (!shape(data, { required: ["id"], optional: ["title", "reviewPolicy", "note", "tags", "files", "dependsOn", "pullRequest"] })) invalidInput(reject, "{id, title?, reviewPolicy?, note?, tags?, files?, dependsOn?, pullRequest?}");
    const id = claimIdOf(reject, data.id);
    if (registry.has(roomId, id)) reject(409, "work_claim_exists", `Work claim "${id}" already exists in this room`);
    if (data.reviewPolicy !== undefined && !REVIEW_POLICIES.includes(data.reviewPolicy)) invalidInput(reject, `reviewPolicy one of ${REVIEW_POLICIES.join(", ")}`);
    const item = runPure(reject, () => createWork({ id, title: data.title, reviewPolicy: data.reviewPolicy, note: data.note, tags: data.tags, files: data.files, dependsOn: data.dependsOn, pullRequest: data.pullRequest }, { now: nowMs, agentId: caller }));
    commit(item, "created");
    return json(res, 201, item);
  }
  if (workClaimRoute === "read" && req.method === "GET") {
    return json(res, 200, load(claimIdOf(reject, workClaimId)));
  }
  if (workClaimRoute === "claim" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["note", "leaseHours", "files", "advisory", "dependsOn", "pullRequest"] })) invalidInput(reject, "{note?, leaseHours?, files?, advisory?, dependsOn?, pullRequest?}");
    if ("advisory" in data && typeof data.advisory !== "boolean") invalidInput(reject, "advisory true or false");
    const item = load(claimIdOf(reject, workClaimId));
    if (item.state !== "unclaimed") reject(409, "work_claim_conflict", `Work "${item.id}" is already ${item.state} — release it first`);
    const claimed = runPure(reject, () => claimWork(item, caller, {
      note: data.note, leaseHours: leaseHoursOfBody(data), files: data.files,
      dependsOn: data.dependsOn, pullRequest: data.pullRequest, room: roomLike, now: nowMs
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
    commit(claimed, "claimed");
    return json(res, 200, { ...claimed, fileWarnings: data.advisory === true ? fileWarningsFor(registry.list(roomId), claimed) : [] });
  }
  if (workClaimRoute === "update" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["state", "note", "deliveryMode", "reviewedBy", "tags", "blobs"] })) invalidInput(reject, "{state?, note?, deliveryMode?, reviewedBy?, tags?, blobs?}");
    if (data.state === undefined && data.note === undefined) invalidInput(reject, "a state transition or a note");
    const item = load(claimIdOf(reject, workClaimId));
    own(item);
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
        if (!canCloseWork(item, reviewer, { policy, verifyMembers: verifiers })) {
          reject(403, "work_review_rejected",
            `Review policy "${policy}" not satisfied for "${item.id}": attestation by ${reviewer} does not close this work`);
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
    commit(updated, "state_changed");
    return json(res, 200, updated);
  }
  if (workClaimRoute === "review" && req.method === "POST") {
    // QA-Sec 2026-09-19: the attestation endpoint. Any room member records
    // their own review of an active claim; the attestation is bound to the
    // caller's authenticated member id — it can never name someone else.
    const data = body(req);
    if (!shape(data, { optional: ["note"] })) invalidInput(reject, "{note?}");
    const item = load(claimIdOf(reject, workClaimId));
    const attested = runPure(reject, () => attestWork(item, caller, { note: data.note, now: nowMs }));
    commit(attested, "reviewed");
    return json(res, 200, attested);
  }
  if (workClaimRoute === "release" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { optional: ["note"] })) invalidInput(reject, "{note?}");
    let item = load(claimIdOf(reject, workClaimId));
    own(item);
    // W2 (QA 2026-09-28): /release used to 422 on in_progress claims with no
    // recovery path. The pure machine's release path is claimed -> unclaimed,
    // so route an active claim through the pause transition internally —
    // both steps are stamped in history — instead of refusing.
    if (item.state === "in_progress" || item.state === "blocked") {
      item = runPure(reject, () => updateWork(item, caller, { state: "claimed", note: "paused for release", now: nowMs }));
      registry.set(roomId, item);
    }
    const released = runPure(reject, () => updateWork(item, caller, { state: "unclaimed", note: data.note, now: nowMs }));
    commit(released, "released");
    return json(res, 200, released);
  }
  if (workClaimRoute === "reassign" && req.method === "POST") {
    const data = body(req);
    if (!shape(data, { required: ["newOwner"], optional: ["note"] })) invalidInput(reject, "{newOwner, note?}");
    const item = load(claimIdOf(reject, workClaimId));
    own(item);
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
    const previousOwnerId = item.owner;
    const reassigned = runPure(reject, () => reassignWork(item, caller, target, { note: data.note, now: nowMs }));
    commit(reassigned, "reassigned", { previousOwnerId });
    return json(res, 200, reassigned);
  }
  if (workClaimRoute === "renew" && req.method === "POST") {
    // Lease-renewal check-ins: the owner extends their claim's lease only by
    // citing their own public progress message, posted in this room after
    // the current lease window began. Renewals are discussed in the channel —
    // a stale holder can't hold work indefinitely without showing progress.
    const data = body(req);
    if (!shape(data, { required: ["progressMessageId"], optional: ["note", "leaseHours"] })) invalidInput(reject, "{progressMessageId, note?, leaseHours?}");
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
    own(item);
    const progressId = data.progressMessageId;
    if (typeof progressId !== "string" || !progressId.trim()) invalidInput(reject, "{progressMessageId, note?, leaseHours?}");
    const messages = store.room(roomId).state.messages ?? [];
    const message = messages.find(entry => entry.id === progressId);
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
    const renewed = runPure(reject, () => renewWork(item, caller,
      { note: data.note, leaseHours: leaseHoursOfBody(data), room: roomLike, now: nowMs }));
    commit(renewed, "renewed");
    return json(res, 200, renewed);
  }
  // RFC 9110: a 405 names the resource's valid methods. The route table above
  // is the source of truth; an unknown route has no meaningful Allow value.
  const WORK_CLAIM_METHODS = {
    list: "GET", receipts: "GET", sweep: "POST", duplicates: "GET", create: "POST",
    read: "GET", claim: "POST", update: "POST", review: "POST", release: "POST",
    reassign: "POST", renew: "POST",
  };
  const allowedMethod = WORK_CLAIM_METHODS[workClaimRoute];
  reject(405, "method_not_allowed", "Method not allowed",
    allowedMethod ? { Allow: allowedMethod } : undefined);
}
