import { createHash } from "node:crypto";
// Reuse Room's formal requests, authorization and operation receipts.
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { validId } from "../src/events.js";
import { nextWorkStep } from "../src/workflow.js";
import { SESSION_STATUSES, sessionRecord } from "../src/work-item-session.js";
import { observeSelectedRuns } from "./request-runs.mjs";
import { readWorkItem } from "./work-repository.mjs";
import { recentRoomResult } from "./room-next.mjs";
import { CAPACITY_STOP, reportsCapacityStop } from "./wake-queue.mjs";

export { CAPACITY_STOP };

export const investigation = "Room investigation pass.";

export function compileCapacityHandoff(route) {
  if (route.capacityHandoff === undefined) return null;
  const { sourceOperationId, replacementOperationId, replacementMemberId, body } = route.capacityHandoff ?? {};
  if (![sourceOperationId, replacementOperationId, replacementMemberId].every(validId)
      || sourceOperationId === replacementOperationId
      || [route.requesterId, route.recipientId].includes(replacementMemberId)
      || typeof body !== "string" || !body.trim())
    throw new Error("Invalid completion capacity handoff");
  const identity = { roomId: route.roomId, memberId: route.requesterId };
  const successor = buildReplyCommand(identity, "room_request_reply", {
    requestId: replacementOperationId, toMemberId: replacementMemberId, workItemId: route.workItemId,
    body: `@(${replacementMemberId})\n${body.trim()}`
  });
  const source = buildReplyCommand(identity, "room_request_reply", {
    requestId: sourceOperationId, toMemberId: route.recipientId, workItemId: route.workItemId, body: "Lookup request identity."
  });
  return { source, successor, replacementMemberId, cancelId: `${successor.data.messageId}-cancel` };
}

export function capacityHandoff(store, binding, receiver) {
  const { route, secret, capacity } = binding;
  const { roomId, requesterId, recipientId, workItemId } = route;
  return store.transaction(() => {
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw new Error("Pickup requester identity changed");
    if (store.operationReceipt(secret, roomId, capacity.successor.id).status === "recorded") {
      return { state: store.operationReceipt(secret, roomId, capacity.cancelId).status === "recorded"
        ? "handed_off" : "replacement_operation_conflict" };
    }
    const pause = store.wakeQueue.pauseStatus(roomId, recipientId);
    if (!pause) return { state: "capacity_not_reported" };
    if (!reportsCapacityStop(pause.reason)) return { state: "paused" };
    if (pause.reason !== `${CAPACITY_STOP}:request:${capacity.source.data.messageId}`)
      return { state: "awaiting_exact_stop" };
    const receipt = store.operationReceipt(secret, roomId, capacity.source.id);
    if (receipt.status !== "recorded" || receipt.sequence <= route.after || receipt.eventType !== "message.posted")
      return { state: "waiting_for_source" };
    const sourceId = capacity.source.data.messageId;
    const { request, page } = store.replyRequests.selected(secret, roomId, sourceId, { view: "compact" });
    if (request.requesterId !== requesterId || request.recipientId !== recipientId || request.workItemId !== workItemId
        || request.openingEventId !== receipt.eventId || request.status !== "open") return { state: "source_not_open" };
    // A pause does not stop an already dispatched turn. The marker is an
    // operator/host attestation of pre-dispatch refusal; any recorded progress
    // or revised context makes this automatic path ineligible.
    if (request.acknowledgedAt || request.progressState || request.contextEventId !== request.openingEventId || page.hasMore || page.items.length !== 1
        || page.items[0].kind !== "opened" || observeSelectedRuns(store, roomId, [request])[sourceId])
      return { state: "inspect_existing_attempt" };
    const target = capacity.replacementMemberId;
    if (store.wakeQueue.pauseStatus(roomId, target)) return { state: "replacement_paused" };
    if (binding.hasOpenRequest({ ...route, recipientId: target })) return { state: "replacement_busy_or_unknown" };
    const exact = { roomId, recipientId: target, requesterId, workItemId, id: capacity.successor.data.messageId };
    if (!receiver?.hasRecoveryReceiver(exact, receipt.sequence, false))
      return { state: "replacement_unreachable" };
    const cancel = buildReplyCommand({ roomId, memberId: requesterId }, "room_cancel_request", {
      requestId: capacity.cancelId, requestMessageId: sourceId,
      expectedRequestRevision: request.revision, reason: "Provider unavailable before work began. The approved replacement is taking this request."
    });
    store.command(secret, roomId, cancel);
    const next = store.command(secret, roomId, capacity.successor);
    return { state: "handed_off", opening: next.sequence };
  });
}

export function compileIdleRefill(route, result = null) {
  if (route.idleRefill === undefined) return null;
  const { requestId, body, discover } = route.idleRefill ?? {};
  const hasBody = typeof body === "string" && !!body.trim();
  if (!validId(requestId) || (discover === true ? body !== undefined : discover !== undefined || !hasBody))
    throw new Error("Invalid idle refill request");
  const { roomId, requesterId, recipientId, workItemId } = route;
  const operation = result ? "idle-evidence-" + createHash("sha256").update(JSON.stringify([
    roomId, requesterId, recipientId, workItemId, requestId, result.workItemId, result.completionEventId
  ])).digest("hex") : requestId;
  return buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
    requestId: operation, toMemberId: recipientId, workItemId,
    body: [route.firstLine ?? `@(${recipientId})`, ...(discover === true ? [
      investigation,
      "Check room_next or room_list_work for authorized work before investigating. If you already have work, continue it and close this request with its ID.",
      ...(result ? [`Start from Room result ${result.workItemId}, exact completion ${result.completionEventId}. Only use it if the existing Room read still gives you access to that result.`] : []),
      "Otherwise inspect one public or explicitly shared source in this lane for a current issue. Propose one bounded task with the exact source, evidence and permissions needed. Say what you checked if no useful task was found. Read-only."
    ] : [body.trim()])].join("\n")
  });
}

export function idleRefill(store, { route, secret, refill, hasOpenRequest }, receiver) {
  const { roomId, requesterId, recipientId, workItemId, after } = route;
  return store.transaction(() => {
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw new Error("Pickup requester identity changed");
    const pause = store.wakeQueue.pauseStatus(roomId, recipientId);
    if (pause) return { state: reportsCapacityStop(pause.reason) ? "capacity_blocked" : "paused" };
    const work = readWorkItem(store.db, roomId, workItemId);
    const nextStep = work && nextWorkStep(work);
    if (hasOpenRequest(route) || nextStep?.memberId === recipientId) return { state: "pending_work" };
    const seed = store.operationReceipt(secret, roomId, refill.id);
    const result = seed.status === "recorded" && seed.eventType === "message.posted"
      && seed.sequence > after && route.idleRefill.discover === true
      ? recentRoomResult(store, roomId, seed.sequence) : null;
    const offer = result ? compileIdleRefill(route, result) : refill;
    if (!receiver?.hasRecoveryReceiver({ roomId, requesterId, recipientId, workItemId, id: offer.data.messageId },
        after, false)) return { state: "receiver_unconfirmed" };
    // This proves availability in the configured lane only.
    if (store.operationReceipt(secret, roomId, offer.id).status === "recorded") return { state: "no_work_ready" };
    const next = store.command(secret, roomId, offer);
    return { state: "refill_requested", opening: next.sequence };
  });
}

export function compileCapacityWork(route) {
  if (route.capacityWork === undefined) return null;
  const { operationId, replacementMemberId, replacementWorkItemId, expectedRevision, title, definitionOfDone } = route.capacityWork ?? {};
  if (![operationId, operationId + "-supersede", operationId + "-pickup", replacementMemberId, replacementWorkItemId].every(validId)
      || route.workItemId === replacementWorkItemId || route.recipientId === replacementMemberId
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof title !== "string" || !title.trim() || typeof definitionOfDone !== "string" || !definitionOfDone.trim())
    throw new Error("Invalid capacity Work Thread handoff");
  return { operationId, replacementMemberId, replacementWorkItemId, expectedRevision, title, definitionOfDone };
}

export function capacityWorkHandoff(store, { route, secret, workHandoff, hasOpenRequest }, receiver) {
  const { roomId, requesterId, recipientId, workItemId, after } = route;
  const { operationId, replacementMemberId, replacementWorkItemId, expectedRevision, title, definitionOfDone } = workHandoff;
  // Keep both writes in one Room transaction, including event publication.
  return store.transaction(() => {
    if (store.authenticate(secret, roomId).member.id !== requesterId) throw new Error("Pickup requester identity changed");
    const supersedeId = operationId + "-supersede";
    const pickupId = operationId + "-pickup";
    const proposed = store.operationReceipt(secret, roomId, operationId);
    const superseded = store.operationReceipt(secret, roomId, supersedeId);
    const pickup = store.operationReceipt(secret, roomId, pickupId);
    const item = readWorkItem(store.db, roomId, workItemId);
    if ([proposed, superseded, pickup].some(receipt => receipt.status === "recorded"))
      return { state: proposed.eventType === "work.proposed" && superseded.eventType === "work.superseded"
        && pickup.eventType === "message.posted" && proposed.sequence < superseded.sequence && superseded.sequence < pickup.sequence
        && item?.supersededBy === replacementWorkItemId ? "work_handed_off" : "replacement_operation_conflict" };
    const pause = store.wakeQueue.pauseStatus(roomId, recipientId);
    if (!reportsCapacityStop(pause?.reason)) return { state: pause ? "paused" : "capacity_not_reported" };
    if (pause.reason !== `${CAPACITY_STOP}:work:${workItemId}:${expectedRevision}`)
      return { state: "awaiting_exact_stop" };
    if (item?.accountableMemberId !== recipientId || item.revision !== expectedRevision
        || item.proposedById !== requesterId || item.state !== "proposed" || item.mode !== "read"
        || item.claim || item.receipt || item.receiptHistory?.length || item.handoff?.open
        || item.verifierMemberId === replacementMemberId || item.humanDecisionMakerId === replacementMemberId)
      return { state: "inspect_existing_work" };
    const session = sessionRecord(item);
    if (session.status !== SESSION_STATUSES.QUEUED || session.attempt_count || session.worker_member_id
        || session.started_at || session.heartbeat_at || session.stop_requested_at)
      return { state: "inspect_existing_work" };
    if (store.wakeQueue.pauseStatus(roomId, replacementMemberId)) return { state: "replacement_paused" };
    if (hasOpenRequest({ ...route, recipientId: replacementMemberId })) return { state: "replacement_busy_or_unknown" };
    const pickupCommand = buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
      requestId: pickupId, toMemberId: replacementMemberId, workItemId: replacementWorkItemId,
      body: `@(${replacementMemberId})\nOpen the linked Work Thread. Check its scope, then accept if you can take it. Reply here to confirm or decline.`
    });
    if (!receiver?.hasRecoveryReceiver({ roomId, recipientId: replacementMemberId, requesterId,
      workItemId: replacementWorkItemId, id: pickupCommand.data.messageId }, after, false))
      return { state: "replacement_unreachable" };
    const recipient = store.roomAuthority(roomId, { memberId: replacementMemberId }).members[replacementMemberId];
    if (!recipient?.active || !recipient.permissions.includes("accept_work")) return { state: "replacement_cannot_accept" };
    store.command(secret, roomId, { id: operationId, type: "work.proposed", data: {
      workItemId: replacementWorkItemId, accountableMemberId: replacementMemberId, title, definitionOfDone, mode: "read",
      independentVerificationRequired: item.independentVerificationRequired, ownerDecisionRequired: item.ownerDecisionRequired,
      ...(item.verifierMemberId && { verifierMemberId: item.verifierMemberId }),
      ...(item.humanDecisionMakerId && { humanDecisionMakerId: item.humanDecisionMakerId }),
      ...(item.dependsOn?.length && { dependsOn: item.dependsOn })
    } });
    store.command(secret, roomId, { id: supersedeId, type: "work.superseded", data: {
      workItemId, expectedRevision, supersededByWorkItemId: replacementWorkItemId,
      reason: "Provider capacity was unavailable before work began. Continue in the replacement Work Thread."
    } });
    const notice = store.command(secret, roomId, pickupCommand);
    return { state: "work_handed_off", opening: notice.sequence };
  });
}
