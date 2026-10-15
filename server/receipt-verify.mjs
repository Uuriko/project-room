// Verify at read time for public receipts (charter Workstream B, P1/P2).
//
// The public receipt page has always shown stored values: hashes recorded
// when the record was projected, a merge the server's poll had settled by
// projection time — never re-checked when a stranger read the page. This
// module is the re-check. Given a public receipt it re-runs, at read time,
// every check the server can run itself: source-record (the record is
// re-derived from its current source and compared field by field),
// artifact (a public-work receipt's stored artifact still hashes to the
// sha256 the record carries), and journal (a bounty lot's escrow entries
// are re-hashed and their per-account chain links re-checked — the same
// core the conservation audit uses, journalEntryHash in bounty-escrow).
// The linked pull request's live GitHub state joins in the follow-up
// slice; until then it is named under not-checked wherever a receipt
// carries one, so no verdict here silently covers it. The verdict never
// outruns the checks, and no human is asked to compare a hash by eye.
import { journalEntryHash } from "./bounty-escrow.mjs";
import { rederivePublicReceipt } from "./public-read-model.mjs";

export const RECEIPT_VERIFICATION_SCHEMA = "project-room-receipt-verification/1";

// What no check in this module even attempts. Stated on every verdict so
// the checks that DID run cannot borrow scope (proof-ux R2).
const NEVER_CHECKED = [
  "Whether the work itself is any good — no check here judges quality",
  "The real-world identity of the named people — names are as the room recorded them",
  "A signature on this record — public receipts are unsigned, so there is none to check",
];

const COMPARED_FIELDS = ["title", "agents", "humans", "pullRequest", "mergedAt", "hashes", "at"];
const sameField = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function checkSourceRecord(store, receipt) {
  const label = "Source record";
  const derived = rederivePublicReceipt(store, receipt.id);
  if (!derived || !derived.row) {
    return [{ id: "source-record", label, status: "missing",
      detail: "The source this receipt was projected from no longer yields it — the work was reverted or removed, or the room is gone." }];
  }
  const checks = [];
  const differ = COMPARED_FIELDS.filter(field => !sameField(derived.row[field], receipt[field]));
  checks.push(differ.length
    ? { id: "source-record", label, status: "contradicted",
        detail: `The stored record no longer matches its source — ${differ.join(", ")} differ${differ.length === 1 ? "s" : ""} from the source record now.` }
    : { id: "source-record", label, status: "pass",
        detail: "The record was re-derived from its source just now and every field matches." });
  if (derived.artifactHashOk !== null) {
    checks.push(derived.artifactHashOk
      ? { id: "artifact", label: "Delivered artifact", status: "pass",
          detail: "The stored artifact still hashes to the sha256 this record carries." }
      : { id: "artifact", label: "Delivered artifact", status: "contradicted",
          detail: "The stored artifact no longer hashes to the sha256 this record carries — it was altered after delivery." });
  }
  return checks;
}

function checkJournal(store, receipt) {
  const label = "Ledger hash chain";
  let entries;
  try {
    entries = store.db.prepare(`SELECT seq, room_id, entry_id, account_id, at, kind, bounty_id, lot_id,
      amount, lot_state, hash, prev_hash, memo, actor_kind, actor_id, track
      FROM bounty_journal WHERE lot_id=? ORDER BY seq`).all(receipt.id);
  } catch {
    return [{ id: "journal", label, status: "missing", detail: "This store holds no escrow ledger to re-check the lot against." }];
  }
  if (!entries.length) {
    return [{ id: "journal", label, status: "missing", detail: "The ledger no longer holds entries for this lot." }];
  }
  for (const entry of entries) {
    if (journalEntryHash(entry) !== entry.hash) {
      return [{ id: "journal", label, status: "contradicted",
        detail: `Ledger entry ${entry.entry_id} does not match its recorded hash — the entry was altered after it was written.` }];
    }
    const prev = store.db.prepare(`SELECT hash FROM bounty_journal
      WHERE room_id=? AND account_id=? AND seq<? ORDER BY seq DESC LIMIT 1`).get(entry.room_id, entry.account_id, entry.seq);
    if (entry.prev_hash !== (prev?.hash ?? "genesis")) {
      return [{ id: "journal", label, status: "contradicted",
        detail: `The hash chain is broken at ledger entry ${entry.entry_id} — it no longer links to the entry before it.` }];
    }
  }
  return [{ id: "journal", label, status: "pass",
    detail: `${entries.length} ledger ${entries.length === 1 ? "entry" : "entries"} re-hashed just now; every hash and chain link matches.` }];
}

const VERDICTS = {
  "record-checked": {
    label: "Record re-checked",
    summary: "The server re-checked this record just now against its source, and everything it ran still matches.",
  },
  "contradicted": {
    label: "Contradicted",
    summary: "A re-check found this record does not match its evidence. The checks below name the mismatch.",
  },
  "no-longer-verifiable": {
    label: "No longer verifiable",
    summary: "The source behind this record is gone or no longer supports it, so it cannot be re-verified.",
  },
};

// Re-run every local check the server can run on one public receipt, now.
// `receipt` is the public shape (server/receipts-live.mjs publicReceiptById).
export function verifyPublicReceipt(store, receipt, { nowMs = Date.now() } = {}) {
  const checks = receipt.source === "bounty-lot"
    ? checkJournal(store, receipt)
    : checkSourceRecord(store, receipt);

  const contradicted = checks.some(check => check.status === "contradicted");
  const missing = checks.some(check => check.status === "missing");
  const verdict = contradicted ? "contradicted" : missing ? "no-longer-verifiable" : "record-checked";

  const meta = VERDICTS[verdict];
  return {
    schema: RECEIPT_VERIFICATION_SCHEMA,
    receiptId: receipt.id,
    checkedAt: new Date(nowMs).toISOString(),
    verdict,
    verdictLabel: meta.label,
    summary: meta.summary,
    checks,
    scope: {
      checked: checks.map(check => check.label),
      notChecked: [
        ...(receipt.pullRequest ? ["The linked pull request's current state on GitHub"] : []),
        ...NEVER_CHECKED,
      ],
      by: "the Project Room server, at read time",
    },
  };
}
