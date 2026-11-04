import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";
import { enqueueClaimWake } from "./work-claim-events.mjs";
import { ownMember } from "../src/events.js";

// Assignment deadlines and escalation ladder (pure policy).
//
// A proposed assignment the delegate (accountableMemberId) has not accepted
// walks a fixed ladder, so a silent assignee never stalls the Board:
//   waiting    -> inside the ack window, nothing to do
//   reping     -> ack window passed: wake the delegate again
//   escalate   -> still silent: tell the assigner (proposedById); if there is
//                 no assigner, or the assigner is the delegate, the room owner
//   free       -> announce the task is free for someone else to take
// Delegate vs owner split (Linear pattern): the delegate is who does the
// work, the owner is who answers for it; stale work escalates to the owner.
//
// Claim leases are heartbeat leases. Before expiry the holder is warned once
// (warn). After expiry the lapse notice belongs to #5841/#5843 (claim-pr-sync
// lease-expiry notice), so this module reports handledBy and emits nothing.
//
// Second claimer: claimConflictResult turns a live claim into an ordinary
// already_claimed result with who holds it and until when, instead of an
// error the caller has to parse.
//
// Read-only: every stage describes who to notify; it grants nothing.

export const ASSIGNMENT_DEADLINE_DEFAULTS = Object.freeze({
  ackWithinMs: 10 * 60_000,       // matches #5838 STALLED_ASSIGNMENT_MS
  escalateAfterMs: 30 * 60_000,   // Linear: stale after 30 min of silence
  freeAfterMs: 4 * 60 * 60_000,
  leaseWarnBeforeMs: 15 * 60_000,
});

const STAGES = ["waiting", "reping", "escalate", "free"];
export const ASSIGNMENT_STAGES = Object.freeze([...STAGES]);

function ms(value) { const t = Date.parse(value); return Number.isFinite(t) ? t : null; }

export function assignmentStage(item, now, { ownerId = null, ...options } = {}) {
  const opts = { ...ASSIGNMENT_DEADLINE_DEFAULTS, ...options };
  if (item?.state !== "proposed" || item.supersededBy) return null;
  const delegateId = item.accountableMemberId ?? null;
  if (!delegateId) return null;
  const created = ms(item.createdAt);
  if (created === null) return null;
  const age = now - created;
  if (!(age >= 0)) return null;
  const assignerId = item.proposedById && item.proposedById !== delegateId ? item.proposedById : null;
  const escalateTo = assignerId ?? (ownerId && ownerId !== delegateId ? ownerId : null);
  const base = { workItemId: item.id, workRevision: item.revision ?? null, delegateId, assignerId, ownerId, ageMs: age };
  if (age >= opts.freeAfterMs) return Object.freeze({ ...base, stage: "free", notify: [escalateTo, delegateId].filter(Boolean), dueAtMs: created + opts.freeAfterMs });
  if (age >= opts.escalateAfterMs) return Object.freeze({ ...base, stage: "escalate", notify: escalateTo ? [escalateTo] : [], dueAtMs: created + opts.escalateAfterMs });
  if (age >= opts.ackWithinMs) return Object.freeze({ ...base, stage: "reping", notify: [delegateId], dueAtMs: created + opts.ackWithinMs });
  return Object.freeze({ ...base, stage: "waiting", notify: [], dueAtMs: created + opts.ackWithinMs });
}

export function leaseStage(work, now, options = {}) {
  const opts = { ...ASSIGNMENT_DEADLINE_DEFAULTS, ...options };
  const holderId = work?.claim?.holderId ?? work?.holderId ?? work?.owner ?? null;
  const expires = ms(work?.claim?.leaseExpiresAt ?? work?.leaseExpiresAt);
  if (!holderId || expires === null) return null;
  const left = expires - now;
  if (left <= 0) return Object.freeze({ stage: "expired", holderId, expiresAtMs: expires, notify: [], handledBy: "lease-expiry-notice (#5841/#5843)" });
  if (left <= opts.leaseWarnBeforeMs) return Object.freeze({ stage: "warn", holderId, expiresAtMs: expires, leftMs: left, notify: [holderId] });
  return Object.freeze({ stage: "live", holderId, expiresAtMs: expires, leftMs: left, notify: [] });
}

export function claimConflictResult(work, now) {
  const lease = leaseStage(work, now);
  if (!lease || lease.stage === "expired") return null;
  return Object.freeze({ ok: false, result: "already_claimed", workItemId: work.id ?? null, holderId: lease.holderId,
    leaseExpiresAt: new Date(lease.expiresAtMs).toISOString(),
    next: "pick other work, or wait; the lease auto-frees if the holder stops renewing" });
}

// Dedupe: one notice per (work item, revision, stage). Callers persist the
// returned keys (claim history / event idempotency key) so a restart or a
// second tick never re-sends the same rung.
export function deadlineNoticeKey(stage) {
  if (!stage?.workItemId || !STAGES.includes(stage.stage) || stage.stage === "waiting") return null;
  return `assignment-deadline:${stage.workItemId}:${stage.workRevision ?? 0}:${stage.stage}`;
}

// Walk a room's work and return the notices due this tick, skipping keys
// already sent. Pure: the caller posts and records them.
export function dueDeadlineNotices(items, now, { ownerId = null, sent = new Set(), ...options } = {}) {
  const out = [];
  for (const item of items ?? []) {
    const stage = assignmentStage(item, now, { ownerId, ...options });
    const key = deadlineNoticeKey(stage);
    if (key && !sent.has(key) && stage.notify.length > 0) out.push(Object.freeze({ key, ...stage }));
    const lease = item?.state === "proposed" ? null : leaseStage(item, now, options);
    if (lease?.stage === "warn") {
      const leaseKey = `lease-warn:${item.id}:${lease.expiresAtMs}`;
      if (!sent.has(leaseKey)) out.push(Object.freeze({ key: leaseKey, workItemId: item.id, ...lease }));
    }
  }
  return out;
}

// ROOM_ASSIGNMENT_DEADLINES: off (default), on, or a comma-separated room list.
export function assignmentDeadlinesEnabled(env, roomId) {
  const raw = String(env?.ROOM_ASSIGNMENT_DEADLINES ?? "").trim();
  if (!raw || raw === "0" || raw === "off") return false;
  if (raw === "1" || raw === "on" || raw === "true") return true;
  return raw.split(",").map(x => x.trim()).includes(roomId);
}

const COPY = {
  reping: n => `Assignment still waiting: "${n.title}" has not been accepted. Accept it, decline it, or say what blocks you.`,
  escalate: n => `Escalation: "${n.title}" has had no answer from its assignee. Nudge, reassign, or supersede it.`,
  free: n => `Task is free: "${n.title}" was never accepted. Anyone may propose to take it.`,
  warn: n => `Lease ending soon on "${n.title}". Renew the claim to keep it, or release it.`,
};

// One tick for one room: post each due rung once (the message id is derived
// from the rung key, so a repeat tick or restart coalesces) and wake agent
// recipients through the claim wake path. Never throws.
export function runAssignmentDeadlines(store, roomId, nowMs, { append = appendRoomEvent, ...options } = {}) {
  try {
    if (!assignmentDeadlinesEnabled(store?.featureEnv, roomId)) return [];
    const room = store.room(roomId);
    const state = room?.state;
    const ownerId = state?.room?.ownerId ?? null;
    const author = ownerId ? ownMember(state?.members ?? {}, ownerId) : null;
    if (!author || author.active === false) return [];
    const items = Object.values(state.workItems ?? {});
    let claims = [];
    try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
    const titles = new Map([...items, ...claims].map(x => [x.id, String(x.title ?? x.id).slice(0, 120)]));
    const posted = [];
    for (const notice of dueDeadlineNotices([...items, ...claims], nowMs, { ownerId, ...options })) {
      const messageId = stableEventId("ad", notice.key);
      const body = COPY[notice.stage]?.({ title: titles.get(notice.workItemId) ?? notice.workItemId });
      if (!body) continue;
      // A rung already posted (repeat tick, restart) returns null: no repeat wake.
      if (!append(store, roomId, { id: messageId, type: "message.posted", actorId: author.id, data: { messageId, body } })) continue;
      for (const memberId of notice.notify) {
        if (ownMember(state.members ?? {}, memberId)?.kind !== "agent") continue;
        enqueueClaimWake(store, roomId, memberId, messageId, { reason: "assignment_deadline", actorId: author.id });
      }
      posted.push(messageId);
    }
    return posted;
  } catch (error) {
    console.error(`assignment deadlines failed: ${error?.message ?? "failed"}`);
    return [];
  }
}

export function runAssignmentDeadlinesAll(store, nowMs) {
  const env = store?.featureEnv;
  if (!store?.db || !env?.ROOM_ASSIGNMENT_DEADLINES) return 0;
  let roomIds = [];
  try { roomIds = store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(r => r.roomId); }
  catch { roomIds = []; }
  let n = 0;
  for (const roomId of roomIds) n += runAssignmentDeadlines(store, roomId, nowMs).length;
  return n;
}
