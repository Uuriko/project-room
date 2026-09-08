# Agent discovery transfer: evidence and next implementation

## Question and method

Does bounded agent search save transfer, or only shrink the output? Measure before
adding a service endpoint or cache. The profiler creates three disposable Node
HTTP fixtures within current pilot limits, then runs full orientation, needs-me,
needs-me search and a selected task read three times each, rotating operation order.
Every operation retains its identity preflight. All20 application tables are audited
before and after the reads. Only synthetic counts and byte measurements are saved.

Each fixture has exactly one task addressed to the producer. Other tasks belong
to the owner and do not match the query. Added messages contain synthetic unrelated
discussion. These are workload scenarios, not measured or claimed typical rooms.

Measured quantity is decoded HTTP response-body bytes, summed across both requests;
output is UTF-8 bytes of serialized client result JSON. Headers, TLS, compression,
MCP framing/duplicated text, model tokens and external network latency are excluded.
The fetch wrapper clones and reads each body, so it must not be used to claim
latency or memory performance. No concurrent load or Workers CPU benchmark is run.

## Results on runtime cefc89b

| Work / messages | Full, focused or search fetched | Search result | Selected task fetched |
| --- | ---: | ---: | ---: |
| 10 /20 |52,304 B |1,537 B |2,532 B |
| 100 /250 |361,321 B |1,539 B |2,533 B |
| 400 /1,200 |1,333,622 B |1,540 B |2,534 B |

All three repeats in each case have the same byte counts. Full/focused/search
currently transfer the identical full snapshot, including messages and recent
event history. Focus/search then reduce the local output. Selected reads already
avoid that response growth. Every read is two requests, including one identity
check, with unchanged Room data. The largest stored projection is1,250,493 B;
the snapshot is larger because it includes additional context such as the audit tail.

This establishes excess transfer, not a measured latency problem or user retention
effect. It does not prove that server-side filtering alone makes storage access
cheap: authentication and projection construction also need separate profiling.

## Research and decision

[Microsoft's extraneous-fetching guidance](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/extraneous-fetching/)
recommends retrieving the data an operation needs. For this application, first
remove unrelated snapshot content; do not add a second index or cache membership.
[HTTP semantics, sensitive URI information](https://www.rfc-editor.org/rfc/rfc9110.html#section-17.9)
also matters: moving a currently local search phrase into a URL changes its logging
exposure. Keeping matching in the client avoids that new exposure.

Chosen next slice: an explicitly versioned work-only snapshot projection on the
existing authenticated snapshot read. It contains Room brief, current members and
work, but no conversation bodies, audit tail, read marker or unrelated private
state. Keep current-field search and focus-before-limit selectors on the client.
This is an incremental transfer optimization, not a promise of constant-size work
discovery or a reduced permission scope. The existing500-work and4MiB room bounds
still apply. A later bounded service-side result could reduce work transfer further,
but would need a deliberate input-privacy, validation and pagination contract.

## Detailed implementation contract

1. Leave no-query/default snapshots and full orientation unchanged. Add one strict
   opt-in projection selector such as `view=work`; never put search text in it.
   Reject malformed/duplicate selectors; preserve existing auth/session fencing.
2. Return a distinguishable projection/version marker, committed sequence and full
   viewer identity metadata. Read current Room instructions from that same snapshot.
   Reuse existing projection, not an independently updated index. No schema change.
3. Let focused/search orientation consume this view. Do not change matching, order,
   selected-read pointers, action descriptions, limits or no-query output contracts.
   Retain every identity preflight and service authorization; no access cache.
4. Define compatibility before coding: retained fallback ignores unknown snapshot
   parameters. Recognize a fully validated legacy snapshot as a slower compatible
   response, not as a partial new view. Unknown projection versions/malformed data,
   wrong room/member or revoked access fail; do not retry those as a weaker read.
   Never fall back after an arbitrary transport/authentication error.
5. Verify exact human/agent result parity, current brief consistency, expiry-clock
   semantics, cancellation, wrong identities, no private field leakage, no reads
   acknowledged and all20-table read-only behavior. The selected view narrows data
   transferred, not what the credential may read through other APIs.
6. Rerun this profiler against candidate and retained fallback. Report both gains
   and remaining O(work) payload and full stored-projection costs. Verify unchanged
   public assets, full core, local Workers and exact-package fallback qualification.
   Do not claim hosted readiness, native-model behavior or measured retention.

## Reproduction and scope

Run `node scripts/discovery-profile.mjs` from the checkout for the fixed three
scenarios. No path, URL, credentials or size arguments are accepted by the CLI.
Output is saved to `test-results/discovery-profile.json`; tests cover bounded
fixture inputs, actual request counts and isolation of transfer vs returned data.
Test assertions preserve measurement integrity without requiring today's excess
transfer to remain forever. Fixtures are closed and removed after each run.

Current change is profiling/test/documentation only. Runtime packagecefc89b,
fallback4d22189 and existing preview remain unchanged. No deployment or models.
The broad goal remains active/incomplete; the work-only view is planned, not built.

Qualification:564 core/API/package checks pass, including the two new profiling
integrity tests. All65 runtime files remain byte-identical to retained candidate
cefc89b; its manifest verifies. The earlier176 browser and local Workers/fallback
checks were not rerun for this test-only slice. No new UI screenshot is warranted.
Baseline JSON is preserved at
`../project-room-runtime-packages-20260908/evidence-discovery-transfer/discovery-profile.json`
so subsequent optimized runs cannot replace the historical comparison.
