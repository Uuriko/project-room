# Mutation unit M9 — server/gmail-content.mjs

tests: tests/gmail-actions.test.js
baseline: GREEN
result: 1 killed / 2 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M9a | wrong-constant | SURVIVED | attachment cap silently drops from 10 MiB to 9 MiB | tests passed with mutant applied |
| M9b | off-by-one | SURVIVED | attachment part paths nested 20 deep rejected | tests passed with mutant applied |
| M9c | wrong-operator | KILLED | base64url padding of 2 chars rejected as invalid attachment data | ✖ formatted drafts preserve explicit attachment review and sanitize executable HTML (4824.625191ms) / ✖ failing tests: / ✖ formatted drafts preserve explicit at |

tree restored clean