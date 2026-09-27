# Mutation testing for `scripts/room` (VERIFY-1)

## Why a custom mutator

`scripts/room` is bash with embedded jq. No standard JS mutation framework
(Stryker, etc.) targets that shape, and the interesting mutations are
protocol-level operator swaps (`>` vs `>=` at a lease boundary, `and` vs `or`
in the parser's prefix chain) rather than generic AST noise. The room already
exposes deterministic test seams — the `_parse` / `_state` verbs and the
fake-`gh` sweep pattern — so a small exact-string mutant generator
(`scripts/room-mutate.mjs`) is the pragmatic fit: one precise textual
replacement per mutant, throwaway copy, targeted test run, kill on any test
failure.

## What is under test

Protocol-critical regions of `scripts/room`, unmodified (byte-identical to
`origin/main`):

- **parse** (`parse_comment`): protocol-prefix recognition and branch
  selection — `[claim]`, `[receipt]`, `[done]`, the prose-terminal
  `DONE|MERGED|DEPLOYED` fallback, and where the prose-terminal task-id is
  resolved from (`$rest` vs `$body`).
- **validate** (`validate_claim`): required-field predicates, the 1–72h
  lease bounds, the failed-state failure-code rule.
- **lease**: `lease_expires_at` computation (heartbeat anchoring, the 3600
  factor) and the expiry comparison (`epoch($at) > lease_exp(...)`).
- **strike** (reducer): strike-one set-once replay guard, future-stamp
  clamping, the missing-strike-one guard on strike-two, the 14400s grace
  comparison, the post-nudge heartbeat guard (`>`), strike-two's
  release-into-`submitted` transition, and the working-state guard on strike
  events.
- **sweep** (`cmd_sweep`): the expired-lease comparison, the working-claim
  selector, the strike-empty branch, the 4h grace comparison, the
  heartbeat-after-nudge guard, and the terminal-claim exclusion.

## How it works

1. `scripts/room-mutate.mjs` reads the baseline `scripts/room`.
2. For each catalogued mutant it requires the anchor string to occur **exactly
   once**, writes an executable mutant copy to a scratch overlay
   (`.tmp/room-mutate/mut-<ID>/`), and `bash -n` checks it. A mutant that
   fails the syntax check is a bad mutant definition (ERROR), never a kill.
3. The protocol test files are copied into the overlay. They resolve
   `scripts/room` via their checkout-relative path, so inside the overlay
   they exercise the mutant. `tests/claim-validate.test.js` runs
   name-filtered to its `validate_claim` parity test with a stub
   `server/store.mjs` (the parity test never touches `RoomStore`).
4. Each mutant is KILLED when at least one test fails. Mutants expected to
   survive must carry a precise equivalence argument in the catalog.

No production test seam was added; `scripts/room` stays byte-clean. The
mutator never touches the live board.

## Running it

```bash
# targeted checks during development
TMPDIR=$PWD/.tmp node --test tests/room-protocol-mutation.test.js

# one mutant / a subset
TMPDIR=$PWD/.tmp node scripts/room-mutate.mjs --run M21 --workdir $PWD/.tmp/room-mutate

# the full campaign (parallel)
TMPDIR=$PWD/.tmp node scripts/room-mutate.mjs --run-all --jobs 4 --workdir $PWD/.tmp/room-mutate

# list the catalog
node scripts/room-mutate.mjs --list
```

## New tests

`tests/room-protocol-mutation.test.js` targets exact boundaries the existing
suites did not pin, through the real script (via `ROOM_UNDER_TEST`, defaulting
to the checkout copy):

- **L4**: a heartbeat exactly at the lease expiry instant is accepted
  (the `>` vs `>=` boundary in `cmd__state`).
- **S3**: a future-dated strike-one stamp is clamped to the comment time.
- **S7**: strike-two at exactly `strike_one_at + 14400s` releases
  (the `<` vs `<=` boundary).
- **S9**: a heartbeat exactly at `strike_one_at` does not void the strike
  (the `>` vs `>=` boundary).
- **W2/W5**: sweep's `-gt` boundaries — nothing planned at exactly the
  expiry instant, or at exactly 14400s after strike-one.
- **W1/W3/W4/W6/W7/W8/W9**: sweep plans strike-one for expired working
  claims, ignores submitted/terminal claims, releases after the grace with
  no heartbeat, spares claims with a post-nudge heartbeat, still releases
  when the heartbeat is exactly at the strike instant, and never
  double-nudges.

S4 (unparseable strike-one stamp refused) is **skipped with a documented
reason**: writing it exposed a real bug — `def epoch($s): (($s |
fromdate) // 0)` does not catch jq errors (`//` only handles
empty/false/null), so a genuinely unparseable strike-one stamp crashes the
whole `_state`/`rebuild`/`sweep` pipeline (jq exit 5) instead of being
refused. Minimal fix: `def epoch($s): (try ($s | fromdate) catch 0)`. Filed
for the `scripts/room`-owning lane; this lane holds no claim on
`scripts/room` and must not edit it. Unskip S4 when the owner repairs
`epoch()`.

Per the repo test-authoring gate, parser/validator mutations are killed by
the pre-existing owner suites (board-grammar, prose-claims,
claim-validate parity, strike-hardening, sweep dry-run/terminal) rather than
by duplicated new tests: the mutator runs those suites against every
mutant, so the new file only pins boundaries they did not cover.

## Mutant catalog

| ID | Area | Mutation | Expected killer |
|----|------|----------|-----------------|
| M1 | parse | `[claim]` branch swapped to `[receipt]` | room-prose-claims: claim kind |
| M2 | parse | `[receipt]` branch swapped to `[done]` | room-board-grammar: receipt parsing |
| M3 | parse | `[done]` branch swapped to `[claim]` | room-board-grammar:120 |
| M4 | parse | prose-terminal fallback `and` → `or` (condition degrades to TRUE: every prefix-less prose comment attempts a terminal close via `first_rc`) | room-board-grammar: 'unmarked CLAIM prose' |
| M5 | validate | task-id required check inverted (`== ""` → `!= ""`) | claim-validate parity |
| M6 | validate | files required check inverted | claim-validate parity |
| M7 | validate | lease `< 1` → `< 0` (accepts `lease=0h`) | claim-validate parity |
| M8 | validate | lease `> 72` → `> 73` (accepts `lease=73h`) | claim-validate parity |
| M9 | validate | failed-state rule inverted (`== "failed"` → `!= "failed"`) | claim-validate parity |
| M10 | lease | `lease_h * 3600` → `* 3601` (1s/hour drift) | strike-hardening F4 (exact expiry) |
| M11 | lease | heartbeat anchoring removed (`$t.heartbeat_at // $t.claim_at` → `$t.claim_at`) | strike-hardening F4 |
| M12 | lease | expiry `>` → `>=` (heartbeat at exact expiry voided) | L4 (new) |
| M13 | strike | replay guard flipped (`!= null` → `== null`) | strike-hardening F1 |
| M14 | strike | refused-stamp predicate flipped (`== 0` → `!= 0`: valid stamps refused) | strike-hardening F3-control |
| M15 | strike | future-stamp clamp swapped (`$at` ↔ `$stamp`) | S3 (new) |
| M16 | strike | missing-strike-one guard flipped (`== null` → `!= null`: forged strike-two releases) | strike-hardening F3 |
| M17 | strike | grace `< 14400` → `<= 14400` (exact-mark strike-two ignored) | S7 (new) |
| M18 | strike | post-nudge heartbeat `>` → `>=` (simultaneous heartbeat voids strike) | S9 (new) |
| M19 | strike | strike-two releases to `working` instead of `submitted` | strike-hardening F3-control |
| M20 | strike | strike working-guard flipped (`!=` → `==`) | strike-hardening F3-control |
| M21 | sweep | expired-lease `-gt` → `-ge` (strike-one at exact expiry) | W2 (new) |
| M22 | sweep | grace `-gt 14400` → `-ge 14400` | W5 (new) |
| M23 | sweep | strike-two guard `hb_ok = 0` → `= 1` (inverted: fires only with heartbeat) | W6 (new) |
| M24 | sweep | heartbeat-after-nudge `-gt` → `-ge` (simultaneous heartbeat counts) | W7 (new) |
| M25 | sweep | selector `working` → `submitted` (nudges submitted claims) | W3 (new) |
| M26 | sweep | selector drops the terminal exclusion (nudges completed/cancelled/receipted) | W8 (new) |
| M27 | sweep | strike-empty branch flipped (`-z` → `-n`: double nudge) | W9 (new) |
| M28 | parse | prose-terminal ref resolved from `$body` instead of `$rest` | room-board-grammar:70 |

## Results

Campaign run 2026-09-26 (second run; the first run's `claim-validate` parity
leg was void because the overlay lacked the test's `../server/*.mjs`
imports — fixed by copying the real `server/claim-validate.mjs` and stubbing
the server-only imports the parity test never touches):

- **mutants: 28, killed: 28, survived: 0, errors: 0**
- equivalent mutants: 0 — one candidate (M4, `and` → `or` in the
  prose-terminal fallback) was initially misjudged equivalent, but the
  campaign proved it a real bug-class mutant: at that branch `$pf.p` is
  always null, so the condition degrades from `R` to `TRUE` and every
  prefix-less prose comment attempts a terminal close. Killed by the
  existing `room-board-grammar` 'unmarked CLAIM prose' test.
- Every mutant was killed by at least one test; the per-mutant killer lists
  are in the campaign log (`.tmp/room-mutate/` during the run) and the
  expected-killer column of the catalog table above held for all 28.

### Incidental finding (not a mutant)

Writing S4 exposed a genuine baseline bug: `def epoch($s): (($s |
fromdate) // 0)` does not catch jq errors, so a truly unparseable
strike-one stamp crashes `_state`/`rebuild`/`sweep` (jq exit 5) instead of
taking the documented "refused" branch. S4 is skipped with a pointer to the
bug; the owning lane's minimal fix is `def epoch($s): (try ($s | fromdate)
catch 0)`. This lane holds no claim on `scripts/room` and did not edit it.
