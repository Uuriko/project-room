# Protocol 19 correctness checkpoint

Runtime source: `6dd3567a911f9f100a8f170da4ea66b7d520bd21`. Test-only reconciliation: `21782bcd2d3be18a55391e449985d018ae0a40fa`. No deployment or production calls. Protocol 20 envelope preservation is a separate peer-owned change; these results do not qualify it.

The actual Native backend and existing remote restore CLI completed a synthetic 32-message restore containing accepted work, a private request and a 160 KB legal atom. There were 385 POSTs (339 coverage/publication and 46 cleanup including a lost acknowledgement). Forty-five cleanup revisions removed 663 guards and all report workspace. Exact T0 report tables/dataSha256 matched the independent whole oracle. Cold restart, exact lost-ACK retry, immutable publication retry, ready status and saved work/message retry passed.

Report 1 semantics remain unchanged within an explicit T0 audit snapshot: exact raw admission control and proven-empty scratch are captured before report writes; only those two tables are substituted in the restore-specific view. All other tables remain included. The default literal oracle and all other final semantic checks remain mandatory. Snapshot capture admits up to 3 MiB of raw control as one bounded atom; it is not a strict small-quantum operation.

Own focused Node controls passed 46/46. Root composition initially passed 79/83: three obsolete total-step caps and one INSERT-result int64 fixture failed. The separate targeted reconciliation passed 15/15 while preserving the original 200/250 pre-report caps, cold/fault/corruption assertions and exact signed source addressing. Its report bound is independently derived from actual T0 rows, cell source reads, chunks and merge work; every request must change a source/merge/hash frontier. This is not a rerun of all 83 root tests.

Fresh runtime inspection found Homebrew Node v26.8.2 and bundled Node v24.22.1, both SQLite 3.53.4. Homebrew throws converting the INSERT lastInsertRowid at int64 minimum, whereas bundled Node rounds it; setting readBigInts on the setup INSERT avoids both. Production source addressing remains exact decimal text. No claim is made about the binary used in an earlier root run.

## Remaining performance blocker

Across 260 actual report-continuation requests (excluding capture and final publication), independent maxima were {"bytes": 1387228, "drops": 6, "requests": 260, "rowsRead": 58533, "rowsWritten": 53, "statements": 472, "totalRowsRead": 14673677, "unknown": 0}. These are physical cursor row counters and materialized JSON bytes, not CPU, IO, heap or a production SLA. Constructor/seed/export/reference-oracle work is excluded. Request-time raw SQL instrumentation includes maintenance SQL; delayed work outside the measurement window is not included.

The highest-row request spent 36,768 of 58,533 reads in repeated exact-name mutable guard probes (two 12-call query families). Repeated catalog inventory/admission and control loads add cost; the largest payload request reread 821,019 bytes of report scratch and 495,288 bytes of control. Bounded source components do not make this route fast. Catalog batching and same-transaction reuse are the next separate optimization; cold exact admission and mutation invalidation must remain intact.

Component/source Native tests also pass: fixed per-call maxima across 64 and 512 rows, plus a cold 800 KB Unicode/NUL/BLOB source. The originally guessed 160-statement bound and a test-controller surrogate-splitting error remain as red log artifacts; the qualified component bound is 176 statements. Peer read-only authority review found no actionable counterexample, but did not independently prove all encoder parity.

`qualification.json` lists full artifact digests and exact source pins. Compressed logs retain original output. All fixture data is synthetic.
