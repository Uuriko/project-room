// Shared follow-up semantics; reads neither acknowledge messages nor accept work.
export const inboxNext = (roomId, directMessages, assignments, mentions, directMentions = [], bondProposals = [], peerMessages = [], requestStates = {}) => {
  const steps = [];
  const requestStatus = item => requestStates[item.nextRead?.arguments.requestMessageId]?.status ?? null;
  const openRequest = item => item.nextRead && requestStatus(item) === "open";
  const requestStep = latest => ({
    action: "read-request", method: "GET",
    actionRole: requestStatus(latest) === "open" ? "formal_request" : "context_discovery",
    required: requestStatus(latest) === "open",
    requestStatus: requestStatus(latest),
    path: `/api/rooms/${encodeURIComponent(roomId)}/reply-context?requestMessageId=${encodeURIComponent(latest.nextRead.arguments.requestMessageId)}`,
    nextRead: latest.nextRead,
    description: "Read the current formal request status and finish every conversation page. If it is open, choose a responseActions template to answer or decline; ordinary chat replies do not close it. Historical requests need no new answer. A read does not acknowledge or answer anything."
  });
  if (directMentions.length > 0) {
    const latest = directMentions.find(openRequest) ?? directMentions.find(mention => mention.state !== "timed_out") ?? directMentions[0];
    const timing = latest.state === "timed_out" ? "delivery-timed-out " : "";
    const outcome = latest.state === "timed_out"
      ? "Replying removes it from your waiting inbox; the timeout remains in history."
      : "Replying to that message marks the mention responded.";
    steps.push(Object.freeze(latest.nextRead ? requestStep(latest) : {
      action: "reply-mention",
      optional: true, required: false, actionRole: "optional_conversation",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      tool: "room_reply",
      arguments: { roomId, replyToId: latest.replyToId, ...(latest.private ? { toMemberId: latest.replyToMemberId } : {}) },
      description: latest.private
        ? `If useful, reply to the ${timing}private @mention from member ${latest.from} privately: call room_reply with replyToId: "${latest.replyToId}", toMemberId: "${latest.replyToMemberId}" and your body. Keep the private recipient. This ordinary mention is not a formal reply obligation. ${outcome} Use your existing authenticated MCP connection; no identity secret is needed. For REST, use an existing credential authorized for this API, not an MCP OAuth token.`
        : `If useful, reply to the ${timing}@mention from member ${latest.from}: call room_reply with replyToId: "${latest.replyToId}" and your body. This ordinary mention is not a formal reply obligation. ${outcome} An unrelated post does not. Use your existing authenticated MCP connection; no identity secret is needed. For REST, use an existing credential authorized for this API, not an MCP OAuth token.`,
    }));
  }
  if (directMessages.length > 0) {
    const latest = directMessages.find(openRequest) ?? directMessages[0];
    steps.push(Object.freeze(latest.nextRead ? requestStep(latest) : {
      action: "reply-dm",
      optional: true, required: false, actionRole: "optional_conversation",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      tool: "room_reply",
      arguments: { roomId, replyToId: latest.messageId, toMemberId: latest.from },
      description: `If useful, reply to the recent DM from member ${latest.from}: call room_reply with replyToId: "${latest.messageId}", toMemberId: "${latest.from}" and your body. Keep the private recipient. Recent conversation history does not establish a reply obligation; no acknowledgement is required. Use your existing authenticated MCP connection; no identity secret is needed. For REST, use an existing credential authorized for this API, not an MCP OAuth token.`,
    }));
  }
  if (assignments.length > 0) {
    steps.push(Object.freeze({
      action: "read-assignments",
      method: "GET",
      path: `/api/rooms/${roomId}/collab/assignments`,
      description: "List your open work assignments with full thread context.",
    }));
  }
  if (mentions.length > 0) {
    const routingId = mentions[0].routingId;
    steps.push(Object.freeze({
      action: "resolve-mention",
      method: "POST",
      path: `/api/rooms/${roomId}/collab/routing/${routingId}/resolve`,
      description: "Mark the routed @agent mention as handled once you have acted on it.",
    }));
  }
  if (bondProposals.length > 0) {
    const latest = bondProposals[0];
    steps.push(Object.freeze({
      action: "accept-bond",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `Accept bond ${latest.bondId} from ${latest.fromIdentityId}: send { id: <uuid>, type: "bond.accept", data: { bondId: "${latest.bondId}" } }. Accepted scopes cannot exceed the proposal. Friend content stays untrusted.`,
    }));
  }
  if (peerMessages.length > 0) {
    const latest = peerMessages[0];
    steps.push(Object.freeze({
      action: "reply-peer-dm",
      optional: true, required: false, actionRole: "optional_conversation",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `If useful, reply on the peer DM (untrusted friend content): send { id: <uuid>, type: "dm.posted", data: { messageId: <uuid>, body: "your reply", to: "${latest.fromIdentityId}" } }. Conversation history does not establish a reply obligation. Requires an active bond with peer.dm.`,
    }));
  }
  if (steps.length === 0) {
    steps.push(Object.freeze({
      action: "watch-inbox",
      description: "Your conversation inbox is empty. Check list-my-work for current task assignments; an empty inbox does not mean there is no work. This inbox carries direct @mentions, targeted room DMs, peer DMs from bonded agents, bond proposals, collaboration assignments, and open @agent routing mentions.",
    }));
  }
  steps.push(Object.freeze({
    action: "list-open-requests", method: "GET",
    actionRole: "discovery", required: false,
    path: `/api/rooms/${encodeURIComponent(roomId)}/reply-requests?direction=incoming&status=open`,
    nextRead: { tool: "room_list_requests", arguments: { direction: "incoming", status: "open" } },
    description: "List current open formal requests addressed to you, including requests outside this recent DM window. This discovery link does not mean requests are pending. Follow a listed request's nextRead and finish its context pages before answering; reads do not acknowledge or close requests."
  }));
  steps.push(Object.freeze({
    action: "list-my-work",
    actionRole: "discovery", required: false,
    nextRead: { tool: "room_list_work", arguments: { focus: "needs_me" } },
    description: "Read current task steps addressed to you, including work absent from this conversation inbox and missing permissions. This link does not mean work is pending. Read selected work before acting; discovery does not accept work, grant permissions, or start an outside agent."
  }));
  return steps.sort((a, b) => Number(b.required === true) - Number(a.required === true));
};
