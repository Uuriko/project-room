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

// A receipt hides when any room it belongs to disabled public receipts.
// pwr_ rows carry the public-work namespace in origin_room_id, so the
// owning room resolves through the task record; wcr_/wir_ rows carry the
// room id in origin_room_id directly.
function hiddenReceiptIds(store, receiptIds) {
  const hidden = new Set();
  if (!receiptIds.length) return hidden;
  ensurePublicReceiptsColumn(store.db);
  const rows = store.db.prepare(`SELECT pr.id AS id, pr.origin_room_id AS origin, pwt.room_id AS taskRoom
      FROM public_receipts pr
      LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
      LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
      WHERE pr.id IN (${receiptIds.map(() => "?").join(",")})`).all(...receiptIds);
  const byId = new Map(rows.map(row => [row.id, row]));
  const receiptPrivate = store.db.prepare("SELECT public_receipts FROM room_directory_settings WHERE room_id=?");
  const isRoom = store.db.prepare("SELECT 1 FROM rooms WHERE id=?");
  for (const id of receiptIds) {
    const row = byId.get(id);
    if (!row) { hidden.add(id); continue; }
    const candidates = [];
    if (row.taskRoom) candidates.push(row.taskRoom);
    if (row.origin && row.origin !== row.taskRoom && isRoom.get(row.origin)) candidates.push(row.origin);
    if (candidates.some(roomId => receiptPrivate.get(roomId)?.public_receipts === 0)) hidden.add(id);
  }
  return hidden;
}

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
  const hidden = hiddenReceiptIds(store, entries.map(entry => String(entry.path).split("/").pop()));
  return entries.filter(entry => !hidden.has(String(entry.path).split("/").pop()));
}

export function collectPublicReceipts(store) {
  const receipts = collectUnderlying(store);
  const hidden = hiddenReceiptIds(store, receipts.map(receipt => receipt.id));
  return receipts.filter(receipt => !hidden.has(receipt.id));
}
