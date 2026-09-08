# Native text results: one work record, exact review

September 8, 2026 · local implementation plan · goal active

Previous turn made verified progress: focused discussion reads and an actual
clarification-driven agent contribution. Next remove the need for placeholder
external evidence URLs when the actual result is already a draft in the room.

## Product and data decision

Use existing immutable, explicitly work-linked messages as text storage. A draft
is not completion: an accountable member deliberately promotes one exact message
through a native-text variant of `work.completed`. Keep ordinary external-evidence
completion unchanged. One logical result per work; each completion event is a new
immutable version. This is a first native text artifact, not an attachment store,
general document editor or multiple-artifact registry.

Native input names exact message ID/post event, expected SHA256 and previous
completion event (null for first), plus existing work revision, summary, next handoff
and nullable reported producer. The service checks reference, same-work association,
exact stored UTF-8 body and digest inside the completion transaction. No trimming,
Unicode/newline normalization or outside fetch. Reject malformed Unicode. The
existing bounded4096-character message body remains the text size limit.

Reuse receipt/history and exact completion-event+evidence-version review gates.
Current completion archives prior receipt/review/decision. Revising remains explicit
rework/resolution followed by a new draft and promotion; identical text in a later
completion cannot inherit approval. Previous completion reference prevents an
unintentional lineage change; exact retry lookup precedes fresh state checks.

Keep three identities distinct: message poster, completion reporter, and reported
or unknown producer. Derive original proposal metadata from the stored message,
retaining manual-unverified attribution. Neither promotion nor a matching hash
verifies outside authorship. No role or external execution permission is added.

## Human and agent flow

Human: existing draft → Save as result → exact text preview and producer choice →
submit. The work card opens the stored text with a short result label; hashes,
lineage and origin sit in Details. Reviewer and owner dialogs pin that exact text.
Keep external-link completion available without fabricating URLs for native text.

Agent: existing post-draft → selected discussion/readback → explicit
`room_submit_text_result` → `room_read_result` for an exact current or historical
completion → existing verification. Thin shared client/MCP; no automatic acceptance,
work launch, external tool use, human approval, read acknowledgement or runtime wake.

Before extending the human form, fix its generic action recovery: immutable unknown
input, exact receipt matching, retained retry after close/reopen, session ownership
and explicit stale-context recovery. Never silently rebase a review or approval.

## Version and recovery boundary

Persisted semantics change, so move writer/schema9→10 despite no new SQL table.
Retain Node v9 function guards; explicitly accept source9 migration; replace verified
Workers v9 trigger/permit definitions transactionally. Preserve genuine v8 paths.
Qualify populated v9→10 migration, rollback and cached/reopened v9 writer refusal.
Update package version acceptance without rewriting frozen historical packages.

Recovery audits must verify native refs/digests/lineage against retained message
and completion events. Never trust only a matching current projection. No conversion
of old external receipts or ordinary drafts. A future release needs a distinct
v10-aware fallback and hosted recovery/current-authority checks; no downgrade.

## Research and acceptance

Paperclip's [documents](https://docs.paperclip.ing/reference/api/issues/#documents)
use revisions and stale-base refusal. GitHub can [dismiss stale reviews](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-pull-request-reviews-before-merging)
when configured; that is not a universal default. A2A describes
[client-owned artifact lineage](https://a2a-protocol.org/latest/topics/life-of-a-task/#tracking-artifact-mutation),
not an implemented lineage store for us. These patterns inform the contract; no
source code is copied and interoperability is not claimed.

Tests: exact Unicode/whitespace bytes, empty/oversized/malformed input, wrong work/
post/digest/parent, parallel stale revision, old exact retry after new versions,
historical review, identical-body versions, producer unknown/self-review, inactive
historical poster, no URL fetching and no read-marker changes. Reopen and backup/
recovery must preserve full current/historical text and its provenance.

Exercise actual producer and reviewer via MCP, including a revision after a finding
and exact-version readback; preserve human decision pending. Root independently
checks bytes/hash/events. Browser scenarios cover draft adoption, pinned review,
unknown save/close/reopen, malformed receipts, stale state and session change;
desktop/mobile/keyboard/200% text screenshots. Full core/browser/Workers/assets/
bundle/exact-package gates before checkpoint. Root sole editor, reviewers read-only.

No deployment, live migration, provider/account changes, new automation, payment,
paid compute, outreach or personal inbox access. Goal remains active beyond this
slice: standing charters, eligible work, durable attention and isolated attempts
remain next, alongside native-host tests and release qualification.
