// Scalar-seq adapter for the UNIFY-R read-cursor foundation (#3677 §B.4
// adopter 1). The units under test are the real pure functions and the
// real in-memory store from server/read-cursor.mjs — ackDurableCursor,
// sessionWatermark, foldHorizonsMin, cursorKey, createMemoryReadCursorStore.
// No stream is wired in production, so the walk itself is the canonical
// scalar page function the wiring will use: items carry integer seq
// positions, a page is the next `limit` visible positions past the session
// watermark, and durable state moves only through the store's ack.

import {
  ackDurableCursor,
  sessionWatermark,
  foldHorizonsMin,
  cursorKey,
  createMemoryReadCursorStore,
} from "../../server/read-cursor.mjs";

export function createReadCursorAdapter({
  roomId = "mw-room",
  memberId = "mw-member",
  streamId = "needs-me",
} = {}) {
  const scope = { roomId };
  const store = createMemoryReadCursorStore(scope);
  const items = new Map(); // id -> { seq, visible }
  let cursorSeq = null; // seq of the last delivered item; null = before start
  let finished = false;
  let highestDelivered = null;

  const sorted = () => [...items.entries()]
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => a.seq - b.seq);
  const maxSeq = () => sorted().reduce((max, i) => Math.max(max, i.seq), 0);
  const minSeq = () => sorted().reduce((min, i) => Math.min(min, i.seq), Infinity);

  return {
    name: "read-cursor",
    supportedOps: [
      "walkNext", "insertBeforeCursor", "insertAfterCursor",
      "deleteUnvisited", "deleteVisited", "moveItem", "visibilityFlip",
    ],
    capBehaviour: "n/a — no page cap at this layer",
    store,
    scope,
    memberId,
    streamId,
    cursorKey: () => cursorKey(memberId, streamId, scope),

    seed(n) {
      items.clear();
      for (let i = 1; i <= n; i++) {
        items.set(`item-${String(i).padStart(3, "0")}`, { seq: i * 10, visible: true });
      }
      return [...items.keys()];
    },
    openWalk() {
      cursorSeq = null;
      finished = false;
      highestDelivered = null;
    },
    nextPage(limit) {
      if (finished) return { items: [], nextCursor: null };
      // Session watermark starts from durable state (reads never write it).
      let from = sessionWatermark(store.getReadCursor(memberId, streamId), cursorSeq);
      if (from == null) from = 0;
      const page = sorted().filter((i) => i.seq > from && i.visible).slice(0, limit);
      const delivered = page.map((i) => i.id);
      if (page.length) {
        cursorSeq = page[page.length - 1].seq;
        highestDelivered = cursorSeq;
      }
      const more = sorted().some((i) => i.seq > (cursorSeq ?? 0) && i.visible)
        || sorted().some((i) => i.seq > (cursorSeq ?? 0));
      const nextCursor = page.length && more ? cursorSeq : null;
      if (nextCursor == null) finished = true;
      return { items: delivered, nextCursor };
    },
    insertBeforeCursor(id) {
      // A backfilled position in the already-walked region (before the
      // cursor), or before the start when the walk has not begun.
      const at = cursorSeq == null ? minSeq() - 10 : cursorSeq - 5;
      items.set(id, { seq: at, visible: true });
      return id;
    },
    insertAfterCursor(id) {
      items.set(id, { seq: maxSeq() + 10, visible: true });
      return id;
    },
    remove(id) { items.delete(id); },
    move(id) {
      // An update re-keys the item to the newest position (end of stream).
      const item = items.get(id);
      if (item) item.seq = maxSeq() + 10;
    },
    flipVisibility(id) {
      const item = items.get(id);
      if (item) item.visible = !item.visible;
    },
    inUnvisitedRegion(id) {
      if (finished) return false;
      const item = items.get(id);
      if (!item) return false;
      return cursorSeq == null || item.seq > cursorSeq;
    },
    present(id) { return items.has(id); },
    visible(id) { return items.get(id)?.visible === true; },

    // P2 surface: ack goes through the real advance-only primitive via the
    // store; pos is a delivered seq.
    ack(pos) { return store.ackReadCursor(memberId, streamId, pos); },
    durable() { return store.getReadCursor(memberId, streamId); },
    highestDeliveredPos() { return highestDelivered; },
    ackRaw(pos) { return ackDurableCursor(store.getReadCursor(memberId, streamId), pos); },
    fold(positions) { return foldHorizonsMin(positions); },
    close() {},
  };
}
