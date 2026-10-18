# Project Room: autonomous cross-platform release campaign

Owner: Codex. Requested by John on 2026-10-18 while stepping away.
Status: executing; this document is a plan, not a release certificate.

## Mission and reusable execution prompt

Continue building and qualifying Project Room until the release gates below are
satisfied or every independently actionable task is exhausted. Do not stop at a
plan, an implementation, a test run, or a request for another “go.” Preserve the
architecture/continuity release already underway. Work through implementation,
verification, source publication, exact-head CI, coordinated merge, deployment,
and observed release behavior. Record each stage separately.

Build one coherent product: people and authorized agents turn conversation into
clear work, a useful result, reviewed evidence, and a reliable next step. The web
app, native Mac app, mobile web/PWA, and agent interfaces must agree on identity,
permissions, current work, results, retries, and recovery. Optimize accepted useful
outcomes, trust, clarity, and maintenance cost alongside speed. Do not invent
market-leading claims; earn improvements with reproducible evidence.

Use the current repository and source-linked decisions, not memory alone. Keep
existing work unless an explicit disposition explains why it is complete,
superseded, deferred, or excluded. A new feature must solve an observed release
problem better than a simpler correction. Do not start unrelated speculative
systems or rewrite stable modules to make the diff look ambitious.

Operate autonomously within John's standing authorization. Inspect shared claims,
use isolated clean worktrees, claim implementation paths, and serialize merges and
production deployments. Do not overwrite another agent's work. Read coordination
messages at checkpoints. Do not weaken security, CI, tests, evidence freshness,
or authorization to make the release pass. Use existing credentials through their
supported interfaces; never put secrets into logs, artifacts, commits, or chat.

Maintain a source-bound execution ledger. On interruption or context compaction,
resume the first actionable unresolved gate, preserving running command IDs,
branches, exact source revisions, failures, and next steps. If a certificate,
external provider, hardware device, or hosted runner is unavailable, document the
specific limitation and proceed with other useful work. Do not repeatedly ask
John questions while he is away. Do not claim work can run while the laptop is
asleep, disconnected, or this execution environment is unavailable.

## Product and platform decisions

1. Retain the existing Swift/AppKit/WKWebView Mac shell and native tool broker.
   Replacing it with Electron adds migration and security work without current
   evidence of a user benefit. The repository, not an assumed framework, drives
   implementation.
2. Ship mobile as a polished responsive web/PWA experience first. Native iOS and
   Android binaries are a separate product decision, not silently promised by
   “mobile ready.” Do not require installation before useful work is possible.
3. Share work and authority semantics across surfaces. Keep native OS operations
   behind explicit native controls and a private broker; do not add a general
   JavaScript-to-native execution bridge.
4. Keep production schema recovery forward-compatible. Schema38 code is not a
   rollback target after schema42 migration. Preserve independently tested export,
   restore, authority reconciliation, and roll-forward procedures.
5. Finish an excellent small core journey before adding breadth: start/join →
   define work → connect/use agent → inspect result → accept exact evidence →
   return and continue. Every feature and performance experiment serves it.

## Existing work that must not be dropped

The detailed release procedure remains
[RELEASE-ACCEPTANCE-EXECUTION-20261018.md](RELEASE-ACCEPTANCE-EXECUTION-20261018.md).
The six-outcome scope remains [FOCUSED-DELIVERY-PLAN.md](FOCUSED-DELIVERY-PLAN.md).
The comprehensive historical inventory and delivery ledger retain obligations;
this campaign does not silently reactivate deferred experiments or erase tasks.

- PR4114: architecture, entity storage, bounded chunked snapshots, replay isolation,
  canonical work, migration/privacy/restart correctness and benchmark evidence.
- PR4118: scoped work briefs, freshness, exact runtime context provenance, durable
  request/retry behavior, packaging/preflight, and integration with PR4114.
- New main f18cd508 escrow and job-health behavior merged into both local candidates.
- Current architecture candidate972a0147; continuity integration1d03bf68.
- Exact-source hosted checks, normal landing and production verification remain open.
- Shared benchmark already recorded replay improvements; other metrics inconclusive.
  Do not rerun to fish for a favorable result. Rerun only for relevant new code.
- Simulated acceptance50/50, recovery boundaries29/29, restore rehearsal passed.
- Actual model transport rehearsal passed: one start, one result, restart retry
  returned same result; input observation persisted. Physical sleep untested.
- Full/affected/lint qualification is running. Compare local host-policy failures
  to the recorded exact baseline; never describe a failing full suite as green.

## Release gate register and execution order

### R0 — Reconcile and freeze the candidate

Read current main, PR heads, reviews, work claims, deployment owner and pause state.
Classify every change since the qualified base. Integrate necessary changes once,
then freeze a bounded candidate rather than chasing unrelated main churn forever.
Run exact-head required CI. Keep architecture and continuity histories reviewable.
Retarget the stacked PR after the base lands. Release one item at a time through
the shared merge slot. Build deployed artifacts from the exact qualified source.

Exit: integrated source and every review blocker resolved or explicitly evidenced;
required hosted checks green for the merge candidate; merge receipts recorded.

### R1 — Data and operational safety

Exercise actual deployed-schema snapshots into42, chunk boundaries, corrupt/missing
parts, old-writer refusal, private-content deletion, message order, work receipts,
restart, backup and restore. Test stale backup authority resurrection and reconcile
revoked credentials/memberships before serving. Document measured recovery time
and the backup watermark rather than invented zero-RPO promises.

Exercise health versus readiness, overload, cancellation, delayed jobs, process
crashes and interrupted external effects. Verify observability says unavailable,
unknown or degraded when that is the truth. Ensure logs are useful without tokens
or private message bodies. Reuse the existing recovery tools and regressions.

Exit: no demonstrated data loss, authority resurrection, stale acceptance or
unreconciled duplicate effects; practical roll-forward procedure and operator proof.

### R2 — Web experience and visual finish

Audit the core journey in a new browser context and a returning context. Cover
accountless entry, account creation/sign-in, room selection, invitation expiry,
wrong-account links, empty/loading/error states, work creation, changes, result
review and return. Ensure every primary action has understandable progress,
success, failure and retry; errors preserve entered content.

Inspect desktop and narrow screenshots for hierarchy, reading width, spacing,
contrast, focus, overflow, long names, large output, multiline content and dialogs.
Prefer consistent existing components and design tokens. Remove duplicate controls
or technical explanations that do not help the user's decision. Preserve keyboard
navigation, semantic labels, reduced motion, text zoom and visible focus.

Run existing auth, first-result, unified-journey, work, native-result, accessibility
and visual checks. Add only missing meaningful regressions for demonstrated gaps.
Automated accessibility checks are evidence, not a full WCAG conformance claim.

Exit: essential journey completes without console errors, lost drafts, misleading
status or inaccessible primary actions across supported browser configurations.

### R3 — Mobile and installable web experience

Cover320/390/768px widths, landscape, safe areas, virtual-keyboard viewport changes,
scroll anchoring, text enlargement, touch targets, file selection, copy/export,
back navigation, deep links and account transitions. Use WebKit as well as Chromium
where available. A desktop viewport emulation is not a physical iPhone test.

Verify manifest scope/start URL/icons, install guidance, standalone behavior,
permission timing, push refusal/unsupported states, notification click routing,
and sign-out privacy. Test service-worker upgrade with an unsent draft, reconnect
after network loss, stale cached shell, and storage eviction. Do not describe
server operations as completed offline. Cache policy must not expose private data
across accounts. Preserve useful text drafts through safe upgrade paths.

Exit: responsive/mobile browser and PWA gates passed; physical-device and actual
push delivery gaps separately recorded rather than hidden under “mobile ready.”

### R4 — Native Mac product and distribution

Build production binaries and run native first-use, auth lifecycle, download policy,
local tools, and restart qualification. Test close versus Quit, reopen, menu/keyboard
behavior, allowed URLs, external links, navigation failures, export completion,
account changes, stale auth callbacks, and persistent scoped drafts. Keep external
provider UI simulation labeled; test real providers only with available authorized
accounts, without sending messages or changing personal data unnecessarily.

Audit broker capability discovery, pause/re-enable, process cancellation, output
limits, environment filtering, file version checks, socket permissions, journal
recovery and exact request identity. Local output remains private by default.
Native permission denial must leave a useful product, not a broken first-run trap.

Close the distribution gap: create an explicit release packaging path that requires
a clean exact source, valid release version, Developer ID, hardened runtime,
timestamped signatures, notarization, stapling and verification. Development builds
must remain clearly distinct. Package only shipping executables, never acceptance
harnesses or credentials. Produce artifact checksum and source/version receipt.
Never silently fall back to ad-hoc signing for a public release.

Current environment probe found zero valid code-signing identities. Implement and
locally verify the release pipeline and failure paths; actual notarized publication
remains externally blocked until a valid configured identity is available. Do not
ask for or invent certificates. Initial updates may use a documented signed manual
replacement path; automatic updating requires authenticated metadata/artifacts,
rollback/recovery and separate tests before being claimed or enabled.

Exit: native behavior qualified and artifact pipeline correct; public Mac readiness
requires an actually signed/notarized verified artifact, not just successful Swift
compilation. No Windows/Linux desktop or app-store binary claim in this scope.

### R5 — Agent productivity and human/agent agreement

Use separately authenticated requester, reviewer and agent roles. Enforce the
actual permissions of each identity. Exercise discovery → bounded context → claim
→ act → publish evidence → review → exact acceptance → continuation. Change the
requirements between read and write, revoke access, reconnect, repeat requests,
interrupt execution, and attempt acceptance against the wrong result.

Run both API/CLI/MCP contract tests and actual model/runtime checks. Verify returned
errors support recovery, context names its omissions and revision, tools remain
bounded, and changing authority invalidates stale assumptions. Record tool calls,
context bytes, model starts, duplicate publications, stale refusals and useful
outcome completion. A model saying “done” is not evidence of an effect.

Use adversarial roles to challenge drafts, not merely replay the same happy path.
Synthetic people are excellent repeatable probes for race conditions and unusual
cases; they do not establish real people's comprehension, preferences or productivity.
The real-human pilot is explicitly deferred by John, with its protocol retained.

Exit: role-separated journey and agent journey agree on the same committed state;
no acceptance bypass, hidden loss of context or repeated external execution.

### R6 — Speed, capacity and maintainability

Measure cold/warm room access, bounded history, send/edit/retry, reconnect, replay,
snapshot/backup, agent context preparation and native startup using realistic room
sizes. Use shared bench:room for relevant storage changes. Retain raw samples,
confidence intervals, machine/source provenance and inconclusive results.

Inspect unnecessary eager reads, repeated serialization, unbounded collections,
DOM growth, listener/process leaks, manifest drift and duplicate domain logic.
Prefer bounded APIs, indexed queries, explicit ownership and small domain modules.
Select optimization by measured bottleneck and correctness risk. Reject cleverness
that complicates recovery or cannot demonstrate a useful improvement.

Use existing performance targets and baseline contracts first. For new metrics,
record baseline and provisional budget before changes. Measure automated timing
separately from human task time. Verify quality at equal scope, not reduced work.

Exit: no meaningful unexplained regression; known scaling limits documented with
reproduction and next action; domain boundaries and packaged runtime remain coherent.

### R7 — Release artifacts, documentation and production

Verify onboarding, quickstart, support, privacy/security contact, data export/delete,
version/source attribution, feature limitations and platform requirements. Correct
stale claims rather than adding another competing guide. Keep release notes short
and user-oriented; link technical evidence separately.

Merge/deploy through the established lane with pinned source and required checks.
Verify both public doors for source/schema, readiness, auth entry, app assets, cards,
and representative reads. Preserve predeploy evidence and record observed outcome.
Run a bounded postdeployment synthetic journey only in disposable isolated data;
never pollute shared rooms with fabricated user activity or productivity results.

Exit: actual deployed revision verified; Mac artifact status honest; mobile scope
explicit; unresolved external gates listed; source/merge/deploy claims released.

## How to work faster without sacrificing evidence

- Before another broad run, inspect which checks already cover the unchanged source.
  Reuse valid evidence with provenance; do not re-label old runs as new runs.
- Bound local concurrency to avoid two CPU-heavy suites distorting timings. Use CI
  waiting time for code inspection, packaging and documentation, not repeated polling.
- Fix causal failures, not symptoms. Replace fixed sleeps with observed state and a
  bounded deadline only when that is the correct contract.
- Finish reviewable vertical slices. Do not accumulate a giant untested redesign.
- Build release verification around existing test harnesses and production modules.
  Do not create a parallel framework that has to be maintained forever.
- Keep failures, external limits and skipped tests in the ledger. A receipt must
  record source SHA, command, environment, result and scope limitation.
- When an external gate blocks one lane, work the next independent lane. When no
  useful work remains, report the precise blocker instead of pretending completion.

## Research informing these choices

- Apple Developer ID and notarization: https://developer.apple.com/developer-id/
  and https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
  support a distinct distribution pipeline; ad-hoc signing is a development artifact.
- W3C WCAG2.2: https://www.w3.org/TR/WCAG22/ and
  https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum
  inform keyboard/focus/mobile acceptance, not a claim that automation proves conformance.
- PWA lifecycle: https://web.dev/learn/pwa/update and
  https://web.dev/learn/pwa/installation inform upgrade and separate-storage tests.
- WebKit storage: https://webkit.org/blog/14403/updates-to-storage-policy/
  motivates eviction/recovery checks instead of assuming local storage is permanent.
- WebKit mobile capabilities: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
  and https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
  inform capability detection, permission timing and explicit physical-device gaps.

## Immediate execution queue

1. Collect in-flight full/affected/lint outcomes and compare exact known failures.
2. Publish current integration heads and await exact-source hosted qualification.
3. Run mobile/PWA/accessibility and native acceptance with bounded concurrency.
4. Implement and verify the missing native distribution pipeline in claimed files.
5. Repair only observed essential journey defects; update source-bound receipts.
6. Finish coordinated landing/deployment as gates clear; continue independent
   platform work while runners or the release lane are occupied.
7. Reconcile every R0–R7 row against evidence; do not call the entire release complete
   while any required gate is unresolved. Preserve actionable follow-ups.
