# Deliberate result copy: implementation plan

## Problem and decision

A useful outcome currently stays inside a work card or requires manually finding
and selecting its text. Make one reported result easy to prepare for another
person or agent without exporting its room. This is a value-bearing sharing
primitive, not a public-feed or automated-growth system.

Build **Evidence & details → Copy summary → editable preview → Copy**. Keep the
existing quiet work surface; no dashboard, top-level navigation or new share
format chooser. Root is sole source editor; three reviewers own read-only product
research, evidence-contract review and failure-test design.

## Research and limits

Primary documentation inspected 2026-09-07 (local date):

- [Linear updates](https://linear.app/docs/initiative-and-project-updates) distinguish
  a link from Markdown copy and allow progress details to be hidden before posting.
  Borrow content-first copying and deliberate detail selection.
- [Notion export](https://www.notion.com/help/export-your-content) explicitly selects
  subpages/content; HTML can include comments and their mentions. Borrow a narrow
  allowlist rather than serializing the entire work object.
- [Basecamp public links](https://5.basecamp-help.com/article/1098-public-links)
  expose one item with optional comments and warn that recipients can save or
  reshare. Do not treat copied text as revocable or as granting source access.

These observations inform the design; they do not establish user demand, retention
or a measured conversion improvement. No source code is copied. No public or
signed evidence links are followed. No product-account changes are made.

## Content and authority contract

1. A pure `resultDraft(work)` projects exactly own nonblank primitive strings
   `{title, summary: work.receipt.summary}`, each at most 4096 code units. No receipt
   means no draft. A separate plain-text formatter supplies a modest “Reported
   result” label. It never adds “verified,” “approved,” authorship or execution.
2. Do not copy structured room/work/member/account IDs, source/discussion, evidence
   links or versions, checks, decisions, claims, credentials, private reminders or
   drafts. Title and summary may themselves contain sensitive text: this is field
   selection, **not automatic redaction**. The editable preview makes that limit clear.
3. The dialog may show the original work status privately. Its copy is not the
   authoritative receipt and edits do not change the room or inherit its review.
   A `completed` state alone is not independent verification or human approval.
4. Any current room member who can read the item may prepare this local draft.
   No new administrative permission, membership grant, command or endpoint.
5. `RoomAgentClient.resultDraft(id, {signal})` uses one existing selected-context
   GET, without source inclusion, then the same pure projection. Returned content
   is untrusted task data; the helper does not publish, copy, execute or acknowledge.

## Interaction and lifecycle

- Use a separate small controller inside the existing portable-work asset and a
  separate dialog. Keep Add result, its pending command and ROOM-RETURN v1 untouched.
- Seed the preview only on explicit opening. It is plain text, editable, initially
  focused, bounded at 16000 code units, with no HTML rendering or link fetching.
- Keep user edits in this tab across closing/reopening the same work. Clear them
  on reload, room/account/session reset or observed access loss. Include edited
  drafts in existing sign-out/room-switch/unload warnings. This is not durable storage.
- Ignore another result-copy entrypoint while this dialog is open; never replace
  an active edit. Original Add-result drafts remain independent.
- Freeze source revision and exact receipt identity privately. On work change,
  retain edits and selection, show an older-source hint, and require deliberate
  **Copy older draft** or **Start fresh**. Refreshing an edited draft confirms discard.
  Unrelated conversation updates do not mark it old. Missing work disables copying.
- A clipboard write starts only after explicit Copy. Keep one physical copy-flight
  latch across close/reset until the promise settles. Disable editing/copy during
  that flight; allow closing. Capture exact text and view/identity ownership.
- Only an owned visible unchanged view receives late success/failure. Failure
  leaves selectable text and instructions; do not steal focus if it moved. Never
  read/clear the system clipboard or promise to cancel an issued write.
- Success is “Copied,” never “shared,” “published,” “delivered” or “approved.”
- Escape closes and restores the stable source control after a rerender; don't
  steal a newer user-selected focus. Tab stays in the modal. Enter edits text on
  desktop and touch; this is an editor, not a message composer.

## Verification

Unit/API: strict two-field projection; unrelated throwing getters untouched;
Unicode/bounds/malformed input; sensitive text remains visibly redactable; all
receipt/review/rework states; cancellable exact GET, no source or writes; unchanged
work/event sequence/private reminders/human read markers.

Browser: hidden until Details, reported-only seed, exact edited clipboard bytes,
no external requests/storage/POST, literal markup inert, blank input, close/reopen
edits, source changes and fresh reset, old callback after edit/close/reopen/identity
change, single-flight copy, refusal/manual selection, independent Add-result draft,
stable focus after rerender, mobile coarse pointer and 200% text screenshots.

Then run core/API, full browser, 15-asset build and local Workers gates. Commit the
runtime candidate before the exact-package recovery gate, retain a fresh candidate
package and preserve frozen7075. Add no public asset, dependency, schema or provider
configuration. Inspect screenshots. Record evidence, update goal/handoff and
release the local lane. This is local only; hosted recovery and publication remain gated.

## Experiment and next decisions

Hypothesis: a user with a useful reported outcome can create an appropriate small
summary for another collaborator without copying a room transcript. Synthetic
tests can prove selection/control mechanics, not safe disclosure of arbitrary text
or voluntary human demand. No analytics or retention-lift claim in this slice.

Future voluntary human test: prepare a shareable summary, explain what was copied,
identify whether recipients get room access, and redact one private detail. A
misunderstanding of publication, access, authorship or approval blocks expansion.
Before causal growth measurement, use the goal's mature-cohort and eligible-identity
contracts; clipboard usage alone is not referral activation.

Now: complete this slice. Next: review the free first-contribution → result → return
journey as a whole for clutter and missing orientation, then choose one measured
problem. Later: opt-in source references/invitations or independently authorized
hosted shares only after audience, access, revocation, attribution and abuse policy
are explicit. No marketing watermark, forced invitation, public showcase, outbound
message, paid resource or recurring automation here.
