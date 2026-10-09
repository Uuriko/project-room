# wave1000 guild-04 — mutation testing triage

Slice: `server/store.mjs`, `server/*sqlite*.mjs`, `server/event*.mjs`, `server/room*.mjs`.
Driver: `findings/guild-04/bin/mutate.py`; specs in `findings/guild-04/specs/*.json`;
raw results in `findings/guild-04/specs/*.results.jsonl`.

**63 mutants: 25 KILLED · 38 SURVIVED · 0 TIMEOUT-HANG** (all 10 timeout-hang
resolved 2026-10-09 — see below).

## Killed (18) — coverage is real, no action

S1 (replay contiguity), S2 (event seq +2), W3 (upsert DO NOTHING), D2 (archived leak),
D3 (owner check inverted), F1 (flood decision flipped), F3 (empty-id validation),
F4 (capacity 10x), G1/G2 (guide activation), G4 (welcome idempotency),
K1 (auth check), K3 (pull-only), L1 (room limit), L2 (409 room_exists),
L4 (roomId cap), E1 (torn-export inverted).

## Survived → fail-first regression tests written (9)

In `findings/guild-04/regressions/reg-survived-mutants.test.js`. Each test PASSES on
the original code and was verified to FAIL with its mutant applied (mutant applied
via the spec regex, test run, original restored — see /tmp/g04-ff.py).

| Mutant | File:line | Defect the suite missed | BUG CONFIRMED |
|---|---|---|---|
| S4 | server/store.mjs:676 | COMMIT dropped in transaction(): 22/22 tests pass with writes never committed; second transaction throws "cannot start a transaction within a transaction" | ✅ posted |
| W4 | server/work-claim-sqlite.mjs:72 | list() reversed to rowid DESC: 2/2 pass; no test asserts claim ordering | ✅ posted |
| W5 | server/work-claim-sqlite.mjs (WORK_CLAIM_DEFAULTS) | default claim state "claimed": 2/2 pass; no test asserts the unclaimed default | fail-first verified |
| W1 | server/work-claim-sqlite.mjs:delete | dependency-waive filter inverted (keeps only the deleted dep): no test covers delete-with-dependents | fail-first verified (test only) |
| W2 | server/work-claim-sqlite.mjs:decodeItem | title→id fallback dropped: no test covers titleless claims | fail-first verified (test only) |
| D1 | server/room-directory.mjs:211 | nextCursor emitted on exact page boundary (>= vs >): phantom cursor | fail-first verified (test only) |
| D5 | server/room-directory.mjs (schema DEFAULT) | public_receipts default flipped to 0: no test pins the schema default | fail-first verified (test only) |
| P3 | server/room-activation-pack.mjs:172 | pin visibility filter dropped: 8/8 pass; pinned DMs leak to unauthorized viewers | ✅ posted |
| H3 | server/room-export-html.mjs:136 | deleted-message tombstone keeps body text (walkExport): renderer masks it in HTML, but the exported message model retains sensitive text | fail-first verified; BUG CONFIRMED post queued (guild 3/day cap reached) |

## Survived → test-gap notes (27, queued for regression tests)

All change observable behavior; the suite has no test pinning the contract.

- **store.mjs**: S3 (BEGIN IMMEDIATE→BEGIN: lock-upgrade semantics untested under contention),
  S5 (busy_timeout 3000→0: no lock-contention test), S6 (synchronous FULL→OFF: durability
  is untestable in unit tests — closest to an equivalent mutant).
- **room-context.mjs**: C1 (seq 0 rejected — boundary untested), C2 (superseded ||→&& leaks
  superseded sessions into live), C3 (liveSessions sort flipped), C4 (haltAll flag inverted),
  C5 (canonical hash loses key sort — context_version stability untested).
- **room-activation-pack.mjs**: P1 (BLOCKED dropped from OPEN work set), P2 (claim expiry
  boundary >→>=), P4 (coordinationNorms shared mutable reference — aliasing hazard).
- **room-assistant.mjs**: R2 (input cap 100→101), R3 (activity ring buffer dropped —
  unbounded growth), R4 (guest denial dropped — authz), R5 (terminal-state guard dropped).
- **room-attachment-bytes.mjs**: A1 (file-bytes cap dropped — DoS), A2 (guest stage denial
  dropped — authz), A3 (discard conflict check inverted), A4 (executable blocklist bypassed —
  security), A5 (expiry boundary off-by-one).
- **room-directory.mjs**: D4 (cleanText truncation max-1).
- **room-flood-guard.mjs**: F2 (Retry-After floor 1→0).
- **room-guide.mjs**: G3 (guide failure propagates instead of being contained).
- **room-key-presence.mjs**: K2 (single-room linkage weakened to <1 — identity/auth),
  K4 (hostId cap 128→129), K5 (host hash truncation 48→47).
- **room-lifecycle.mjs**: L5 (start validation &&→|| — always rejects; start field untested).

Security-relevant survivors worth prioritizing next: R4, A2, A4, K2, P3(done), A1.

## TIMEOUT-HANG (10) — resolved

**L3 → KILLED.** Re-ran `tests/room-lifecycle.test.js` under the L3 mutant with a
240s timeout: 3 tests fail fast on the mutant ("archiving closes commands…",
"seeded history that ends archived…", "migration: genuine v27 data…"), 4 pass,
and one trailing test hangs (file-level timeout). The mutant is caught — the
prior TIMEOUT-HANG classification was the trailing hang, not an escape.
Finding: `verifyRoomLifecycle` inversion is well-covered; the trailing hang
after store-open failures is a test-robustness note (a store that throws at
open can wedge a later test's event loop).

**H1 → KILLED (verified).** Re-ran with a 600s timeout: KILLED in 221.4s —
the stored-XSS mutant is caught by the suite; the 300s timeout was purely a
harness limit against a ~298s baseline suite.

**H2–H5, E2–E5 → resolved 2026-10-09 (third coordinator).** The prior run died
mid-E3, leaving the E3 mutant applied in `server/room-export.mjs` with a stale
`.thbak` backup (no finally-restore). Cleaned up: `git checkout --` the file,
deleted the stale backup. Final classification from clean-state reruns:

- **H2 → KILLED** (221.2s), **H4 → KILLED** (254.1s), **H5 → KILLED** (203.2s) —
  spec test file catches them; the 300s timeout was a harness artifact.
- **H3 → SURVIVED** (226.3s) — real gap: deleted-message tombstone retains body
  text in `walkExport`'s message model. Fail-first regression test written and
  verified (`reg-survived-mutants.test.js` "H3"); BUG CONFIRMED post queued —
  guild already posted its 3/day on 2026-10-09.
- **E2 → KILLED** — not by the spec's mapped `tests/room-export.test.js`, but by
  `tests/rel14-backup-bytes.test.js` ("junk" case asserts /not canonical base64/;
  2 failures with mutant applied, verified 2026-10-09). Spec→test mapping gap,
  not a coverage gap. No duplicate regression test written.
- **E3 → KILLED** — by `tests/rel14-backup-bytes.test.js` (2 failures: valid
  replay throws, tampered-BLOB refusal lost). Spec mapping gap, same as E2.
- **E4 → SURVIVED** (310.8s) — dropping `quoteIdent` validation in replayNdjson.
  No test anywhere pins the "will not write" error, but analysis shows it is
  defense-in-depth only: table names are allowlisted against the store's real
  tables and column names against the real schema *before* the interpolated
  SQL, so no hostile export can reach the unquoted interpolation. Equivalent-ish
  under the current schema; recorded as a test-gap note.
- **E5 → SURVIVED** (274.8s) — `timingSafeEqual` → `===` on operator export auth.
  Real side-channel class, but functionally untestable (no timing assertion can
  be reliable). Recorded as a test-gap note, not a BUG CONFIRMED.
