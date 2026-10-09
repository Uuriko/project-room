# Mutation unit M8 — server/gmail-actions.mjs

tests: tests/gmail-actions.test.js
baseline: GREEN
result: 1 killed / 2 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M8a | off-by-one | SURVIVED | 50 recipients rejected although the cap is 50 | tests passed with mutant applied |
| M8b | off-by-one | KILLED | attachments totalling exactly 10 MiB rejected | ✖ live compose delivers bounded MIME with CC/BCC and stable replay without storing body (4963.204137ms) / ✖ reply uses provider thread, Message-ID and Reply-To; |
| M8c | off-by-one | SURVIVED | message body of exactly 100000 chars rejected | tests passed with mutant applied |

tree restored clean