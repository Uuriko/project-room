// One task status for the board, the thread, the task card, and the API.
// Legacy claim states and work-item states map through this module only.
import { nextWorkStep } from "./workflow.js";

export const TASK_STATUSES = Object.freeze(["open", "claimed", "running", "needs_you", "blocked", "done"]);

export const TASK_STATUS_LABELS = Object.freeze({
  open: "Open",
  claimed: "Claimed",
  running: "Running",
  needs_you: "Needs you",
  blocked: "Blocked",
  done: "Done",
});

// Board claims. closed is terminal and maps to done; outcome keeps the
// distinction so a retired claim is not described as finished work.
const CLAIM_STATUS = Object.freeze({
  unclaimed: "open",
  claimed: "claimed",
  in_progress: "running",
  blocked: "blocked",
  delivered: "needs_you",
  done: "done",
  closed: "done",
});

const pack = (status, legacy, outcome = null) => Object.freeze({
  status,
  legacy,
  label: TASK_STATUS_LABELS[status],
  ...(outcome ? { outcome } : {}),
});

export function taskStatusFromClaim(claim) {
  const legacy = typeof claim?.state === "string" ? claim.state : "";
  const status = CLAIM_STATUS[legacy];
  if (!status) return null;
  const outcome = legacy === "closed" ? "closed" : legacy === "done" ? "completed" : null;
  return pack(status, legacy, outcome);
}

// Work items. proposed already names an accountable member, so the shared
// word is Needs you. Unclaimed board work stays Open.
export function taskStatusFromWork(item, now = Date.now(), ownerId = null) {
  if (!item || typeof item !== "object") return null;
  const legacy = typeof item.state === "string" ? item.state : "";
  if (legacy === "superseded" || item.supersededBy) return pack("done", legacy || "superseded", "superseded");
  if (item.handoff?.open) return pack("needs_you", legacy, "handoff");
  if (legacy === "proposed") return pack("needs_you", legacy, "accept");
  if (legacy === "accepted") return pack("claimed", legacy);
  if (legacy === "working") return pack("running", legacy);
  if (legacy === "blocked") return pack("blocked", legacy);
  if (legacy === "completed") {
    const next = nextWorkStep(item, now, ownerId);
    if (next.needsAttention) return pack("needs_you", legacy, next.action);
    return pack("done", legacy, "completed");
  }
  return null;
}

export function taskStatus(record, now = Date.now(), ownerId = null) {
  if (record?.source === "work" || record?.accountableMemberId || record?.definitionOfDone) {
    return taskStatusFromWork(record, now, ownerId);
  }
  return taskStatusFromClaim(record);
}
