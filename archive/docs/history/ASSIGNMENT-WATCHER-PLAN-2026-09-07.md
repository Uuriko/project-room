# Assignment watcher: implementation plan

## Value and scope

Help an operator or their agent notice assignments and review requests without
continually reconstructing the room. Opt-in, foreground, read-only. No runtime,
background service, execution, message sending, human read acknowledgement,
reminder change, hosted inference or additional UI. Reuse `nextWorkStep` and the
authenticated client. This is a retention hypothesis, not measured retention lift.

## Interface

Extend the existing inbox namespace:

```text
node scripts/agent-inbox.mjs watch start PRIVATE_DIRECTORY [--once]
node scripts/agent-inbox.mjs watch status PRIVATE_DIRECTORY
node scripts/agent-inbox.mjs watch stop PRIVATE_DIRECTORY
```

Start uses existing ROOM_AGENT_ORIGIN/ROOM/TOKEN environment variables. Credentials
remain in memory; no token in arguments, state, output or errors. Start remains in
the foreground; Ctrl-C or a stop request interrupts waiting and network reads.
`--once` reconciles and writes at most 20 current pending notifications, then stops;
later checks drain any remainder.
Status/stop use only local state and never contact Room. Stop means requested until
the holder acknowledges; a saved running flag is not evidence of a live process.
Document direct Node or silent npm invocation to keep stdout machine readable.

Stdout contains one versioned notification JSON object per line. Status/error
transitions go to stderr as bounded JSON; ordinary polls are silent. Titles and
IDs are data, never shell commands or authorization. A notice says attention is
needed, with work/revision/receipt identifiers and a reason (`initial` or `changed`).
There is no automatic reply, acceptance, claim, execution or approval.

## Reconciliation contract

Use complete authenticated snapshots, not historical event replay. This deliberately
simplifies the initial watcher: its independent checkpoint means **current state
evaluated through sequence N**, not every intermediate event delivered. A task
created and resolved entirely between polls can remain quiet. Never use or update
the human read cursor. Initial catch-up baselines current state and labels existing
work honestly. No historical notification flood.

Each poll verifies origin, room, member/account/auth epoch and immutable room-created
event identity. Pin the last processed event ID as well as sequence; check that
anchor against current history before accepting a newer snapshot. Stop on identity,
history or schema mismatch rather than silently resetting. Token rotation may resume
only after explicit restart proves the same identity/history. Revocation stops.

Select only `nextWorkStep(item, now).needsAttention` for the authenticated member.
Reevaluate periodically even at an unchanged sequence: write claims can expire with
no event. Exclude running, resolved, superseded and other people's work. A compact
semantic identity includes action/recipient/current receipt/blocker/decision and
claim lifecycle when applicable, not raw revision alone. Historical reviews and
chat activity must not repeat unchanged requests. Disappearance clears deduplication
so a later observed return can notify again. Unobserved transitions are not promised.

Snapshot validation, semantic deduplication, pending outbox insertion/cancellation
and checkpoint advancement commit atomically. Before emitting, obtain another fresh
authenticated snapshot and reconcile; drop obsolete pending notices. Output is only
as current as its recorded snapshot, not a guarantee against subsequent races.
Recheck at bounded output batches, with a cap per tick to avoid stale large drains.

## Local durability and ownership

Use built-in Node SQLite with a distinct watcher application ID/schema v1, not the
Room database or a Room schema migration. Dedicated owner-only local directory,
regular private files, no symlinks/hardlinks; fail closed on alien/corrupt schema.
Reject permissive directories rather than silently changing their permissions.
No shared, network or cloud-synchronised directory; do not copy/delete state while
running. Files contain private selected task metadata; they are not encrypted.

One small ownership SQLite file holds a lifetime BEGIN IMMEDIATE transaction. OS
locks survive pause and release after process death. A second short-transaction
database stores identity/checkpoint, semantic attention records, pending output,
run ID and stop request. Never delete/recreate a lock based on an old PID or lease.
Status probes ownership but does not steal it or claim a paused holder is healthy.

Generate a stable notification ID before committing pending output. Await the
stdout callback before removing its pending row. A crash after printing but before
that commit can replay the same ID. A successful callback is **written to stdout**,
not read or durably received by another agent. Consumers deduplicate IDs. No
exactly-once, guaranteed external delivery or human attention claim. Keep compact
last-observed identities, not an unbounded delivered-payload history.

Bound current attention/output rows and individual payload size; fail without
advancing on capacity overflow, never discard pending work merely to make room.
Use short transactions, FULL synchronous durability, explicit busy timeouts and
bounded maximum SQLite pages. No new dependency. Stop preserves pending output.

## Retry and failure behavior

Default polling 10 seconds. Retry transient transport, 408/429/5xx with capped
exponential backoff and a finite consecutive-failure budget; honor Retry-After or
stop if its requested delay exceeds the supported wait ceiling. Stop promptly on
401/403, invalid configuration/history, local storage failure or broken output.
Add optional read cancellation and parsed Retry-After to the shared client without
changing write semantics. Suppress late state/output after stop. Never print raw
response errors that might include private content or credentials.

## Verification and release

Tests: current catch-up/deduplication; assignment/review handoff; claim expiry without
events; stale evidence review; resolved queued output; history reset/gaps; identity
and auth epoch change; same-member key rotation; only authenticated GET calls and
unchanged Room events/read cursor; crash before/after checkpoint/output; rollback;
two processes/paused owner/killed owner; stop during network/wait/output; broken
pipe; schema/permissions/symlink rejection; bounded state; quiet structured CLI.
Use disposable local rooms only. Preserve non-sensitive terminal evidence; do not
invent human user testing. No browser UI changes means no new screenshot claim.
Run core regressions and review packaging/docs. Commit locally with a checkpoint;
do not push/deploy. Live remains v7; prior local reminders still require v8.

## Evidence informing the design

Research date: 2026-09-07. These are design inferences, not copied source code.

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html) and
  [locking](https://www.sqlite.org/lockingv3.html): use an immediate transaction on
  a separate ownership database rather than a stale-PID lease for a non-fenceable
  stdout sink. Validate the two-process behavior locally.
- [Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): built-in
  synchronous database and explicit timeout; keep durable operations small.
- [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html):
  persist intended output and checkpoint together; expect duplicate output and
  require consumer deduplication, without importing a broker.
- [Node writable streams](https://nodejs.org/docs/latest-v24.x/api/stream.html#writablewritechunk-encoding-callback):
  wait for stream callbacks; do not equate them with downstream receipt.
- [GitHub CLI watch](https://cli.github.com/manual/gh_run_watch) separates observing
  a run from running it; borrow the explicit foreground observer boundary.
- [Watchexec manual](https://github.com/watchexec/watchexec/blob/main/doc/watchexec.1.md)
  describes events-only JSON output; borrow separation from execution, not its
  default command-launching behavior.
