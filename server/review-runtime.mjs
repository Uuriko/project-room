import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { nextWorkStep } from "../src/workflow.js";
import { LISTENER_TOKEN_HEADER } from "./listener-fence.mjs";
import { nativeOutboxEventId } from "./mcp-outbox-event-id.mjs";
import { runOnce } from "./run-once.mjs";

export const reviewRuntimeSchema = `
  CREATE TABLE IF NOT EXISTS review_runtime_reports (
    room_id TEXT NOT NULL, work_item_id TEXT NOT NULL, completion_id TEXT NOT NULL,
    member_id TEXT NOT NULL, revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('claimed','started','start_unknown')),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (room_id,work_item_id)
  );
  CREATE TABLE IF NOT EXISTS review_runtime_claim_receipts (
    room_id TEXT NOT NULL, work_item_id TEXT NOT NULL, completion_id TEXT NOT NULL,
    revision INTEGER NOT NULL, member_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (room_id,work_item_id,completion_id,revision,member_id)
  );
  CREATE TABLE IF NOT EXISTS review_runtime_interruptions (
    room_id TEXT NOT NULL, work_item_id TEXT NOT NULL, completion_id TEXT NOT NULL,
    revision INTEGER NOT NULL, member_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (room_id,work_item_id,completion_id,revision,member_id)
  );`;

const phases = ["claimed", "started", "start_unknown", "interrupted"];
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const tableReady = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Call inside the same write transaction that validated the exact action.
export function recordReviewRuntime(db, roomId, work, member, input, now, listenerToken) {
  if (!input || Array.isArray(input)
    || Object.keys(input).some(k => !["workItemId","completionEventId","evidenceVersion","expectedRevision","attemptId","phase","reserveDispatch","reservationId"].includes(k))
    || input.reserveDispatch !== undefined && (input.reserveDispatch !== true || input.phase !== "start_unknown")
    || input.reservationId !== undefined && (input.reserveDispatch !== true || !validId(input.reservationId) || !listenerToken)
    || ![input.workItemId,input.completionEventId,input.attemptId].every(validId)
    || !Number.isSafeInteger(input.expectedRevision) || !phases.includes(input.phase)) fail(422, "invalid_review_runtime");
  const next = nextWorkStep(work, now);
  if (member.kind !== "agent" || !member.permissions?.includes("verify") || work.verifierMemberId !== member.id)
    fail(403, "review_runtime_denied");
  if (next.action !== "verify" || next.memberId !== member.id || work.id !== input.workItemId || work.revision !== input.expectedRevision
    || work.receipt?.eventId !== input.completionEventId || work.receipt.evidenceVersion !== input.evidenceVersion)
    fail(409, "review_runtime_stale");
  const row = db.prepare("SELECT * FROM review_runtime_reports WHERE room_id=? AND work_item_id=?").get(roomId, work.id);
  const sameReview = row?.completion_id === input.completionEventId && row.revision === input.expectedRevision && row.member_id === member.id;
  if (sameReview && row.attempt_id !== input.attemptId) fail(409, "review_runtime_attempt_conflict");
  if (input.phase === "interrupted") {
    db.prepare(`INSERT INTO review_runtime_interruptions VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(roomId,work.id,input.completionEventId,work.revision,member.id,input.attemptId,now);
  }
  const interrupted = db.prepare(`SELECT attempt_id,observed_at FROM review_runtime_interruptions
    WHERE room_id=? AND work_item_id=? AND completion_id=? AND revision=? AND member_id=?`)
    .get(roomId,work.id,input.completionEventId,work.revision,member.id);
  if (interrupted) {
    if (interrupted.attempt_id !== input.attemptId) fail(409, "review_runtime_attempt_conflict");
    return { status:"interrupted", observedAt:interrupted.observed_at };
  }
  // Only the initiating call can replay a lost grant, under its original live
  // listener fence and call ID. A replacement gets the observation only.
  const reservationScope = input.reservationId && "review-dispatch:" + createHash("sha256").update(JSON.stringify([
    roomId, work.id, input.completionEventId, input.evidenceVersion, work.revision, member.id, input.attemptId, listenerToken,
  ])).digest("hex");
  if (input.reserveDispatch === true && sameReview && row.phase !== "claimed") {
    if (row.phase === "start_unknown" && reservationScope && tableReady(db, "request_replays")) {
      const saved = db.prepare("SELECT result_json FROM request_replays WHERE scope=? AND request_id=?")
        .get(reservationScope, input.reservationId);
      if (saved) return JSON.parse(saved.result_json);
    }
    return { status:row.phase, observedAt:row.observed_at };
  }
  if (input.phase === "claimed" || (sameReview && row.phase === "claimed")) {
    // Keep the actual first claim separate from the latest provider phase.
    // Neither the claim nor a retry settles the work wake.
    const observedAt = sameReview && row.phase === "claimed" ? row.observed_at : now;
    db.prepare(`INSERT INTO review_runtime_claim_receipts VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(roomId, work.id, input.completionEventId, work.revision, member.id, input.attemptId, observedAt);
  }
  if (sameReview) {
    // A confirmed start remains confirmed. A report of uncertainty cannot
    // erase that evidence, and a delayed claim cannot rewind either phase.
    if (row.phase === "started" || row.phase === input.phase || input.phase === "claimed")
      return { status: row.phase, observedAt: row.observed_at };
  }
  db.prepare(`INSERT INTO review_runtime_reports VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(room_id,work_item_id) DO UPDATE SET completion_id=excluded.completion_id, member_id=excluded.member_id,
    revision=excluded.revision, attempt_id=excluded.attempt_id,phase=excluded.phase,observed_at=excluded.observed_at`)
    .run(roomId,work.id,input.completionEventId,member.id,work.revision,input.attemptId,input.phase,now);
  const result = { status: input.phase, observedAt: now, ...(input.reserveDispatch === true ? { dispatchGranted:true } : {}) };
  if (reservationScope) runOnce(db, reservationScope, input.reservationId, () => result, { now });
  return result;
}

function claimObservation(db, roomId, work, revision, memberId) {
  if (!Number.isSafeInteger(revision) || !tableReady(db, "review_runtime_claim_receipts")) return {};
  const claim = db.prepare(`SELECT observed_at FROM review_runtime_claim_receipts
    WHERE room_id=? AND work_item_id=? AND completion_id=? AND revision=? AND member_id=?`)
    .get(roomId, work.id, work.receipt.eventId, revision, memberId);
  return claim ? { claimObservedAt: claim.observed_at } : {};
}

// Both callers must already have authorized this current exact result.
export function reviewRuntimeFor(store, roomId, work, next, now, { includeClaim = false } = {}) {
  const { db } = store;
  if (work.supersededBy || !work.receipt?.eventId) return null;
  if (work.verification?.completionEventId === work.receipt.eventId
    && work.verification.evidenceVersion === work.receipt.evidenceVersion) {
    const verdict = { status:"verdict_recorded", source:"room_verdict" };
    if (!includeClaim) return verdict;
    const basis = db.prepare(`SELECT json_extract(body,'$.data.expectedRevision') AS revision
      FROM events WHERE room_id=? AND id=?`).get(roomId, work.verification.eventId);
    return { ...verdict, ...claimObservation(db, roomId, work, basis?.revision, work.verification.verifierId) };
  }
  if (next?.action !== "verify") return null;
  if (tableReady(db, "review_runtime_interruptions")) {
    const interrupted = db.prepare(`SELECT observed_at FROM review_runtime_interruptions
      WHERE room_id=? AND work_item_id=? AND completion_id=? AND revision=? AND member_id=?`)
      .get(roomId,work.id,work.receipt.eventId,work.revision,next.memberId);
    if (interrupted) return { status:"interrupted", source:"managed_host", observedAt:interrupted.observed_at,
      ...(includeClaim ? claimObservation(db, roomId, work, work.revision, next.memberId) : {}) };
  }
  if (tableReady(db, "review_runtime_reports")) {
    const report = db.prepare(`SELECT phase,observed_at FROM review_runtime_reports
      WHERE room_id=? AND work_item_id=? AND completion_id=? AND revision=? AND member_id=?`)
      .get(roomId,work.id,work.receipt.eventId,work.revision,next.memberId);
    if (report) return { status:report.phase, source:"managed_host", observedAt:report.observed_at,
      ...(includeClaim ? claimObservation(db, roomId, work, work.revision, next.memberId) : {}) };
  }
  if (tableReady(db, "agent_work_wakes") && tableReady(db, "agent_wake_listener_leases")) {
    const agentId = store.identities.identityIdForMember(roomId, next.memberId);
    const wake = agentId && db.prepare(`SELECT w.created_at, w.delivered_at,
      NOT EXISTS(SELECT 1 FROM agent_wake_listener_leases l WHERE l.agent_id=w.agent_id
        AND l.room_key IN ('',w.room_id) AND l.lease_expires_at>?) AS no_listener
      FROM agent_work_wakes w
      WHERE w.agent_id=? AND w.room_id=? AND w.event_id=? AND w.member_id=? AND w.work_item_id=? AND w.work_revision=?
      AND w.invalidated_at IS NULL LIMIT 1`)
      .get(now,agentId,roomId,work.receipt.eventId,next.memberId,work.id,work.revision);
    if (wake?.delivered_at != null) return { status:"wake_acknowledged", source:"managed_pull_wake", observedAt:wake.delivered_at };
    if (wake?.no_listener) return { status:"waiting_receiver", source:"managed_pull_wake", observedAt:wake.created_at };
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='mcp_event_outbox_event' AND tbl_name='mcp_event_outbox'").get()) {
    // A webhook response records delivery only. Keep runtime status independent
    // and match the exact current review before exposing this transport evidence.
    const delivery = db.prepare(`SELECT state FROM mcp_event_outbox
      WHERE event_id=? AND state IN ('pending','leased','delivered')
        AND json_extract(document,'$.data.roomId')=?
        AND json_extract(document,'$.data.memberId')=?
        AND json_extract(document,'$.data.nextRead.tool')='room_read_result'
        AND json_extract(document,'$.data.nextRead.arguments.roomId')=?
        AND json_extract(document,'$.data.nextRead.arguments.workItemId')=?
        AND json_extract(document,'$.data.nextRead.arguments.completionEventId')=?
        AND json_extract(document,'$._roomPolicy.workRevision')=?
      ORDER BY state='delivered' DESC LIMIT 1`)
      .get(nativeOutboxEventId(roomId, next.memberId, work.receipt.eventId),
        roomId, next.memberId, roomId, work.id, work.receipt.eventId, work.revision);
    if (delivery) return { status:"unavailable", webhook:delivery.state === "delivered" ? "delivered" : "queued" };
  }
  return { status:"unavailable" };
}

export const REVIEW_RUNTIME_ROUTE = Object.freeze({
  id: "review-runtime-observe", method: "POST", path: "/api/rooms/{roomId}/review-runtime",
  auth: "room", capability: null, scope: "room",
  parity: "exempt:host-only observations and dispatch fencing do not authorize Room actions",
  schema: { params:{ type:"object", required:["roomId"], properties:{ roomId:{type:"string"} } },
    body:{ type:"object" }, response:{type:"object"} }, events: [],
  async handler(ctx) {
    const { roomId } = ctx.params;
    const selected = ctx.roomCredentials(ctx.req, ctx.url);
    if (!selected.bearer) ctx.reject(401, "unauthenticated", "Use the managed reviewer's bearer credential");
    const binding = ctx.expectedBinding(ctx.req);
    const auth = ctx.roomAuth(selected, roomId, binding);
    if (auth.credentialScope !== "room") ctx.reject(403, "access_denied", "A room bearer is required");
    if (auth.kind === "api-key" && !auth.apiKeyScopes?.some(scope => ["rooms:write","rooms:*"].includes(scope)))
      ctx.reject(403, "insufficient_scope", "Room write scope is required");
    const body = await ctx.body(ctx.req,{limit:4096});
    const bucket = body?.reserveDispatch === true ? "review-dispatch" : "review-runtime";
    ctx.rate(`${bucket}:${auth.credentialHash}`, 60);
    return ctx.json(ctx.res,200,ctx.store.reportReviewRuntime(selected.token,roomId,body,
      binding,ctx.req.headers[LISTENER_TOKEN_HEADER]));
  }
});
