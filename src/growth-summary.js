// Track C slice C5 — Growth summaries.
//
// Read-only analytics over a C2 collector: per-type totals, daily activity,
// top-mentioned agents, and engagement ratios inside a time window. Pure,
// dependency-free, deterministic given the same events. No I/O, no network,
// no timers, no storage. Outputs are frozen.
//
// topMentionedAgents is the display list, truncated to topN (default 10).
// allMentionedAgents is the same ranking untruncated: downstream consumers
// that need an exact count for an arbitrary agent (C8 movers, C9
// mention-spike alerts) must read it, not the truncated list — an agent
// ranked outside the top-N otherwise looks like it has 0 mentions.

import { GROWTH_EVENT_TYPES } from "./growth-events.js";

export const DEFAULT_TOP_MENTIONED_AGENTS = 10;

const isTimestamp = value =>
  typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));

const checkCollector = collector => {
  if (!collector || typeof collector !== "object") throw new TypeError("summarize: collector must be a collector object");
  if (typeof collector.query !== "function" || typeof collector.stats !== "function") {
    throw new TypeError("summarize: collector must expose query() and stats()");
  }
  return collector;
};

const checkWindowBound = (value, label) => {
  if (value === undefined) return null;
  if (!isTimestamp(value)) throw new Error(`summarize: "${label}" must be an ISO-8601 timestamp`);
  return new Date(value).toISOString();
};

const checkTopN = value => {
  if (value === undefined) return DEFAULT_TOP_MENTIONED_AGENTS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError("summarize: topN must be a positive integer");
  }
  return value;
};

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

const freezeDeep = value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  }
  return value;
};

// Summarize the collector's stored events inside [since, until] (both
// inclusive; omitted bounds mean unbounded). Bad window bounds throw a clear
// Error — never partial garbage. An empty window yields a zeroed summary.
export function summarize(collector, { since, until, topN } = {}) {
  checkCollector(collector);
  const sinceIso = checkWindowBound(since, "since");
  const untilIso = checkWindowBound(until, "until");
  if (sinceIso !== null && untilIso !== null && Date.parse(sinceIso) > Date.parse(untilIso)) {
    throw new Error('summarize: "since" must not be after "until"');
  }
  const limit = checkTopN(topN);

  const { capacity } = collector.stats();
  const events = collector.query({
    since: sinceIso ?? undefined,
    until: untilIso ?? undefined,
    limit: capacity
  });

  const totals = Object.fromEntries(GROWTH_EVENT_TYPES.map(type => [type, 0]));
  const byDay = new Map();
  const mentionCounts = new Map();

  for (const envelope of events) {
    totals[envelope.type] += 1;
    const day = utcDay(Date.parse(envelope.occurredAt));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    if (envelope.type === "agent.mentioned") {
      const agentId = envelope.fields.mentionedAgentId;
      const count = typeof envelope.fields.mentionCount === "number" ? envelope.fields.mentionCount : 1;
      mentionCounts.set(agentId, (mentionCounts.get(agentId) ?? 0) + count);
    }
  }

  const activityByDay = [...byDay.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const allMentionedAgents = [...mentionCounts.entries()]
    .map(([agentId, mentions]) => ({ agentId, mentions }))
    .sort((a, b) => b.mentions - a.mentions || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  // Copy the entries, don't share them: consumers treat repeated object
  // references in a summary as a cycle (see growth-http's JSON-safety).
  const topMentionedAgents = allMentionedAgents
    .slice(0, limit)
    .map(({ agentId, mentions }) => ({ agentId, mentions }));

  const messages = totals["message.sent"];
  const mentions = [...mentionCounts.values()].reduce((sum, n) => sum + n, 0);
  const engagement = {
    messages,
    reactions: totals["reaction.added"],
    pins: totals["message.pinned"],
    mentions,
    mentionsPerMessage: messages === 0 ? null : mentions / messages
  };

  return freezeDeep({
    totals,
    activityByDay,
    topMentionedAgents,
    allMentionedAgents,
    engagement,
    window: { since: sinceIso, until: untilIso },
    generatedAt: new Date().toISOString()
  });
}
