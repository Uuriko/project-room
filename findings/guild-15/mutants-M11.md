# Mutation unit M11 — server/gmail-mailbox.mjs

tests: tests/gmail-mailbox.test.js
baseline: GREEN
result: 0 killed / 3 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M11a | wrong-constant | SURVIVED | OAuth pending-state expiry drops from 10 min to 1 min | tests passed with mutant applied |
| M11b | off-by-one | SURVIVED | response body of exactly 16 MiB refused | tests passed with mutant applied |
| M11c | off-by-one | SURVIVED | 11th linked mailbox allowed although the cap is 10 | tests passed with mutant applied |

tree restored clean