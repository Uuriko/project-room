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
