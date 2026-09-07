# Project Room execution plan

Updated 2026-09-06. This plan implements the [shared roadmap](https://github.com/Uuriko/project-room/issues/6). Substantive source handoffs and findings belong in [issue #11](https://github.com/Uuriko/project-room/issues/11).

Project Room should be a comfortable place where humans and agents can talk, find context, and work together. Conversation stays useful without task ceremony. Consumer and enterprise use share the same room model; organization policy adds controls where needed.

## Current candidate and responsibility

The current Codex candidate combines these published inputs in a new branch:

| Input | Exact source | Role |
| --- | --- | --- |
| PR #8 | `30eaa935d55aaa91d6033d7ba9938f265a8cd20c` | Current Phase 0 integration, including provenance, session, migration, and accessibility corrections |
| PR #12 | `c22e8bdd80e89cf421dfd5691bf21acf1f0e2519` | Catch-up request ownership, reopened work, and form recovery |
| PR #13 | `50bffdff9448140488364dbfbffa3285b436f07d` | Composer focus, discussion-scoped errors, composition/repeat guards |
| PR #14 | `d8149470903f47bb733a18d7647c31c1ea555a6a` | Recorded work status and optional tab draft recovery |

The #12/#13/#14 line descends from the earlier #8 head `1d18471974243b3ffcd77c77124171f1351a4e25`. Testing those original PRs does not establish compatibility with current #8. This candidate resolves that overlap and retains the original source branches. Its publication record must state the resulting head/tree and actual executed results.

- **Codex:** this client consolidation, product direction, consumer interaction, source publication, and verification executable in this environment.
- **Instinct:** active identity/DS-1, service, operational-evidence, and accessibility correction work. Its complete source chain must be reconstructed before the client candidate and identity line can be called one tested product.
- **Grokbot:** existing real-agent adapter, hosting/evidence, and mobile work; obtain a current source artifact and acknowledgement before counting it as integrated.
- John's [full authorization for Instinct](https://github.com/Uuriko/project-room/issues/11#issuecomment-5561821391) supersedes older project-imposed approval holds. Codex review is engineering feedback, not a permission gate. Actual environment capabilities still apply.
- [PR #9](https://github.com/Uuriko/project-room/pull/9) remains separate from this candidate. Historical adversarial evidence is not silently relabeled as evidence for a different tree.

## Integration decisions

1. Keep current #8's producer/verification independence requirements, revision checks, supersession cleanup, and schema-v2 checkpoint behavior. Shared UI/server status helpers must enforce the same provenance and exact-receipt requirements.
2. Keep #8's application-owned record identifiers and history links. Draft and work-status additions locate records through that current representation.
3. Replace duplicate return-brief request bookkeeping with the #12 controller, while preserving #8's acknowledgement behavior: reopening cannot replace an acknowledgement in flight; both caught-up controls reconcile the brief; a committed marker followed by a failed read is described as saved and its stale horizon is invalidated.
4. Preserve #13's submission ownership and displaced-focus recovery together with #8's local error announcements, sign-out state, and focus-return behavior. Old asynchronous completions cannot modify a new session.
5. Retain #14's optional room/member/thread draft recovery. It never sends automatically and keeps an uncertain send's original command identity.
6. Run all browser suites from current #8 plus the composer suite. Update inherited test selectors to match the current record identity contract without weakening their behavioral assertions.

## Dependency-ordered packages

| Order | Concrete work | Completion evidence | Current boundary |
| --- | --- | --- | --- |
| 1 | Consolidate #12–#14 on current #8; resolve client, selector, and reducer overlaps; preserve all existing browser suites. | Published base/head/tree and source provenance; full contract/service and browser results on that source. | Current Codex execution slice. |
| 2 | Reconstruct Instinct's complete identity/DS-1 chain and integrate invitation preview → sign-in → explicit acceptance → room session → first message. | One complete desktop/mobile-viewport browser journey through the integrated HTTP/client surfaces, with ordinary error recovery. | DS-1 received source review separately. A published patch and a participant test total do not prove this client's end-to-end integration. |
| 3 | Close known accessibility findings, preserve reading and typing across live updates, and execute physical-device/screen-reader checks. | Corrected checklist/harness; keyboard/reflow checks; separately recorded VoiceOver and NVDA results on the actual source. | Four findings in review 5562594376 remain open until a corrected delta is published. Human evaluation is not completed by writing a script. |
| 4 | Make a real agent useful in the room: explicit context, recipient, capability, acceptance, pause, cancellation, and evidence. | One harmless real-runtime collaboration from human message to agent result and optional source-linked work item. | Grokbot's current adapter source and runtime evidence are required. Simulated presence and canned output do not qualify. |
| 5 | Consolidate exact-source verification, backup/restore, capacity signals, dependency review, and release records. | A working verification entrypoint; trustworthy receipt; integrated-schema restore result; an exercised monitoring and release path. | Several Instinct deltas are source-reviewed or participant-tested on its separate line. Loopback benchmarks are pilot evidence. |
| 6 | Simplify first visit and return visit, then evaluate consumer usefulness. | Observed first conversation, thread return, next-action comprehension, and human/agent handoff, with explicit denominator and privacy boundary. | Engineering fixtures do not establish adoption, retention, or usability with actual participants. |
| 7 | Implement organization lifecycle, private scopes, retention/export, and storage isolation according to concrete pilot needs. | Consistent role/offboarding effects across sessions and data paths; authorized exports; deletion survives replay/restore; realistic operator recovery. | Identity, data, and operational controls must be demonstrated together before making enterprise claims. |

These packages express dependencies, not calendar promises. Prefer finishing a usable journey over adding another independent feature branch.

## Immediate remaining handoffs

### Identity and first visit

Use the current DS-1 contract and its published corrections. Account authentication alone must not grant room membership. Invitation acceptance must check the current invitation, account, space, inviter, and permitted membership bundle. Its transactional and duplicate-safe behavior must remain correct when the browser loses a response. Room access must not require users to copy reusable credentials or place them in URLs.

The client must explain expiry, denied entry, retry, and session recovery in context. The development mock issuer is not proof of a configured production identity provider. Lightweight work should remain optional; reviewed-work requirements are enforced by the server.

### Accessibility corrections

The [current review](https://github.com/Uuriko/project-room/issues/11#issuecomment-5562594376) requires:

- Add AA criteria 1.2.4 and 1.2.5, with a reason if not applicable, so the checklist accounts for all 55 WCAG 2.2 A/AA criteria. A complete checklist is not a conformance claim. [W3C Recommendation](https://www.w3.org/TR/WCAG22/)
- Complete the primary keyboard flow without a pointer click.
- Fail when a relevant keyboard focus stop is not visible; do not merely skip its outline assertion.
- Track controls without IDs in focus order rather than silently skipping them.

Also complete all R1–R14 result rows in the human package and record VoiceOver and NVDA runs separately. Narrow viewport and CSS-zoom automation do not replace physical mobile devices, actual browser zoom, or assistive technology.

### Evidence integrity and operations

- The browser wrapper must return a failure exit status when its receipt invariant fails, even if the browser child process exited successfully. Add a focused negative check for this wiring.
- Retain clean-tree state, exact tested source, installed runtime/browser versions, and lockfile identity. Include cleanup failures in the outcome.
- Resolve the two residual evidence-pack items from [review 5562238576](https://github.com/Uuriko/project-room/issues/11#issuecomment-5562238576): shell-free filesystem probing and replay assertions/comments that prove the same properties.
- Run recovery against the integrated schema. An identical event digest is not a rebuilt projection; describe exactly what the drill checks and measure recovery loss/time.
- Add an actual consumer and sustained thresholds to cap telemetry before calling it alerting. Keep room-specific usage behind room authorization.
- Retain load shape, host/storage/runtime, network conditions, and stream interval with performance evidence. Do not extrapolate a single-host loopback measurement into enterprise capacity.

## Cross-component checks

| Invariant | Required evidence |
| --- | --- |
| Old requests cannot affect a new account or room view. | Session replacement, late success/failure, shared-cookie viewer mismatch, and form cleanup checks. |
| Reopened work stays active until its new completion satisfies its own gates. | Reducer-to-store lifecycle plus shared UI/server status checks. |
| A matching PASS is not automatically independent. | Producer known/distinct, designated verifier, confirmed independence, exact completion/evidence identity. |
| Acknowledgement is explicit and cannot be confused with a failed follow-up read. | Frozen-H acknowledgement, H+1 remaining new, cross-session suppression, saved-but-unrefreshed recovery. |
| Draft recovery does not invent a new send. | Same command identity across uncertain retry/reload, no automatic send, expiry, scope binding, access-loss cleanup. |
| Account and organization lifecycle changes affect existing access. | Integrated account/session/room tests after the complete identity source is available. |
| Private conversation is a real authorization scope. | History/search/export/agent-context coverage; an addressed message in a shared room is not private. |
| Deletion and retention survive recovery. | Replay, projection, search, backup, and export behavior specified and exercised together. |

## Working method and release evidence

For each meaningful result, record the problem, responsible contributor, exact starting source, changed behavior, relevant verification, source/digest, limitations, and next dependency. Reuse adequate evidence and stop optional testing after concrete remaining risks are covered. Use a failing regression when it establishes a real defect; do not add tests that merely mirror low-impact edits.

Publish substantive findings and artifacts in one completion handoff. Keep source review, local execution, independent execution, CI, physical-device work, and deployment distinct. Do not combine totals from incompatible source lines. Preserve current authorization and ask the owner only for missing information or access needed for the next concrete action.

The candidate is a reviewable integration step. Broader community and organization readiness require their remaining implemented and evaluated journeys, not just a green test count.
