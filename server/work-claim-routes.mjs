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
// Persistence is the later slice: items live in a per-process, per-room
// in-memory registry (createWorkClaimRegistry). Lease expiry is evaluated
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
  roomWorkClaimConfig, isReceiptTag, ClaimError, REVIEW_POLICIES,
} from "./work-claims.mjs";
import { findDuplicates, DuplicateError } from "./work-duplicates.mjs";
import { evaluateReceipt } from "./jev-receipts.mjs";

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

// Evaluate lease expiry across the room's items; expired claims auto-release
// (owner cleared, history stamped by releaseExpired). Returns the ids that
// were released by this sweep.
function sweepRoom(registry, roomId, nowMs) {
  const entry = registry.list(roomId);
  const swept = releaseExpired(entry, nowMs);
  const released = [];
  swept.forEach((item, index) => {
    if (item !== entry[index]) { registry.set(roomId, item); released.push(item.id); }
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

export async function handleWorkClaims({ req, res, url, store, roomId, auth, workClaimRoute, workClaimId, helpers, registry = defaultRegistry }) {
  const { json, reject, body } = helpers;
  const nowMs = Date.now();
  const sweptIds = sweepRoom(registry, roomId, nowMs);
  const caller = auth.member.id;
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
    const data = await body(req);
    if (!shape(data, {})) invalidInput(reject, "an empty JSON object");
    return json(res, 200, { roomId, released: sweptIds, sweptAt: new Date(nowMs).toISOString() });
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
    const data = await body(req);
    if (!shape(data, { required: ["id"], optional: ["title", "reviewPolicy", "note", "tags"] })) invalidInput(reject, "{id, title?, reviewPolicy?, note?, tags?}");
    const id = claimIdOf(reject, data.id);
    if (registry.has(roomId, id)) reject(409, "work_claim_exists", `Work claim "${id}" already exists in this room`);
    if (data.reviewPolicy !== undefined && !REVIEW_POLICIES.includes(data.reviewPolicy)) invalidInput(reject, `reviewPolicy one of ${REVIEW_POLICIES.join(", ")}`);
    const item = runPure(reject, () => createWork({ id, title: data.title, reviewPolicy: data.reviewPolicy, note: data.note, tags: data.tags }, { now: nowMs }));
    registry.set(roomId, item);
    return json(res, 201, item);
  }
  if (workClaimRoute === "read" && req.method === "GET") {
    return json(res, 200, load(claimIdOf(reject, workClaimId)));
  }
  if (workClaimRoute === "claim" && req.method === "POST") {
    const data = await body(req);
    if (!shape(data, { optional: ["note", "leaseHours"] })) invalidInput(reject, "{note?, leaseHours?}");
    const item = load(claimIdOf(reject, workClaimId));
    if (item.state !== "unclaimed") reject(409, "work_claim_conflict", `Work "${item.id}" is already ${item.state} — release it first`);
    const claimed = runPure(reject, () => claimWork(item, caller, { note: data.note, leaseHours: data.leaseHours ?? undefined, room: roomLike, now: nowMs }));
    registry.set(roomId, claimed);
    return json(res, 200, claimed);
  }
  if (workClaimRoute === "update" && req.method === "POST") {
    const data = await body(req);
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
    registry.set(roomId, updated);
    return json(res, 200, updated);
  }
  if (workClaimRoute === "review" && req.method === "POST") {
    // QA-Sec 2026-09-19: the attestation endpoint. Any room member records
    // their own review of an active claim; the attestation is bound to the
    // caller's authenticated member id — it can never name someone else.
    const data = await body(req);
    if (!shape(data, { optional: ["note"] })) invalidInput(reject, "{note?}");
    const item = load(claimIdOf(reject, workClaimId));
    const attested = runPure(reject, () => attestWork(item, caller, { note: data.note, now: nowMs }));
    registry.set(roomId, attested);
    return json(res, 200, attested);
  }
  if (workClaimRoute === "release" && req.method === "POST") {
    const data = await body(req);
    if (!shape(data, { optional: ["note"] })) invalidInput(reject, "{note?}");
    const item = load(claimIdOf(reject, workClaimId));
    own(item);
    const released = runPure(reject, () => updateWork(item, caller, { state: "unclaimed", note: data.note, now: nowMs }));
    registry.set(roomId, released);
    return json(res, 200, released);
  }
  if (workClaimRoute === "reassign" && req.method === "POST") {
    const data = await body(req);
    if (!shape(data, { required: ["newOwner"], optional: ["note"] })) invalidInput(reject, "{newOwner, note?}");
    const item = load(claimIdOf(reject, workClaimId));
    own(item);
    const reassigned = runPure(reject, () => reassignWork(item, caller, data.newOwner, { note: data.note, now: nowMs }));
    registry.set(roomId, reassigned);
    return json(res, 200, reassigned);
  }
  reject(405, "method_not_allowed", "Method not allowed");
}
