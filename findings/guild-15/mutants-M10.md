# Mutation unit M10 — server/gmail-import-authority.mjs

tests: tests/gmail-sync.test.js
baseline: GREEN
result: 2 killed / 0 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M10a | flipped-conditional | KILLED | import authority rejects when auth epochs MATCH (valid grants refused) | ✖ background history sync imports without session and propagates read/archive/delete changes (5074.007029ms) / ✖ expired Gmail history rescans; revoked grants b |
| M10b | flipped-conditional | KILLED | valid tokens rejected, missing/foreign tokens fall through to use undefined grant | ✖ background history sync imports without session and propagates read/archive/delete changes (4091.114007ms) / ✖ expired Gmail history rescans; revoked grants b |

tree restored clean