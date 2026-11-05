# Incremental independent work-help recovery audit — 2026-11-01

Status: offline schema45 qualification only. Root owns integration and deployment. Original final recovery oracle remains mandatory.

## Problem and resulting behavior

Strict event replay does not replace `auditWorkHelp`: historical checkpoints can contain help or offer values which replay did not independently compare, and the original audit additionally checks historical owner/member permissions, accountable work revisions, global offer identities, selected-offer uniqueness, capacity and ordering. This change extracts the original predicates and stages these exact checks through the existing sealed restore cursor and scratch. It adds no user action, grant or storage authority.

The original full oracle calls the same historical member/work and offer validation leaves. Public help-offer readers and transitions still validate the complete original map. Incremental recovery scans every historical offer before each offer transition; derived identity and selected-work indices are updated atomically with the offer and independently checked against every scanned row. They do not replace the global scan or its capacity checks.

## Source and integration

- `a946f3460`: original shared leaf extraction.
- `dccd3b355`: durable work-help phase and first 12 controls.
- Pairing `eb70205c5` (local adoption `b59963975`): protocol15, reply_requests then work_help before advancing a room. Native ArrayBuffer checkpoint bytes accepted through the existing byte normalization.
- `bd1e4c745`: Native fixture and qualification.
- `3741ee4c6` (parent `bd1e4c745`): narrow checkpoint leaf validation cure. Root already adopted the earlier chain; this is the standalone runtime delta to add.

`advanceRecoveryWorkHelp` requires the existing privileged transaction, exact pending restore ID and source seal. It admits scalar sizes before transferring source payloads. Existing codec chunks are 16KiB; emitted leaves are decoded individually, including discarded leaves. Parent frames are never hydrated. No whole-checkpoint `json_valid` or full projection read remains in this phase. A supported checkpoint compares exact compact room/member/help/offer facts at its historical sequence before the tail.

Unsupported codec grammar is explicitly **deferred** to the still-required original oracle. The report keeps `deferred` distinct from completed comparisons. No-help rooms preserve the original absence-only audit behavior rather than inventing historical authorization requirements.

## Bounds and limitations

The phase normally admits up to32 atoms and4MiB per step, with the existing128-row scratch flush bound. A legal sealed source atom above4MiB executes alone and reports its actual bytes; it is not refused by an invented source cap. JSON decoding of one admitted leaf/event remains atomic. This is not a strict CPU or peak-heap bound, and no whole-purge or whole-recovery bound is claimed.

The existing final full oracle still repeats these checks, so this qualification does not establish a net recovery speedup. Historical offer transitions require complete offer scans and can perform quadratic total work within the existing500-offer capacity. The independent checkpoint scan also overlaps reply and replay scans; this is recorded rather than hidden as saved work.

Native SQL counters cover adapter-observed per-request spans only. They exclude cold constructors, raw runtime-permit SQL and test-only forensic snapshots. Clock measurements are illustrative elapsed time, not CPU. Restore guard DDL can force exact catalog revalidation; earlier ordinary warm-reader cost does not describe every restore step.

## Executable controls

Focused Node controls cover retained/no checkpoint, historical owner transfers including agent permission removal, checkpoint help scope, current member revision, work revision, accountable permissions, duplicate or missing/wrong identity/selected indices, interrupted atomic offer/index saves, ordinary/wrong-ID/wrong-seal authority, oversize refusal before payload, legal above-quantum atoms, explicit unsupported-shape deferral, and malformed discarded leaves.

The leaf regression is causal: the new control against the pre-cure module `bd1e4c745` fails with `no whole checkpoint parse or payload read`; the cured source passes. It also injects invalid bytes into an otherwise discarded checkpoint message span and requires reconciliation failure.

Actual Native uses real legacy commands, legal completion of legacy mirror work, H conversion, a retained historical checkpoint and142 events containing13 help scopes and14 offers. It alternates warm/cold continuation, retries the latest receipt, injects a fault after a real offer scratch insertion, checks exact rollback, then independently corrupts a derived identity and requires refusal with unchanged progress. Final reports must match13 help scopes,14 offers and197 complete offer-row checks. Final cold readiness and completed receipt replay are asserted separately.

Logs and machine-readable measurements are in `audit/evidence/recovery-work-help-20261101.json`. No deployed/live claim is made.

## Final receipts and commands

Cured source: **88/88 Node**, including17 incremental controls and71 original help/service/ownership controls; **1/1 actual Native** with explicit final cold `/api/ready`200 and exact completed receipt retry. Native fixture elapsed64.65s is test-wall time including cold restarts and a separate corruption target. Lint has0 errors,2 pre-existing-style raw-member warnings on locally created addressed maps; secret scan clean.

For the valid target,17 sampled work-help requests observed8,086 SQL statements,731,178 physical rows read and292 written, unknown0; maxima803 statements/49,893 rows read/29 written per sampled request. Maximum reported input211,582 bytes. These are limited adapter spans as described above, not the full restore total. The separate corrupted target contributes10 additional sampled spans; it must not be pooled into valid completion cost. Exact raw spans and interrupted-fault span are retained in JSON.

```sh
node --test tests/recovery-work-help.test.mjs tests/work-help.test.js tests/help-offers.test.js tests/work-help-audit-ownership.test.js tests/work-help-service.test.js tests/help-offer-service.test.js
MINIFLARE_WORKERD_PATH=/Users/johnpotter/.npm/_npx/c943b712072b77c4/node_modules/workerd/bin/workerd /Users/johnpotter/.local/bin/node --test cloudflare/recovery-work-help-native.check.mjs
node node_modules/eslint/bin/eslint.js server/recovery-work-help.mjs tests/recovery-work-help.test.mjs cloudflare/recovery-work-help-native.check.mjs
```

Final local logs: `/tmp/recovery-workhelp-qualification-final.log`, `/tmp/recovery-workhelp-native-leaf-cold-final.log`; causal baseline `/tmp/recovery-workhelp-leaf-causal-red.log`. Hashes are in the evidence JSON. Pairing's separate combined protocol15 two-room actual Native proof is `a451c837e`; this document does not relabel it as this fixture's result.
