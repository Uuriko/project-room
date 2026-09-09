# Exact action recovery and pinned review

September 8, 2026 · local checkpoint, not pushed or deployed

Tested runtime: `fc69f8458a34f91e42265d13ace103b4c355d0f6` (implementation
`41881ef`). Subsequent changes are screenshot-harness/documentation only.
The larger goal remains active and incomplete. Schema9 and15 MCP tools are
unchanged. Recorded live app fb90a70 / Worker901be347 / schema7 was neither
changed nor reverified. No new provider connection or external execution occurred.

## What is now reliable

The human action dialog covers accept/start/block/resolve, completion, scope
acquire/release, verification and owner decision. It now confirms the exact
authenticated event and command fingerprint before announcing a save. Ordered
claim paths, payload fields, causal identity, room/member and operation all match;
an empty or mismatched successful HTTP response is not treated as confirmation.

An uncertain result keeps its original command and locked inputs when closed.
Check pending save reopens it even if its original action disappeared; opening a
different work action cannot replace that pending submission. Exact retry resolves
the original before edits are permitted. Uncertain retries remain locked across
pre-ledger size/rate errors and idempotency conflicts. Only recognized post-ledger
refusals unlock correction; the shared policy now includes exact claim refusal
pairs. Reservations are still room coordination, not outside write permission.

The retained retry is in memory, not durable across reload. Navigation/sign-out/
account-switch warnings include closed uncertain forms and explain that an action
may already be saved. Confirmed access loss clears the form and evidence link.
Late command/refresh replies cannot restore old fields or steal replacement-session
focus. Closing an uncertain form is not cancellation of a server-side action.

Review/decision dialogs pin the original revision, result version and evidence
link. Background updates disable stale submissions. Review current work performs
an owned fresh read, preserves notes and resets a verdict if the result changed;
producer/independence guidance updates too. A known stale refusal exposes this
recovery even without live updates. Failed refresh retains old context and never
rebases or resubmits. A valid save remains saved when its follow-up snapshot fails.

Warnings are not rewritten for unchanged background updates. The regression
observes zero alert DOM mutations while unrelated messages arrive, then observes
mutations for a new explicit attempt. This is not a manual screen-reader audit.

## Verification

- 438 core/API/package checks pass.
- 145 browser regressions pass, including24 new action recovery scenarios.
- 10 local workerd compatibility/recovery/browser checks pass.
- 16 exact public assets; production service bundle234089 bytes (unchanged;
  the changed browser assets are independently packaged).
- Four screenshot-focused scenarios rerun after adding capture-only steps.

New scenarios include lost/uncommitted/empty/malformed/wrong receipts; exact
ordered claim retries; real overlap refusal and correction without overwriting
either reservation; first versus uncertain invalid scope; declined sign-out;
stale result/approval, unknown producer, offline refresh, delayed replacement
sessions, keyboard cycling, mobile and200%-root-text layout. The full suite also
retains existing invitation/account boundaries and cooperation coverage.

Root inspected six credential-free images in `test-results/`:
`action-recovery-desktop-retry.png`, `action-recovery-mobile-retry.png`,
`action-recovery-mobile-large-start.png`, `action-recovery-mobile-large-retry.png`,
`action-recovery-refreshed-verify.png`, `action-recovery-refreshed-decide.png`.
Large forms scroll vertically; both beginning and retry-control views were checked.
No tested horizontal overflow, page errors or off-origin requests. These are
simulated human journeys, not interviews or evidence of retention/preferences.

Three read-only research/review lanes contributed; root remained sole code editor.
No new actual semantic agent task was run in this slice; the earlier real same-room
agent and clarification exercises remain separate evidence. Disposable browser
fixtures close/remove their test databases; automated workerd checks retain their
synthetic recovery evidence by design. No dedicated listener remains from this
slice; existing user previews were not replaced or closed.

## Exact local package

`../project-room-runtime-packages-20260908/candidate-fc69f84` from the parent work
directory contains56 allowlisted files, schema9,16 assets. Source tree:
`22b92bff341823e6ea4bed875b4d20eba6d0f4f3`.
Manifest SHA256:
`63ea8192ba72c87aea632150033cd03de2fd084360adf62d03686a449a49a617`.
The core gate includes cold exact-package and populated schema9 preservation tests.
Historical v8 fallback tests are not a release fallback for migrated schema9 data.

## Next: let results live directly in the room

The [native text result plan](NATIVE-TEXT-RESULT-PLAN-2026-09-08.md) is researched
and ready to implement; **native completion semantics and schema10 are not built**.
Reuse an explicitly selected immutable work-linked draft, promote it deliberately,
verify exact bytes/hash and parent version in the service, expose exact current/
historical result reads, and reuse the existing review/decision gates. No fake
external evidence URL or automatic acceptance/approval. Preserve poster, reporter
and reported-or-unknown producer as different facts.

That persisted change requires v9→v10 migration/rollback, stale-writer refusal,
recovery audits and a genuinely compatible fallback. Then actual producer/reviewer
agents should submit, inspect, revise and cross-review room-native results. Native
vendor-host acceptance remains unverified. Standing charters/eligible work and
durable attention follow; isolated attempts and mock-backed Dasha integration
remain later. No live migration, deployment, new automation, money, personal inbox
access, provider/account changes or outreach is authorized by this checkpoint.
