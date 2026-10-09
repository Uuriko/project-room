# Mutation unit M1 — server/channel-connection.mjs

tests: tests/channel-connection.test.js
baseline: GREEN
result: 1 killed / 2 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M1a | off-by-one | KILLED | revision 0 accepted as valid profile revision | ✖ the generic connection record validates every field and rejects extra or unknown keys (16.902936ms) / ✖ failing tests: / ✖ the generic connection record valid |
| M1b | flipped-conditional | SURVIVED | auth-epoch mismatch reports active instead of reconnect_required | tests passed with mutant applied |
| M1c | off-by-one | SURVIVED | localId max length shrinks by one char | tests passed with mutant applied |

tree restored clean