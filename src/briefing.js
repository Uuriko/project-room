// Morning briefing (Town-style): one short read across every room.
// Pure composer over Updates items (server/updates.mjs), so the briefing
// never disagrees with the needs-you list.
const LABEL = Object.freeze({ request: "asks", mention: "mentions", dm: "direct messages", review_requested: "review requests", handoff: "handoffs",
  approval: "approvals", outbound_draft: "drafts to approve", group_review: "reviews to answer", access_request: "access requests",
  invite_pending: "pending invites", agent_joined: "agents joined" });

export function composeBriefing(items, { since = null, top = 8 } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const open = items.filter(item => item.state === "unread" || item.state === "read");
  const counts = {};
  for (const item of open) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  const rooms = {};
  for (const item of open) rooms[item.roomId] = (rooms[item.roomId] ?? 0) + 1;
  const fresh = sinceMs === null ? open : open.filter(item => Date.parse(item.updatedAt) > sinceMs);
  const lines = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${LABEL[kind] ?? kind}`);
  return {
    headline: open.length === 0 ? "Nothing needs you." : `${open.length} things need you: ${lines.join(", ")}.`,
    changedSinceLast: fresh.length,
    needsYou: open.slice(0, top).map(({ id, roomId, kind, title, next }) => ({ id, roomId, kind, title, next: next ?? null })),
    byRoom: Object.entries(rooms).map(([roomId, n]) => ({ roomId, count: n })).sort((a, b) => b.count - a.count),
  };
}
