# Mutation unit M4 — server/channel-journal.mjs

tests: tests/channel-journal.test.js, tests/channel-journal-parity.test.js
baseline: GREEN
result: 3 killed / 0 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M4a | off-by-one | KILLED | poison updates park one attempt late (attempts+1 > max instead of >=) | ✖ an update that cannot be imported records its error and attempt count, parks after the bound, and never blocks its neighbours (3441.332236ms) / ✖ failing test |
| M4b | flipped-conditional | KILLED | verify() integrity check inverted: throws on valid journal | ✖ journaled webhook updates survive a store reopen, and the drained page marks exactly what it consumed imported (6228.472662ms) / ✖ a redelivered update id is  |
| M4c | off-by-one | KILLED | backlog of exactly `backlog` rows refused (409 one early) | ✖ a redelivered update id is a no-op in every status, and the backlog and payload bounds refuse a delivery unchanged (3996.767771ms) / ✖ failing tests: / ✖ a re |

tree restored clean