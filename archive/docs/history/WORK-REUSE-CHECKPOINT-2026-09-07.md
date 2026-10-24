# Deliberate work reuse — local checkpoint

**Built and verified locally, not pushed or deployed.** Tested source:
`45d40c7a87a9a31a571808da664c4c312a25752e`. Subsequent evidence/checkpoint docs do
not change the runtime. Recorded live remains fb90a70 / Worker901be347 / schema v7;
live was not reverified. The unbounded product goal remains active and incomplete.

## What changed

- Details → **Use again** opens the ordinary editable New work form. Only the
  outcome and done criteria copy. Current people are blank, read mode and full
  checks are restored, options remain collapsed. The original is never reopened,
  modified or used as a permission grant. No extra template dashboard.
- Existing drafts/pending proposals survive another reuse action. Live updates
  preserve text and selection. Session/form epochs and stable source-action keys
  prevent obsolete focus restoration or cross-session draft changes.
- Both fields support the service's4096-code-unit bounds; the outcome is a one-row
  textarea. No content is silently cut to the former100/300 limits. The browser
  normalizes CR/CRLF to LF; the agent helper preserves exact original strings.
- **Retry original** explicitly reconciles an unconfirmed create with the same
  command/work ID and frozen fields. Malformed or mismatched2xx responses cannot
  claim success. Confirmed refusals remain correctable; a definitive post-ledger
  rejection of the exact original also unlocks corrections. Close does not undo
  a request already sent. Work-form recovery is session-local, not durable.
- Long work definitions/links wrap, the Work grid cannot silently expand beyond
  the screen, and mobile attribution rows stack. Keyboard modal wrapping includes
  expandable Review & permissions controls.
- `RoomAgentClient.workDefinition(id,{signal})` reuses one authenticated selected
  context GET and the same two-field projection. No new endpoint, schema, asset,
  dependency, scheduling, execution or hosted inference. API callers explicitly
  choose people and gates; omitted API gates still default false.

[Plan and primary sources](WORK-REUSE-PLAN-2026-09-07.md),
[human/agent usage contract](WORK-REUSE.md).

## Evidence

Final committed-source gates:

| Check | Result |
| --- | --- |
| All source syntax and core/API tests |381 passed |
| Complete configured browser suite |90 passed |
| All configured local Workers tests |9 passed |
| Exact public assets |15 |
| Production Worker ESM bundle |203,302 bytes |
| Exact v8 candidate→pause→7075→candidate fallback |passed on same populated local Workers object |

The new slice adds four core/HTTP tests and13 browser journeys. Tests inspect actual
service records, including exact retry deduplication, unchanged source and human
cursor, fresh revision0/proposer/gates, revoked access, mismatched receipts, failed
transport, valid Unicode inputs exceeding the overall16KB request bound, changed
reviewer eligibility, post-ledger refusal, source rerenders, session A→replacement,
and keyboard/390px/200%-text behavior.

Review and early tests caught oversized-refusal locking, permanently locked
uncommitted retries, a nested Work-grid overflow and omission of summary controls
from keyboard wrapping. These were fixed, not waived. Earlier exploratory failed
runs are not the final result above. All13 new journeys and existing suites passed
after those fixes. Synthetic Workers certificate-rejection diagnostic noise remains;
certificate verification was not disabled.

Root inspected current screenshots in `test-results/`: reuse-desktop-preview,
reuse-mobile-large-text-top, reuse-mobile-large-text-controls, reuse-mobile-created,
and reuse-unconfirmed. They are synthetic fixtures, not production observations.
Large text uses vertical scrolling; the mobile document, dialog, Work list and card
have explicit horizontal-reflow assertions.

One separate agent actually adapted a seeded completed agenda into a new proposal
through the client. Root independently verified the service snapshot. Sequence14,
exact retry duplicate true, one new proposed/revision0 work item, cursor0, original
completed/revision2, no inherited result/authority. This was not a fresh-context
agent or human study. [Detailed exercise](evidence/work-reuse-agent-2026-09-07.md).
No retention, referral or productivity lift is claimed.

## Preserved package and remaining gates

Exact runtime package retained outside the checkout:
`work/project-room-runtime-packages-20260907/candidate-45d40c7`.
It independently verifies:49 runtime/source files,15 public assets, source tree
`a0624c32f6ca6067c8ecbbc4a1bbc688f78f3193`, manifest SHA256
`ea90a87fdea5bb31b453c24ab797698a29cd284fb626ba00b5a0d8f4e29ecb69`.
The existing candidate65f094e and frozen7075 packages remain unchanged.

The historical fallback's47-file contract still verifies. It ignores the newer
pause flag; independent traffic blocking or a tested pause-capable fallback remains
necessary. This is not provider PITR or current-authority certification after data
restore. Node is not Durable Object storage failover. All hosted recovery/migration
approval gates in the [runbook](V8-RECOVERY-RUNBOOK.md) remain.

Root was sole source editor. Three read-only reviewer lanes advised the work; the
service reviewer also performed the separately authorized fixture-only API exercise.
All test/listener processes ended. The actual-agent fixture database and plaintext
test config were removed; prior previews, retained packages and historical synthetic
evidence remain. No push/deploy/wrangler/live migration/provider/DNS/account/Dasha/
Desk changes, money, paid compute, outbound outreach or recurring automation.

## Next

Research and plan a deliberate previewable result-sharing/export flow, reusing
existing work/evidence and portable-packet boundaries. Keep private context excluded
by default, sharing user-initiated, attribution truthful and publication separately
authorized. Continue broader agent/manual collaboration and optional feature work
under the unchanged goal. Do not restart completed reuse, watcher, invitation,
return, selected-context or recovery checkpoints.
