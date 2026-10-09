# Mutation unit M13 — server/session-adapter.mjs

tests: tests/session-adapter-contract.test.js
baseline: GREEN
result: 0 killed / 3 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M13a | off-by-one | SURVIVED | resume command with exactly 64 args rejected | tests passed with mutant applied |
| M13b | off-by-one | SURVIVED | resume command of exactly 8 KiB rejected | tests passed with mutant applied |
| M13c | off-by-one | SURVIVED | pane read with lines=0 falls back to 200 instead of honoring 0 | tests passed with mutant applied |

tree restored clean