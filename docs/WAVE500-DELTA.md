# WAVE-500 W5 — Delta board cursor: benchmark + correctness

Worker W5 (presence + streaming lane), 2026-10-08. Branch:
`wave500/presence-w5-delta-tests`.

## Status of the subject

W4's delta implementation had **not landed** in this base at measurement
time — no `boardSeq` surface exists anywhere in `server/` on this branch.
So:

- The **benchmark** (`perf/wave500-delta-bench.mjs`) measures the F3 design
  contract: the full-page side uses the real production
  `buildWorkClaimPage` (the code path serving board polls today); the delta
  side is a contract-faithful encoder running the repo's own
  `summarizeClaimHistory` + `stampClaimPage` pipeline.
- The **correctness tests**
  (`tests/work-claims-delta-correctness.test.js`) assert the F3 design
  contract and fail on this base for exactly the right reasons (13 of 14 —
  see below).

## Benchmark: bytes per poll, 200-claim board

`TMPDIR=$PWD/.tmp node perf/wave500-delta-bench.mjs`. Fixtures: 200 claims
with realistic shapes/history via the repo's own pure state machine
(create/claim/attest/review), stamped with monotonic boardSeq as an F3
registry would. Full page measured with `limit=200` (the whole board in one
poll — the "full re-download" the F3 design's ~145 KB figure refers to; the
contract adds one top-level `boardSeq` field, ~14 bytes, not measured here).
Delta = `?since=` from the cursor after the initial full page.

| scenario | full page | delta | ratio (full/delta) | delta claims |
|---|---|---|---|---|
| steady-state (0 changes) | 248.4 KB (15.6 KB gz) | 0.3 KB (0.2 KB gz) | **794.9x** (66x gz) | 0 |
| 2 claims changed | 248.6 KB (15.7 KB gz) | 3.2 KB (0.9 KB gz) | **77.8x** (18x gz) | 2 |
| 50 claims changed | 253.6 KB (15.7 KB gz) | 75.6 KB (5.6 KB gz) | **3.4x** (2.8x gz) | 50 |

Raw bytes: full 254363 / delta 320 (steady); full 254534 / delta 3270
(2 changes); full 259708 / delta 77405 (50 changes).

Takeaways:

- Steady-state polling — the common case — drops from ~248 KB to ~320
  bytes per poll. This is where the fleet wins: presence pumps poll the
  board continuously and almost always see zero changes.
- At 25% board churn the delta is still 3.4x smaller, but the design's
  "never truncated by `limit`" rule means a heavy-churn delta can approach
  (never much exceed) one full page. The delta carries per-claim `boardSeq`
  and full summarized history per changed claim, so crossover happens only
  under extreme churn.
- Steady-state gzipped (the wire reality behind HTTP compression): 15.6 KB
  → 0.24 KB, ~66x.

### Fidelity of the delta numbers

The committed bench's delta encoder was validated **byte-identical**
against the only landed F3 implementation — the `wave300-fanout-perf`
branch, which carries the same F3 design — over identical fixtures
(real F3 registry seq stamps, 0/7/all-changed probes plus a stale `since`):
`real=13306B mine=13306B`, `9230B/9230B`, `318B/318B`, `67214B/67214B`.
So the byte ratios above are the real F3 wire format, not a guess.

## Correctness: 14 contract tests

`tests/work-claims-delta-correctness.test.js` (node:test, repo
conventions). Covers the task's list:

1. `registry.boardSeq()` starts at 0, bumps on every `set()` (in-memory).
2. Re-setting the same claim (update/renew/release) advances the seq; the
   stored row carries its last-mutation seq.
3. `boardSeq` is per-room.
4. Lease-expiry auto-release goes through `set()` → the read-path sweep
   advances the seq (shows up in the next delta, per the design caveat).
5. Full page: top-level `boardSeq`; per-claim `boardSeq` stripped
   (byte-identical claim shape).
6. `?since=N`: only claims with `boardSeq > N`, ascending by boardSeq
   (mutation order); delta claims self-describing; top-level `boardSeq`,
   room-wide `openClaims`/`terminalClaims`; `hasMore` false,
   `nextCursor` null, `historyScope` "delta".
7. Steady-state `since=current` → empty delta with counts.
8. Stale `since` → exactly the changes since that seq.
9. `since=0` excludes pre-F3 rows (seq 0) — they re-send only when they
   mutate (design: "old claims read back as seq 0").
10. Interleaved multi-writer mutations: seq strictly increasing, no seq
    reused; an advancing cursor drains every mutation exactly once at its
    final seq; draining to the current cursor yields an empty delta.
11. Validation: `since=abc/-1/2.5/(empty)` → 400 `invalid_input`;
    `since` + `cursor`/`queue`/`state` → 400; `since` + `limit=1` → 200
    with all 3 changes (delta never truncated by limit);
    `since` + `view=summary` → 200; a huge-but-numeric `since` is
    accepted and matches nothing.
12. `?fast=1` cross-check: **no such param exists** on the work-claims
    board in this base or on the wave300 F3 branch; unknown params stay
    422. This test passes and pins the behavior so a future fast path
    cannot silently change the contract.
13. Durable registry: `set()` stamps `boardSeq`; `delete()` advances the
    seq and ships **no tombstones** — a delta after a delete shows the seq
    jump with zero claims, so a caching client that sees the jump without
    matching deltas must re-fetch the full page (the documented
    no-tombstone behavior).
14. Durable registry: `boardSeq()` works on a pre-F3 database (lazy
    `CREATE TABLE IF NOT EXISTS`, no schema-version bump).

### Results

- On this base (no F3 implementation): **13 of 14 fail** — 11 page-builder
  tests fail with 422 `invalid_input` on `?since=` (unknown param, proving
  the param is absent), the registry tests fail with
  `registry.boardSeq is not a function`. The `?fast=1` documentation test
  passes.
- Against the `wave300-fanout-perf` F3 reference implementation:
  **all 14 pass** (checked via a scratch harness importing the wave300
  server tree; the harness lives in `.tmp/` and is not committed). The
  tests are contract-correct and should turn green when W4 lands.

## Bugs found

None — there is no implementation in this base to find bugs in. No
production code was changed (bench + tests + this doc only).

## Notes for W4 / the coordinator

- The durable-registry F3 implementation from `wave300-fanout-perf`
  (`work_claim_board_seq` table, bump inside `set()`, stamp on the stored
  row, `delete()` bumps, lazy table creation outside `workClaimSchema`)
  already satisfies every durable-side contract test here; porting it is
  the shortest path to green.
- `?fast=1` does not exist on the board route. If a fast path is added,
  the contract only requires it to be orthogonal to `since` (unknown
  params currently 422).
- Watch the 50-change crossover: under extreme churn a delta is only ~3x
  smaller than a full page. The steady-state and low-churn wins (795x /
  78x) are where presence polling lives.
