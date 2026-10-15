# Deliberate work reuse

## Problem and product decision

A returning collaborator should not have to reconstruct an outcome and its done
criteria to do similar work again. Reuse should add value to accumulated Room
history without making the ordinary conversation or New work flow noisier.

Implement **Details → Use again → New work**. The ordinary editable form is the
preview. Copy only the outcome/title and done criteria; always start a new proposal,
with fresh people and the normal read-only, review-plus-approval defaults. Nothing
is sent until Create. The original record never changes.

This is definition reuse, not workflow cloning or a saved-template library. No
public sharing, recurring work, inherited approval, permission, source conversation,
claim, evidence, history, reminder, identity, command ID or relationship. The copied
text is user content, not execution authority. No agents are dispatched.

## Research and inference

Primary documentation reviewed 2026-09-07 PDT:

- [Linear issue templates](https://linear.app/docs/issue-templates) puts template
  selection in its existing issue composer. Borrow contextual creation, not its
  configurable default assignment/status/agent properties.
- [Notion database templates](https://www.notion.com/help/database-templates)
  offers editable reusable content near New. Its warning about prefilled relations
  pointing at existing records reinforces keeping Room relationships out of reuse.
- [Trello template cards](https://support.atlassian.com/trello/docs/creating-template-cards/)
  supports creating from an existing card template. Its documentation notes that
  completion can carry through from a completed template; Room must instead create
  proposed work with fresh acceptance and checks.

These are documented patterns, not authenticated product testing or evidence of
retention lift. Our hypothesis: repeating a useful collaboration becomes easier
when its definition is reusable without setup or accidental inherited authority.
Simulated human journeys and actual agent/API exercises can validate mechanics;
real preference, repeat use and referral effects remain unmeasured.

## Implementation contract

1. One pure `reusableWorkDefinition` helper in the existing workflow module. Return
   only own primitive title/done strings, nonblank, within the service's4096-code-unit
   limit, preserving text. No new public asset or historical package requirement.
2. An optional Use again action inside work Details for a current steering member.
   Resolve the selected record at click time; check an existing open draft before
   prefill. Never overwrite a current draft or pending submission. Source revisions
   or live updates do not alter the new draft's text.
3. Existing form controls preview all copied text, including API-created definitions
   longer than the old100/300 limits. Match service field bounds; preserve line breaks
   with a one-row outcome textarea. No truncation. Keep the16KB command limit enforced
   by the service. Blank people, collapsed advanced choices, normal full-review/read
   defaults. One short hint states that only the definition was copied.
4. Guard deferred focus with session generation and form epoch; resolve a rerendered
   source action by its stable focus key. Clear new UI state on cancel and access end.
5. Make creation uncertainty explicit for all New work paths: exact pending command
   and work ID survive transport/5xx/malformed receipt failures; temporarily lock
   edits and expose Retry original. It bypasses new-form validation so a changed
   reviewer cannot prevent reconciliation. A confirmed first-attempt validation
   rejection stays editable. Close dismisses the form, never claims to undo a sent
   proposal. A valid receipt stays successful even if refreshing the Room fails.
6. `RoomAgentClient.workDefinition(id,{signal})` makes one authenticated selected
   context GET, omits linked source, projects the same two fields, and never writes.
   Examples explicitly choose fresh participants and review flags: the raw API's
   omitted flags default false, unlike browser defaults. No new endpoint/schema.

## Verification and rollout

- Pure projection: exact allowlist, no input mutation, Unicode/whitespace/bounds,
  malformed inputs, no reading unrelated authority fields.
- Actual HTTP: authorized definition read; explicit new proposal by a steering
  agent; guest read does not grant create; fresh revision0/state/proposer; unchanged
  source, cursors/reminders; exact retry deduplication and denied revoked access.
- Browser desktop/390px/200% text: contextual discovery, editable full definition,
  blank people/default checks, no side effects before Create, cancel and fresh New,
  draft preservation, source-card rerender/focus, current role validation.
- Failure journeys: committed and uncommitted lost response, malformed receipt,
  known refusal/correction,5xx, original retry with changed eligibility, and held
  success/failure across session replacement. Inspect service records, not notices.
- Run complete core/API, browser and local Workers suites; verify15-asset package
  and frozen7075 fallback still work. Inspect actual screenshots and document limits.

Root remains sole editor; three independent read-only reviewers advise product,
service and failure cases. Preserve original stack/dependencies and all private
data/previews. No push/deploy/live migration/provider/DNS/account/money/outreach.

## Now / next / later

Now: implement and verify this complete reuse loop, including uncertainty recovery.
Next: assess a previewable shared-result/export path using existing private-work
boundaries; research first and avoid automatic publication. Keep recovery gates.
Later: named libraries/remixing/public discovery only after actual demand; opt-in
automation, bounties and hosted AI remain coordinated product work, not hidden
side effects of reuse. The overall long-running goal remains active.
