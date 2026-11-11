# Storage incident: research and falsifiable next steps

Research checked2026-11-02UTC against official Cloudflare documentation. This is a source-backed incident plan, not a claim of service recovery.

## Established

- Runtime error observed by Grok: storage-operation timeout causes object reset. No CPU/memory-limit exception in that sample. The official troubleshooting page describes a storage-operation time limit; its deleteAll example is not evidence our code calls deleteAll (source search found none in room.mjs/storage.mjs). https://developers.cloudflare.com/durable-objects/observability/troubleshooting/
- Rollback of both doors to6a64 was admitted, executed and read back in run41374042040, but strict smoke failed and later canonical ready still503.5651 removal alone did not restore service. https://github.com/Uuriko/project-room/actions/runs/41374042040
- One passive45.34s postrollback tail:79events,13DOrequest structured logs,0OAuth metadata/register/token events,0exceptions. This does not exclude earlier or unsampled loops. No raw request URLs/headers/bodies retained.
- The paid SQLite DO cap is10GB. A full database normally throws SQLITE_FULL and reads can still work. That signature differs from the observed timeout; neither excludes cap pressure until measured. https://developers.cloudflare.com/durable-objects/platform/limits/ and https://developers.cloudflare.com/durable-objects/reference/faq/
- The native size measurement is ctx.storage.sql.databaseSize, in bytes. A real local Worker reproduction of our original measureStoreGrowth returned0 for28672bytes because its page PRAGMAs are unsupported. The patch uses native bytes on Workers and retains page measurements on Node.16affected tests passed, including actual Worker. This is a monitoring repair, not an outage-cause fix. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#databasesize

## Better diagnosis

1. Get exact production size through native measurement or existing authorized Cloudflare analytics; do not infer size from event count or treat unsupported zero as an empty database. Earlier GraphQL access403 remains an access limitation, not size evidence.
2. Compare matched synthetic actual-Worker fixtures on6a64/bbb8 and on/off background jobs. Vary room projection size and request concurrency separately; measure rows/bytes/write counts, cold/warm, completed vs timeout. Retain operation IDs; never generate a production load storm.
3. Trace fixed operation categories around storage, with a bounded sample and no SQL parameters/token/identity secrets. Distinguish SQLite synchronous execution, async KV await, input gate waiting and output commit. Request timeout is not cancellation of underlying work.
4. Only then disable the implicated job or route behind an explicit reversible switch and canary it. Keep health reporting the paused job honestly; do not suppress stale/error to green the release.

Cloudflare documents that async storage calls normally pause delivery of I/O events while they are pending, and output messages wait for persistence. A hung heartbeat/alarm write can therefore delay unrelated work without a CPU-limit error. This is a hypothesis to isolate locally, not the diagnosed root cause. Do not switch allowConcurrency or allowUnconfirmed globally: those options change coordination/durability semantics. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#asynchronous-kv-api

## Remove unnecessary coupling

OAuth metadata is static configured data but currently enters the single shared DO in server/http.mjs. Serve that metadata at the existing edge path using the same metadata builder, with exact issuer/resource/config parity and fail-closed configuration; keep actual registration, consent, token issue/refresh, revocation and seat authority durable and authenticated as required. Test a throwing/hanging DO with zero metadata storage calls. This is a next patch, not implemented by the size repair.

Continue normalized per-entity state, addressed reads, budgeted/resumable recovery and bounded jobs already under PR5655. Do not rush the schema45 cutover into this outage or introduce another parallel storage system. Per-room isolation is valuable after the data migration/identity directory contracts and cross-room operations are qualified; one hot room must eventually cease blocking all owners.

## Laptop division

Root: sole deployment/recovery; size repair; composed source and acceptance evidence. Other laptop: already assigned retained-guard matched cost comparison; new local scheduler/OAuth A/B request sent through Grok bus because Room is unavailable (not acknowledged). Existing local helper: finish selective-query receipts, then matched OAuth cost experiment. Independent machines can split cold/runtime builds, large synthetic fixtures and focused browser/device tests; they cannot simulate platform production storage behavior, another consenting human owner, or Android delivery by assertion. Publish exact source/fixture/runtime/command/results and measurement limits, avoiding repetitive audits of unchanged code.

## Scheduled patrol isolation qualification

Cloudflare documents that production Date.now/performance.now advance only after I/O. A synchronous scan cannot rely on elapsed-clock checks as a work bound. Alarm exceptions also trigger automatic retries. These support deterministic row/byte/work bounds and inspection of alarm re-arming, rather than raising timeouts. Sources: https://developers.cloudflare.com/workers/runtime-apis/performance/ and https://developers.cloudflare.com/durable-objects/api/alarms/ .

Stored onset observations name `cron jobs failed: patrol` on an alarm with 77 ms CPU and 14.11 s wall time. Dashboard aggregate SQLite size was 235.79 MB, below the 10 GB cap; this is not an exact current per-object measurement. The retained October 31 backup has no eligible patrol rooms at acquisition, so it cannot establish which work was pending at onset. Offline query analysis still demonstrates that a 200-event tail can involve a preceding-history scan and whole-head hydration. None of these observations alone proves the outage cause.

The incident patch pins ROOM_PATROL_ENABLED=0 on both production upload commands and configurations. Only exact string zero opts out, before eligibility and health queries. Prior findings, cursors and errors remain; health explicitly says disabled. Manual authorized Store rechecks and separate integrity, backup and retention jobs remain available. No schema or grant changes.

Composed runtime b1c3135e1 with final deployment assertion and manifest passed 106 focused Node tests and two actual local Worker tests: scheduled/direct-RPC isolation with zero patrol queries and preserved state, plus native database-size measurement. The initial local Worker invocation lacked the existing cloudflare dependency link and failed to import Miniflare; after resolving dependencies both tests passed. These are local controls, not production recovery evidence. The ordinary full check found an unlinked investigation document, now linked from INDEX; full Node suite was not requested by that CI-mode check.

The complete matched local OAuth refresh HTTP comparison is counterevidence to a blanket refresh-write regression: native writes fell from 22 to 18 between 6a64 and bbb8 because the new transaction batches the work. Redundant client updates remain an optimization opportunity. This does not exclude a client retry loop or establish incident traffic.
