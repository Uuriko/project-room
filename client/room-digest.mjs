// Validate the bounded catch-up contract before an agent uses its checkpoint.
// A digest is a summary of a window, never proof that its events were handled.
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const caps = { messages: 3, work: 4, attention: 5, decisions: 2 };
const countMap = value => object(value) && Object.values(value).every(integer);
const sum = value => Object.values(value).reduce((total, count) => total + count, 0);

export function validRoomDigest(value, { roomId, memberId, since }) {
  if (!object(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 4096
    || value.contractVersion !== 1 || value.roomId !== roomId || !text(value.viewerId)
    || memberId && value.viewerId !== memberId || value.untrusted !== true
    || !integer(value.since) || !integer(value.through) || value.through < value.since
    || value.next !== value.through || value.requestedSince !== since || value.since < since
    || (value.since > since ? value.floorApplied !== true : value.floorApplied !== undefined)
    || typeof value.evaluatedAt !== "string" || !Number.isFinite(Date.parse(value.evaluatedAt))) return false;
  const c = value.coverage;
  if (!object(c) || c.fromSeq !== value.since + 1 || c.toSeq !== value.through
    || !integer(c.eventsInWindow) || c.eventsInWindow > value.through - value.since
    || !countMap(c.byType) || sum(c.byType) !== c.eventsInWindow
    || ![c.workChangedTotal, c.attentionTotal, c.messagesTotal].every(integer)
    || c.messagesTotal !== (c.byType["message.posted"] ?? 0)
    || (c.messagesTotal > 0 ? value.bodiesOmitted !== c.messagesTotal : value.bodiesOmitted !== undefined)) return false;
  const context = value.context;
  if (!object(context) || !/^[a-f0-9]{64}$/.test(context.context_version)
    || ![context.rosterCount, context.focusWorkTotal, context.decisionsTotal, context.locksTotal].every(integer)
    || !Array.isArray(context.omitted) || !context.omitted.every(text)
    || !object(value.actionableNow) || !integer(value.actionableNow.total)
    || !countMap(value.actionableNow.byKind) || sum(value.actionableNow.byKind) !== value.actionableNow.total) return false;
  for (const [key, limit] of Object.entries(caps)) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > limit) return false;
    let previous = value.since;
    for (const row of rows) {
      if (!object(row) || !integer(row.seq) || row.seq <= value.since || row.seq > value.through || row.seq < previous) return false;
      previous = row.seq;
      if (key === "decisions") { if (!text(row.type)) return false; }
      else if (!text(row.id)) return false;
      if (["messages", "attention"].includes(key) && (typeof row.summary !== "string" || row.summary.length > 140)) return false;
      if (key === "attention" && !text(row.kind)) return false;
    }
  }
  if (value.work.length > c.workChangedTotal || value.attention.length > c.attentionTotal || value.messages.length > c.messagesTotal) return false;
  if (value.truncated !== undefined && (!countMap(value.truncated)
    || Object.entries(value.truncated).some(([key, count]) => !(key in caps) || count < 1))) return false;
  const room = encodeURIComponent(roomId), follow = value.followUps;
  return object(follow)
    && follow.events === `GET /api/rooms/${room}/events?after=${value.since}&limit=100`
    && follow.work === `GET /api/rooms/${room}/work-claims/{id}`
    && follow.context === `GET /api/rooms/${room}/context`
    && follow.updates === `GET /api/rooms/${room}/updates`;
}
