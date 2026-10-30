# C-FIX-PUBLISH — cure design (against eb325a13dc5132ae335816a08c82c9e06084e380)

Defect gate: server/public-read-model.mjs publicLotReceiptById line 1117-1118:
  const settlement = resolution?.settlement : null;
  if (!settlement || typeof settlement !== "object") return null;
acceptWork (bounty-escrow.mjs:2167ff) records approval + attribute movement, NO
settlement; settlement stamped only in _sweep after challengeEnds (72h) or on
terminal paths. bounty_records carries challenge_ends_ms + dispute_id columns.

## Cure (read model / visibility path only; no settlement/money/window change)

### 1. server/public-read-model.mjs
- Header comment: add post-acceptance exception to the settlement paragraph.
- After the settlement extraction, replace the hard return:
    const settlement = (resolution && typeof resolution === "object"
      && resolution.settlement && typeof resolution.settlement === "object")
      ? resolution.settlement : null;
    // Post-acceptance exception: ...
    let pending = null;
    if (!settlement) {
      if (bounty.state !== "accepted" && bounty.state !== "disputed") return null;
      let extra = null;
      try { extra = store.db.prepare("SELECT challenge_ends_ms, dispute_id FROM bounty_records WHERE bounty_id=?").get(bountyId); } catch { extra = null; }
      pending = {
        state: bounty.state,
        challengeEnds: iso(extra?.challenge_ends_ms ?? null),
        disputeId: bounty.state === "disputed" ? cleanText(extra?.dispute_id, 256) : null,
      };
    }
  (separate guarded query: main SELECT stays byte-identical, legacy stores fail soft)
- settledBy: `settlement && settlement.settledBy && ...` (null-safe).
- lot.settlement: `settlement ? { ...existing block... } : null,`
- lot.pending: the pending object above, or null when settled.

### 2. server/receipts-page.mjs (lot block, after Bounty state row)
    l.pending?.state === "disputed"
      ? `<div><dt>Outcome</dt><dd>Accepted, then disputed — not final. A dispute is open${l.pending.disputeId ? ` (<code>${escapeHtml(l.pending.disputeId)}</code>)` : ""} and no settlement has been recorded; the amounts shown can still change.</dd></div>`
      : l.pending
      ? `<div><dt>Outcome</dt><dd>Accepted — challenge window open${l.pending.challengeEnds ? ` until <time datetime="${escapeHtml(l.pending.challengeEnds)}">${escapeHtml(l.pending.challengeEnds)}</time>` : ""}. Not settled yet: no payment has been recorded, and a dispute can still change this outcome.</dd></div>`
      : "",
- provenNote: insert bounty-lot+pending branch BEFORE the settled bounty-lot branch:
  "Verification tier: recorded ledger movement. What was checked: the room's credit ledger recorded this movement and the acceptance shown. No settlement has been recorded yet, so this outcome is not final. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."

### 3. server/receipt-share.mjs
- verdictLineOf lot branch: kind → existing; else pending disputed →
  "Ledger-recorded movement — accepted, then disputed; not final and not settled, recorded in the room's credit ledger";
  pending accepted → `Ledger-recorded movement — accepted; challenge window open until <challengeEnds>, not yet settled, recorded in the room's credit ledger` (omit until-clause when null);
  else existing fallback line.
- receiptProvenNote: pending variant before the settled lot branch:
  "What this record proves: the room's credit ledger recorded this movement and the acceptance shown. No settlement verdict has been recorded yet, so this outcome is not final. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
- JSON-LD already conditional on settlement?.kind — untouched.

## Label wording (exact, for the deliverable)
- HTML accepted: "Accepted — challenge window open until <ISO time>. Not settled yet: no payment has been recorded, and a dispute can still change this outcome."
- HTML disputed: "Accepted, then disputed — not final. A dispute is open (<dispute id>) and no settlement has been recorded; the amounts shown can still change."
- JSON: lot.settlement = null; lot.pending = { state: "accepted"|"disputed", challengeEnds: <ISO|null>, disputeId: <id|null> }; lot.bountyState already carries the raw state.

## Tests — NEW file tests/lot-receipt-pending.test.js (seams copied from lot-receipt-page.test.js)
Unit (fake-clock BountyEscrow + seedReadTables + recordOptIn mirror):
 (a) accepted bounty, opt-in ON: attribute + escrow-lock lots resolve; settlement null;
     pending.state "accepted"; pending.challengeEnds == bounty.challengeEnds;
     HTML matches /challenge window open until/ and /Not settled yet/;
     HTML doesNotMatch /settlement verdict shown/; receiptJson carries pending.
 (b) disputed (accept + disputeBounty, verifierId decider setup as runToSplit):
     attribute lot resolves; pending.state "disputed"; HTML /not final/; settlement null.
 (c) NEGATIVE CONTROL: accepted bounty, never-recorded → null; recorded OFF (mirror 0) → null.
 (d) pre-acceptance still 404: submitted bounty lots → null (funded already pinned by existing suite).
 (e) settled unchanged: runToPaid → settlement.kind "verified-complete", pending null.
HTTP (RoomStore + real server, opt-in via real room.public_receipts_set command):
 (f) accepted bounty + ON → attribute lot 200 html/json/alias/og/badge; json lot.pending.state "accepted".
 (g) same room opt-in OFF → 404 on all faces.
Failing-first: (a),(b),(f) fail at base head (null/404); (c),(d),(e),(g) pass both ways (controls).

## Non-goals / invariants
- Listing stays detail-only (collectPublicReceipts reads public_receipts only) — untouched.
- Opt-in OFF / never-recorded stays 404 on every face (visibility gate unchanged, runs after the pending gate exactly as for settled).
- No change: settlement timing, challenge window, money movement, dispute machine.
