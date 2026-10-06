// ACT-1a: append a room event without a member credential, and post the in-room
// receipt card for a done board claim. Public receipts stay the opt-in PRM/GR1
// path. This module does not import the work-claim or guide modules.
//
// ACT-1b renders the card. The Board done branch in work-claim-routes stays
// untouched while BF (#1331, #1345) is open; emitWorkClaimEvent calls
// postReceiptCard instead.
import { createHash } from "node:crypto";
import { applyEvent, event, isRoomArchived } from "../src/events.js";
import { syncMessageRows } from "./messages-store.mjs";

export const ROOM_GUIDE_ID = "room-guide";

export function stableEventId(prefix, material) {
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 40);
  return `${prefix}${digest}`;
}

export function appendRoomEvent(store, roomId, { id, type, actorId, data, atMs }) {
  if (!store?.db || typeof store.room !== "function") return null;
  return store.transaction(() => {
    const room = store.room(roomId);
    if (isRoomArchived(room.state)) return null;
    if (store.db.prepare("SELECT 1 FROM events WHERE id=?").get(id)) return null;
    const member = room.state.members?.[actorId];
    const incoming = event({
      id,
      idempotencyKey: id,
      type,
      actorId,
      roomId,
      at: new Date(Number.isFinite(atMs) ? atMs : (typeof store.now === "function" ? store.now() : Date.now())).toISOString(),
      data: member?.system === true ? { ...data, actorKind: "system" } : data
    });
    const state = applyEvent(room.state, incoming);
    const sequence = room.sequence + 1;
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, store.storedProjection(roomId, compact), roomId);
    syncMessageRows(store.db, { roomId, sequence, event: incoming, state });
    try {
      if (store.agentPlugin) store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
    } catch (error) {
      console.error("room event fan-out failed:", error?.message ?? error);
    }
    return { sequence, event: incoming };
  }, { isolated: true });
}

const evidenceOf = item => {
  const stamp = [...(item.history ?? [])].reverse().find(entry => entry.action === "state:done");
  const note = typeof stamp?.note === "string" ? stamp.note.trim() : "";
  return note || "Closed.";
};

// One card per claim. A second done notification for the same id is a no-op.
export function postReceiptCard(store, roomId, item, atMs) {
  if (!item || item.state !== "done") return null;
  if (!["result", "merged", "production"].includes(item.deliveryMode)) return null;
  const room = store.room(roomId);
  const members = room.state.members ?? {};
  const guide = members[ROOM_GUIDE_ID];
  const closer = item.owner && members[item.owner]?.active !== false ? members[item.owner] : null;
  const author = guide?.system === true && guide.active !== false ? guide : (closer ?? members[room.state.room.ownerId]);
  if (!author) return null;
  const claimId = item.id;
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : claimId;
  const closedBy = (closer?.displayName || closer?.id || author.displayName || author.id);
  const pull = item.pullRequest?.url;
  const messageId = stableEventId("rc", `${roomId}\0${claimId}`);
  if (room.state.messages?.some(message => message.id === messageId)) return null;
  return appendRoomEvent(store, roomId, {
    id: messageId,
    type: "message.posted",
    actorId: author.id,
    atMs,
    data: {
      messageId,
      body: `${title} closed as ${item.deliveryMode}.`,
      kind: "receipt_card",
      claimId,
      title,
      closedBy,
      deliveryMode: item.deliveryMode,
      evidence: evidenceOf(item),
      ...(typeof pull === "string" && pull.trim() ? { pullRequestUrl: pull } : {})
    }
  });
}
