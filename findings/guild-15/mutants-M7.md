# Mutation unit M7 — server/demigod-policy-adapter.mjs

tests: tests/demigod-jobs-money.test.js
baseline: GREEN
result: 2 killed / 0 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M7a | wrong-operator | KILLED | placement fee computed at 100% instead of 10% (divisor 1000 vs 10000) | ✖ placement fee is exactly 1000 bps: table of known values (27.378186ms) / ✖ failing tests: / ✖ placement fee is exactly 1000 bps: table of known values (27.378 |
| M7b | wrong-operator | KILLED | net-to-talent adds the fee instead of subtracting it | ✖ placement fee is exactly 1000 bps: table of known values (14.390416ms) / ✖ failing tests: / ✖ placement fee is exactly 1000 bps: table of known values (14.390 |

tree restored clean