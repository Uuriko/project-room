# Public-work reseed: bounded alarm selection only

Runtime `c9d799bad5d0f9935df37fc074e64d8e6734d2b0` (implementationa18591ed6 plus removal of its retired unused decoder import); causal red2375ba391; base89816a27e. Offline qualification only.

The scheduler previously enumerated all starter family rounds and iterated every non-receipted public offer during per-request alarm re-arm. An empty/closed board could require thousands of complete terms/claim decodes, even though SQL statement count stayed nearly constant. Missing starter anchors still caused LIKE family scans across unrelated tasks. Raising the prior six-statement assertion would hide this work.

The new gate is explicitly a **conservative request for a scheduled check**, not an exact zero-supply certificate. It probes only the four original starter offer primary keys and existing indexed receipt existence. A historical original submission remains a scheduling signal after later generations/rounds exist. Missing or unsubmitted original anchors do not request checks. There is no new schema, cross-request cache or durable authority. No offer terms, claims, packets or whole family is read by this gate.

Actual replenishment remains unchanged: it requires exact global claimableCount0, creates at most one next round per eligible family, and preserves original owner/terms/visibility/retry checks. The source-parity receipt hashes the byte-identical `_starterFamily`, `_starterTaskState`, `reseedStarterPool` and `_reseedStarter` methods. The jobs.mjs whole-module AST is unchanged; only its comment now describes the conservative gate accurately.

This deliberately permits no-op scheduled checks while useful work is available. The actual Node runner test proves existing60s cadence: one no-op, no extra run at the same clock or59,999ms, one at60,000ms, and no failures. It does not repeatedly mint work or busy-loop. No scheduler budget/cadence/registry behavior changed.

## Qualification and measured cost

The new causal control fails the original runtime because it enumerates whole families; final13 affected Node tests pass. They retain exact replenishment checks for visibility, offer version, deadlines, expired/live leases, legacy bare claim rows, archived rooms, receipt state and repeated round creation. Conservative scheduling cannot bypass these checks. Missing anchors and submitted older original generations are covered explicitly.

Actual production ProjectRoom Native fixture,12 arms: original898 and candidate;0/1,000/5,000 unrelated closed candidates; missing/submitted original anchors. All arms pass with0 unknown adapter samples. Synthetic SQL data is a targeted scheduler fixture, not a complete ownership/onboarding/full-recovery qualification.

At5,000 candidates with submitted anchors:

| Metric | Original | Candidate |
| --- | ---: | ---: |
| Adapter-reported physical rows read |25,907|890|
| Returned cell bytes |1,837,083|3,018|
| Hydrated offer candidates |5,003|0|
| SQL statements |7|5|
| Returned rows |5,016|12|
| SQL text bytes |1,230|466|
| Bound value bytes |128|139|

With missing anchors,5,000 tasks cost20,887 original rows versus891 candidate rows. The candidate has identical physical reads, returned rows/bytes, SQL text and bind bytes across0/1,000/5,000 for each anchor case. The remaining roughly890 reads are fixed admission/catalog work, not board traversal. Measurements exclude constructor/cold-start cost and raw native SQL outside the DurableDatabase observer; they do not prove CPU time or whole-job bounds. Bind bytes increase slightly even as materialized data decreases. Exact arm receipts are in native-cost.json.

Targeted lint:0 errors,1 preexisting raw-members lookup warning in unrelated public-work authority code. No broad unchanged suite, live request, push or deploy.

## Still open

The actual scheduled global-zero scan, full packet list and `_starterFamily` scans remain unbounded. This checkpoint removes that work from every request, but **does not finish bounded scheduling/replenishment**. Root requested source-backed examination of existing job checkpoint state before approving any new schema. No mutation epoch, new table or protocol is implemented or approved here.
