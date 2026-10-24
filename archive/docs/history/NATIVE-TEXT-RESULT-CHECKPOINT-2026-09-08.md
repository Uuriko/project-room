# Native text results: local checkpoint

September 8, 2026. Goal active and incomplete. Local-only implementation; no push,
deployment, live migration, provider setup, paid compute or external activity.
Root was sole editor, with three independent read-only review/research lanes.

## Delivered

One existing immutable work-linked message can become the work's versioned result.
The same completion, assignment, permission, write-claim, review and human-decision
rules apply. Existing external evidence remains supported without conversion.

- Human **Save as result**, exact preview, **View result**, pinned text in review
  and decision dialogs. Existing unknown-save recovery retains original inputs.
  Keyboard containment/focus return, mobile layout and actual 200% text scaling.
- Authenticated selected current/historical/draft reads; missing exact versions
  fail rather than silently selecting current. Older-than-100-event drafts work.
- `room_submit_text_result` and `room_read_result`; 17 MCP tools total. Direct
  client and CLI selected reads use the same authority model. Draft receipts now
  include message ID to avoid a needless extra discussion lookup.
- Server-checked retained post identity, exact UTF-8 digest and immediate previous
  completion. No text normalization, automatic acceptance, URL fetch or execution.
- Poster, reporter and nullable reported producer stay distinct. Original proposal
  packet/basis/submission revision and manual-unverified attribution remain intact.
- Rework creates a new completion, even for identical text. Old exact retries and
  historical reviews cannot substitute the newer version or inherit its approval.
- Schema/writer 10; still 20 application tables. Node and actual local Workers
  migration from frozen v8/v9 preserves existing data and identity/retry records.
  Injected failed upgrades roll back catalog/data; cached/reopened old writers are
  rejected after successful migration. Workers permits return to 0 outside writes.
- Recovery verifies native receipt/event correspondence in both directions,
  including checkpoint prefixes, exact text/proposal origin and parent lineage.
  The current populated recovery fixture includes a native result and exact retry.

Read-only review caught and root fixed three gaps before the checkpoint: pinned
review hash mismatch; orphan native receipts hidden in checkpoints; and text/
proposal invariant checks skipped by legacy checkpoint replay. Screenshot review
caught a long-hash layout overflow and text that initially failed to enlarge.

## Actual producer and independent reviewer

Two existing Codex subagents participated through separate MCP subprocesses and
their own scoped synthetic credentials. This is actual semantic agent work, not
scripted verdict generation, a human user study or vendor-host acceptance. Same
OS access was not a secret-isolation boundary; participants followed assigned scope.

Producer read the task/discussion, authored an agenda, accepted/started, posted,
previewed, independently hashed and submitted exact text. Reopened MCP and retried
the original input: identical saved completion, no duplicate work. Reviewer read
the room directly, independently hashed the 481 UTF-8 bytes and honestly passed the
agenda against the criteria. No finding was manufactured to force actual rework;
scripted integration tests cover the revision/finding/retry mechanics.

- Seed sequence 9 → final 14: accept, start, draft, completion, verification.
- Post `b1d260de-3060-410f-b3a3-de8dc9f91cc5`.
- Completion `821d2b80-8da5-4c65-83b6-877418836f4c`.
- Review `11c88010-4f0d-47e5-8ac3-064064f6da30`.
- SHA256 `ccb7cac0f3a35785012621d564078040505eea6554b23e54ed2143aea741bb67`.
- Work revision 4, independent PASS, human decision null, next owner/decide.
- Owner, producer and reviewer read markers all remained 0.

Root independently checked the evidence bytes/hash, matching completion/review,
final ownership and cursors. Participant subprocesses closed; the dedicated
fixture listener exited and its temporary room/keys were removed. Existing user
previews remained untouched. Local evidence is in
`test-results/native-result-participants-20260908.json` (ignored test artifact).

## Exact candidate and gates

Implementation `1bfab738e43567de339fc6d6a88c9f5d65cf9da0`; accessibility polish
`8a94363f29c4471019037d8269bb6712ec05c23b`; final runtime
`b538ee8792abee6dfefc152fd9c90e73ba4d4bc5`.

All final gates passed against the frozen final runtime: **447 core/API/package,
152 browser and 11 local Workers checks**. The browser suite was fully rerun after
the last result-viewer keyboard/focus edit. All test processes have exited. Root
viewed the desktop, mobile, review and 200%-text screenshots; no dedicated fixture
listener remains. These are simulated human journeys, not a human usability study.

Exact 57-file/schema 10 package, under the project mirror:
`work/project-room-runtime-packages-20260908/candidate-b538ee8`. Source tree
`8bf0106e70af1de91e7f3844548df7a79c606a9c`; manifest
`7efa837d0a8b0bd27e3286d3a4303629ebd9bdc851014a39f857d64f7fc307e9`.
Sixteen public assets; service bundle 242485 bytes.

## Boundaries and next work

Recorded live state remains app fb90a70 / Worker 901be347 / schema 7, unchanged and
not reverified. This is **not live**. A release needs a separate qualified
v10-compatible fallback, hosted recovery exercise and current-authority checks.
The retained v8↔v8 app-switch exercise is historical evidence, not a v10 fallback.

The native result is bounded text, not a multi-document editor, attachment store,
sandboxed runtime, hosted model or automatic task dispatcher. Unknown producer
cannot satisfy independence; a hash does not verify outside authorship/execution.

Next: versioned standing roles/charters, eligible-work suggestions and durable
attention without changing human read markers. Start with read-only orientation
and explicit opt-in; configuration is not an execution permission. Preserve the
existing free/manual/BYO-agent path. Then isolated attempts and provider/tool
adapters, with explicit scope/budget/revocation and real host-specific acceptance.
No claim that Claude/Grok/Instinct/iMessage/WhatsApp is fully connected follows
from the local stdio proof. Do not repeat the completed result implementation.

See the [next charter slice](AGENT-CHARTERS-NEXT-2026-09-08.md) for the research,
implementation boundaries and acceptance gates.
