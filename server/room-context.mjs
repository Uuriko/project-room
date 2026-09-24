// Compact agent catch-up. One authenticated projection of who is here, what
// the room requires, which work is aimed at the caller, and the refs needed
// to resume. Message bodies, file bytes, and result prose stay out: those
// have their own reads. context_version hashes this projection so an unchanged
// room answers { not_modified: true } instead of another copy.
import { createHash } from "node:crypto";
import { roomPolicy } from "../src/events.js";
import { activeClaim, nextWorkStep } from "../src/workflow.js";

export const ROOM_CONTEXT_OMITTED = Object.freeze([
  "message_bodies", "file_bodies", "native_result_text", "definition_of_done",
  "handoff_done_summary", "decision_reason"
]);

const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

const text = value => typeof value === "string" ? value : null;
const list = value => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];

function evidenceRef(workItemId, record, source) {
  const url = text(source?.evidenceUrl);
  if (!url) return null;
  return { kind: "evidence", workItemId, record, url, evidenceVersion: text(source.evidenceVersion) };
}

// Latest open handoff whose triage member is the viewer. doneSummary is omitted.
function handoffToYou(items, viewerId, ownerId) {
  const open = items.filter(item => item.handoff?.open && (item.handoff.triageMemberId ?? ownerId) === viewerId);
  open.sort((a, b) => (a.handoff.at < b.handoff.at ? 1 : a.handoff.at > b.handoff.at ? -1 : a.id < b.id ? -1 : 1));
  const item = open[0];
  if (!item) return null;
  const handoff = item.handoff;
  return {
    workItemId: item.id, eventId: text(handoff.eventId), at: text(handoff.at), actorId: text(handoff.actorId),
    triageMemberId: handoff.triageMemberId ?? ownerId, nextAction: text(handoff.nextAction),
    limitReason: text(handoff.limitReason), haltAll: handoff.haltAll === true,
    evidenceUrl: text(handoff.evidenceUrl), evidenceVersion: text(handoff.evidenceVersion)
  };
}

export function contextVersion(stable) {
  return createHash("sha256").update(canonical(stable)).digest("hex");
}

// Pure projection. `now` is the service clock in epoch milliseconds, the same
// clock active claims use. evaluatedAt is not part of context_version.
export function buildRoomContext({ state, sequence, viewerId, caughtUp, now }) {
  if (!state?.room?.id || typeof viewerId !== "string" || !Number.isSafeInteger(sequence) || sequence < 0
    || !Number.isSafeInteger(caughtUp) || caughtUp < 0 || !Number.isSafeInteger(now)) {
    throw new RangeError("Room context needs a room, viewer, sequence, cursor, and clock");
  }
  const ownerId = state.room.ownerId ?? null;
  const storedPolicy = state.room.policy ?? {};
  const items = Object.values(state.workItems ?? {}).filter(item => item && typeof item.id === "string");
  const roster = Object.values(state.members ?? {})
    .filter(member => member && typeof member.id === "string")
    .map(member => ({
      id: member.id, displayName: text(member.displayName), kind: text(member.kind),
      active: member.active !== false, permissions: list(member.permissions)
    }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const focusWork = [];
  const locks = [];
  const deps = [];
  const decisions = [];
  const fileRefs = [];
  for (const item of items) {
    const next = nextWorkStep(item, now, ownerId);
    const lock = activeClaim(item, now) ? item.claim : null;
    if (next.memberId === viewerId || lock?.holderId === viewerId) {
      focusWork.push({
        id: item.id, title: text(item.title), state: text(item.state), revision: item.revision ?? 0,
        mode: text(item.mode), accountableMemberId: text(item.accountableMemberId),
        nextAction: next.action, nextMemberId: next.memberId, needsAttention: next.needsAttention === true
      });
    }
    if (lock) {
      const paths = list(lock.paths);
      locks.push({
        workItemId: item.id, holderId: text(lock.holderId), repository: text(lock.repository),
        ref: text(lock.ref), paths, expiresAt: text(lock.expiresAt), status: "active"
      });
      for (const path of paths) fileRefs.push({ kind: "claim_path", workItemId: item.id, path, repository: text(lock.repository), ref: text(lock.ref) });
    }
    if (typeof item.supersededBy === "string" && item.supersededBy) deps.push({ workItemId: item.id, supersededBy: item.supersededBy });
    if (item.decision?.decision) {
      decisions.push({
        workItemId: item.id, decision: item.decision.decision, actorId: text(item.decision.actorId),
        eventId: text(item.decision.eventId), completionEventId: text(item.decision.completionEventId),
        evidenceVersion: text(item.decision.evidenceVersion)
      });
    }
    for (const record of ["receipt", "verification", "handoff"]) {
      const ref = evidenceRef(item.id, record, item[record]);
      if (ref) fileRefs.push(ref);
    }
  }
  const byId = (a, b, key = "workItemId") => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  const refKey = ref => [ref.workItemId, ref.kind, ref.record ?? "", ref.path ?? "", ref.url ?? ""].join("\0");
  focusWork.sort((a, b) => byId(a, b, "id"));
  locks.sort(byId);
  deps.sort(byId);
  decisions.sort(byId);
  fileRefs.sort((a, b) => refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0);
  const stable = {
    roomId: state.room.id, viewerId,
    roster, policy: {
      requireIndependentReview: roomPolicy(state).requireIndependentReview,
      requireOwnerDecision: roomPolicy(state).requireOwnerDecision,
      revision: Number.isSafeInteger(storedPolicy.revision) ? storedPolicy.revision : 0
    },
    focusWork, locks, deps, handoffToYou: handoffToYou(items, viewerId, ownerId),
    decisions, fileRefs,
    cursors: { roomSequence: sequence, caughtUp, eventsQuery: "after", resumeAfter: caughtUp },
    omitted: [...ROOM_CONTEXT_OMITTED]
  };
  return {
    contractVersion: 1, context_version: contextVersion(stable),
    evaluatedThrough: sequence, evaluatedAt: new Date(now).toISOString(),
    ...stable
  };
}
