# Direct normalization scale qualification

Runtime `76e492a89`; new tests only, final test source `bc0b9cde793c5a2e05f110df9706d80e29dd1f7e`. No runtime edits, deploy, grant or real room data.

## Results

October Native Worker (`workerd 2026-10-19`), compatibility date unchanged at `2026-07-30`:

| Synthetic room | Original projection | Events / retained messages / members | Activation host elapsed | Native SQL / rows read / physical rows written | Consumed JSON bytes |
| --- | ---: | --- | ---: | --- | ---: |
| Small control | 141,741 B | 1,000 / 100 / 1 | 23.92 ms | 842 / 3,837 / 1,947 | 934,423 |
| Large, one owner | 7,040,095 B | 50,000 / 5,000 / 1 | 569.86 ms | 38,818 / 180,930 / 95,278 | 44,977,560 |
| Large, active roster | 7,051,454 B | 50,000 / 5,000 / 64 | 1,818.33 ms | 38,929 / 3,331,947 / 95,785 | 45,009,466 |

Both final October runs passed 1/1, zero skipped, exit 0. Carrier becomes 130–131 bytes. Cold restart preserves exact activation receipt; second cold restart then post, subsequent post, selected useful result read and exact command retry pass. Final room has 50,002 events and 5,002 messages. The 64-member since-join control denies a pre-join message after cold restart. History remains UNKNOWN / uncertified.

Warm post counters are identical at 1,000 and 50,000 events, and with 64 members: 114 SQL statements, 1,181 rows read, 40 physical row writes. Exact command retry writes only the two raw runtime permit flips. Cold 64-member post host elapsed is 194.87 ms, versus 3.94 ms warm; constructor cost is included in host elapsed and excluded from the SQL counters. This is a matched flat serving observation, not a universal constant-time proof.

**Compatibility limitation:** the checked-in validation package pins Miniflare `4.20260730.0` / workerd `2026-07-30`. With that default engine, the same final fixture accepts and normalizes the 141,741-byte small room, then fails seeding the 7,040,095-byte legacy projection with `pilot_limit` (platform row limit), before operator normalization. That run exits 1 and is retained as a failure. October success does not make July support 7 MB, does not change the checked-in package, and does not establish the deployed engine or production room size. The one-room sizes above are actual fixture rows, not aggregate cold-start logs.

## Remaining measured cost

The 64-member activation performs `historyActivationTuple` 64 times. Each query scans the 50,000-event room, yielding **3,200,000 reads** for that family alone. This is an avoidable member × history one-time cost. Smallest seam: initializer can fold all relevant member activation entries in one ordered history pass using the existing `advanceHistoryActivation` / `historyJoinPoint` / `historyActivationValue` semantics, keyed only by the already admitted exact member IDs. Keep reactivation, noncanonical equivalent timestamps, missing activation refusal and source-sequence tie breaks unchanged. This is a proposal, not an implemented fix. No index or migration framework is needed for that approach.

Other one-time work remains proportional to retained messages: canonical materialization, per-row write proofs and normalized metadata/proof inserts. The full legacy state and canonical rows coexist in JS during adoption. No 128 MB memory-headroom assertion is possible from these counters. Local wall timing is neither CPU nor a production SLA, and this test does not enforce production Cloudflare CPU limits.

## Reproduce

Use existing repository dependencies. No new packages or limits:

```sh
MINIFLARE_WORKERD_PATH=/Users/johnpotter/.npm/_npx/c943b712072b77c4/node_modules/workerd/bin/workerd /Users/johnpotter/.local/bin/node --test cloudflare/normalization-scale.check.mjs
ROOM_SYNTHETIC_ROSTER=64 MINIFLARE_WORKERD_PATH=/Users/johnpotter/.npm/_npx/c943b712072b77c4/node_modules/workerd/bin/workerd /Users/johnpotter/.local/bin/node --test cloudflare/normalization-scale.check.mjs
```

The first command measures small plus one-owner large. The second measures only the 64-member large room. Omitting the override reproduces the package-default refusal.

The fixture is the reusable source recipe: normal `initialRoom` and real event envelopes, then 5,000 posts (one small edit target and 4,999 bodies of 1,250 ASCII characters), with real `message.edited` events to exactly 50,000 total. Each edit carries its exact revision. The 64-member variant adds a `since_join` policy and 63 active members joined after the messages' timestamps, reducing edit count to 44,934. The one-owner variant has 44,998 edits. Administrative `RoomStore.initialize` generates source integrity proofs; no manually stamped proof, inflated orphan table or fixture-only production route. Native data is temporary and removed on completion. A future live isolated rehearsal must use existing backup/restore/operator routes; this fixture endpoint is not deployable.

`receipt.json` binds source files, full command outcomes, samples, and compressed full logs. Earlier invalid edit-revision fixture, smaller-than-target 6,290,245-byte seed, and July row-limit failures are retained with explicit meanings; none is presented as a runtime regression or passing qualification. Final focused ESLint and diff check exit 0. Account/OAuth/connection preservation is separately qualified by the pairing lane; this test does not infer it solely from the success flag.
