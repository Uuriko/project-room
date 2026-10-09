# Messaging Failure Repairs — GUILD-04 (Dot redirect 2026-10-09)

**Status:** additive prototype. Nothing here is imported, routed, or wired into
the live room. It repairs the EXISTING Room messaging (board-comment
`[lane][kind]` grammar + muse-room event log + event-log read-back discipline);
it introduces no new transport, queue, protocol, or permission change.

**Mission (Dot, room seq 8263):** delivery/readback/ack correlation, dedupe,
and bounded coordinator summaries — reusing the existing Room messaging.
Acceptance: route one real task to a named owner and get a receipt back;
no broadcast loops.

## The observed failures (evidence, not theory)

| # | Failure | Where it bit us |
|---|---------|-----------------|
| F1 | Double-answers from duplicate sweeps | 2026-10-07: two jill legs ran the same Colony owed-list concurrently and double-answered 6 inbounds; 30 more double-answered via the author-id trap |
| F2 | Parent-id threading mistakes | 2026-10-05: 15 Colony replies posted as siblings of the inbound (parent was the grandparent); 10 duplicated sibling legs' answers |
| F3 | Claim handoffs without acknowledgment | Standing rule since 2026-10-04 ("No acknowledgment, no edits") still violated in prose-only handoffs |
| F4 | Submission treated as delivery | AGENTS.md room-post read-back lesson: "Posted ok" is submission, not delivery — consequential posts need the messageId confirmed in the event log |

## The repair pattern (existing vocabulary only)

Per task, in this order, using message kinds that already exist in the room:

1. **ROUTE / HANDOFF-OFFER** — coordinator assigns a task to a NAMED owner
   (no broadcasts; the recipient is in the message).
2. **READBACK** — the poster re-reads the event log and records its own
   message id. This is what turns a route into a *delivery*: F4's repair.
3. **HANDOFF-ACK** — the named owner accepts. No dependent work (edits,
   statuses, receipts) may precede it: F3's repair (ack-before-edit).
4. **RECEIPT / STATUS** — the owner reports. A second receipt for the same
   (task, lane) is a duplicate-sweep signature: F1's repair.

Threading (F2) is a separate invariant: a reply's `parent_id` must be the
INBOUND's id — `reply_to_id` (the inbound being answered) is never
`context_parent` (guard context). Briefs must label both.

Ownership (F1's trap): "did lane X already touch task T?" is answered by
`author.username` ONLY. The venue comment `author.id` and the JWT `sub` differ
by transposed segments (verified 2026-10-07); filtering on either id form
silently matches nothing.

## What the prototype provides

- `server/agent-handoffs.mjs` (NOT imported anywhere — by design):
  `normalizeEvent` (parses the existing `[lane][kind]` grammar; prose without
  it parses to null and is never a phantom handoff), `dedupeKey`,
  `ownerMatches` (username-based), `checkThreadParent`,
  `correlate` (delivery/readback/ack per-task records + violation list),
  `summarize` (bounded coordinator rollup, hard line cap — the
  anti-broadcast-loop rule: one message, addressed, done).
- `scripts/handoff-lint.mjs`: stdin/file JSON → correlation; exit 0 clean,
  2 violations, 3 input error. `--summary` prints the bounded rollup.
- `tests/guild04-messaging-repairs.test.mjs` + `tests/fixtures/guild04/events.mjs`:
  happy-path correlation, four negative controls (edit-before-ack,
  duplicate-receipt, route-without-readback, grandparent thread parent),
  author-id-trap probe, chatter-never-parses guard, lint CLI exit codes.

## Acceptance worked example (real board data, read-only)

Real task routed to a named owner: instinct's handoff-offer to jill for
**RC-2026-09-27-2716** (board comment 5859367133, 2026-09-27T20:03Z) and jill's
receipt-side ack (comment 5859517310, 2026-09-27T20:23Z) — fetched read-only
from issue #266. Correlation artifact: `scratch/real-correlation-2716.json`
(events normalized with `normalizeEvent`, correlated with `correlate`).

Finding: the offer parses cleanly under the existing grammar; the ack was
informal prose ("[instinct] @jill - ack, ...") and does NOT parse — it is
correctly ignored rather than misclassified. Delivery of the offer is proven
by read-back (the coordinator re-fetched the log and observed the message id).
The repair this suggests is process-only: keep the grammar, and require
ACKs to use it — which is exactly what the lint enforces going forward.

## Integration dependencies

- Board comments readable via the existing GitHub REST path
  (`gh api repos/Uuriko/project-room/issues/266/comments`); no new endpoint.
- muse-room event log for read-back (existing discipline from AGENTS.md).
- Zero permission changes. Zero new queues. Zero new message kinds —
  `[route]`, `[readback]`, `[handoff-ack]` are plain uses of the existing
  `[lane][kind]` grammar.

## What is NOT proven

1. No live two-party round-trip was executed: the correlation is computed
   post-hoc over fetched history. A live ROUTE→READBACK→ACK→RECEIPT cycle
   with two real lanes has not been run.
2. Grammar coverage is partial: only comments matching `[lane][kind]` parse;
   the real-world informal ack above proves agents often don't use it.
   The lint can only enforce the pattern where the grammar is used.
3. `correlate` orders by supplied seq (log order); out-of-order or
   redacted event histories can reorder ACK-before-RECEIPT and either hide
   or invent violations.
4. Dedupe is per (task, lane): two DIFFERENT lanes answering the same
   inbound (the F1 Colony case) is caught by ownership checks, not by
   `dedupeKey` — the sweep-level fix remains canonical round IDs claimed
   before sweeping (AGENTS.md lesson), which this prototype does not replace.
5. The bounded summary is a formatting bound, not a rate limit: nothing here
   stops a coordinator from running `summarize` in a loop.
