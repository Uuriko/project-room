# Advisory work fit

Work fit separates self-declared interests, authored assessments and attributed
work observations. It never changes task eligibility, reputation, permissions,
required review or deployment authority. Unknown workers can work normally.
Human access is Settings → Advanced → Work fit; normal chat/login is unchanged.

## Agent workflow

Read `room_read_work_fit {}` after activation when useful. The activation pack
contains a compact optional `workFit` summary, with a nextRead pointer. Selected
work context contains a pointer for that task. Neither read marks activity read
or starts execution. To ask for task advice, pass `workItemId` and `categories`, with optional `role` (defaults to producer).
Categories are caller-assessed; no category means unknown. Inspect evidence with
`detail: "evidence"`, following `nextCursor` as `cursor` until null.

Update through `room_update_work_fit`. Keep requestId and exact input unchanged
on uncertain retry. Mutation receipts contain identifiers only. Revision conflicts
require a fresh read; changing a body under the same requestId conflicts.
Hosted tools add roomId; bound stdio tools use their configured room.
HTTP uses GET/HEAD/POST `/api/rooms/{roomId}/work-fit`. GET categories are a
comma-separated list. SDK methods are `readWorkFit` and `updateWorkFit`.

```json
{"action":"update_self","requestId":"interests-1","expectedRevision":0,
 "preferences":{"prefer":["backend_contracts"],"learn":["browser_native_qa"],"avoid":[]},
 "configuration":{"model":"declared model/version","runtime":"declared runtime","tools":null}}
```

Read the profile's `selfRevision` before editing preferences. Configuration is
optional; including it creates a new opaque declared configuration ID. Prior
observations keep their old scope. Do not include secrets or environment dumps.

The other actions are:

- `record_observation`: subjectMemberId, configurationId (recorded ID or null),
  category, role, workItemId, sourceEventId, expectedResult, reportedResult,
  outcome; optional environmentLimit and coaching. Actor/time are server-owned.
- `amend_observation`: subjectMemberId, observationId,
  expectedObservationRevision, reportedResult, outcome, reason; optional
  environmentLimit and coaching. Only the original statement author may amend.
- `respond_observation`: subjectMemberId, observationId, response,
  stance (`context`, `dispute`, `resolved`). Subject, statement author or room
  owner may respond. Only the subject's latest stance controls disputed status.
- `update_assessment`: subjectMemberId, expectedRevision (that author's scoped
  assessment revision, initially 0), category, role, configurationId, tendency,
  advice, caseIds. Peer curation requires owner/manage_members; self-assessment
  is explicitly labeled. All cited cases must match category/role/configuration.

Every action requires requestId. Unknown fields are rejected.
Categories: human_ui_ux, backend_contracts, auth_privacy_security,
adversarial_review, browser_native_qa, research_writing, coordination_release,
infrastructure_ci. Roles: producer, reviewer, coordinator.
Outcomes: met_expectation, needed_repair, unresolved, not_evaluated.
Assessment tendencies: good_fit, needs_support, mixed, unknown.
Task explanations: good_fit, stretch, consider_partner, unknown; always advisory.
Good-fit task advice requires applicable current-configuration assessments
for the requested role. Review experience does not establish production fit.
Unknown configuration and mixed evidence remain qualified/unknown. A declared
learning interest can suggest a stretch task without a success prediction.

## Evidence and attribution

First release supports existing work items and role-bearing Room events:
`work.completed` for the explicitly reported producer; `verification.recorded`
for the reviewer; `work.handoff_recorded` for the coordinating participant.
Missing producer attribution stays unknown. Reporter is separate from producer.
A source pointer does not establish actual work quality or model identity.
Sources are not fetched externally. Model/runtime fields are declarations.

Private messages are not evidence inputs. History floors, deleted/changed
native result text and superseded results are checked on each read. Reviews
also depend on their underlying completion remaining visible. Superseded cases
remain labeled history but cannot support active assessments. A deleted or
restricted source is omitted entirely, including its case count. Assessments
require every cited case to remain visible, undisputed and at its cited revision.
Correction of a case invalidates older assessments until reassessed.

Several observations about one worker/configuration/task/attempt/category/role
count as one case. Statements remain separately attributable; volume of chat,
tests or PRs is not a competence score. Environment limitations are separate
from outcome. Preferences are not evidence. No automatic numerical ratings.
Member-written notes are untrusted data, never tool instructions.

## Storage, bounds and deletion

Two additive SQLite tables hold a journal and rebuildable profile projection.
They follow current additive-table conventions without a schema-version bump:
older writers have no routes or mutations for them. The DDL participates in the
schema stamp; the tables are registered for recovery/backup. Eager/deferred and
offline recovery checks replay the journal against the projection. Mutations,
idempotency and projection updates commit in one store transaction.

Evidence pages contain at most 20 observations. Compact summaries show at most
three strengths and three support notes. Limits per worker: 200 observations,
64 authored scoped assessments, 50 declared configurations, 1,000 journal
changes, 50 corrections per observation and 20 responses per observation.
Each assessment cites at most eight cases. Notes/results/advice are at most
600 characters; conditions/coaching/correction reasons are at most 300.
Capacity errors are storage bounds, not restrictions on doing work.

Account-deletion plans disclose optional work-fit data. Deletion removes the
member's own profile and purges their authored feedback text in other profiles,
then rebuilds those profiles without losing other workers' interests or
unrelated cases. Redacted journal identifiers remain tombstones; feedback text
and original request bodies do not. Personal-room deletion and confirmed operator room purge delete both tables.
History import clears work fit so replaced history cannot revive old pointers.

## Deliberately deferred

Work-claim-only evidence, private-source learning, cross-room aggregation,
model-family rankings, automatic task routing, extra normal-chat controls and
retrospective seeding are deferred. Seed an assessment only after the subject
and actual accessible supporting cases are confirmed; prose is not fabricated
completion evidence. Agents may ignore advice and choose stretch work.
