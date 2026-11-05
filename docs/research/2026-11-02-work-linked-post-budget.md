# Bounded OAuth work-linked posts

Source: main `0448ab55d`; runtime `5efaf85e0`, Native qualification `2b2d6a244` plus the final test-only input-byte counters in this checkpoint. This is a local synthetic qualification, with no production writes.

A five-member normalized room with an existing agent explicitly adopted by a human reproduces a legitimate `current_room_context_unavailable` 409 **after authentication**, at the protected thread-participant read in `prepareCurrentWrite`. Repeated OAuth authority checks plus metadata and selected work exceed the old 200-record reservation. The synthetic fixture's plain post also exceeds that reservation; the observed production plain post succeeded, so this is not an assertion that the two room states are identical. Direct small room-key work posts already passed. A separate managed-OAuth exploratory fixture also found budget exhaustion caught as unauthenticated; the adopted fixture is the retained causal proof.

The change gives `MESSAGE_POSTED` a fixed 512-record command reservation. Existing mention posts retain 1024; other commands, global default reads, history limits, the 256 KiB aggregate input limit and 128 KiB per-record limit are unchanged. No caching, permission, reducer, proof, schema, or storage changes. This fixes capacity admission, not SQL efficiency.

Actual hosted HTTP tests exercise explicit account adoption, plain and 1648-byte work-linked posts, actor/work binding, cold exact retry, revocation, a fault after current-head insertion with complete rollback, successful retry, and an oversized **legal** three-message reply ancestry that still fails before saving. Whole-room hydration is forbidden in the fixture. The body survives cold read and full recovery audit. The old source fails both new tests; the second failure is that its budget prevents reaching the intended save-fault boundary. Final new tests pass 2/2, with 16/16 affected tests passing. Lint: zero errors, 30 existing Store warnings. Secret scan clean.

Actual Native SQLite uses the same valid adopted authority and shared command implementation. Baseline fails with 409; fixed passes 1/1, including process restart, exact receipt retry, body read, full audit and closed permit. The carrier remains 130 bytes.

| Operation | SQL statements | Physical reads | Adapter writes | Separate raw permit writes | Returned SQL string bytes | SQL text bytes | Bound bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain post | 210 | 569 | 42 | 2 | 88,361 | 24,151 | 7,731 |
| 1648-byte work-linked post | 223 | 582 | 42 | 2 | 93,732 | 25,581 | 13,090 |
| Cold exact retry | 143 | 2,097 | 0 | 2 | 88,269 | 13,516 | 5,907 |

All Native statement counters are known. Physical counters come from the existing DurableDatabase observer; raw permit writes are counted separately. Returned string bytes exclude numeric/binary cells; input counters cover adapter statements and bindings and exclude raw native permit SQL. These are not physical storage-byte measurements. One final run observed Worker wall times 5/3/6 ms respectively; cold host time was 435 ms including startup. These local, clock-dependent samples are not production latency or CPU claims.

The explicit full-audit/read route cost is separate (702 SQL, 40,010 physical reads), and remains unbounded. No 50k scale rerun is claimed: prior normalized-serving evidence covers unchanged entity/transition writer behavior, while this case qualifies the missing OAuth dependency reservation. Very large authority, metadata or ancestry can still refuse at existing bounded limits.

Commands:

```sh
node --test tests/current-work-linked-post.test.mjs tests/mcp-post-compact.test.mjs tests/current-work-review.test.mjs tests/current-private-context-composition.test.mjs tests/current-private-writer-fence.test.mjs
node --test cloudflare/work-linked-post-native.check.mjs
node scripts/secret-scan-diff.mjs --base 0448ab55d
```

Evidence: [receipt](../../audit/evidence/work-linked-post-budget-20261102/receipt.json), with compressed source-bound before/after logs. New Native check is directly runnable; no broad package/manifest regeneration or deployment was performed in this lane.
