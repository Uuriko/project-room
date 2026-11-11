# Scoped native inbox record admission

Base main `7320a9354`; runtime `0576f097b`, Native fixture/check `c59d18869`.
This local synthetic reproduction uses five room members, two current tasks
(one active assigned task), overlapping mentions, a directed formal request,
DM/replies to two own parents, and a private message belonging to other parties.
The independent production report did not establish its credential type; this
fixture proves the defect for a genuinely authorized scoped API key, not that
its exact grants or room state match production.

Actual Node and production Native HTTP GET `agent-inbox?after=42&limit=1`
succeeds on the old source; limit 5 fails 409 `current_room_context_unavailable`.
The shared logical budget reaches 201 records at 104,179 input bytes. Without
the formal request this small shape uses 198 records: a valid overlapping
obligation can cross the old 200 reservation.

The one runtime change reserves 512 record units for the complete native inbox
operation. The same request completes at 208 units/107,457 bytes. Default reads
remain 200; aggregate 256 KiB and individual record limits, four conversation
source rows, bounded discovery, privacy and global/history limits are unchanged.
No caching, permission or grant changes. This is fixed admission capacity, not
a SQL optimization or a claim that every legal room fits any bounded request.

Actual HTTP qualification: limits 1/5/30, exact conversation continuation without
duplicate DM/reply/mention delivery, independent standing work/request pointers,
private-other-party absence, cold reopen, unchanged operator audit and key
revocation. Excessive legal selected reply bodies still fail the byte limit
without advancing anything. Standing obligations intentionally repeat until
acted on; conversation completion never claims global attention completeness.
Twenty affected Node tests pass. Actual production Native HTTP: one test passes
including cold continuation and exactly expected public/private obligations;
matched original source fails at limit 5. No whole-room hydration is allowed.

Scope distinction: the qualified test key has `inbox:read`, `rooms:read`,
`rooms:write`, `heartbeats:report`, `heartbeats:read`. The separate ACP five-scope
set (`mcp:room:commons`, room read/write, heartbeat report/read) does not include
`inbox:read` and correctly remains HTTP 403. No missing scope is manufactured.

| Warm request | SQL | Physical reads | Physical writes | Returned SQL JSON bytes | SQL text bytes | Binding bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| limit 1 | 216 | 1,084 | 4 | 258,062 | 23,801 | 5,872 |
| limit 5 | 263 | 1,135 | 4 | 268,978 | 33,502 | 7,333 |
| limit 30 | 263 | 1,135 | 4 | 268,978 | 33,502 | 7,333 |

Counters wrap actual native SQL execution, including raw statements; all cursors
have known counters. Four observed writes are reported, not hidden behind a
read-only claim. Node qualification separately proves no operator audit writes.
Returned JSON includes object/column envelope overhead; it is not physical
storage size. The logical 256 KiB input bound does not imply a 256 KiB bound on
all SQL transfer: repeated admission/catalog/control input is visible above.
Worker wall samples 7/5/4 ms are clock-dependent local measurements, not CPU or
production latency. This 47-event fixture is causal coverage, not a new 1k/50k
scale claim; unchanged indexed source-window code retains its prior evidence.

Commands (Node 24):

```sh
node --test tests/current-scoped-inbox.test.mjs tests/current-native-inbox.test.mjs tests/agent-inbox.test.js tests/current-inbox-cursor-privacy.test.mjs
node --test cloudflare/scoped-inbox-native.check.mjs
node scripts/secret-scan-diff.mjs --base 7320a9354
```

Lint zero errors; secret scan clean. Native check is directly runnable, not added
to broad package/manifest scheduling in this lane. No production requests,
credential access, push, merge, deployment or other runtime edits.

Evidence: [receipt](../../audit/evidence/scoped-inbox-budget-20261102/receipt.json),
with compressed matched before/after logs. Earlier fixture-only errors (missing
HTTP inbox scope, then wrong synthetic revocation column) were corrected using
the existing scope and revokeApiKey service; runtime auth was not loosened.
