// Derived, read-time coordination-loop signals over existing room state.
// Detection only - a pause/escalation hint, never a block, write or dispatch.
// Pure reads of the current projection: no new events, so strict replay is
// unaffected and historical rooms evaluate identically on recovery.

// Two drafts carrying the same normalized text on one work item mean the
// conversation is producing, not converging.
function duplicateProposals(messages) {
  const seen = new Map();
  for (const message of messages) {
    if (!message.proposal || message.deletedAt) continue;
    const body = message.body.trim().replace(/\s+/g, " ");
    if (!body) continue;
    const hit = seen.get(body);
    if (hit) { hit.count++; hit.messageIds.push(message.id); }
    else seen.set(body, { count: 1, messageIds: [message.id] });
  }
  return [...seen.values()].filter(entry => entry.count >= 2);
}

// Handoffs never advance state by design, so a pile of them on one item is
// churn: work is being passed around instead of moved.
function handoffChurn(item) {
  return (item.handoffHistory?.length ?? 0) + (item.handoff?.open ? 1 : 0);
}

// A tail of short messages strictly alternating between two authors, with no
// draft, result or state change inside, is an acknowledgement chain.
const ACK_LIMIT = 160;
function ackChain(messages) {
  const tail = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.deletedAt) continue;
    if (message.proposal || message.body.trim().length > ACK_LIMIT) break;
    tail.unshift(message);
    if (tail.length >= 2 && tail[0].authorId === tail[1].authorId) { tail.shift(); break; }
  }
  if (tail.length < 4) return null;
  const authors = new Set(tail.map(message => message.authorId));
  return authors.size === 2 ? tail : null;
}

export function coordinationLoops(item, messages) {
  if (!item || item.supersededBy) return [];
  const linked = messages.filter(message => message.workItemId === item.id);
  const signals = [];
  const duplicates = duplicateProposals(linked);
  if (duplicates.length) signals.push({ kind: "duplicate_proposals", count: duplicates[0].count,
    messageIds: duplicates[0].messageIds,
    label: `${duplicates[0].count} identical drafts were posted on this work. Pause automatic drafting; a human should pick one or revise.` });
  const handoffs = handoffChurn(item);
  if (handoffs >= 3) signals.push({ kind: "handoff_churn", count: handoffs,
    label: `${handoffs} handoffs without the work advancing. Pause further handoffs; owner triage: reassign, resume or supersede.` });
  const chain = ackChain(linked);
  if (chain) signals.push({ kind: "ack_chain", count: chain.length,
    messageIds: chain.map(message => message.id),
    label: `${chain.length} short replies alternating between the same two members with no draft or result. Pause the exchange and decide in the work item.` });
  return signals;
}
