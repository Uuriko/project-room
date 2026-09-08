# Durable current attention: implementation plan

September 8, 2026. Local-only slice of the active broader goal.

## Problem and intended value

The existing foreground watcher has a durable outbox, but a successful stdout
write clears pending output. An agent pulling intermittently cannot explicitly
acknowledge a notice after recording it. It also misses changed room instructions
while work is in progress. Extend these proven components, keeping the ordinary
room unchanged and all participation notify-only until separately authorized.

This is a current-condition inbox, not an archive of every intervening event.
Historical causes, explicit message requests and synchronized cross-device seen
state remain separate next slices; do not label this implementation as those.

## Evidence and design choice

Primary documentation reviewed September 8, 2026:

- [Paperclip attention](https://docs.paperclip.ing/reference/api/attention/) separates
  a current attention projection from underlying work and personal dismissal.
- [Paperclip wake requests](https://docs.paperclip.ing/reference/api/agents/#wake-an-agent)
  carry cause/idempotency information and may be coalesced, deferred or skipped.
- [MCP 2025-11-25 tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
  make status notifications optional; the newer [extension draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks)
  has different explicit subscription semantics. Neither contract is adopted here:
  attention is not asynchronous task execution or a claimed host notification.

Inference, not independent product verification: separate subject, meaningful
condition and notice identities. Reconcile obsolete conditions before delivery;
acknowledging one notice must never clear a replacement. Do not infer an obligation
from free-form prose or pretend a write to stdout proves downstream receipt.

## Contract and implementation

1. Keep legacy assignment watch/start/status/stop and its v1 directory untouched.
   Reuse the SQLite ownership lock and short transaction journal. New opt-in pull
   state is local journal v2, in a dedicated owner-private directory. Old readers
   refuse it; the new pull mode refuses a v1 directory without resetting/migrating
   pending output. Room schema/writer 11 and public assets do not change.
2. Add typed current work-step and room-instructions notices. Existing semantic
   work signatures avoid noise from unrelated revisions. Instructions identify the
   exact current revision/event, including clear, with no charter prose persisted.
   Work-in-progress can therefore receive a charter notice without inventing an
   actionable work transition. Omit confirmed never-set instructions.
3. Preserve snapshot authentication, room incarnation and history anchors; require
   valid consistent charter metadata for the new mode. Persist processing position,
   current conditions and pending IDs atomically. Use bounded batches and refuse
   overflow without advancing the checkpoint. Never store keys or full discussion.
4. A pull reconciles current conditions and returns up to 20 pending notices with
   allowlisted read pointers. It does not acknowledge them. Exact acknowledgement
   authenticates/reconciles first and reports acknowledged, already acknowledged
   or no longer current. No stale acknowledgement can dismiss a newer notice.
5. Add CLI pull/ack and optional MCP read/ack tools enabled only by an operator-set
   private directory. The model cannot choose a filesystem path. Disabled adapters
   retain their existing tool list. Reads/acknowledgements mutate only private local
   observer state, never human read markers, work, permissions or approval.
6. Keep output-written, local acknowledgement, accepted work and completed work
   explicitly different. Local acknowledgement is not proof of human attention,
   agent understanding, server-side delivery, execution or approval. No timer or
   new recurring job is created by setting up or pulling the inbox.

## Verification

Test immutable IDs across restart/lost output, explicit ack retry, stale ack after
replacement, quiet unrelated revisions, charter update/clear while working,
malformed/contradictory metadata, history/identity mismatch, revocation, cancellation,
ownership contention, capacity rollback, private paths and genuine old-reader
refusal. Existing v1 journal/CLI tests must pass unchanged. Exercise actual CLI/MCP
over a disposable service with read-only service effects, plus a real agent that
discovers changed instructions itself and follows the returned read pointer.
Run core, browser and local Workers gates and exact-package verification. Inspect
representative desktop/mobile/large-text screens for preservation; no new GUI is
claimed. Document current-state sampling and local-device durability honestly.

## Now / next / later

Now: implement and verify this pull/ack path end to end, without shipping a second
watcher or altering the room UI. Next: retained targeted discussion/request causes
with anchored resume and explicit relevance/clearing rules, then eligible work.
Later: opt-in standing roles, real host acceptance, scoped tool/compute attempts
and separately qualified v11-compatible fallback/hosted recovery. Keep the goal
active and preserve useful free/manual/BYO participation.
