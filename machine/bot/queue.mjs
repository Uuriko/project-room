// Wake envelopes and the Updates queue.
//
// POST /api/agent-heartbeats and GET /api/agent-wakes/poll both return
// pendingWakes. Mention and DM pointers carry messageId. Work pointers carry
// workItemId and are present on the heartbeat, because the poll read does not
// name a host. The queue itself is orient plus the room Updates list. A wake
// is only a pointer into that list.

export function wakePointers(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.pendingWakes)) return [];
  return body.pendingWakes.filter(item =>
    item && typeof item.signalId === "string" && typeof item.roomId === "string");
}

function samePointer(ref, messageId, workItemId) {
  if (!ref || typeof ref !== "object") return false;
  if (messageId && (ref.messageId === messageId || ref.requestId === messageId)) return true;
  if (workItemId && (ref.workItemId === workItemId || ref.claimId === workItemId)) return true;
  return false;
}

export function sourcesIncomplete(incomplete) {
  if (!incomplete || typeof incomplete !== "object") return false;
  return incomplete.mentions === true || incomplete.peerDms === true || incomplete.claims === true || incomplete.wakes === true;
}

// Match a wake pointer to an actionable update, or to work the orient payload
// already lists for this member. Null means the pointer is not in the queue.
export function queueMatch(signal, { updates = [], orient = null } = {}) {
  const messageId = typeof signal?.messageId === "string" ? signal.messageId : null;
  const workItemId = typeof signal?.workItemId === "string" ? signal.workItemId : null;
  const update = updates.find(item => samePointer(item?.sourceRef, messageId, workItemId));
  if (update) {
    const ref = update.sourceRef ?? {};
    return {
      updateId: typeof update.id === "string" ? update.id : null,
      basisToken: typeof update.basisToken === "string" ? update.basisToken : null,
      kind: typeof update.kind === "string" ? update.kind : "mention",
      messageId: typeof ref.messageId === "string" ? ref.messageId : (typeof ref.requestId === "string" ? ref.requestId : messageId),
      workItemId: typeof ref.workItemId === "string" ? ref.workItemId : (typeof ref.claimId === "string" ? ref.claimId : workItemId),
      title: typeof update.title === "string" ? update.title : "",
    };
  }
  const work = [...(orient?.workItems ?? []), ...(orient?.work ?? [])]
    .find(item => item?.id && item.id === workItemId);
  if (work) {
    return {
      updateId: null,
      kind: "work",
      messageId: null,
      workItemId: work.id,
      title: typeof work.title === "string" ? work.title : work.id,
    };
  }
  const claim = (orient?.claims ?? []).find(item => item?.id && item.id === workItemId);
  if (claim) {
    return {
      updateId: null,
      kind: "work",
      messageId: null,
      workItemId: claim.id,
      title: typeof claim.title === "string" ? claim.title : claim.id,
    };
  }
  return null;
}
