const CLOSED = new Set(['done', 'failed', 'cancelled']);

export function addressesAssistant(body, name = 'Room') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s,:.!?])`, 'iu').test(body ?? '');
}

// Routing is not authorization. The server still validates visibility,
// authorship, conversation membership and the observed run revision.
export function conversationIntent({ content, messages = [], runs = [], assistant, selfId, ownerId }) {
  if (content.toMemberId || !assistant?.coordinatorMemberId || assistant.availability === 'not_connected') return null;
  const addressed = addressesAssistant(content.body, assistant.name || 'Room');
  const target = messages.find(message => message.id === content.replyToId);
  if (!content.replyToId) return addressed ? { action: 'invoke' } : null;
  if (!target || target.deletedAt || target.toMemberId
    || (target.channelId ?? 'general') !== (content.channelId ?? 'general')) return null;

  // Only direct links to recorded run messages establish a continuation. A
  // conversation sharing a channel or thread is not enough to wake an agent.
  const linked = runs.filter(run => !run.sourceDeleted && (run.sourceMessageId === target.id
    || run.resultMessageId === target.id || run.inputs?.some(input => input.sourceMessageId === target.id)));
  if (linked.length !== 1) return addressed ? { action: 'invoke' } : null;
  const run = linked[0];
  if (CLOSED.has(run.status)) return { action: 'invoke' };
  if (run.status === 'cancel_requested') return null;
  if (run.status === 'needs_input') {
    if (selfId !== run.initiatorId && selfId !== ownerId) return null;
    return { action: 'resolve', runId: run.id, expectedRevision: run.revision };
  }
  return { action: 'contribute', runId: run.id, expectedRevision: run.revision };
}
