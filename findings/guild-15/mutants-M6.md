# Mutation unit M6 — server/channel-send-budgets.mjs

tests: tests/channel-send-budgets.test.js
baseline: GREEN
result: 0 killed / 3 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M6a | wrong-operator | SURVIVED | env budget of 0 accepted instead of falling back to default | tests passed with mutant applied |
| M6b | wrong-operator | SURVIVED | burst floor drops from 1 to 0, allowing a zero-token bucket | tests passed with mutant applied |
| M6c | wrong-operator | SURVIVED | Retry-After header may be 0 instead of minimum 1 | tests passed with mutant applied |

tree restored clean