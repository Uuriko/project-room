# Journal append semantics

Every journal in `server/` is append-oriented; races are closed by keys, not locks.

## The pattern

| Journal | Dedup / race guard | Verified by |
|---|---|---|
| `channel-journal.mjs` (webhook updates) | PK `(account_id, connection_id, update_id)` + `ON CONFLICT DO NOTHING`; status transitions are conditional single-statement UPDATEs | rh09 (2 procs × 40 same ids → exactly 40 rows, no dupes), rh10 (imported-vs-failed race → every row consistent), M-07 (removing `DO NOTHING` breaks it) |
| `invitation-journal.mjs` | PK `(invitation_id, sequence)` + `no_update`/`no_delete` triggers (append-only) + sha256 hash chain per entry | rh12 (60/60 rounds: exactly one appender wins per sequence) |
| `graph-reply-journal.mjs` | pure transition functions — no shared state at all | rh20 (10k transitions: input never mutated, `structuredClone` isolation) |
| `claim-reputation.mjs` `syncClaimReputationJournal` | derived journal: `DELETE` legacy + `INSERT OR IGNORE` fold; concurrent syncs converge idempotently | rh14 (concurrent syncs converge to identical signal sets) |
| `wake-queue.mjs` receipts | `wake_queue_commands` PK `(room_id, member_id, request_id)` + fingerprint; `complete()` writes receipt in the same txn as the state change | code inspection (M-19/M-20 comments) |
| `fee-credit-ledger.mjs` | in-memory `appliedKeys` set; double-apply throws synchronously | rh16 (50k double-applies refused) |

## Rules for journal writers

1. **Idempotency key first**: every journal has a natural dedup key (provider update id, journal
   sequence, request id). The key — not a lock — is the concurrency control.
2. **Conditional transitions**: state changes (`pending→imported`, `pending→leased`) are single
   `UPDATE ... WHERE state='pending'` statements. The loser's `changes` count is 0 — check it,
   don't re-read. (M-10: removing the predicate double-leases 40/40.)
3. **Never UPDATE/DELETE history**: the triggers enforce it; `replay*` functions assume it.
4. **Derived journals rebuild**: `syncClaimReputationJournal` runs with no wrapping transaction
   (`DatabaseSync` has no `.transaction`) — each statement is its own implicit txn. A crash between
   DELETE and INSERT leaves the journal empty until the next sync; readers must tolerate that.
   This is accepted because the journal is fully derived from `events`.

## Cross-process note

`fee-credit-ledger.mjs` is **in-memory per process** — its double-apply guard does not span
processes. That is safe only because the supported topology is one server per database
(`instance-lock.mjs`). If the topology ever changes, this ledger needs a durable unique key.
