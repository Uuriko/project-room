import { validId } from "../src/events.js";
import { nextWorkStep } from "../src/workflow.js";
import { nativeOutboxEventId } from "./mcp-outbox-event-id.mjs";

export const reviewRuntimeSchema = `
  CREATE TABLE IF NOT EXISTS review_runtime_reports (
    room_id TEXT NOT NULL, work_item_id TEXT NOT NULL, completion_id TEXT NOT NULL,
    member_id TEXT NOT NULL, revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('claimed','started','start_unknown')),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (room_id,work_item_id)
  );`;

const phases = ["claimed", "started", "start_unknown"];
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const tableReady = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Call inside the same write transaction that validated the exact action.
export function recordReviewRuntime(db, roomId, work, member, input, now) {
  if (!input || Array.isArray(input)
    || Object.keys(input).some(k => !["workItemId","completionEventId","evidenceVersion","expectedRevision","attemptId","phase"].includes(k))
    || ![input.workItemId,input.completionEventId,input.attemptId].every(validId)
    || !Number.isSafeInteger(input.expectedRevision) || !phases.includes(input.phase)) fail(422, "invalid_review_runtime");
  const next = nextWorkStep(work, now);
  if (member.kind !== "agent" || !member.permissions?.includes("verify") || work.verifierMemberId !== member.id)
    fail(403, "review_runtime_denied");
  if (next.action !== "verify" || next.memberId !== member.id || work.id !== input.workItemId || work.revision !== input.expectedRevision
    || work.receipt?.eventId !== input.completionEventId || work.receipt.evidenceVersion !== input.evidenceVersion)
    fail(409, "review_runtime_stale");
  const row = db.prepare("SELECT * FROM review_runtime_reports WHERE room_id=? AND work_item_id=?").get(roomId, work.id);
  if (row?.completion_id === input.completionEventId && row.revision === input.expectedRevision && row.member_id === member.id) {
    if (row.attempt_id !== input.attemptId) fail(409, "review_runtime_attempt_conflict");
    // A confirmed start remains confirmed. A report of uncertainty cannot
    // erase that evidence, and a delayed claim cannot rewind either phase.
    if (row.phase === "started" || row.phase === input.phase || input.phase === "claimed")
      return { status: row.phase, observedAt: row.observed_at };
  }
  db.prepare(`INSERT INTO review_runtime_reports VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(room_id,work_item_id) DO UPDATE SET completion_id=excluded.completion_id, member_id=excluded.member_id,
    revision=excluded.revision, attempt_id=excluded.attempt_id,phase=excluded.phase,observed_at=excluded.observed_at`)
    .run(roomId,work.id,input.completionEventId,member.id,work.revision,input.attemptId,input.phase,now);
  return { status: input.phase, observedAt: now };
}

// Both callers must already have authorized this current exact result.
export function reviewRuntimeFor(store, roomId, work, next, now) {
  const { db } = store;
  if (work.supersededBy || !work.receipt?.eventId) return null;
  if (work.verification?.completionEventId === work.receipt.eventId
    && work.verification.evidenceVersion === work.receipt.evidenceVersion) return { status:"verdict_recorded", source:"room_verdict" };
  if (next?.action !== "verify") return null;
  if (tableReady(db, "review_runtime_reports")) {
    const report = db.prepare(`SELECT phase,observed_at FROM review_runtime_reports
      WHERE room_id=? AND work_item_id=? AND completion_id=? AND revision=? AND member_id=?`)
      .get(roomId,work.id,work.receipt.eventId,work.revision,next.memberId);
    if (report) return { status:report.phase, source:"managed_host", observedAt:report.observed_at };
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
  parity: "exempt:host-only runtime observations carry no execution authority",
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
    ctx.rate(`write:${auth.credentialHash}`, 60);
    return ctx.json(ctx.res,200,ctx.store.reportReviewRuntime(selected.token,roomId,await ctx.body(ctx.req,{limit:4096}),binding));
  }
});
