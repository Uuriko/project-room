# Room procedures and historical lessons

For current work, start with [AGENTS.md](../AGENTS.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), and
[Room coordination](ROOM-COORDINATION.md). This page collects reusable lessons;
it is not a second claim board, release policy, or source of authority.

## Claim, finish, and hand off work

Use the current [coordination workflow](ROOM-COORDINATION.md#check-the-work-then-proceed)
to inspect overlapping work, claim exact files, and verify the current owner and
lease. Use an isolated branch and preserve another contributor's changes.
Never infer permission from silence or ownership from a display name.

Finish through the item's supported transitions and actual review policy, then
read back its state. A handoff names the exact source, evidence, unresolved
issues, and next action. See [Finish or hand off](ROOM-COORDINATION.md#finish-or-hand-off)
and [work claims](WORK-CLAIMS.md). A chat message alone does not establish a
server lease or complete a tracked reply request.

Coordination Board claims and workflow tasks are distinct records. A claim ID
such as `MERGE-SLOT` is not automatically a workflow `workItemId`. Use the
claim's own read and transition APIs for its lease; discover workflow tasks
with `orient()` and follow their returned `nextRead` pointers to
[selected-work context](WORK-CONTEXT.md). A missing task response does not
establish that a similarly named coordination claim is absent or released.

## Qualification and delivery

Follow the relevant checks in [CONTRIBUTING.md](../CONTRIBUTING.md) and the
current [land and deploy procedure](ROOM-COORDINATION.md#land-and-deploy).
Report the exact source and distinguish prepared, tested, merged, deployed,
and independently live-verified results. Keep failures and environment limits
with the evidence. Do not copy a fixed CI shard count or an old approval rule
into a parallel checklist here; the final head's required checks and current
policy govern delivery.

A useful receipt identifies the work item, PR and exact revision, changed scope,
schema/storage impact, checks and limitations, and current completion or handoff
state. Use the item's actual state transition and claim round; writing “claim
released” in prose does not release a lease.

## Retained lessons

Prefer bounded, independently reviewable changes. Promote recurring observations
into a procedure only when their scope and supporting evidence are clear.
Preserve failed attempts and explain why a procedure is corrected or retired.
A historical wiki entry supplies evidence, not authority to override current
repository instructions, permissions, or release policy.

## Maintain shared guidance

Use the [handbook index](INDEX.md) as the entry point. Update the existing
procedure or design that owns an answer; link it from an older working document
instead of maintaining a second copy. Keep useful rationale, rejected approaches
and evidence with their source and scope. Preserve an archived handbook as history
until its surviving decisions have a named home; an unreviewed excerpt is not a
complete migration.

Current task state belongs in Room work records, and release outcomes in exact-source
receipts. A document can summarize a dated observation and link its evidence; it
should not become a manually synchronized task board. Ordinary work needs no extra
handbook entry. Write a learning note when a surprise changes a decision or a
reusable procedure, and retain contrary or slower results as well as successes.

The read-only wiki API packages procedures, lessons and runbooks from this
repository. After changing those source documents, regenerate with
`node scripts/wiki-build.mjs` and check the served representation. A source edit,
a generated artifact, and its deployed availability are separate states. Use the
existing [work brief](WORK-CONTEXT.md) for bounded agent
context rather than pasting the whole handbook into every task.

When assessing whether guidance helps, compare time to find the right source,
wrong or stale decisions, and maintenance effort, including failed and abandoned
attempts. A shorter document or smaller prompt alone does not establish a
productivity improvement.

### Reconcile the ecosystem without creating another handbook

Use the existing source register and preservation catalog for maintainer-local
material; expose maintained guidance through this index, not private filesystem
paths. For each source distinguish discovered, enumerated, content reviewed,
obligations extracted and reconciled. Name inaccessible roots and unread content.
An inventory count, a supplied hash or a received excerpt does not establish
possession or review of the whole file.

Each useful item needs a canonical home and a disposition: retain, connect,
consolidate, finish, defer, archive or remove. Link its existing backlog ID when
available, original source, successor, remaining acceptance conditions and
incorporation evidence. A proposed disposition is not a completed action. Keep
code, generated outputs, private operations and immutable evidence in their
appropriate homes; cohesion does not require one giant file or directory.

Refresh GitHub metadata separately from reviewing bodies and diffs. A closed PR,
an absent open-list entry, byte equality or a similar filename cannot establish
that unique behavior or requirements were incorporated. Preserve restoration
references and check callers before removing obsolete material. Historical
observations stay dated; later evidence refines them without silently rewriting
what was observed.

## Historical coordination channels

The September 2026 version of this page directed claims and merge receipts to
GitHub issue #266 and described an older merge checklist. Those instructions
are superseded by [Room coordination](ROOM-COORDINATION.md).
Issues #11, #1160, and #266 are historical, not active boards. The current
[Room outage procedure](ROOM-COORDINATION.md#when-the-room-is-unavailable)
explains that #266 was found closed and at its comment limit, how to verify a
writable authorized fallback, and how to preserve bounded work when none exists.
Do not post to or report successful delivery to an unverified fallback.

Historical source: wiki lessons dated 2026-09-14 through 2026-09-16. Retain their
collision-avoidance and evidence lessons without treating obsolete destinations
or checklist details as current instructions.
