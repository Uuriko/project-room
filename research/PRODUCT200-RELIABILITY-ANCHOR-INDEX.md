# PRODUCT-200 Reliability — Regression Anchor Index

Every regression anchor the reliability program has produced: one row per
anchor, append-only. An anchor is a named test (or test set) that pins a
never-break invariant — retry must not duplicate work, failed actions
preserve data, reopening shows committed state.

**Canonical home:** this file is versioned in the repo at
`research/PRODUCT200-RELIABILITY-ANCHOR-INDEX.md` (PR-reviewed) and mirrored
to `~/workspace/project-room-qa/product200-reliability/ANCHOR-INDEX.md`
(the coordinator's working copy). Update rule: edit the repo copy, land it
via PR, then copy the landed file over the workspace mirror. Never edit the
mirror alone.

**How a future wave adds a row:** append one line to the table below — do
not rewrite existing rows. Columns:

| Anchor ID | Invariant (plain words) | Test file(s) | PR | Status | Kind |
|---|---|---|---|---|---|

- **Anchor ID:** the program slice + sequence (`ANCHOR-D6`, `ANCHOR-A3`…).
  Test names carry the same id so `grep ANCHOR-D6 tests/` finds the pin.
- **Invariant:** one plain sentence — what must never break.
- **Test file(s):** repo-relative path(s) holding the anchor.
- **PR:** the PR that introduced the anchor (link by number).
- **Status:** `MERGED` / `OPEN` / `PENDING` (as of the verified date).
- **Kind:** `fix` (anchor + production fix in the same PR) or
  `anchors-only` (pins already-fixed or already-sound behavior).

## Anchors

| Anchor ID | Invariant (plain words) | Test file(s) | PR | Status | Kind |
|---|---|---|---|---|---|
| ANCHOR-D6 | Completed-but-unforwarded outbox entries eventually flush exactly once | tests/inbox-outbox.test.js | #2177 | MERGED | fix |
| ANCHOR-D7 | Invite redeem → timeout → retry recovers the membership deterministically | tests/agent-invites.test.js | #2215 | OPEN | fix |
| ANCHOR-D8 | Settle → retry settle with the same payload records exactly one settlement | tests/work-claim-settle-retry.test.js | #2243 | OPEN | anchors-only |
| ANCHOR-D1 | _reserved — D1-5 worker respawned 2026-10-09 ~01:03 PDT; anchors not yet reported_ | — | — | PENDING | — |
| ANCHOR-D2 | _reserved — see D1_ | — | — | PENDING | — |
| ANCHOR-D3 | _reserved — see D1_ | — | — | PENDING | — |
| ANCHOR-D4 | _reserved — see D1_ | — | — | PENDING | — |
| ANCHOR-D5 | _reserved — see D1_ | — | — | PENDING | — |
| ANCHOR-A2 | Claim-create retry never duplicates the claim | tests/invariants/retry-semantics.test.mjs | #2154 | MERGED | anchors-only |
| ANCHOR-A3 | Stale release replay never destroys a fresh claim (E5) | tests/invariants/release-replay-anchor.test.mjs | #2156 | MERGED | anchors-only |
| ANCHOR-A4 | Claim updates are idempotent via opt-in requestId (AQ-HI-06) | tests/invariants/work-claim-update-retry.test.mjs | #2214 | OPEN | fix |
| ANCHOR-A5 | A failed claim update preserves the claim's data | tests/invariants/failed-update-preserves-claim.test.mjs | #2155 | MERGED | anchors-only |
| ANCHOR-A6 | Invite redeem is atomic: consume + grant in one transaction | tests/invariants/invite-redeem-atomicity.test.mjs | #2220 | MERGED | anchors-only |
| ANCHOR-A7 | Reopening a claim shows the committed close/update state | tests/invariants/claim-reopen.test.mjs | #2209 | MERGED | anchors-only |
| ANCHOR-A8 | Projection rebuild matches live state across the claim lifecycle | tests/rebuild-claim-parity.test.js | #2157 | MERGED | anchors-only |
| ANCHOR-A9 | Every land-queue board mutation emits its event | tests/invariants/board-mutations-emit-events.test.mjs | #2240 | OPEN | fix |
| ANCHOR-A10 | Invite + receipt lifecycle: consume/grant/retry/expiry | tests/invariants/invite-receipt-lifecycle.test.mjs | #2226 | OPEN | anchors-only |
| ANCHOR-A11 | Receipt chain stays intact across retries | tests/public-work-receipt-retry-invariant.test.js | #2170 | MERGED | anchors-only |
| ANCHOR-C2 | Claim/release/reclaim races: exactly one winner, no lost releases | tests/chaos/claim-release-reclaim-races.test.js | #2234 | OPEN | anchors-only |
| ANCHOR-C3 | Torn writes are impossible; claim history stays monotonic | tests/chaos/claim-torn-writes.test.js, tests/chaos/claim-history-monotonicity.test.js | #2172 | MERGED | anchors-only |
| ANCHOR-C9-11 | Invite lifecycle + escrow transitions hold under seeded chaos | tests/chaos/invite-lifecycle.test.js, tests/chaos/escrow-transitions.test.js | #2225 | OPEN | anchors-only |

## Related (not anchors — context for the next wave)

- `docs/INVARIANTS.md` (#2162, merged) — the reliability contract in plain
  words; the invariants above are its executable pins.
- Invariants CI gate (#2180, open) — runs `tests/invariants/` on every PR;
  fail-closed.
- Chaos seed corpus (#2197, open) — 4 XFAIL seeds (SEED-E5, SEED-A3,
  SEED-B24, SEED-G1); CI fails loudly when a fix flips a seed to pass.
  Note: SEED-G1 pins the *default* redeem retry as stranded — ANCHOR-D7's
  opt-in `requestId` recovery does not change default behavior, so the seed
  still fails as intended.
- Idempotency audits (B-series, read-only): route matrix #2216, work-claim
  #2169, invite/identity #2160, receipt/escrow/settle #2159, messages #2221,
  board/land-queue #2244, misc #2201, client-retry #2174. Findings feed
  future anchor + fix slices; they are not anchors themselves.

## Invariant contract (one-line each)

1. A completed-but-unforwarded outbox entry is eventually forwarded exactly
   once (D6).
2. A timed-out redeem retried with the same idempotency key recovers the
   same membership — never a second one, never stranded (D7).
3. Settling twice with the same payload records one settlement (D8).
4. Retrying a claim create never creates a second claim (A2).
5. Replaying a stale release never destroys a fresh claim round (A3).
6. Retrying a claim update never applies it twice (A4).
7. A failed update never corrupts or loses the claim (A5).
8. Redeeming a code consumes it and grants membership atomically (A6).
9. Reopening shows exactly what was committed (A7).
10. A rebuilt projection equals the live projection (A8).
11. Every board mutation emits its event (A9).
12. Invite and receipt lifecycles stay consistent under retry/expiry (A10).
13. The receipt chain survives retries intact (A11).
14. Races produce one winner and lose no releases (C2).
15. No torn writes; history is append-only and ordered (C3).
16. Money and membership are conserved under chaos (C9-11).

---
_Statuses verified 2026-10-09 ~21:30 PDT against the live PR list. Next
wave: re-verify the OPEN rows, fill D1–D5 when that worker reports, append
new rows — never rewrite._
