# Mutation unit M15 — server/channel-adapters/whatsapp.mjs

tests: tests/whatsapp-adapter.test.js
baseline: GREEN
result: 1 killed / 2 survived / 0 other

| id | kind | status | note | detail |
|----|------|--------|------|--------|
| M15a | off-by-one | SURVIVED | whatsapp message ids of exactly 512 chars rejected | tests passed with mutant applied |
| M15b | off-by-one | SURVIVED | 15-digit whatsapp timestamps rejected | tests passed with mutant applied |
| M15c | off-by-one | KILLED | whatsapp timestamp at exactly maxWhatsAppSeconds rejected | ✖ out-of-range WhatsApp timestamps are contract errors, never a RangeError (16.268534ms) / ✖ failing tests: / ✖ out-of-range WhatsApp timestamps are contract er |

tree restored clean