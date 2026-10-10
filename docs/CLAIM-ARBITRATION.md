# Claim arbitration (timestamp-based fallback)

The pure rule in `server/claim-arbitration.mjs` for picking ONE winner from
competing claims on the same item/lease when the contention is resolved by
timestamp.

## Scope — read this first

The live work-claims board (see [WORK-CLAIMS.md](WORK-CLAIMS.md)) grants a
claim to whoever arrives first: a second claim on the same item is
**409** `work_claim_conflict`, and the duplicates endpoint only *suggests*
candidates — it never auto-merges. **This rule does not change any of that.**
It is the documented, deterministic rule for any *future* timestamp-based
fallback path (e.g. reconciling claims recorded on two replicas that both
claim the same item before converging). No timestamp-fallback call site
exists in the codebase today; the module ships unwired until one does.

## The rule

Given a set of competing claims, each carrying `{ id, claimedAt }`:

1. **Earliest minute wins.** Each `claimedAt` is floored to its UTC minute
   bucket: `Math.floor(ms / 60000)`. The claim in the smallest bucket wins.
2. **Same-minute tie-break: lexicographically smallest claim id wins.**
   Comparison is UTF-16 code-unit order (`<` on strings) — spec-deterministic
   across runtimes, no locale, no collation tables.

`arbitrateClaims(claims)` returns the winner; `rankClaims(claims)` returns the
full deterministic ranking, winner first. `minuteBucketMs(claimedAt)` exposes
the bucketing. `claimedAt` accepts ISO-8601 strings, epoch-ms numbers, or
`Date` instances. Outputs are frozen copies; inputs are never mutated.

## Why the tie-break is load-bearing

Simulation (g1-sim) of timestamp-based arbitration showed that with 200
competing claims, **64% of rounds contained two or more claims landing in the
same minute**. Minute ties are the common case, not the edge case: a rule
that only breaks ties at exact-millisecond equality would leave most ties
undecided, and an undecided tie falls back to input order — which is
nondeterministic across replicas and runs. The minute bucket + id tie-break
makes the order total and input-order-independent.

## Why lexicographic id instead of a hash

Claim ids are unique, opaque, and bounded by the board's
`[A-Za-z0-9_-]{1,128}` charset, so code-unit ordering is already a total
order. It is spec-deterministic (ECMA-262 string comparison), reviewable in
one line, and needs no crypto. A stable hash would be equally deterministic
but buys nothing here.

## Purity guarantees

- No randomness. No wall-clock reads — every timestamp is an input.
- Same claim set → same winner, always: across runs, processes, and input
  orderings (covered by property tests in
  `tests/fix52-claim-arbitration.test.js`: seeded-shuffle invariance, 200×
  cross-run determinism, never-two-winners).
- Fail-closed on bad input: empty sets, non-arrays, missing ids, and
  unparseable timestamps throw `ClaimArbitrationError` with a named `code`
  (`no_competing_claims`, `claim_missing_id`, `claim_bad_timestamp`, …).

## Worked example

```js
import { arbitrateClaims } from "./server/claim-arbitration.mjs";

const winner = arbitrateClaims([
  { id: "lane-zulu",  claimedAt: "2026-10-09T16:00:41.000Z" },
  { id: "lane-alpha", claimedAt: "2026-10-09T16:00:03.000Z" },
  { id: "lane-mike",  claimedAt: "2026-10-09T15:59:12.000Z" },
]);
// → lane-mike wins: its minute bucket (15:59) is earliest.
// If lane-mike were absent, lane-alpha would win: same minute as lane-zulu,
// smaller id breaks the tie (ms offsets inside the minute are ignored).
```
