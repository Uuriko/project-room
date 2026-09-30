// Feedback endpoint HTTP routes (dogfood of the /feedback standard —
// docs/feedback-endpoint.md).
//
// Room-scoped routes mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks —
// the same mounting pattern as server/work-claim-routes.mjs:
//
//   POST   /api/rooms/{roomId}/feedback                        submit a filing
//   GET    /api/rooms/{roomId}/feedback                        list clusters + your mark
//   GET    /api/rooms/{roomId}/feedback/queue                  triage queue (fast-track first)
//   GET    /api/rooms/{roomId}/feedback/notifications           drain-on-read lane events
//   GET    /api/rooms/{roomId}/feedback/{id}                    verdict poll (the standard's verdict_url)
//   POST   /api/rooms/{roomId}/feedback/{id}/triage             lane verdict
//   POST   /api/rooms/{roomId}/feedback/{id}/appeal             filer appeal (one, priced)
//   POST   /api/rooms/{roomId}/feedback/{id}/appeal/decision    appeal decided by a different lane
//   POST   /api/rooms/{roomId}/feedback/{id}/outcome            record merged/adopted (closes the loop)
//
// Identity: the caller's lane is the authenticated member id (auth.member.id).
// A body-claimed agent.lane that disagrees is rejected — identity spoofing is
// junk by construction. Guests may read but never write, per the guest policy
// (they stay out of claims-board participation; feedback filing is
// participation). Non-GET routes additionally enforce the caller's autonomy
// tier, mirroring server/work-claim-routes.mjs.
//
// Durability: the store is a process-level singleton. Feedback items drain
// into the claims board via triage promotion, so loss on restart is bounded —
// but durable SQLite persistence is an OPEN ITEM (docs/feedback-endpoint.md).
//
// The Jev triage-advisor seam is documented but NOT wired (owner call: leave
// Jev open, build without it). Triage is lane-operated; the advisor interface
// lives in docs/feedback-endpoint.md for a future slice.
//
// Error contract: the pure store throws FeedbackError (code, no HTTP status);
// STATUS_FOR_CODE maps it to a stable status. Unknown errors are rethrown for
// the generic 500 path — never wrapped, so no internal detail leaks.
import {
  createFeedbackStore, validateFeedback, routeForSeverity, FeedbackError,
  FEEDBACK_ID_PATTERN,
} from "./feedback-store.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";

export { createFeedbackStore, validateFeedback };

export const LANE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS_FOR_CODE = {
  invalid_feedback: 422, invalid_agent: 422, invalid_repro: 422, invalid_verdict: 422,
  invalid_reviewer: 422, invalid_decision: 422, invalid_outcome: 422,
  invalid_transition: 409, not_found: 404, not_appealable: 409, already_appealed: 409,
  appeal_window_closed: 409, same_reviewer: 422, not_filer: 403,
  suspended: 403, insufficient_mark: 402, rate_limited: 429,
  not_reviewer: 403, not_release_authority: 403, unverified_merge_ref: 422,
};

// Per-lane filing throttle: 10 filings/hour. The room funnel already applies
// its 60/min write limit; this is the additional economic throttle so a
// single lane cannot spray the triage queue at machine speed. The submit
// route keys the lane on the room (`${roomId}:${lane}`), so the budget is
// per room, not global.
export function createSubmitLimiter({ capacity = 10, refillPerHour = 10, now } = {}) {
  const clock = now ?? (() => Date.now());
  const buckets = new Map();
  return {
    check(lane) {
      const b = buckets.get(lane) ?? { tokens: capacity, last: clock() };
      const elapsedH = (clock() - b.last) / 3600000;
      b.tokens = Math.min(capacity, b.tokens + elapsedH * refillPerHour);
      b.last = clock();
      if (b.tokens < 1) { buckets.set(lane, b); return false; }
      b.tokens -= 1;
      buckets.set(lane, b);
      return true;
    },
  };
}

// Process-level per-room stores (see the durability note above). Feedback
// IDs and list reads are room-keyed: one room can never see another room's
// filings. Tests inject their own feedbackStore and bypass this entirely.
const roomStores = new Map();

// Authority for the H-2 gates (server/feedback-store.mjs), resolved from
// room roles: triage and appeal decisions (which move Mark) require a
// reviewer — the room owner or a moderator; recording merged/adopted
// outcomes (which mint Mark) requires the room owner as release authority.
// Roles are read fresh on every gated call (roomAuthority() is a fresh
// storage read, never a cache), so membership changes take effect
// immediately and the process-level store cache cannot go stale.
//
// verifyMergeRef is deliberately NOT wired: the only existing merge-record
// facility (the per-room land queue) is opt-in per PR, so a strict gate on
// it would reject legitimate merges that were never queued; a live GitHub
// check inside the synchronous store call is not cleanly reusable (needs a
// token and network I/O). The owner-only release-authority gate is the
// protection, exactly as the store documents. Revisit when a room-scoped
// merge record with full coverage exists.
function feedbackAuthorityOptions(roomId, store) {
  // No main store on this path (unit tests that bypass the HTTP mount):
  // keep the store's legacy behavior; production always passes the store.
  if (!store || typeof store.roomAuthority !== "function") return {};
  const authority = () => {
    try { return store.roomAuthority(roomId); }
    catch { return null; } // unknown/corrupt room: fail closed below
  };
  return {
    isReviewer: lane => {
      const a = authority();
      if (!a || typeof lane !== "string") return false;
      return lane === a.ownerId || a.members?.[lane]?.role === "moderator";
    },
    isReleaseAuthority: lane => {
      const a = authority();
      if (!a || typeof lane !== "string") return false;
      return lane === a.ownerId;
    },
  };
}

function storeForRoom(roomId, store) {
  let fb = roomStores.get(roomId);
  if (!fb) { fb = createFeedbackStore(feedbackAuthorityOptions(roomId, store)); roomStores.set(roomId, fb); }
  return fb;
}
const defaultLimiter = createSubmitLimiter();

const readMethod = method => method === "GET" || method === "HEAD";

export function handleFeedbackCore({ req, res, store, roomId, auth, feedbackRoute, feedbackId,
  feedbackStore, limiter, helpers }) {
  const { reject } = helpers;
  try {
    return dispatchFeedbackCore({ req, res, store, roomId, auth, feedbackRoute, feedbackId,
      feedbackStore, limiter, helpers });
  } catch (e) {
    // Domain errors carry a machine code, never an HTTP status — the
    // mapping lives here so no internal detail leaks and every route
    // shares one stable code→status table.
    if (e instanceof FeedbackError) reject(STATUS_FOR_CODE[e.code] ?? 500, e.code, e.message);
    throw e;
  }
}

function dispatchFeedbackCore({ req, res, store, roomId, auth, feedbackRoute, feedbackId,
  feedbackStore, limiter, helpers }) {
  const { json, reject, body } = helpers;
  const fb = feedbackStore ?? storeForRoom(roomId, store);
  const lim = limiter ?? defaultLimiter;
  const lane = auth?.member?.id;
  if (typeof lane !== "string" || !LANE_RE.test(lane)) {
    reject(401, "unauthenticated", "Member id cannot serve as a feedback lane");
  }
  if (!readMethod(req.method) && isGuestAgentMemberId(lane)) {
    reject(403, "guest_scope_denied", "Guest members cannot file or triage feedback");
  }
  if (!readMethod(req.method)) {
    enforceAutonomyTierForAction({
      db: store?.db, roomId,
      state: { room: { ownerId: store?.roomAuthority?.(roomId)?.ownerId } },
      actor: auth.member, action: `${req.method} feedback ${feedbackRoute}`, fail: reject,
    });
  }
  const head = req.method === "HEAD";
  const base = `/api/rooms/${roomId}/feedback`;
  const data = readMethod(req.method) ? undefined : body();

  if (feedbackRoute === "submit") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Use POST to file feedback");
    // Room-keyed: a lane's 10/hour budget is per room, so filing in one
    // room never starves another.
    if (!lim.check(`${roomId}:${lane}`)) {
      reject(429, "rate_limited", "Too many feedback filings. Slow down — each filing should carry a real repro.");
    }
    // The member's lane is authoritative; a body-claimed lane that disagrees
    // is rejected (identity spoofing becomes junk by construction).
    if (data?.agent?.lane && data.agent.lane !== lane) {
      reject(403, "lane_mismatch", "agent.lane must match the authenticated member lane");
    }
    const result = fb.submit({ ...(data ?? {}), agent: { ...((data ?? {}).agent ?? {}), lane } });
    return json(res, 202, {
      feedback_id: result.item.id,
      outcome: result.outcome, // accepted | duplicate
      cluster_key: result.item.clusterKey,
      verdict_url: `${base}/${result.item.id}`,
      ...(result.markBalance !== undefined ? { mark_balance: result.markBalance } : {}),
    }, head);
  }
  if (feedbackRoute === "list") {
    if (!readMethod(req.method)) reject(405, "method_not_allowed", "Use GET to list feedback");
    return json(res, 200, { roomId, clusters: fb.clusters(), your_mark: fb.mark(lane) }, head);
  }
  if (feedbackRoute === "queue") {
    if (!readMethod(req.method)) reject(405, "method_not_allowed", "Use GET to read the triage queue");
    return json(res, 200, { roomId, queue: fb.triageQueue() }, head);
  }
  if (feedbackRoute === "notifications") {
    if (!readMethod(req.method)) reject(405, "method_not_allowed", "Use GET to read notifications");
    return json(res, 200, { notifications: fb.drainNotifications(lane) }, head);
  }
  if (feedbackRoute === "read") {
    if (!readMethod(req.method)) reject(405, "method_not_allowed", "Use GET to read a feedback item");
    if (!FEEDBACK_ID_PATTERN.test(feedbackId ?? "")) reject(404, "feedback_not_found", "No such feedback");
    const item = fb.get(feedbackId);
    if (!item) reject(404, "feedback_not_found", `No feedback "${feedbackId}"`);
    // The standard's machine-readable verdict shape (§3): open|triaged +
    // the closed verdict enum, so the filing agent can poll its own loop.
    return json(res, 200, {
      feedback_id: item.id,
      status: item.status === "new" ? "open" : item.status === "promoted" ? "triaged" : item.status,
      verdict: item.verdict ?? null,
      triaged_at: item.triagedAt ?? null,
      severity: item.severity,
      route: routeForSeverity(item.severity),
      cluster_key: item.clusterKey,
    }, head);
  }
  if (feedbackRoute === "triage") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Use POST to triage feedback");
    if (!FEEDBACK_ID_PATTERN.test(feedbackId ?? "")) reject(404, "feedback_not_found", "No such feedback");
    const result = fb.triage(feedbackId, data?.verdict, lane);
    return json(res, 200, {
      feedback_id: result.item.id, status: result.item.status, verdict: result.item.verdict,
      mark_balance: result.markBalance, suspended: result.suspended,
      promoted_task: result.promotedTask,
    }, head);
  }
  if (feedbackRoute === "appeal") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Use POST to appeal a verdict");
    if (!FEEDBACK_ID_PATTERN.test(feedbackId ?? "")) reject(404, "feedback_not_found", "No such feedback");
    const result = fb.appeal(feedbackId, lane);
    return json(res, 202, {
      feedback_id: result.item.id, status: result.item.status, mark_balance: result.markBalance,
    }, head);
  }
  if (feedbackRoute === "appeal-decision") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Use POST to decide an appeal");
    if (!FEEDBACK_ID_PATTERN.test(feedbackId ?? "")) reject(404, "feedback_not_found", "No such feedback");
    const result = fb.decideAppeal(feedbackId, lane, data?.decision);
    return json(res, 200, {
      feedback_id: result.item.id, status: result.item.status,
      mark_balance: result.markBalance,
      promoted_task: result.promotedTask ?? null,
    }, head);
  }
  if (feedbackRoute === "outcome") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Use POST to record an outcome");
    if (!FEEDBACK_ID_PATTERN.test(feedbackId ?? "")) reject(404, "feedback_not_found", "No such feedback");
    const result = fb.recordOutcome({ feedbackIds: [feedbackId],
      kind: data?.kind, ref: data?.ref, recordedBy: lane });
    return json(res, 200, { attributions: result.attributions }, head);
  }
  reject(404, "not_found", "Not found");
}

export async function handleFeedback(options) {
  const { req, res, helpers, reauthorize } = options;
  const requestData = readMethod(req.method) ? undefined : await helpers.body(req);
  const run = () => handleFeedbackCore({ ...options,
    auth: reauthorize ? reauthorize() : options.auth,
    helpers: { ...helpers, body: () => requestData, json: (_res, status, value, head) => ({ status, value, head }) },
  });
  const result = run();
  return helpers.json(res, result.status, result.value, result.head);
}

// Periodic settlement sweep (room-watch style, not per-request): verdicts
// that survive the appeal window unchallenged confirm the reviewer;
// promoted items that never ship go stale (precision signal, no Mark
// penalty). Wire to a scheduler when the metrics dashboard slice lands
// (docs/feedback-endpoint.md §6); until then it is available but unscheduled.
export function sweepFeedbackVerdicts(feedbackStore) {
  return feedbackStore.settleVerdicts();
}
