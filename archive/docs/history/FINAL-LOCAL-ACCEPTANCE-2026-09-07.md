# Project Room: verified local milestone

7 September 2026. **The bounded local milestone in GOAL-LOCAL-MILESTONE-2026-09-07.md satisfies its acceptance requirements. This is not production release approval.**

Project Room now demonstrates conversation → source-linked proposed work → exact inline artifact → distinct reviewer finding → service interruption/recovery → correction → exact-version review → synthetic human-role decision, using the same service and records for the browser and structured agent client. Guest links work without sharing an owner's key, and uncertain joins retry without duplicating membership or link usage.

All participants, artifacts and decisions in these demonstrations are synthetic. This agent operated all test identities. Distinct authenticated producer/reviewer records are **not** organizational independence, live AI execution, or an independent review of this implementation. The inline receipt text is the checked artifact; its explicitly non-live `example.invalid` URL is not a retrieved external artifact.

## Scope and authority

The active September 7 goal expressly calls for a local synthetic milestone, permits a tested API with MCP deferred, and separates live runtimes, independent review, physical devices/assistive technology, operations and dogfooding. That later objective governs this verdict.

SPEC-v0.md, FIRST-WORKFLOW.md and EVENT-FIXTURES.md remain broader product contracts. Their live GitHub/runtime demonstration, worker availability integration and five representative-team handoffs are **not complete**. They are not silently replaced by the fixtures here, nor claimed to be required-and-passed under this narrower, explicitly user-approved local goal. Historical 140/152/155/157/160-test checkpoints and old browser-policy blockers describe previous candidates, not the current state.

## Tested candidate

- Canonical directory: `/Users/johnpotter/.codex/.chatgpt-projects/g-p-6a9b22adb83c81919c156230b24f4d4c/work/project-room-canonical`.
- Branch: `codex/project-room-canonical-20260906`; base HEAD `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`.
- Retained tracked and untracked changes are part of the candidate. No commit, push, merge or deployment was made.
- Node 24.19.0; SQLite schema v7; single loopback service, no live AI or external execution.
- Source/test/config inventory digest: `b73fe979dec6b543194a83f4a7c4e46f9af3eec093e21e0f74d3e0f6d56a6b7f`.
- Current `node scripts/check.mjs`: syntax checks plus **163 tests passed, 0 failed, 0 skipped**. The script was inspected: it syntax-checks source/server/client/scripts/tests, then runs Node's test discovery. `git diff --check` also passes.
- Current read-only invitation audit: `consistent: true`, **3 invitations, 6 journal entries, 0 legacy baselines**, complete journal history for this fixture. This is not a claim that every historical database has complete pre-migration history.

Inventory command, from the canonical directory:

```sh
rg --files src server client scripts tests index.html package.json server.mjs | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
```

Documentation and generated screenshots are outside this fingerprint. All source-changing edits preceded the final test run and final connected demonstration.

## Requirement-by-requirement audit

| Local-goal requirement | Inspected authoritative evidence | Finding |
| --- | --- | --- |
| Preserve canonical work, read-only sources and coordination | Current worktree status; additive claims/releases on board and local bus; changes confined to canonical files and synthetic fixture | Satisfied. Retained changes preserved; no new agents/tasks or other-product edits. |
| Complete joined-event evidence | `invitationJoinedEvent` and `assertInvitationMembershipEvidence`; their issuance/audit call sites in store and share-links; evidence and journal tests | Satisfied locally. Complete deterministic event envelope, stored ID/room/sequence, account binding and public membership provenance are reconciled. Private account/token data does not enter the shared joined event. |
| Immutable member fields without rejecting legitimate later changes | Evidence helper checks member ID, kind, name, role, accountable human and origin; tests remove each required field and separately change permission/active/revision | Satisfied. Current authority remains separate from immutable acceptance evidence. |
| Atomic migration, safe failure/recovery and old-writer exclusion | Store constructor's transaction and validation order; writer-fence definitions and five migration tests; journal/provenance migration tests | Satisfied for synthetic local fixtures. Pre-open older writes fail after upgrade; existing records survive; injected failure rolls back marker/triggers; read-only audit never migrates. Not protection against a database administrator. |
| Human conversation remains useful without mandatory work | Browser guest message/reaction and addressed reply; service/event tests; explicit Make this work UI | Satisfied. Talking does not create an assignment or grant authority. Guest work controls are disabled while discussion remains usable. |
| Bounded work from the actual conversation | Browser created `work-1b46e93d-1521-45e0-bea5-73c2c0732ead`; read-only persisted projection confirmed `sourceMessageId: test-request`, proposer owner, producer/reviewer, definition, read mode and owner gate | Satisfied through UI and storage, not inferred from a hidden field's text readout. |
| Distinguish responsibility, attempt, completion, verification, approval and execution | Event transitions/tests, `nextWorkStep`, browser revisions 0/4/8/9, separate exact-version review/decision fields | Satisfied locally. Approval explicitly does not execute an external action. |
| Exact artifact, producer, reviewer, decision and next actor | Recomputed SHA-256 from persisted inline text; matching receipt/review completion ID and version; final browser/CLI at revision 9 | Satisfied for inline synthetic artifacts. External artifact retrieval remains a separate gate. |
| Correction cannot inherit old PASS/approval | Event tests for changed versions, revoked approvals and historical evidence; API handoff; corrected browser-created work checked with null verification/decision before its new review | Satisfied. Earlier evidence is retained historically, not transferred to a replacement. |
| Recovery after real interruption, without transcript relay | Stopped confirmed-live fixture session 45215, observed stale-history warning and revision 4 finding, reopened the same DB as session 37219; browser and agent client resumed the same next step | Satisfied. No reprovisioning or external replay. The earlier handoff also tested draft continuity through service restart. |
| Retries, cancellation, access changes and unknown outcomes | Client/service/return/event tests; browser committed join-response loss; one guest and one link use in SQLite; cancellation/expiry/revocation tests | Satisfied locally. Same logical request keeps its ID; revoked access is rechecked. Work supersession retires current authority/evidence rather than replaying actions. No external execution is implemented or retried. |
| Anyone-with-link access, bounded grants and membership reuse | Share-link implementation/tests; browser new guest, old account reuse, visible owner reuse, same-guest re-entry, link creation/copy/cancellation/error evidence | Satisfied. Each new guest has its own identity; fixed conversation-only grants; expiry/use limits; cancellation stops future joins, not existing membership. Local links work only on this Mac. |
| One canonical permission and record model for humans/agents | HTTP/store boundary; browser RoomClient and `RoomAgentClient`; shared `nextWorkStep` used by browser/client/return selector | Satisfied. No second authority model or disconnected agent work store. |
| Runnable structured orientation/context/work/evidence/resumption | `AGENT-CLIENT.md`, `room-agent.mjs`, `agent-inbox.mjs`, handoff tests and executed orient/brief/changes commands | Satisfied. Versioned responses, stable IDs/revisions, typed service errors, explicit command IDs. MCP is explicitly deferred under the goal's allowed option; no host compatibility claim. |
| Bounded, source-aware context and calm attention | Service caps: 500 work items, 10,000 room events, 100 members and 4 MiB projection; event pages at most 100; source-message references; return-brief horizon/cursor tests; in-progress attention suppression | Satisfied at the documented pilot scale. Room-wide sharing is explicit; no private connector context is imported. No selective task privacy or scalable public inbox claim. |
| Browser/keyboard/focus and narrow/enlarged presentation | Final browser matrix below; fixes verified after reload; screenshots and geometry measurements | Satisfied for the exercised local Chromium workflows. Not full WCAG, physical-device, screen-reader or cross-browser certification. |
| Runnable handoff and something John can inspect | Preserved disposable DB and browser tab; completed source-linked record; repeatable fixture and scripts below | Satisfied locally. Temporary data can expire; new-fixture instructions preserve existing databases. |
| Research-informed scope and fair adoption claims | Existing research/alternative documents retained; no activity-reward system, recruitment or forced-tool migration added | Satisfied as scope discipline, not validation of demand, productivity or retention. Dedicated room, existing-chat complement and configured incumbent remain alternatives. |
| No unauthorized external actions | Local tools, isolated fixture and coordination only; no push/merge/deploy/publish/live integration/outreach/spending | Satisfied for this work. |

## Final connected browser demonstration

The second demonstration began with **Make this work** on the actual synthetic request message, rather than a seeded work item.

| Stage | Current evidence |
| --- | --- |
| UI proposal | `work-1b46e93d-1521-45e0-bea5-73c2c0732ead`, revision 0, source `test-request`, owner proposer, Test producer accountable, Test reviewer verifier, owner decision required; next: producer accepts. |
| First producer result and reviewer finding | Revision 4 blocked; first inline version `sha256:208e72d8c9b8d229467bddbb6cfa304dd8144d472f83c452f1586a69d9200f9d`; reviewer identifies missing owner; browser names producer for correction. |
| Service interruption/recovery | Actual test process stopped and reopened on its existing DB. Browser showed stale-history warning while disconnected, then the same revision 4 finding and producer next step after reconnect. |
| Correction and new review | Revision 8; old verification/decision absent before new review. Corrected inline text: “Owner: Room owner. Agenda: review the request, agree on scope, and record the next decision.” |
| Exact corrected evidence | `sha256:b87a7d366cca7d4906286b4af06732defaf48945990ca9507c0126f2aad5e6bb`; persisted text hash independently recomputed by this test operator; receipt/review completion IDs and versions match, with distinct member IDs. |
| Browser decision | Owner-role UI chose Approve and supplied an explicitly synthetic/no-external-action reason. Enter activated Save record. Revision 9; next: approved, no external execution. |
| Agent resumption | All three documented read commands exited 0 after restart/completion. Orientation evaluated through event 34, with both demonstration items at revision 9 and next `complete`; producer return brief had 0 attention items; changes returned 34 events. |

The producer/reviewer exchanges used the documented RoomAgentClient against only the fixture's localhost origin, with exact work/state preconditions and stable command IDs. The browser selected the source and recorded the final owner-role decision. No human transcript relay, live model or external artifact fetch was involved.

## Browser and accessibility evidence

- Reusable guest link: new guest joined without owner credentials, posted a message and reacted; elevated controls were absent/disabled. Existing account and visible-member reuse did not duplicate identity.
- A synthetic response-reader failure hid a real successful guest join from the application. Same-request retry and later same-guest entry left exactly one Retry Browser Guest and one recorded use on that link. Its name, reply text, thread and addressed recipient survived same-member re-entry.
- Management feedback remains truthful when creation or cancellation is confirmed but list refresh fails. Both confirmed creation and confirmed cancellation followed by a simulated list-response loss were observed in the browser. Reopening the manager confirmed the keyboard-test link was cancelled at 0/10 uses; the previously joined guest's separate link remained active at 1/2. Handler tests also cover the retained creation request and confirmed-result feedback.
- Clipboard success and one-shot simulated refusal were observed. Refusal focused/selected the complete link and showed manual-copy guidance; the exact prior clipboard method restored itself. Actual OS/browser denied-permission configuration was not supported and is not claimed tested.
- Native empty-name validation focuses the input. A final-build controlled refresh failure focuses the re-enabled Join room button. **Return successfully retries from that focus and returns to the composer.**
- Five Tab and five Shift+Tab steps reached only join controls or the native browser/body boundary, never a background page control. Escape closed the non-pending dialog and returned to its opener. Pending lock/Escape prevention were exercised in the earlier browser run and current handler test.
- Doubled root/body text (16 → 32px) and doubled fixed-size titles were tested at 390×844 and at desktop width. This is controlled text enlargement, not a native zoom or physical-device claim. The join dialog remained scrollable and a retry completed at enlarged narrow size.
- An initial desktop overflow (2208px document in 1280px viewport) was corrected with font-relative container reflow. A further enlarged proposal Cancel button extended left of the viewport even though document width was 390px; wrapping its action row fixed this. Recheck: Cancel bounds 153.625–292px, Create outcome 98–292px, both within the 390px viewport. Required-field focus and cancel worked.
- Final ordinary desktop check after the fix: 1280px viewport/document, body 16px, grid layout, both work cards within 865–1247px, with no internal horizontal overflow. All temporary text/viewport overrides were removed.

There was a temporary tab-input/control issue during the preceding turn. On this turn the old tabs were absent and a fresh same-browser tab signed in successfully. A screenshot showed a populated password field while the text readout returned an empty value; that readout was not evidence that typing failed. Refreshing the CUA session supplied the correct supported keyboard API. No security restriction, browser permission or native app protection was bypassed.

Current browser evidence is the executed CUA matrix above and earlier scenario reports, with affected behaviors rechecked after their fixes. The historical **28-test standalone Chromium runner was not rerun** in this CUA-only session and is not presented as a current pass. The 163 automated tests and manual browser checks have different scopes; neither implies exhaustive UI coverage.

## Screenshots and local output

28 PNGs are saved under `test-results/acceptance-2026-09-07/` (numbered 01–29, with 13 absent). They are local, Git-ignored generated evidence. Earlier reports explain 01–20. This turn added and inspected:

- 21: source-linked UI proposal.
- 22: enlarged narrow next actor.
- 23: enlarged proposal action-row correction.
- 24: enlarged retry error/focus.
- 25: keyboard retry completion.
- 26: reviewer finding on the browser-created proposal.
- 27: actual service interruption.
- 28: completed browser-created handoff in the final desktop layout.
- 29: confirmed cancellation despite a failed list refresh. The warning identifies the displayed list as not yet refreshed; reopening then showed the authoritative cancelled state.

Some earlier clipboard/management captures contain a portion of a **disposable** invitation URL. These are synthetic test screenshots, not universally token-redacted public assets. No production credentials or private user conversation were used in these tests.

## Try it and reproduce

The preserved local test room is [Project Room — Disposable Test](http://localhost:52331/). It is left signed in as the synthetic owner in browser tab 9, marked to remain available. John's original `http://127.0.0.1:52330/` preview was not touched by the acceptance tests. Different hostnames deliberately isolate cookies; different ports alone do not.

Inspect Browser proposal: agenda handoff, follow From this conversation, inspect its inline evidence and decision, or open the return brief. Invite people creates links for this Mac only. Do not share your owner key or interpret the synthetic decision as approval of a real project.

The test service is execution session **37219**, reopened from `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/room.sqlite`. Its private synthetic `test-credentials.json` sits alongside it, mode 0600; do not copy its contents into reports. Session 45215 is stopped. No process is intentionally suspended. OS temporary cleanup or session expiry may require a fresh fixture.

From the canonical directory with Node 24.19+:

```sh
node scripts/check.mjs
node --test tests/agent-handoff.test.js
node scripts/acceptance-fixture.mjs --port 52331
```

The last command always creates a new temporary DB and prints its location, not its keys. First stop only the known disposable server if reusing its port; do not stop the user's original preview. Never rerun provisioning against existing members merely to reset a test.

For a **fresh seeded fixture**, using its printed credential-file path:

```sh
node scripts/acceptance-handoff.mjs /absolute/path/to/test-credentials.json first-review
node scripts/acceptance-handoff.mjs /absolute/path/to/test-credentials.json correction
```

Inspect the intermediate states in the browser and use the synthetic owner to record the decision. These helpers intentionally target the seeded `test-handoff`; they do not target the separate browser-created work automatically. Both stages have already run on the preserved fixture and must not be repeated there. `tests/agent-handoff.test.js` is a repeatable disposable end-to-end programmatic demonstration including restart and revocation.

The tested Node executable on this Mac is `/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. Prefix commands with that full path if Node is not on PATH. Loopback tests need normal local execution permission. A denied bind is not a pass.

For read-only local consistency checking:

```sh
node scripts/audit-invitations.mjs --db /absolute/path/to/room.sqlite
```

For agent orientation, brief and changes, follow AGENT-CLIENT.md; credentials belong in a configured process environment, never URLs or command arguments. The existing API is enough for this local milestone; an MCP wrapper would add transport/host integration work, not a missing canonical record capability.

## Explicitly open gates

Independent implementation/security review; separately operated real humans and live agent runtimes; real external artifacts and GitHub integration; MCP transport/authentication/host conformance; physical devices, assistive technology and non-Chromium browsers; production TLS/deployment/availability/restore procedures; representative-team dogfooding, five suitable live handoffs, and demand/productivity/retention measurement.

No self-review or synthetic PASS closes these gates. Broader discovery, federation, payments/reputation, recruitment, integrations and forced adoption remain deferred. This report closes the requested **local** acceptance milestone only.
