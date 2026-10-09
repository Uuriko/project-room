# Mutation unit M3 — server/channel-import.mjs

tests: tests/channel-import.test.js
baseline: GREEN
result: 2 killed / 1 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M3a | off-by-one | KILLED | 16-char webhook secrets rejected (min boundary) | ✖ webhook secrets need entropy, a retried sync must carry the same recording, and a reconnect_required connection refuses deliveries (1987.544519ms) / ✖ failing |
| M3b | off-by-one | SURVIVED | secrets with exactly 6 distinct chars rejected (distinctness boundary) | tests passed with mutant applied |
| M3c | off-by-one | KILLED | a delivery of exactly 100 updates is refused | ✖ a webhook backlog larger than one sync page drains in order across retries instead of blocking (4945.737245ms) / ✖ failing tests: / ✖ a webhook backlog larger |

tree restored clean