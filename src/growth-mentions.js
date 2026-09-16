// Track C slice C4 — @-mention detection for agent.mentioned growth events.
//
// Projects MESSAGE_POSTED room events into one C1 `agent.mentioned` envelope
// per mentioned agent member. Pure and dependency-free apart from the two
// sibling modules it bridges (EVENT_TYPES from src/events.js, defineEvent
// from src/growth-events.js). No network, no storage, no timers.
//
// Mention semantics mirror the product's own detection
// (messageMentionsMember in src/conversation.js, which drives mention
// notifications, and the mentionHtml chip renderer): a mention is the exact
// text "@" + displayName (the registered handle) or "@" + member id,
// followed by end-of-string or whitespace. Matching is exact and
// case-sensitive — never substring-fuzzy — so analytics counts exactly the
// mentions the room itself recognizes.
//
// Only identifiers and aggregates travel in the emitted envelopes
// (roomId, messageId, mentionedAgentId, mentionCount). Message bodies are
// never collected.

import { EVENT_TYPES } from "./events.js";
import { defineEvent } from "./growth-events.js";

// A mention token ends at end-of-string or whitespace — the same boundary
// rule the room core uses in messageMentionsMember.
const isMentionBoundary = ch => ch == null || /\s/.test(ch);

// Count exact occurrences of `label` in `text` where each occurrence is
// followed by a mention boundary. Literal scan (indexOf), so display names
// containing regex-special characters match exactly, as in the room core.
const countLabelMentions = (text, label) => {
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(label, from);
    if (i === -1) return count;
    if (isMentionBoundary(text[i + label.length])) count += 1;
    from = i + 1;
  }
  return count;
};

// Normalize the roster from context. Accepts the post-apply state's `members`
// map (id -> member), a plain member array, or an object carrying either.
// Returns active agent members with usable identities only.
const agentRoster = context => {
  const raw = context?.members ?? (Array.isArray(context) ? context : undefined);
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : [];
  return list.filter(m =>
    m && typeof m === "object" &&
    m.kind === "agent" &&
    m.active !== false &&
    typeof m.id === "string" && m.id &&
    typeof m.displayName === "string" && m.displayName.trim()
  );
};

// Candidate mention labels for one agent: the registered handle
// ("@" + displayName, exactly as the composer inserts it) and the exact
// member id ("@" + id). Display-name handles win when both spell the same
// label. Id labels containing whitespace or "@" are unusable as handles and
// are skipped.
const mentionLabels = agent => {
  const labels = new Map();
  labels.set(`@${agent.displayName}`, agent.id);
  if (!agent.id.includes("@") && !/\s/.test(agent.id)) {
    const idLabel = `@${agent.id}`;
    if (!labels.has(idLabel)) labels.set(idLabel, agent.id);
  }
  return labels;
};

const memberIndex = context => {
  const raw = context?.members ?? (Array.isArray(context) ? context : undefined);
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : [];
  const index = {};
  for (const m of list) {
    if (m && typeof m === "object" && typeof m.id === "string" && m.id) index[m.id] = m;
  }
  return index;
};

const isActorLike = actor =>
  actor && typeof actor === "object" &&
  typeof actor.id === "string" && actor.id &&
  ["human", "agent", "system"].includes(actor.kind);

// Actor for the emitted envelopes: supplied via context (growth-emit reuses
// the message.sent envelope's actor), otherwise derived from the room event
// the same way growth-emit's classifyActor does.
const actorOf = (roomEvent, context, membersById) => {
  if (isActorLike(context?.actor)) return { id: context.actor.id, kind: context.actor.kind };
  const rawId = roomEvent?.actorId;
  const id = typeof rawId === "string" && rawId ? rawId : "system";
  return { id, kind: membersById[id]?.kind === "agent" ? "agent" : "human" };
};

// Detect @-mentions of agent members in a MESSAGE_POSTED room event.
//
// `context` carries `{ members }` (the post-apply roster) and optionally
// `{ actor, occurredAt }` to reuse the caller's already-derived values.
//
// Returns an array of C1-valid `agent.mentioned` envelopes — one per
// mentioned agent, sorted by mentionedAgentId for determinism — each with
// identifiers only plus the mention-count aggregate. Returns [] when there
// is nothing to detect: non-message events, missing/non-string bodies,
// missing identifiers, empty rosters, or no agent mentioned.
//
// Throws only when a valid-looking message event cannot produce a valid
// envelope (the same contract as buildGrowthEvent in growth-emit.js);
// callers that must not throw (applyEventWithGrowth) isolate these.
export function detectMentions(roomEvent, context = {}) {
  if (!roomEvent || typeof roomEvent !== "object" || Array.isArray(roomEvent)) return [];
  if (roomEvent.type !== EVENT_TYPES.MESSAGE_POSTED) return [];
  const data = roomEvent.data && typeof roomEvent.data === "object" && !Array.isArray(roomEvent.data)
    ? roomEvent.data
    : {};
  if (typeof data.body !== "string" || !data.body) return [];
  const roomId = typeof roomEvent.roomId === "string" && roomEvent.roomId ? roomEvent.roomId : null;
  if (!roomId) return [];
  const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : roomEvent.id;
  if (typeof messageId !== "string" || !messageId) return [];
  const agents = agentRoster(context);
  if (!agents.length) return [];
  const membersById = memberIndex(context);
  const actor = actorOf(roomEvent, context, membersById);
  const occurredAt = context?.occurredAt ?? roomEvent.at;

  const counts = new Map();
  for (const agent of agents) {
    let count = 0;
    for (const [label] of mentionLabels(agent)) {
      count += countLabelMentions(data.body, label);
    }
    if (count > 0) counts.set(agent.id, (counts.get(agent.id) ?? 0) + count);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([mentionedAgentId, mentionCount]) =>
      defineEvent("agent.mentioned", {
        actor,
        source: "system",
        occurredAt,
        fields: { roomId, messageId, mentionedAgentId, mentionCount }
      })
    );
}
