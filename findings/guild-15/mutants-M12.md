# Mutation unit M12 — server/gmail-sync.mjs

tests: tests/gmail-sync.test.js
baseline: GREEN
result: 2 killed / 1 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M12a | off-by-one | KILLED | exactly 200 ids forces a full reset instead of incremental history | ✖ background history sync imports without session and propagates read/archive/delete changes (5072.510965ms) / ✖ expired Gmail history rescans; revoked grants b |
| M12b | wrong-constant | KILLED | sync-failure backoff caps one doubling earlier | ✖ background history sync imports without session and propagates read/archive/delete changes (4038.302402ms) / ✖ expired Gmail history rescans; revoked grants b |
| M12c | off-by-one | SURVIVED | sync tick processes 9 due mailboxes per cycle instead of 10 | tests passed with mutant applied |

tree restored clean