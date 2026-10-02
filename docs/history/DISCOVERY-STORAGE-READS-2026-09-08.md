# Discovery storage-read baseline

## Finding

The lean response reduced transfer, not repeated full-room decoding. Every measured
client operation currently loads and decodes the complete stored projection four
times with a legacy agent key, or seven times with an owner-connected agent.
This applies to full orientation, focused orientation, search and selected-task
context. A small selected-task response does not imply a cheap server read.

| Connection | Identity request | Operation request | Total full-room reads |
| --- | ---: | ---: | ---: |
| Legacy key | 1 | 3 | 4 |
| Owner-connected agent | 2 | 5 | 7 |

The client identity preflight authenticates once. The operation authenticates at
the HTTP boundary and again inside its committed read, then loads response data.
Each managed-agent authentication also reads the room to verify its sponsor.
These checks are intentional; reducing repeated decoding must not remove them.

| Work / messages | Stored projection bytes | Legacy input bytes / operation | Owner-connected input bytes / operation |
| --- | ---: | ---: | ---: |
| 10 / 20 | 24,603 | 98,412 | 172,221 |
| 100 / 250 | 278,393 | 1,113,572 | 1,948,751 |
| 400 / 1,200 | 1,250,493 | 5,001,972 | 8,753,451 |

At the largest size, a selected-task read returns 2,534 decoded HTTP body bytes
including identity, but the managed path feeds about 8.75 MB of projection text
through seven full-room decodes. The search result is 1,540 bytes and its two HTTP
bodies total 411,782 bytes. All three repeats agree for each scenario and mode.
No latency, CPU, physical disk I/O, retained-memory or hosted-cost claim follows
from these byte counts.

## Reproducible method

`scripts/discovery-profile.mjs` now runs six bounded, disposable fixtures: three
sizes times two credential modes, with three rotated repeats of four operations.
The existing acceptance fixture optionally enrolls the producer through the real
owner session and connection service. No direct authority-table insertion or
fake authentication is used. Its default remains the existing legacy fixture.

Instrumentation wraps only that fixture's `room()` instance. It counts successful
calls during each HTTP request. The current implementation selects one complete
projection and calls `JSON.parse` once per successful call. The stored UTF-8 text
length is measured once before requests and multiplied by the count. This is an
implementation-specific volume measure, not a general-purpose JSON profiler;
if a future implementation caches or narrows `room()`, revise instrumentation.
It does not count SQL-internal JSON parsing or unrelated event-body decodes.

The sequence stays fixed and all 20 application tables retain the same recovery
audit hash before and after measured reads. No read marker advances. Both modes
retain two HTTP requests and unchanged output sizes. Setup and audit reads are
outside request measurement. No live database or existing preview is touched.

Version-2 raw evidence is retained separately at
`../project-room-runtime-packages-20260908/evidence-storage-reads/discovery-profile.json`
relative to the integration repository. Original transfer and optimized package
evidence are not overwritten. Run the profiler with the supported Node runtime;
it accepts no CLI arguments and cannot target an existing database or remote host.

## Next experiment: narrow fresh authority reads

1. Prototype a small internal storage read that returns committed sequence,
   owner ID and the complete members map, using fixed SQL JSON paths. Preserve
   all member provenance/revision fields; do not construct paths from identities
   or accept client-supplied authority snapshots. Keep default room reads intact.
2. Compare full projection versus fixed-path extraction on identical disposable
   rooms before changing authentication. Measure returned text volume and timed
   execution separately, excluding fixture setup. Rotate order, warm both paths,
   repeat, report variability and verify equivalent consumed values. A narrower
   JavaScript input alone is not proof of a faster total operation.
3. If justified, use the helper only in credential member lookup and managed
   sponsor lookup first. Preserve credential/parent expiry, revocation, account
   epoch and binding checks, invitation evidence, active membership, permissions,
   sponsor ownership/revision, managed generation and session binding checks.
   Requery on every existing authentication; no authority memoization.
4. Test legacy agents, managed agents, human room sessions and account sessions;
   missing rooms/members; sponsor or member changes between identity and operation;
   expiry, disconnection, rotation, account suspension and later reactivation.
   Verify denial remains denial and reactivation cannot revive a retired key.
   Validate exact output/identity parity and unchanged all-table audits.
5. Exercise actual Node and local Workers implementations. Preserve synchronous
   transaction boundaries and fallback compatibility. Extend measurements to
   count narrow reads as well as full reads, so shifting work cannot disappear
   from the reported total. Only then qualify a new exact runtime package.
6. Consider narrower work-context data reads separately. Do not expand this first
   change into a schema migration, search service, cache, new endpoint or index.

SQLite documents that text JSON generally needs conversion to its internal form;
`json_extract` can return selected values, but does not make the stored text free
to parse. JSONB can avoid that conversion, yet most operations remain O(N) and it
introduces a storage/compatibility decision. Do not adopt it merely to make the
JavaScript metric smaller. [SQLite JSON documentation](https://www.sqlite.org/json1.html).

SQLite WAL read transactions provide a stable snapshot, not freshness across
separate requests. Local Node `readTransaction` currently starts a deferred
transaction and nested transactions reuse the connection; its name alone is not
a guarantee that arbitrary nested helpers cannot mutate objects or write. The
Workers adapter has additional read-only guards. A shared/request/global cache
would therefore need a separate invalidation and aliasing design. It is not part
of this experiment. [SQLite isolation](https://www.sqlite.org/isolation.html).

## Checkpoint and boundaries

570 core/API/package checks pass. All 65 runtime files still match retained
candidate `2553d7329100c25591ac63ff410e4d906837fc04`, including all 19 public assets;
the package manifest verifies. Schema12 and fallback4d22189 are unchanged.
No new runtime build or browser/Workers/fallback rerun is claimed. No UI change
requires another screenshot; machine-readable evidence captures this measurement.

This checkpoint adds test tooling and an evidence-based plan, not a runtime
performance fix. No native model, paid compute, push, publication, live migration,
preview restart or external action occurred. The broader product goal remains
active, with native-host acceptance, independent current-authority recovery and
hosted release approval still separate gates.
