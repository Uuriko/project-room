# PRODUCT-200 Reliability — Final Report (worker D6-10/50, batch 2)

**Track:** product200-reliability (coordinator claim) — regression anchor batch 2.
**Worker:** D6-10/50 (respawn; prior attempt died on infra error — no partial
work was found at `~/workspace/product200-d6-10-batch2/`, started fresh).
**Date:** 2026-10-09. **Base:** origin/main @ `dbdd088bd`.
**Rule:** John's PR #1786 — reviews ADVISORY; gates are up-to-date branch,
all required hosted CI green at the exact head, conversation resolution, no
admin bypass, substantive findings assessed, explicit holds preserved,
one-at-a-time merge slot. Nothing below was merged by this worker.

## What this batch delivered

Five slices, in order. Each got its own branch, fail-first anchors where
the bug was live, early commits, and an open PR (never merged).

### D6 — OUTBOX: idempotent flush for stuck-at-unknown outbox entries
- **Bug present: YES — fixed in this PR.** QA-200 ch-2039's liveness note:
  a crash between the reply-outbox dispatch commit (status `unknown`) and
  the provider submit — or a lost observation after a successful submit —
  left the entry completed-but-unforwarded forever. `dispatch()` only
  re-runs for `queued` entries; `reconcile()` only settles from provider
  evidence. No flush path existed.
- **Fix:** `SyntheticInboxTransport.flush()` (`server/inbox-transport.mjs`):
  for every `unknown` attempt, reconcile first (provider already accepted →
  settle from evidence, no resubmit); only submit — with the SAME
  `correlation(operationId)` — when the provider has no record. Adapters
  dedupe on operationId, so racing flushes collapse to one provider
  message. Write-only: queued/cancelled/settled entries untouched, no
  resurrection, no history rewrite; a failed submit stays `unknown` for a
  later cycle — eventually, exactly once.
- **Anchors** (`tests/inbox-outbox.test.js`): ANCHOR-D6a (crash-before-submit
  flushes to one message and settles; second flush no-ops), D6b
  (lost-observation settles from evidence, zero resubmits), D6c (queued
  ignored; concurrent flushes collapse to one message). All 3 failed
  pre-fix (`flush` did not exist); 17/17 green post-fix; eslint clean.
- **PR #2177 — MERGED** (merge queue landed it during this batch).

### D7 — G1: idempotent invite redeem (redeem → timeout → retry)
- **Bug present: YES — fixed in this PR.** QA-200 failseq G1 (medium,
  security-adjacent): redeem commits the membership burn but the 201 body
  is lost on timeout; the retry gets 409 `invite_already_used` with no
  recovery path. Root cause: in the one-shot flow the server mints the
  identity with a random secret that is never returned, so the client can
  never present `identitySecret` to reach the existing duplicate-identity
  recovery path. Membership stranded. (#2088's work is work-claim
  compare-and-release — no overlap, verified.)
- **Fix:** opt-in client-kept `requestId` on `POST /api/agent-invites/redeem`
  (mirrors the #2085 direct-send convention). The receipt
  (`agent_invite_redeem_receipts`, new additive table, registered in
  `server/writer-fence.mjs`) is journaled in the SAME transaction as the
  code burn. Retry with the same requestId + same code/displayName replays
  the membership (`duplicate:true`, fresh onboarding token, no new member
  event, no second burn). Same key + different content → 409
  `invite_redeem_idempotency_conflict`; malformed key → 422; no key →
  legacy 409 unchanged (A6's accepted pin holds). Replay re-checks the
  membership is still active. `docs/openapi.yaml` documents the field.
- **Anchors** (`tests/agent-invites.test.js`): ANCHOR-D7a (timeout→retry
  recovers deterministically; no second membership; legacy 409 contrast),
  D7b (key reuse with different content 409s; other code still redeemable),
  D7c (malformed keys 422; code untouched). D7a/D7b failed pre-fix; 3/3
  green post-fix; writer-fence suites green; eslint clean.
- **PR #2215 — OPEN.** Note: the default flow is intentionally unchanged —
  SEED-G1 (chaos XFAIL) still fails as intended; only `requestId` retries
  recover. If John wants the default flow recoverable, that's his call
  (flagged, not assumed).

### D8 — DOUBLE-SETTLE: exactly-one settlement anchor
- **Bug present in QA-200: YES — already fixed by #2086 (merged
  2026-10-08). Anchors-only, no production change.** QA-200 MUT-15:
  retry-after-timeout at `commitPullRequestLookup` drove the commit path
  twice with the same pre-settle item → 2 `pr_merged` events + 2 history
  stamps. #2086 fixed it (commit against the freshest registered row;
  stale retry no-ops); its tests went 2 red → green.
- **Anchor** (`tests/work-claim-settle-retry.test.js`): ANCHOR-D8 pins the
  full contract in one named test — settle → retry with the same payload
  and stale item → exactly one settlement (one event, one history stamp,
  terminal `done`), retry returns false, third attempt still a no-op.
  Complements #2086's two outcome pins. 3/3 green; eslint clean.
- **PR #2243 — OPEN.**

### D9 — ANCHOR INDEX
- Single append-only index of every regression anchor the program produced:
  id, invariant in plain words, test file(s), PR, status, kind.
- **PR #2252 — OPEN.** Repo copy
  `research/PRODUCT200-RELIABILITY-ANCHOR-INDEX.md` is canonical; mirrored
  to `~/workspace/project-room-qa/product200-reliability/ANCHOR-INDEX.md`.
  D1–D5 rows reserved (worker respawned, anchors not yet reported).
  Statuses verified against the live PR list 2026-10-09 ~21:30 PDT.

### D10 — FINAL REPORT (this document)
- **PR: this one.** Repo copy
  `research/PRODUCT200-RELIABILITY-FINAL-REPORT.md` is canonical; mirrored
  to `~/workspace/project-room-qa/product200-reliability/FINAL-REPORT.md`.

## Coverage map (batch 2)

| Slice | PR | Bug? | Anchors | Tests | Status |
|---|---|---|---|---|---|
| D6 outbox flush | #2177 | yes, fixed | ANCHOR-D6a/b/c | 17/17 | MERGED |
| D7 redeem retry | #2215 | yes, fixed | ANCHOR-D7a/b/c | 3/3 (+fence suites) | OPEN |
| D8 double-settle | #2243 | fixed by #2086 | ANCHOR-D8 | 3/3 | OPEN |
| D9 anchor index | #2252 | n/a (docs) | — | — | OPEN |
| D10 final report | this PR | n/a (docs) | — | — | OPEN |

Whole-program anchor roster lives in the index (D9). This batch added
D6–D8; A-series and C-series anchors were produced by sibling workers
(see the index for the full table).

## Gaps remaining (owner + next step each)

1. **D1–D5 anchors unreported.** Owner: D1-5 respawned worker (478f215c).
   Next: when it reports, fill the five reserved rows in the anchor index
   (append-only; instructions in the file header).
2. **#2215 (D7) and #2243 (D8) await the merge slot.** Owner: merge-queue
   shepherd. Next: land in slot order once hosted CI is green at exact
   heads. #2215 needs a rebase if main moved under it.
3. **Direct-send outbox has no reaper (B10 follow-up hole, still open).**
   `direct_channel_sends` is record-first `pending` → provider send →
   settle; a crash strands `pending` rows and retries replay "pending"
   forever. D6's flush covers the *reply* outbox only. Owner: unassigned.
   Next: a fix lane should build the write-only idempotent reaper for
   pending direct sends (reconcile-then-submit with the same requestId),
   mirroring D6.
4. **Composer mints a fresh requestId per submit** (`src/inbox-send-ui.js:480`,
   B9 finding). A timeout-after-commit defeats the #2085 server dedupe.
   Owner: client track. Next: mint one requestId per user action, retain
   across retries.
5. **G1 default-flow design decision.** Without `requestId`, redeem retry
   still 409s by design (A6's accepted pin). Owner: John's call. Next:
   only change the default flow on his explicit word; the opt-in path
   (#2215) is the safe middle.
6. **Open fix PRs from the program** (merge-slot order): #2214 (A4 claim
   updates), #2240 (A9 land-queue events), #2225 (C9-11 chaos), #2226
   (A10), #2234 (C2), #2180 (A12 invariants gate). Owner: merge-queue
   shepherd.
7. **B11's worst finding still open:** `POST /credits/transfer` keyless
   retry double-moves payable credits (silent double-spend — the only
   money-moving op with no once-only guard). Owner: B11 worker (steer
   stands). Next: land the once-only guard.
8. **Infra flakiness during this batch:** ~30–50% of exec calls failed to
   register session metadata (transient), one 180s tool-dispatch timeout;
   retries succeeded. Prior D6-10 attempt died on infra. Owner: runtime.
   Next: none for this track — noted for the record.

## The never-break invariant contract (plain words)

1. A completed-but-unforwarded outbox entry is eventually forwarded exactly
   once.
2. A timed-out redeem, retried with the same idempotency key, recovers the
   same membership — never a second one, never stranded.
3. Settling twice with the same payload records exactly one settlement.
4. Retrying a claim create never creates a second claim.
5. Replaying a stale release never destroys a fresh claim round.
6. Retrying a claim update never applies it twice.
7. A failed update never corrupts or loses the claim.
8. Redeeming a code consumes it and grants membership atomically.
9. Reopening shows exactly what was committed.
10. A rebuilt projection equals the live projection.
11. Every board mutation emits its event.
12. Invite and receipt lifecycles stay consistent under retry and expiry.
13. The receipt chain survives retries intact.
14. Races produce exactly one winner and lose no releases.
15. No torn writes; history is append-only and ordered.
16. Money and membership are conserved under chaos.

(Executable pins for each: the anchor index, D9.)

## Verification notes

- Every anchor was written fail-first and run red before its fix (D6a/b/c,
  D7a/b; D7c is a boundary pin that already held; D8's contract was proven
  red→green by #2086's own tests, whose assertions D8 restates).
- Targeted suites re-run green post-fix; `verify:affected` was skipped per
  the repo's known-hang guidance in favor of direct `node --test` runs.
- eslint clean on all touched files (one pre-existing warning in
  `server/http.mjs:858`, untouched).
- Test-harness caveat: repo tests must run with `TMPDIR` pointed inside
  the worktree (`/tmp` is a near-full tmpfs shared by all agents).
- `git checkout` was never used to move the shared checkout's HEAD; all
  work happened in the disposable worktree
  `~/workspace/pr-product200-rel2-batch2` (remove after the PRs land).

---
_Worker D6-10/50 sign-off: 5/5 slices delivered, 4 PRs open (#2215, #2243,
#2252, this one), 1 merged (#2177), 2 bugs fixed (D6, D7), 0 merges
performed. Claim `product200-rel2-d6-10` + file claims held for the batch;
release when the coordinator confirms._
