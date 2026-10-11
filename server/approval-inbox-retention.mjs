// Unified approval inbox — retention policy.
//
// The inbox is a live surface for pending HUMAN decisions, not an archive.
// Resolved cards accumulate, so this module sweeps resolved cards that are
// strictly older than RETENTION_DAYS into the "archived" status. Archived
// cards stay queryable; stores exclude "archived" from default pending views.
//
// Hard rule: the decision journal (audit, sibling slice 25) is NEVER
// archived. Audit is permanent. Journal entries are recognized by
// kind === "decision-journal" or journal === true and are always skipped.
//
// Pure logic over a store seam. The real store is owned by sibling slice 1
// (server/approval-inbox-store.mjs); this module never imports it and never
// touches sibling files. The seam:
//
//   store.listApprovalCards() -> Array<card>   (all cards incl. archived)
//   store.setApprovalCardStatus(id, status, { archivedAt }) -> void
//
// Card shape consumed here:
//   { id, status: "pending"|"approved"|"rejected"|"expired"|"archived",
//     resolvedAt: ms epoch (set when the card left "pending"),
//     kind?, journal? }
//
// Backward compatible: additive new module, no existing imports changed.

export const RETENTION_DAYS = 90;
export const RETENTION_MS = RETENTION_DAYS * 86_400_000;
export const ARCHIVED = "archived";

// Statuses that count as resolved. "pending" stays live; anything else is
// left to the store's own lifecycle (only these three resolve a decision).
export const RESOLVED_STATUSES = Object.freeze(new Set(["approved", "rejected", "expired"]));

export function isJournalEntry(card) {
  if (!card || typeof card !== "object") return false;
  return card.kind === "decision-journal" || card.journal === true;
}

// A card is archivable only when it is a resolved decision card, not a
// journal entry, not already archived, with a finite resolvedAt strictly
// older than the retention window.
export function shouldArchive(card, nowMs = Date.now()) {
  if (!card || typeof card !== "object") return false;
  if (isJournalEntry(card)) return false; // audit is permanent
  if (card.status === ARCHIVED) return false;
  if (!RESOLVED_STATUSES.has(card.status)) return false;
  if (typeof card.resolvedAt !== "number" || !Number.isFinite(card.resolvedAt)) return false;
  return nowMs - card.resolvedAt > RETENTION_MS;
}

// One sweep pass. Two-phase (collect then write) so a partial failure never
// leaves the set half-decided; each status write is idempotent. Returns
// counts; a second identical sweep archives 0 (alreadyArchived > 0).
export function archiveSweep(store, nowMs = Date.now()) {
  const counts = { scanned: 0, archived: 0, skippedJournal: 0, alreadyArchived: 0, skipped: 0 };
  const cards = store.listApprovalCards() ?? [];
  const due = [];
  for (const card of cards) {
    counts.scanned += 1;
    if (isJournalEntry(card)) {
      counts.skippedJournal += 1;
      continue;
    }
    if (card.status === ARCHIVED) {
      counts.alreadyArchived += 1;
      continue;
    }
    if (shouldArchive(card, nowMs)) {
      due.push(card);
    } else {
      counts.skipped += 1;
    }
  }
  for (const card of due) {
    store.setApprovalCardStatus(card.id, ARCHIVED, { archivedAt: nowMs });
    counts.archived += 1;
  }
  return counts;
}
