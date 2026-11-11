# Normalized serving costs on current main

Runtime: exact main `2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e`. Test-only extension `747099061578550074bebae69597e97807191b3f` of the existing Native normalization-scale fixture and default compact check. No runtime edits, production load, accounts changed, deployment or push.

The existing fixture executes real RoomStore operations over the Native DurableDatabase/SQLite adapter in Miniflare. This is not the production HTTP wrapper or a production latency measurement. The default compact source contains1k/50k events and100/5000 messages respectively; most events are original edits. It is a legal compact fixture, not a claim that50k full-size message bodies fit platform memory. Earlier optional7MB stress evidence remains separate.

One actual Native test passes, zero skipped. Both histories accept useful posts and two edits, preserve selected updated body, and survive cold reopen with the exact original post/edit requests returning duplicate and original sequence. Presence reports the one real current member and explicitly does not claim execution/held-work/wake completeness. The complete suite takes6.19s local host wall; Worker performance clocks are not CPU measurements.

Warm accepted operations (same result at1k and50k history):

| Operation | SQL calls | Physical rows read | Rows written | Returned bytes1k/50k | SQL text bytes | Bound parameter bytes1k/50k | Room carrier write bytes1k/50k |
|---|---:|---:|---:|---:|---:|---:|---:|
| Post |114|1222|44|66567 /66269|13824|5158 /5172|130 /131|
| Message edit |109|1242|37|69049 /68754|13624|4953 /4967|130 /131|
| Presence read |40|265|0|66646 /66346|4106|1106 /1106|0 /0|

These returned/bound values are JSON UTF8 accounting for consumed SQL cursor rows and bound values, not physical disk writes or network packet sizes. SQL text includes repeated statement text. Unknown adapter counters are zero. Every accepted operation explicitly asserts the largest returned `projection` value is at most512bytes; observed130/131bytes. Post/edit also assert the actual carrier write was observed and is at most512bytes. No whole-room body rewrite occurs for these tested operations; source still writes one small rooms carrier plus selected canonical/proof/event/receipt rows. This is not a long-running concurrency or throughput SLA.

First50k post after cold construction costs115SQL/3697physical reads/44writes versus warm114/1222/44. The constructor itself runs before measurement and is excluded, not called free. Cold post and edit exact retries perform only the two existing native runtime-permit writes, with no repeated business mutation. Both histories' retries are explicitly tested. First-use edit and warm edit differ: the initial measurement assertion incorrectly compared those two states and failed112vs111SQL. That failed control is retained; both arms now execute the same accepted edit warmup and measure the second accepted edit. No runtime change or widened cost threshold was used to hide it.

Physical versus logical storage after the operations:

| Quantity |1k history|50k history|
|---|---:|---:|
| SQLite databaseSize scalar |3497984B|34721792B|
| Retained event JSON bytes |244300B|12507090B|
| Current message body bytes |6406B|320008B|
| Room carrier |130B|131B|

The SQLite scalar is allocated SQL database size, separate from logical payload sums; it is not a measurement of KV, filesystem/WAL, backup size or billable storage. Offline `/state` count/sum queries intentionally scan history to produce these aggregates (110013physical rows in the50k measurement); they are separate test-only calls and excluded from serving-operation counts. Retained history still consumes storage.

Remaining risks are explicit. A `SELECT1 FROM sqlite_master WHERE name='room_assistant_config'` existence check scans885catalog rows and dominates warm post reads; exact-schema admissions also transfer fixed catalog SQL. Those are catalog-size costs, not history-size scans, and are not optimized here. Presence performs a complete current roster read with512record budget and max100members; this one-owner fixture does not qualify a100member room. Current serving retains256KiB total input/128KiB individual record limits, other contexts' logical-record budgets, max500work items and1million-event admission. Long ancestry, private history tails, large profile/receipt metadata and expiry/capacity checks can still refuse or cost more. Existing explicit unavailable sections remain unavailable. Final recovery and optional aggregate/report paths still contain global work; this benchmark does not qualify or remove those scans.

`update` here means the accepted canonical `message.edited` command. The old normalized aggregate `/updates` remains explicitly replaced by Needs me; it is not relabeled a successful operation. Privacy/auth tests from the parent remain separate evidence, not rerun or claimed by this single public-owner cost fixture.

Run:

```sh
node --test cloudflare/normalization-compact-scale.check.mjs
node node_modules/eslint/bin/eslint.js cloudflare/normalization-scale.test-fixture.mjs cloudflare/normalization-compact-scale.check.mjs
node scripts/secret-scan-diff.mjs --base 2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e
```

Lint and secret diff pass. Compressed logs, raw measured groups and uncompressed SHA256 hashes: `audit/evidence/normalized-serving-cost-20261102/receipt.json`.
