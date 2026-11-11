# Existing SQLite checks with durable progress

`recovery-engine-continuation.mjs` performs the existing mandatory SQLite checks as part of the existing restore continuation contract. It requires a privileged synchronous restore transaction and the exact pending restore ID/audit phase. The caller still validates the sealed schema/frozen target and commits the resulting cursor atomically. This module does not admit a target or issue a certificate.

Quick checks preserve the old non-`sqlite_*`/non-`_cf_*` table filter; foreign-key checks visit every table, preserving the old unscoped check. Quoted identifiers are escaped. The first diagnostic or orphan causes refusal without allocating all diagnostics. A single SQLite table check remains internally atomic and is not a strict CPU bound.

The initial one-atom prototype is retained at123b140df. The measured default now admits up to16 mandatory small-table atoms per durable transaction. Existing sealed coverage row counts and maximum row bytes identify large atoms: above128 rows or131072 maximum row bytes, or unknown size, the table runs alone. A batch stops before a large atom after doing any work, and returns immediately after a large atom. No table is omitted. Cursor version2 records the batch span explicitly.

Actual production `ProjectRoom` construction and pending readiness are exercised by a test-only engine driver. This is a module/cost qualification with persisted synthetic target controls, not proof that the final operator continuation is composed. Both batch sizes execute227 quick and228 foreign-key checks on1k/5k synthetic canonical histories; a separate5k arm includes one legal1MiB staged attachment with exact SHA256. Fault after actual checks but before checkpoint preserves the exact old admission through cold restart; exact request retry changes no rows. Even engine completion keeps readiness503 because remaining independent checks have not granted admission.

| History | Batch | Steps | Adapter physical rows | Raw native rows | Total physical rows | Engine rows alone | Worker elapsed sum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1k | 1 | 456 | 4,378,767 | 912 | 4,379,679 | 12,339 | 378ms |
| 1k | 16 | 58 | 970,662 | 116 | 970,778 | 12,339 | 68ms |
| 5k | 1 | 456 | 4,426,830 | 912 | 4,427,742 | 60,402 | 362ms |
| 5k | 16 | 58 | 1,018,725 | 116 | 1,018,841 | 60,402 | 71ms |
| 5k +1MiB attachment | 1 | 456 | 4,426,831 | 912 | 4,427,743 | 60,403 | 504ms |
| 5k +1MiB attachment | 16 | 62 | 1,054,933 | 124 | 1,055,057 | 60,403 | 74ms |

These are finite local Worker elapsed samples, not CPU or production guarantees. Every successful step was also retried; client HTTP counts are twice step counts. Maximum engine rows per atom grow from2006 to10006. The1MiB row does not increase row count proportionally to bytes, and that metric cannot establish memory use. `process.memoryUsage()` returned all-zero Worker placeholders, so usable memory telemetry is unavailable. Full physical counters include adapter operational catalog/admission costs plus independently observed native runtime-permit SQL. The earlier0127 receipt mislabeled adapter counters as totalphysical; the updated receipt preserves that correction explicitly. Native runtime updates are measured separately, not assumed. Retried calls have0 adapter writes but still incur native permit updates; totals above cover committed advancing steps, while retry overhead is reported separately in the fixture.

Five Node controls cover exact inventory, escaped identifiers, scope/stale validation, actual orphan foreign key, actual CHECK corruption, and batching boundaries. Actual Native six-arm test passes with no unknown physical counters. Exact measurements and limits are in `audit/evidence/recovery-engine-continuation-20261101.json`. Pairing owns protocol/cursor integration and final composed operator recovery qualification. The existing full oracle remains required.

The native counter uses one stable storage proxy per instance. A discarded intermediate observer replaced that proxy per request and increased catalog-cache costs; it is excluded from the final receipt. Constructor costs are outside step totals. Client wall includes cold reopen and retry calls; physical/Worker-clock totals cover advancing steps.
