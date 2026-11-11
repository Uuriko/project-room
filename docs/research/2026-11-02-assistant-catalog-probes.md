# Remove optional-assistant catalog scans from post/edit

Runtime baseline: exact main `2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e`. Test fixture prerequisite `747099061` (same extension recorded separately in the normalized-serving-cost report). Candidate `8233814b3`. Only runtime file is server/room-assistant.mjs. No schema/version/protocol, grants, proof rules, recovery path, deployment or live data changes.

The ordinary unconfigured post called invokeFromPlainPost, which scanned sqlite_master for room_assistant_config and then performed its indexed room-specific read. Message-edit invalidation similarly probed room_assistant_runs before its existing run query. Each probe visits885catalog rows. The fix executes the original real query directly. A private helper returns absence only for the exact Node `no such table: <selected table>` or actual Native `<same>: SQLITE_ERROR` message; all other SQL failures propagate. It has no cache, schema_version assumption, revision trust or invalidation protocol. It neither installs schema nor catches errors from subsequent validation/mutations. RoomAssistant.list's independent probe remains outside this slice.

Actual matched Native SQLite, using the existing1k/50k history fixture:

| Warm operation | SQL before→after | Physical reads before→after | Writes | Returned bytes change | SQL text change | Binding change |
|---|---:|---:|---:|---:|---:|---:|
| Post (both sizes) |114→113|1222→337|44unchanged|−7B|−62B|0|
| Edit (both sizes) |109→108|1242→357|37unchanged|−7B|−60B|0|
| Presence (both sizes) |40→40|265→265|0|0|0|0|

Total consumed SQL transfer (statement text+bindings+returned JSON bytes) declines69B per post and67B per edit. Physical reads fall72.4% and71.3%, respectively. No extra query or payload transfer is hidden behind the reduction. Carrier writes remain130/131B; max returned projection remains130/131B. Native first-use/cold overhead and exact post/edit retries at both sizes remain qualified by the existing benchmark, not treated as warm samples. Local timing is not CPU or production latency; no latency distribution improvement is claimed from these single samples.

Node causal run: two new no-catalog assertions fail on the original source; two compatibility/error controls pass. After:47/47 new+original normalized/legacy assistant tests pass, including original permissions, revoked access, public/private visibility, transactional save fault and retry. The new controls exercise missing optional tables, immediate create/drop/recreate, freshly observed malformed config, wrong-column schemas, real run-input invalidation and unrelated/misleading errors.

Native causal run uses the exact original runtime and same final fixture, and fails the post cost guard with1222physical reads. Candidate actual Native passes1/1. The test directly observes the real Native missing-table strings, then checks absence→create→drop→recreate, wrong-schema rejection and held wrapper rejection for both tables. This deliberately destructive schema control runs in a separate disposable object; its DDL cost is not part of serving measurements, and deliberately failing SQL probes are not presented as complete cost accounting. No production guards are disabled. The normal serving objects still exercise all existing schema and canonical proof admission.

No full import/restore suite was rerun for this helper: there is no persistent presence cache to invalidate, but this does not relabel older package evidence as a new restore qualification. Root will run its composed package/Native release controls. Unchanged active-assistant run lookup/invalidation queries can still depend on the number of relevant runs/inputs; no broad assistant query rewrite is claimed. Current100member/500work/256KiB/128KiB admission limits and cold constructor costs remain explicit.

Commands:

```sh
node --test tests/assistant-optional-table-query.test.mjs tests/normalized-room-assistant.test.mjs tests/room-assistant.test.js
node --test cloudflare/normalization-compact-scale.check.mjs
node node_modules/eslint/bin/eslint.js server/room-assistant.mjs tests/assistant-optional-table-query.test.mjs cloudflare/normalization-scale.test-fixture.mjs cloudflare/normalization-compact-scale.check.mjs
node scripts/secret-scan-diff.mjs --base 2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e
```

Lint has zero errors and seven inherited raw-members warnings. Secret diff clean. Exact raw groups, source hash and compressed before/after logs with uncompressed SHA256 are in audit/evidence/assistant-catalog-probes-20261102/receipt.json. No push/deployment performed.
