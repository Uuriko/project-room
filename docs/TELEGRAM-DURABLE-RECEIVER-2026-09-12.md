# Durable receiver checkpoint

Implemented a separate encrypted Telegram staging queue and one bounded receive
cycle. No live account, runtime, database or provider configuration was changed.

Flow: replay pending pages into the idempotent private Inbox importer; request a
Telegram page using the durable offset; atomically persist encrypted page and next
offset; commit page into Inbox; mark delivery. Only the next request acknowledges
the prior offset. An import failure retains the page, and replay happens before
the next provider request. A crash after Inbox commit replays without duplicates.

AES-256-GCM authenticates each payload against queue scope and offsets. Queue
scope binds account, connection, auth epoch and encryption key. Writes use SQLite
FULL synchronous transactions. Capacity is intentionally bounded at 256 retained
pages, each at most 25 updates and 256 KiB; delivered pages remain retained. At
capacity the receiver stops rather than acknowledging unpersisted messages.

Five queue/tick tests pass: failed-import replay ordering, restart durability and
plaintext absence, transaction rollback, stale-offset rejection, wrong account/key,
payload corruption, capacity, and real Inbox-import replay after a simulated crash
before delivery marking. Earlier related messaging tests also passed; full suite
has not been run for this checkpoint.

Remaining before activation:

- Host must securely create the separate private queue DB and encryption key.
  Never pass the live RoomStore DB as this staging database.
- Bind one account and configured chat scope to one bot; single-owner lease is
  required across workers. Epoch changes require explicit queue disposition.
- Wire durable connection lifecycle, revoke/disconnect fences and a commit callback
  that rechecks authority inside the Inbox transaction. The tick's before/after
  checks do not replace transaction-time authorization.
- Add retention/pruning policy and capacity status before long-running use.
- Add supervised scheduling and authenticated UI status/sync/disconnect.
- Resolve corruption/recovery operator flow, old queue cleanup and key rotation.
- Independent review and runtime acceptance before enabling provider acknowledgements.

These modules are not scheduled or wired into the existing manual pilot. Manual
pilot limitations in TELEGRAM-LOCAL-PILOT-2026-09-12.md remain truthful.
