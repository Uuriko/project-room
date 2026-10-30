# Post-acceptance lot receipts: public at acceptance (opt-in ON), labelled pending — not settled

**Hand-in form:** small PR for review, base `codex/mvp-integration-1030` at `a57cb5c5791766306290ef1c2a36c8c51ff4c97f`. Fixer does not merge; **composition is Codex's call**. This changes public-read semantics: a post-acceptance outcome becomes publicly readable via its lot link before settlement. **The demo works without this change** (pre-settled specimen) if you decline it — it only cures the accept-live-then-open-the-link beat.

## Defect (composition tree at the base SHA; verify-public.md §8, gaps-prod.md §7)

`publicLotReceiptById` (server/public-read-model.mjs) returns null unless the bounty carries a recorded settlement. `acceptWork` records an approval + an `attribute` movement and no settlement; the `verified-complete` settlement is stamped only in the sweep after the 72 h challenge window. So a bounty driven to `accepted` 404s on every public face (`/receipts/<lot>`, `.json`, `/room/` alias ×2, `og.png`, `badge.svg`) even with the room's publicReceipts opt-in recorded ON. Reproduced at the base head with the verify-public harness pattern (real RoomStore + real HTTP server, unauthenticated probes): accepted bounty's 3 lots 404 on all 6 faces; settled bounty's lots 200 on all 6 faces; opt-in OFF 404 everywhere (incl. stale-mirror ablation).

## Cure (read model / visibility path only)

- `server/public-read-model.mjs`: when no settlement is recorded, a lot still composes **iff** its bounty state is `accepted` or `disputed` (post-acceptance only — funded/submitted/etc. still 404). The visibility gate (recorded opt-in at read time, operator unpublish, directory toggle) is unchanged and still runs before anything is served. The composed lot carries `settlement: null` and a truthful `pending` block: `{ state, challengeEnds, disputeId }` read from `bounty_records.challenge_ends_ms` / `dispute_id`.
- `server/receipts-page.mjs`: pending lots render an Outcome row —
  - accepted: "Accepted — challenge window open until \<time\>. Not settled yet: no payment has been recorded, and a dispute can still change this outcome."
  - disputed: "Accepted, then disputed — not final. A dispute is open (\<id\>) and no settlement has been recorded; the amounts shown can still change."
  The honesty note for a pending lot no longer claims "the settlement verdict shown".
- `server/receipt-share.mjs`: verdict line + proven note get matching pending variants ("accepted; challenge window open until …, not yet settled" / "accepted, then disputed; not final and not settled"), so og/badge/share text never present the outcome as final.

No change to settlement timing, the challenge window, money movement, or the dispute machine. Lots stay detail-only (nothing enters the public listing). Opt-in OFF / never-recorded stays 404 on every face.

## Tests

Failing-first (at base head, new tests fail: post-acceptance lots are null/404; controls pass):
- `tests/lot-receipt-pending.test.js` (new, 7 tests): unit — accepted lots resolve pending-labelled on all lot kinds; disputed labelled not-final; negative control OFF/never-recorded; pre-acceptance still 404; settled unchanged (settlement present, pending null). HTTP — accepted lot 200 on html/json/alias/og/badge with opt-in ON via the real `room.public_receipts_set` command; 404 on every face when never-recorded/OFF; gallery does not list it.
- Re-run at the fixed head: `tests/mirror-readtime.test.js` + `tests/lot-receipt-page.test.js` — counts in the lane report (fix-publish.md).

Kill rule (lane charter): unverifiable by Sun 2026-11-01 12:00 PT = cut.
