# Mutation unit M5 — server/channel-live-status.mjs

tests: tests/channel-live-status.test.js
baseline: GREEN
result: 0 killed / 3 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M5a | off-by-one | SURVIVED | received() rejects count=0 although 0 is a valid non-negative count | tests passed with mutant applied |
| M5b | off-by-one | SURVIVED | send outcome truncated to 31 chars instead of 32 | tests passed with mutant applied |
| M5c | wrong-operator | SURVIVED | undefined connectionId no longer coerced to '' (only null is) | tests passed with mutant applied |

tree restored clean