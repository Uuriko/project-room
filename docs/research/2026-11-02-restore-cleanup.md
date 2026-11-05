# Bounded post-publication restore cleanup (offline protocol17)

Runtime `e4fb4700f` on `14cc486a1`; AST-identical spacing `bf35c0046`. Schema45/native-work-5 unchanged. No production calls, migration, grants, push or deployment.

Publication still runs the unchanged original full recovery oracle, invitation summary comparison, exact frozen schema validation and current-format schema check in one transaction. It atomically clears pending admission and publishes its result. It now retains the existing conditional restore guards, which become inactive when admission clears. The original receipt `{requestId,expectedRevision,restoreId,sourceSeal,result}` remains unchanged thereafter. A target-owned cleanup sidecar advances independently in the existing latest_receipt field; no table or daemon was added.

The initial result includes `cleanupComplete:false` and an exact `nextCleanup` POST template. Each operator-authenticated `cleanup:true` JSON call rechecks original binding, current control DDL, code-owned inventory/definition hashes, cursor/CAS, every remaining guard's exact SQL and absence of every removed prefix. It drops at most15 frozen guards plus the one control UPDATE guard needed to checkpoint its sidecar: **at most16 physical DROP statements**, including that overhead. The sidecar checkpoint and exact latest cleanup response are atomic with DDL. No IF EXISTS, source business-row revalidation, ordinary-read DDL or guard rebaseline is used.

Cleanup responses keep `verified:true,pending:false`: HTTP202 means only maintenance remains, not that source recovery is unverified. They bind restoreId/sourceSeal and report cleanup revision, nextIndex, total, removed, remaining and verifiedGuardCount. Final HTTP200 requires actual zero restore_frozen_* guards, `cleanupComplete:true` and `nextCleanup:null`. Exact latest cleanup retries return the same result. Original publication retries always return the original immutable result, including its initial hint. A supported driver must persist the exact outstanding request BEFORE sending, then follow cleanup responses; replaying only the original publication hint after several steps is intentionally stale. A later table-name inventory change refuses cleanup rather than inventing a new inventory.

## Qualification and cost

Ten focused Node tests pass, with no skips: publication before cleanup, interleaved proved message work/read/retry, cold cleanup, every latest retry, final zero, immutable original publication retry, wrong/missing/extra/reintroduced removed-prefix guards, changed restore-control DDL, authority/CAS/rebinding, faults after actual DROP and after actual checkpoint, and genuine archived16 controls. The old16 clear constructor itself can return; its restore-control admission and exact guard entry/operator refuse17 before DROP. A precompiled restore-control mutation also refuses. This does not claim all old schema45 business writers were revoked after publication.

The original16 test fails its intended publication spike assertion with666 physical DROP statements. Current publication drops3 control guards and retains663 conditional frozen guards. Cleanup retires those663 over45 calls, adding45 single control-guard drops, for708 cleanup DROP statements and711 combined versus666 originally. The early compact source condition triggered a secret scanner false positive; final spacing preserves the entire Acorn AST including literal raw values, and scans clean without checker/allowlist exemptions.

The actual Native qualification reuses the exact frozen seed and production Native fixture bytes from the earlier482c cost evidence: one room, two members,1009 events,1002 messages, accepted native work/private request/history floors and a legal160029-byte timestamp. Random synthetic IDs differ; the runtime baseline differs. It runs496 restore steps, publication, a useful post/read before cleanup,45 cleanup calls and45 exact retries, both after-DROP/after-checkpoint faults with unchanged state and cold original retry, final zero, and ordinary/cold reads after cleanup. It passes1/1. Focused package checks pass3/3; lint is clean.

| Measured successful scope | Physical rows read | Materialized result JSON bytes |
| --- | ---: | ---: |
| Original frozen baseline publication |944950|6964984|
| New first publication |154218|6743590|
| All45 cleanup calls |1277791|15498574|
| New publication + all cleanup |1432009|22242164|
| Exact publication retry |3071|34701|
| All45 cleanup retries (separate) |132427|6826406|
| Two injected fault requests (separate) |40502|795267|

Maximum cleanup request:36874 rows read; at most16 physical DROP statements. The total successful publication-plus-cleanup work is **higher**, about51.5% more physical reads than the earlier atomic publication. This reduces the DDL spike and permits useful interleaved work, not a net total-work saving. Repeated exact catalog/remaining-guard/receipt validation contributes overhead and remains a concrete optimization opportunity. No redesign or validation waiver was added to hide it.

After cleanup, the separately measured cold constructor reports39 statements/5246 reads/6 cursor writes; its cold conversation request reports129/1599/0. The pre-cleanup useful post reports196/5415/40 and its read127/850/0. These are synthetic completed-cursor counters, not production CPU, universal engine IO, heap or latency. DROP TRIGGER mutates schema even when its cursor reports zero rowsWritten. Returned-byte accounting serializes result values, not wire/storage/peak allocation. Constructor, ordinary, retries and faults are separate from the publication/cleanup totals. Full per-query aggregates, commands/source hashes and compressed causal logs are retained in `audit/evidence/restore-cleanup-20261102.json` and its sibling directory.

## Exact remaining final-oracle seams

`server/recovery.mjs` remains the mandatory oracle. Existing resumable stages do not yet justify removing it wholesale:

* Lines62–73 duplicate engine/table/fence checks and replay-cutover recovery validation. The durable engine checks exist, but `auditReplayCutoverRecovery` is still an original-only staging/capture integrity check; legacy/deferred cases cannot be silently admitted.
* Lines77–178 still build complete current/legacy room state and rebuilt projection, normalize original channel/work-control backfills, enumerate drift, check checkpoint/count/history structure and run text/charter/reply/help audits. Current independent stages cover many exact shared leaves, but legacy rooms and every explicitly deferred replay/request/help grammar remain original-oracle obligations. Their completed counters are not a certificate for deferred branches.
* Lines182–191 still run global `shareLinks.verify`, reminders schema, `agentConnections.verify`, requestRuns schema, inbox/email journal verification, delegation journal, channel-update and handoff journals. Invitation/reminder continuation does not prove those distinct journals or their cross-system references. The three share-link loops are a compact next independent phase: usage cap, exact joined-event/member/account proof, and redemption orphan checks, using existing verifyJoin rules and bounded global keysets.
* Lines192–213 repeat the reminder-global census already staged; removal needs exact complete-stage consumption under the same sealed admission, not another parallel validation.
* Lines214–226 materialize, canonically sort and hash every application-table row for the original contractVersion1 report/dataSha256. Sealed coverage row-bags do not have the same meaning as that sorted canonical hash. A bounded equivalent or an explicitly reviewed new report contract with independent parity is still needed; silently substituting the seal is not acceptable.

Recommended next narrow semantic slice: share-links' original global verification and shared exact join leaf, then consume its complete resumable result under the same still-frozen source to REPLACE that exact final-oracle component. Do not append another ignored precheck; all other original components remain until their own equivalence is qualified. In parallel, the report-fingerprint contract needs an explicit root decision; none is changed here. Even empty optional journals require exact schema/absence/empty proof before replacing their oracle calls. The remaining full oracle is still unbounded, and cleanup alone does not clear the blob cutover blocker.
