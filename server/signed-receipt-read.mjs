// Store-level resolver for one signed bounty receipt body, by receiptId.
//
// This module is the adapter between two interfaces that grew up apart
// (proof-layer B7 D-2, reconciled here deliberately):
//   - B3's serving design names a STORE-level resolver,
//     signedReceiptBodyById(store, receiptId), because the HTTP handler
//     thinks in stores and journal stamps: the stamp is what the gate
//     (lotReceiptVisible) and the cross-check bind to.
//   - B2's lookup is an ESCROW method, getSignedReceipt(roomId, receiptId),
//     because the legs live behind the escrow's tables.
// The adapter is stamp-first: it resolves the journal stamp (room, lot,
// bounty) from the store, then asks the escrow lookup for the body in
// that room, then cross-checks the body's identity fields against the
// stamp — a genuine body served under a foreign stamp is a replay, not
// a hit (B3 §1.2 step 4). The escrow lookup contains its own stamp
// resolver; the duplication is the price of keeping both interfaces
// honest, and it is paid here, once, not in the handler.
//
// Admission, two tiers (B3 §1.3 vs §3.2 reconciled):
//   - Candidate admission (this module's candidate resolver, consumed
//     by the receipt-verify signature leg): strict shape only — a body
//     whose shape validates is a candidate even if its signature does
//     not, so the verify leg can report the tamper as `contradicted`
//     instead of never seeing the body.
//   - Serving admission (signedReceiptBodyById): shape + signature.
//     A body that fails is treated as ABSENT, never served raw or
//     partially: this is what makes a planted tampered body read as
//     404 on the serving face.
// Bodies are returned exactly as issued (the parsed object);
// serialisation order is not load-bearing because verification
// re-canonicalises (B3 §1.1).
import { createHash } from "node:crypto";
import { BountyEscrow } from "./bounty-escrow.mjs";
import { verifyBountyReceipt } from "./bounty-receipts.mjs";

// The journal stamp for a receiptId: the one row class every issued
// receipt leaves behind (bounty-escrow _issueReceipt stamps both journal
// legs). Returns { roomId, lotId, bountyId } or null.
export function signedReceiptStamp(store, receiptId) {
  try {
    const row = store.db.prepare(
      "SELECT room_id, lot_id, bounty_id FROM bounty_journal WHERE receipt_id=? LIMIT 1").get(receiptId);
    if (!row) return null;
    return { roomId: row.room_id, lotId: row.lot_id, bountyId: row.bounty_id };
  } catch { return null; } // a store with no escrow ledger stamps nothing
}

function escrowOf(store) {
  return store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store);
}

// Resolve one shape-admitted candidate body by receiptId (verify-leg
// tier). Returns { body, source, mismatch, stamp } or null.
export function signedReceiptCandidateById(store, receiptId) {
  if (typeof receiptId !== "string" || !receiptId) return null;
  const stamp = signedReceiptStamp(store, receiptId);
  if (!stamp) return null;
  let found = null;
  try { found = escrowOf(store).getSignedReceipt(stamp.roomId, receiptId); } catch { found = null; }
  if (!found || !found.receipt) return null;
  const body = found.receipt;
  // Stamp/body cross-check (B3 §1.2 step 4): identity fields must agree.
  if (body.receiptId !== receiptId || body.roomId !== stamp.roomId
    || body.lotId !== stamp.lotId || body.bountyId !== stamp.bountyId) return null;
  // Candidate admission: shape validates (verifyBountyReceipt reaches
  // the signature stage, or passes outright). A bad_signature result
  // still admits — classifying it is the verify leg's whole job.
  const probe = verifyBountyReceipt(body, {});
  if (!probe.ok && !String(probe.reason ?? "").startsWith("bad_signature")) return null;
  return { body, source: found.source, mismatch: found.mismatch === true, stamp };
}

// Resolve one serving-admitted signed body by receiptId: the candidate
// plus the signature stage. Returns { body, source, mismatch, stamp }
// or null (absent — every absence reason converges here; the serving
// handler answers the identical 404 for all of them).
export function signedReceiptBodyById(store, receiptId) {
  const candidate = signedReceiptCandidateById(store, receiptId);
  if (!candidate) return null;
  if (!verifyBountyReceipt(candidate.body, {}).ok) return null;
  return candidate;
}

// --- signer key history seam (S5 fills this; B7 D-1) -------------------------
//
// The identity-PASS path needs S5's published key history
// (server/receipt-key-history.json + its reader). That reader does not
// exist yet, and S4 must not improvise one: this seam is the ONE named
// function whose body S5's reader replaces. Until then it returns null —
// no history published — and every consumer degrades exactly as B3 §3.2
// designs: identity is `not-checked` ("key history not published —
// signer identity not pinned"), never pass, never contradicted.
export function receiptKeyHistory() {
  return null;
}

// The fingerprint a key-history entry pins: sha256:<hex> over the raw
// 32 public-key bytes (B3 §4.2 — the same definition the index and
// bundle surfaces use, so fingerprints compare byte-for-byte).
export function signerFingerprint(pubkeyHex) {
  if (typeof pubkeyHex !== "string" || !/^[0-9a-f]{64}$/.test(pubkeyHex)) return null;
  return `sha256:${createHash("sha256").update(Buffer.from(pubkeyHex, "hex")).digest("hex")}`;
}

// Resolve a body's signer against a key-history document (the B3 §4.2
// shape). Returns the matching entry or null. Matching is by
// fingerprint + ref + role: a key is pinned only when all three agree.
export function signerKeyEntry(body, history = receiptKeyHistory()) {
  if (!body || !body.issuer || !history || !Array.isArray(history.keys)) return null;
  const fingerprint = signerFingerprint(body.issuer.pubkey);
  if (!fingerprint) return null;
  return history.keys.find(entry => entry && entry.fingerprint === fingerprint
    && entry.ref === body.issuer.ref && entry.role === "escrow-keeper") ?? null;
}
