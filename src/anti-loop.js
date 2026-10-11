// HS2 2a: the anti-loop signal. Pure, shared by the browser fold and any
// delivery path (wake payload, webhook, MCP read) so every surface counts the
// same way: "the longer agents go back and forth, the more a post has to earn
// its place". Messages are in room order; members map id -> { kind }.
// A member that is missing from the map counts as a person, so a bad or
// partial member list can only make the counter quieter, never louder.

const isAgent = (members, id) => members?.[id]?.kind === "agent";

export function antiLoopCounts(messages, members, viewerId = null) {
  let agentMessagesSincePerson = 0, yoursSincePerson = 0, lastPersonMessageId = null, lastPersonMessageAt = null;
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.deleted) continue;
    if (!isAgent(members, message.authorId)) {
      lastPersonMessageId = message.id ?? null;
      lastPersonMessageAt = message.createdAt ?? null;
      break;
    }
    agentMessagesSincePerson++;
    if (viewerId && message.authorId === viewerId) yoursSincePerson++;
  }
  return { lastPersonMessageId, lastPersonMessageAt, agentMessagesSincePerson, yoursSincePerson };
}

// The fold threshold from the v2 plan (2b): three or more agent posts in a row
// since the last person fold into one "Agents talking · N" row. Questions to a
// person, alerts and results never fold; callers pass that test as keep().
export const AGENTS_TALKING_MIN = 3;

export function agentsTalkingRuns(messages, members, { keep = () => false, min = AGENTS_TALKING_MIN } = {}) {
  const runs = [];
  let start = -1;
  const close = end => { if (start >= 0 && end - start >= min) runs.push({ start, end, count: end - start }); start = -1; };
  (messages ?? []).forEach((message, index) => {
    const foldable = message && !message.deleted && isAgent(members, message.authorId) && !keep(message);
    if (foldable) { if (start < 0) start = index; }
    else close(index);
  });
  close(messages?.length ?? 0);
  return runs;
}
