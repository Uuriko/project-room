# Mutation unit M14 — server/channel-adapters/telegram-transport.mjs

tests: tests/telegram-live.test.js, tests/telegram-token-leak.test.js
baseline: GREEN
result: 2 killed / 1 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M14a | wrong-operator | KILLED | HTTP 500 no longer retried by the telegram transport | ✖ the live transport posts sendMessage once per outbox key, honors retry_after, and maps failures to channel codes (7801.001656ms) / ✖ failing tests: / ✖ the li |
| M14b | wrong-operator | KILLED | retry delay floor becomes ceiling: always waits at least maxDelayMs | ✖ the live transport posts sendMessage once per outbox key, honors retry_after, and maps failures to channel codes (6795.928817ms) / ✖ failing tests: / ✖ the li |
| M14c | off-by-one | SURVIVED | 20-digit chat ids (valid per M-25 contract) rejected as unsafe | tests passed with mutant applied |

tree restored clean