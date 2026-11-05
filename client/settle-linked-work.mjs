// Operator opt-in (`settleLinkedWork`) for an unattended request host.
//
// Baseline stall (agent-work baseline, 3 Nov 2026): a woken agent can answer
// a reply request but cannot accept, start or save the linked work without
// its main worker, because the runtime model is (correctly) given no write
// tools. This moves the three lifecycle steps into the HOST: deterministic
// code, never model output, and only when every gate below holds.
//   - The request is linked to a work item whose accountable member is this
//     connection's member. Nothing else is ever transitioned.
//   - Only read-mode work is started; write mode needs a scope claim, so it
//     is accepted and then left for the main worker.
//   - The saved result is the delivered reply itself (a work-linked room
//     message), pinned by its event id and exact UTF-8 SHA-256.
// Every command id is derived from the host attempt and the step, so a retry
// replays the same operation. The service still validates every command;
// a refusal is reported, never retried with new ids. Default: off.
import { createHash } from "node:crypto";

const stepId = (attemptKey, step) => "settle-" + createHash("sha256").update(JSON.stringify([attemptKey, step])).digest("hex").slice(0, 40);
const sha256 = text => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");

export function linkedWorkEligible(work, memberId) {
  return Boolean(work && typeof work.id === "string" && work.accountableMemberId === memberId
    && ["proposed", "accepted", "working"].includes(work.state));
}

// Before execution: accept a proposed item, start an accepted read-mode item.
export async function settleBeforeRun(client, { memberId, attemptKey, workItemId, signal }) {
  const steps = [];
  let work = (await client.workContext(workItemId, { signal })).work;
  if (!linkedWorkEligible(work, memberId)) return { steps, skipped: "not_assigned_to_this_member" };
  if (work.state === "proposed") {
    await client.workAction("room_accept_work", { workItemId, requestId: stepId(attemptKey, "accept") }, { signal });
    steps.push("accepted");
    work = (await client.workContext(workItemId, { signal })).work;
  }
  if (work.state === "accepted") {
    if (work.mode === "write") return { steps, skipped: "write_mode_needs_scope_claim" };
    await client.workAction("room_start_work", { workItemId, requestId: stepId(attemptKey, "start") }, { signal });
    steps.push("started");
  }
  return { steps };
}

// After delivery: save the delivered reply as the item's text result.
export async function settleAfterDelivery(client, { memberId, attemptKey, workItemId, body, receipt, signal }) {
  if (typeof receipt?.messageId !== "string" || typeof receipt?.eventId !== "string") return { steps: [], skipped: "delivery_receipt_incomplete" };
  const work = (await client.workContext(workItemId, { signal })).work;
  if (work?.accountableMemberId !== memberId || work.state !== "working") return { steps: [], skipped: "not_working" };
  await client.workAction("room_submit_text_result", {
    workItemId, requestId: stepId(attemptKey, "result"),
    summary: "Answer delivered to the linked reply request.", nextAction: "Review the saved answer.",
    evidenceMessageId: receipt.messageId, evidenceMessageEventId: receipt.eventId,
    evidenceVersion: sha256(body), previousCompletionEventId: work.receipt?.eventId ?? null, producerId: memberId
  }, { signal });
  return { steps: ["result_saved"] };
}
