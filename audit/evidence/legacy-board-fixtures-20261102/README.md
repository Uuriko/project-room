# Historical Board and native paging qualification

Base: `3690a6f18`. Tests-only source: `6063856bf`, `571a60795`.

Production AgentRooms now creates normalized rooms. Historical Board fixtures must construct the genuine existing legacy representation rather than relabeling a normalized carrier or restoring retired Board writes. The synthetic helper registers the held founder identity and preserves the historical starter claim and its real sequenced retention receipts. Original assertions, including 209 exact Board rows, remain intact. No production authority, schema, grants, credentials, or room behavior changed.

## Causal results

- Original F12/context files: 15 tests, 5 pass / 10 fail. Reconciled historical fixtures plus two new native context controls: 17 / 17 pass.
- Hosted claim-PR selected controls: 2 / 2 pass. Only the shared import and claimLinkFixture were changed in mcp-core-profile; its other tool/profile tests remain outside this lane.
- Original work-pagination file at the base: 1 / 2 pass; native unknown total `null` contradicted historical expected exact 63. The original hosted and stdio exact-total/query assertions now use a genuine legacy fixture and remain unchanged.
- Final pagination file: 3 / 3 pass, including the untouched invitation expiry test and new native test.
- Targeted ESLint: 0 errors, 0 warnings. Whole-tree secret scan: 1905 files, 0 findings.

The new native context control forbids whole-room and legacy Board reads, proves full/conditional charter-context freshness after a real canonical proposal, and compares all durable rows. Existing agent identity usage telemetry (`last_used_at`, `last_used_ua`, `mcp_legacy_uses`) is excluded from that equality only; every other identity field and every other table remains compared. The independent storage-fault control makes actual protected summary admission throw, requires refusal for both full and conditional reads, then proves the original conditional version still works after restoration. No false empty context or error detail leak is accepted.

The new native paging control uses actual production AgentRooms creation, 63 canonical proposals and real HTTP plus child-process stdio. For each transport, all-focus traverses 16 pages with exactly 63 unique IDs; results-focus traverses all 16 empty pages before completion. Totals and match counts remain unknown, source windows examine at most four work items, returned next-read arguments are followed exactly, and changing focus/limit/head refuses. Full-room/Board readers throw. Actual abuse limiting is respected by retrying unchanged arguments only after the announced retry interval.

An existing transport limitation remains: hosted unsupported query/sort returns `current_work_selection_unavailable`, while stdio maps it to generic `service_unavailable`. Both refuse without successful empty work data. This is recorded as error-label/recovery guidance friction, not repaired or represented as supported global selection.

No actual Cloudflare Worker, deployment, live user, or native claim-PR feature parity is claimed here. Historical claim-PR registry behavior remains distinct from canonical saved-result evidence.
