// Room-state provider: a compact markdown snapshot of the agent's standing
// in the room — open claims, attention items, recent completions. The
// ElizaOS wiring (src/plugin.js) exposes this as a provider so the agent
// always has room context.

/**
 * Build a markdown snapshot of the agent's room standing.
 * @param {object} args
 * @param {object} args.client - room client (createRoomClient)
 * @param {string} args.roomId
 * @param {string} args.memberId - the agent's member id (owner filter)
 * @returns {Promise<string>} markdown context, or an error note (never throws)
 */
export async function buildRoomContext({ client, roomId, memberId }) {
  if (!roomId) return "Project Room: no ROOM_ID configured; set it to join a room.";
  try {
    const [board, inbox, receipts] = await Promise.all([
      client.listWorkClaims(roomId),
      memberId ? client.getInbox(roomId, { limit: 20 }).catch(() => null) : Promise.resolve(null),
      client.listReceipts(roomId, { limit: 5 }).catch(() => null),
    ]);
    const claims = board.claims || [];
    const mine = claims.filter(c => c.owner === memberId && c.state !== "done" && c.state !== "unclaimed");
    const open = claims.filter(c => c.state === "unclaimed");
    const lines = [`## Project Room standing (room ${roomId})`];
    lines.push(`My open claims (${mine.length}):`);
    for (const c of mine.slice(0, 10)) {
      const lease = c.leaseExpiresAt ? ` (lease expires ${c.leaseExpiresAt})` : "";
      lines.push(`- ${c.id}: ${c.title || "(untitled)"} [${c.state}]${lease}`);
    }
    if (inbox) {
      const dms = inbox.directMessages || [];
      const mentions = inbox.mentions || [];
      const assignments = inbox.assignments || [];
      const dmRequests = inbox.dmRequests || [];
      lines.push(`Attention: ${dms.length} DM(s), ${mentions.length} mention(s), ${assignments.length} assignment(s), ${dmRequests.length} DM-consent request(s).`);
      for (const m of dms.slice(0, 3)) lines.push(`- DM from ${m.from}: ${(m.body || "").slice(0, 160)}`);
      for (const m of mentions.slice(0, 3)) lines.push(`- Mention: ${(m.body || m.text || "").slice(0, 160)}`);
    }
    lines.push(`Open work on the board: ${open.length}.`);
    if (receipts && receipts.receipts && receipts.receipts.length) {
      lines.push("Recent completions:");
      for (const r of receipts.receipts.slice(0, 5)) {
        lines.push(`- ${r.receiptId}: ${(r.summary || r.title || "").slice(0, 120)}`);
      }
    }
    return lines.join("\n");
  } catch (error) {
    const code = error && error.code ? error.code : "unknown";
    return `Project Room: could not load room state (${code}). The room may be unreachable or the credential expired.`;
  }
}
