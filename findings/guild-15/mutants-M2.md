# Mutation unit M2 — server/channel-drain.mjs

tests: tests/channel-drain.test.js
baseline: GREEN
result: 3 killed / 0 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M2a | dropped-await | KILLED | importSlice promise not awaited; imported count becomes null | ✖ a scheduled tick drains verified updates into the inbox through the real drain path (4769.008166ms) / ✖ update_id dedup holds through the scheduled drain: red |
| M2b | off-by-one | KILLED | scan collects 26 connections instead of 25 per cycle | ✖ the scheduled poison screen parks a repeatedly-failing update without an import authority (5047.411218ms) / ✖ with an import authority the drainer imports aro |
| M2c | flipped-conditional | KILLED | deferral logic inverted: drains without authority, defers with authority | ✖ a scheduled tick drains verified updates into the inbox through the real drain path (4419.473467ms) / ✖ update_id dedup holds through the scheduled drain: red |

tree restored clean