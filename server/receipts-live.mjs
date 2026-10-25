// Public receipt reads. Rows live in public_receipts, written when an owner
// opts in or a public-work receipt is recorded. These functions do not read
// rooms.projection.
//
// Visibility has one definition (server/public-visibility.mjs) and the
// read model applies the whole of it in SQL, before pagination: operator
// unpublish and the owner's public-receipts toggle
// (room_directory_settings.public_receipts = 0, default 1) both hide a
// receipt from listings, detail reads, the sitemap, and lot pages. This
// module used to wrap the read model with a second, JS implementation of
// the toggle half and post-filter pages the read model had already
// paginated — pages came back short, and hidden rows' positions were
// bracketable from their visible neighbours. The wrapper is now a plain
// pass-through so the surface keeps one import home; the only filter
// left here is excludeHiddenReceipts, for secondary surfaces (room
// pages, embeds) that list receipts this surface never paginated, and it
// applies the same shared definition.
import { hiddenReceiptIds } from "./public-visibility.mjs";
import {
  PUBLIC_RECEIPT_ID,
  LOT_RECEIPT_ID,
  projectPublicWorkReceipt,
  queryPublicReceipts,
  publicReceiptById,
  listPublicReceiptSitemap,
  collectPublicReceipts,
  roomProofRows,
} from "./public-read-model.mjs";

export {
  PUBLIC_RECEIPT_ID,
  LOT_RECEIPT_ID,
  projectPublicWorkReceipt,
  queryPublicReceipts,
  publicReceiptById,
  listPublicReceiptSitemap,
  collectPublicReceipts,
};

// Verify-at-read-time is part of this public receipts surface.
export { verifyPublicReceipt } from "./receipt-verify.mjs";

// Secondary receipt surfaces (room pages, embeds) list receipts the
// paginated reads never saw. Apply the shared visibility definition
// there too: an operator-unpublished or owner-hidden receipt must not
// leak its title/href through /r/<slug>. Fail-closed on unknown ids,
// matching the definition's batch form.
export function excludeHiddenReceipts(store, items) {
  if (!items.length) return items;
  const hidden = hiddenReceiptIds(store.db, items.map(item => item.id));
  return items.filter(item => !hidden.has(item.id));
}

// One room's proof-page rows with the full visibility predicate applied
// in the read model, newest first.
export function queryRoomProof(store, slug) {
  return roomProofRows(store, slug);
}
