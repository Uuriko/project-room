// Public receipt reads. Rows live in public_receipts, written when an owner
// opts in or a public-work receipt is recorded. These functions do not read
// rooms.projection. Operator unpublish is applied inside the read model.
//
// Owner-only public-receipts toggle: a room whose owner turned public
// receipts off (room_directory_settings.public_receipts = 0, default 1)
// drops out of every public read here — listings, detail reads, and the
// sitemap. Members still read the room's receipts through the member-gated
// room endpoints. The filter wraps the read model rather than editing it,
// so receipt projection keeps working and flipping the toggle back on
// restores visibility immediately.
//
// The wrapper keeps the read model's public-route contracts: it never
// reads rooms/rooms.projection, never writes on a booted store, and issues
// a constant set of parameterized queries (batched via json_each) so the
// query plan does not grow with the room count.
import { ensurePublicReceiptsColumn } from "./room-directory.mjs";
import {
  PUBLIC_RECEIPT_ID,
  projectPublicWorkReceipt,
  queryPublicReceipts as queryUnderlying,
  publicReceiptById as byIdUnderlying,
  listPublicReceiptSitemap as sitemapUnderlying,
  collectPublicReceipts as collectUnderlying,
} from "./public-read-model.mjs";

export { PUBLIC_RECEIPT_ID, projectPublicWorkReceipt };

// Column presence. The schema carries public_receipts on every booted
// store; this is only the legacy-database path (a table predating the
// column). The steady-state read issues one indexed query.
function anyRoomPrivate(db) {
  try {
    return !!db.prepare("SELECT 1 FROM room_directory_settings WHERE public_receipts = 0 LIMIT 1").get();
  } catch (error) {
    if (!/no such column/i.test(error?.message ?? "")) throw error;
    ensurePublicReceiptsColumn(db);
    return !!db.prepare("SELECT 1 FROM room_directory_settings WHERE public_receipts = 0 LIMIT 1").get();
  }
}

// A receipt hides when any room it belongs to disabled public receipts.
// pwr_ rows carry the public-work namespace in origin_room_id, so the
// owning room resolves through the task record; wcr_/wir_ rows carry the
// room id in origin_room_id directly. A namespace never matches a
// settings row (settings are keyed by room id), so no rooms-table read is
// needed to tell them apart.
function hiddenReceiptIds(store, receiptIds) {
  const hidden = new Set();
  if (!receiptIds.length) return hidden;
  const db = store.db;
  // Fast path: no room turned receipts private — nothing can hide.
  if (!anyRoomPrivate(db)) return hidden;
  const idList = JSON.stringify(receiptIds);
  const rows = store.db.prepare(`SELECT pr.id AS id, pr.origin_room_id AS origin, pwt.room_id AS taskRoom
      FROM public_receipts pr
      LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
      LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
      WHERE pr.id IN (SELECT value FROM json_each(?))`).all(idList);
  const candidates = new Set();
  const roomsOf = new Map();
  for (const row of rows) {
    const rooms = [];
    if (row.taskRoom) rooms.push(row.taskRoom);
    if (row.origin && row.origin !== row.taskRoom) rooms.push(row.origin);
    roomsOf.set(row.id, rooms);
    for (const roomId of rooms) candidates.add(roomId);
  }
  const privateRooms = new Set();
  if (candidates.size) {
    for (const row of store.db.prepare(`SELECT room_id FROM room_directory_settings
        WHERE public_receipts = 0 AND room_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...candidates]))) {
      privateRooms.add(row.room_id);
    }
  }
  for (const id of receiptIds) {
    if (!roomsOf.has(id) || (roomsOf.get(id) ?? []).some(roomId => privateRooms.has(roomId))) hidden.add(id);
  }
  return hidden;
}

const receiptIdOf = entry => String(entry.path).split("/").pop();

export function queryPublicReceipts(store, options) {
  const page = queryUnderlying(store, options);
  if (!page || page.error || !Array.isArray(page.receipts)) return page;
  const hidden = hiddenReceiptIds(store, page.receipts.map(receipt => receipt.id));
  return { ...page, receipts: page.receipts.filter(receipt => !hidden.has(receipt.id)) };
}

export function publicReceiptById(store, id) {
  if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id)) return null;
  if (hiddenReceiptIds(store, [id]).has(id)) return null;
  return byIdUnderlying(store, id);
}

export function listPublicReceiptSitemap(store, limit) {
  const entries = sitemapUnderlying(store, limit);
  const hidden = hiddenReceiptIds(store, entries.map(receiptIdOf));
  return entries.filter(entry => !hidden.has(receiptIdOf(entry)));
}

export function collectPublicReceipts(store) {
  const receipts = collectUnderlying(store);
  const hidden = hiddenReceiptIds(store, receipts.map(receipt => receipt.id));
  return receipts.filter(receipt => !hidden.has(receipt.id));
}
