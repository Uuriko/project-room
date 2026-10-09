# Suspected bugs — server/messages-store.mjs

Flagged, not fixed. All in `server/messages-store.mjs`.

- `:certifyMessagesParity` — `sequences` maps only `message.posted` events, but `row.seq` for an *edited* row keeps the earliest sequence (per the upsert's `MIN`); if the earliest write for a message id came from a non-posted row type, `sequences.get(message.id)` is undefined and parity fails on a correct row. (Probably unreachable in practice — every message has a posted event — but the invariant isn't enforced.)
- `:fillRoom` — `pruneMessages` runs inside the chunk transaction only when `last.sequence === sequence`; on a budget-exceeded stop mid-room, stale rows for deleted messages linger until the next pass completes the room.
- `:syncMessageRows` — `messages.find` is O(n) per affected id; with many affected ids on a large room this is quadratic. The byId map is only built when a touched message is a reply. Minor perf note, not correctness.

Checked and clear: cursor/log consistency checks, torn-snapshot fallback, DM visibility rule, stored-body redaction parity, upsert idempotency (double-call leaves one row), read-only store refusal.
