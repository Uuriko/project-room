# Finish useful work already started

Snapshot prepared October 11, 2026. Reviewed code baseline: `83746c5b`; source checkpoints and PR states are explicitly separate from the running product. This is the completion queue for the existing product direction, not another competing redesign. The combined implementation/reuse decisions are in PR2629's `CONNECTED-WORKSPACE-PLAN.md`; the product consolidation plan remains relevant where it does not conflict with newer verified behavior.

## Outcome and order

Finish a dependable shared conversation where people ask one visible assistant to do useful work, the configured agent actually starts, desktop tools work when connected, and every participant can understand results and recover from failure. Then replace the conversation presentation with a better tested React surface. Finish features because they complete this experience, not merely because a branch exists.

The [open PR snapshot](OPEN-PR-INVENTORY-20261011.md) contains 385 PRs, 38 drafts. It includes stacked dependencies, alternatives, superseded carriers and intentionally failing regressions. It is not 385 unique product features. The full title inventory is captured; selected critical diffs, tests and implementation paths were inspected. The rest require classification before selection, not a claim of exhaustive source review.

## Batch 1 — finish the connected agent and desktop workflow

| Work | Existing carrier / state | Finish condition |
| --- | --- | --- |
| Continuous shared ask pickup | #2612, source and local tests ready; hosted coverage/size blockers observed | Exact-head hosted tests pass; eligible ask starts without supplying run ID manually; idle/reconnect remain bounded |
| Private host status, preflight and Stop | #2630 stacked on 2612 | Status follows owned live process and dedicated profile; missing login is actionable; stale status never looks connected; confirmed Stop reaches runtime |
| Native connection across isolated HOME | #2611 | Installed helper uses explicit connection path; fresh private runtime reaches the intended broker |
| Native host Start/Stop | #2625 stacked on 2611; consumes 2630 | Stable installed app starts actual packaged CLI, survives closing/reopening room window, cleans up on app quit; technical manifest selection replaced by generated setup before ordinary-user readiness |
| Complete agent resume | #2631 | Own assistant assignments, pending inputs, revision/attempt and next read visible through one bounded read-only command |
| Honest human connection status | #2609 | UI distinguishes no coordinator, waiting, listening and actual work; no presence-as-execution claim |
| Green cube Dock identity | #2603 | Stable installed bundle and Dock target show cube after launch/relaunch; preview copy is not permanent installation |
| Stop after stale queued display | Repro a9e43b7c and surgical patch; source owned by Jill | Initial stale Stop rejected; explicit Review loads fresh attempt; confirmed retry targets that attempt; review never silently executes; uncertainty preserves original operation |
| End-to-end acceptance | #2629 | Real browser→Room→host→result→Stop→restart passes at release head; repeat with an authenticated provider and small useful task |

Dependency order:2611→2625 and 2612→2630;2631/2609/2603 independent unless new conflicts arise. Qualify the combination, not just individual green branches. Keep held native and legacy paths separate until their conditions are met.

Evidence already obtained:36 combined JS/browser tests,6 actual Swift→CLI→Room lifecycle checks and 18 native process checks passed. Provider execution was simulated. A real authenticated model turn, stable installed build, and live web/device operation remain open.

## Batch 2 — account and recovery quality before inviting more users

- Keep the first screen to logo, primary sign-in/account flow and one Agent sign in entry. Do not restore explanatory copy or a grid of authentication choices.
- Test fresh account, existing account, incorrect password, password reset, passkey enrollment/use, expired invite and sign-out from both web and desktop. Preserve the invite destination across the whole flow.
- Exercise desktop authentication cancellation, back, close, timeout, network loss and retry. Every failed attempt must leave a usable screen without force-quitting the app.
- Review #2635's passkey/email-link affordances against the minimal design; existing backend support does not require every option to become a primary button. Secondary disclosure or account settings may be the right home.
- Inspect security fixes #2602 (OAuth state binding), #2607 (session/key revocation), #2596 (guest agent history floor), and their tests together with current routes. Prioritize real account/privacy defects without merging unrelated work.
- Verify changing account/room while a request is pending cannot expose old drafts, private messages, attachments or late results. Account recovery and room invitations are distinct scopes.

Done: one tested signup→invite→chat and returning-user→chat journey in Chromium and native WebKit; authentication failure/cancel always recoverable. Real-provider limitations are stated rather than inferred from mocks.

## Batch 3 — finish everyday human collaboration

| Area | Started work to reconcile | Acceptance |
| --- | --- | --- |
| Attachment and composer recovery | #2006 atop 2003/2001; compare against current code before carrying | Failed upload never silently sends text alone; retry cannot double-post; scoped drafts survive expected reload; IME and Enter preferences work |
| Search and history | #2357 plus existing REST paging | Every reported match is reachable; muted/private content filtered before totals; load-more retains focus and room/query scope |
| Invitations and room navigation | #1992/#1984 and newer invite fixes | One clear share path; copied link reaches intended room; drafts survive ordinary navigation; keyboard focus predictable |
| Catch up and unread | #2636 plus #2622 and existing Updates | Badge and panel agree, read/unread changes propagate, partial reads do not erase unseen work; one useful Updates surface |
| Shared prompting | Existing assistant source/run model | Two humans contribute without overwriting each other; conflicting direction is surfaced; one public result with optional attribution details |
| Long conversations | Existing bounded timeline, prior large-history experiment | Stable scroll/draft/focus while arrivals and images change height; older history reachable; measurable typing/render performance |
| Accessible compact UI | Existing layout/focus fixes including 2597 | Small viewport, keyboard, screen-reader names, reduced motion and dark mode; no expanded operational tutorial for routine agent use |

Reconcile old stacked PRs by comparing actual behavior at current main. Extract missing repairs; retire an old carrier only after its useful changes are proven present or explicitly declined. Preserve links to replacement evidence.

## Batch 4 — React conversation replacement

Proceed with a substantial presentation change if it produces a better product. Initial React 19.3.0 + assistant-ui 0.15.27 prototype passed concurrent human sends, distinct agent authors and draft preservation against a real fixture Room API. It is not production-integrated. Minimal bundle was about 174KB gzip; compare actual application performance before claiming a speed win.

1. Mount the transcript at the existing scoped `renderMessages()` seam. Keep Room's store, stream, authorization and operation IDs; no parallel backend or second history store.
2. Preserve member identity, private visibility, message revisions, replies, tombstones, result IDs and per-run attempt controls in the adapter. Never equate all assistant-role messages with one author.
3. Start with rendering/scrolling primitives and the current composer controller. Extract that controller before replacing its view; preserve uploads, Ask Room scope and recovery behavior.
4. Use custom Room Stop/review actions. Default assistant-ui cancellation can optimistically rewrite a trailing user message before backend confirmation; it is unsuitable as-is for multiplayer.
5. Qualify streaming, reading older content, older-history loading, expanded tool details, edits/reactions/files, concurrent participants, account switch, revocation and reconnect.
6. Run keyboard/IME, axe, native WebKit, visual and comparative performance checks. Promote the new transcript after parity, then remove old DOM reconciliation and duplicate listeners.

Done: a single maintained conversation implementation with objectively better interaction and no lost functionality. Do not convert unrelated settings pages merely to make the application uniformly React.

## Batch 5 — finish fast agent and computer capabilities

- Reconcile #2129's batch/first-run work with current APIs. Verify operation IDs, per-action results and partial failures before calling batch actions faster or safe to retry.
- Evaluate #2626's lean tool discovery and #2634's REST parity against current catalogs. Agents should discover a small useful surface, then request schemas as needed; do not create another universal command language.
- Combine #2633 assistant change cursors with compact resume where compatible. Assistant-only changes must remain visible even if chat context version does not change.
- Land #2614 native app observations/private window screenshots only after exact-head checks. Preserve permission denial, secure-field omission, pause and bounded local retention.
- For semantic Mac actions, evaluate Peekaboo integration before writing another engine. Its current OS/toolchain floor differs from Room's; prove packaging and permission identity first.
- Reuse Playwright MCP for browser tools. Prefer APIs and structured actions; screenshots/coordinates are a fallback, not the standard route for Room operations.
- Qualify one host at a time: Codex, Claude, Grok, then other compatible hosts. For each record installed/access/listening/run/result/restart separately; a mention or membership never proves idle activation.
- Connect browser-initiated work to the selected Mac through existing relay/device mechanisms where appropriate. The leased VM executor and personal Mac broker are different targets; do not accidentally grant room members the host computer.
- Finish simple generated connection setup and actionable permission guidance. Keep launch-at-login/menu-bar support after stable host shutdown and signed identity are qualified.

Done: one useful browser or desktop request executes on the selected host using direct tools, returns a result once, and respects Stop/reconnect/local pause. No copy-pasted secrets or manual run-ID steps in the normal flow.

## Batch 6 — reliability, release and unfinished infrastructure

- Fix hosted coverage gaps with behavior tests, not lower thresholds. Keep targeted tests fast and preserve Linux sandbox qualification.
- Full local suite had 9,368 passes/28 failures/10 skips; all 28 failures reproduced on unchanged 83746c5b. Baseline work: 23 Linux/bubblewrap-dependent cases; 3 canonical temporary-path fixtures; 1 compressed-image golden; 1 same-millisecond fixture assumption. Scope repairs separately. Do not add an unsandboxed fallback to get a Mac test green.
- Review legacy scratch executor #2589 versus #2510/#2306. It lacks durable exclusive execution across restart even after cleanup fixes. Either finish its narrow safety repair with clear support limits or deprecate its entry point once the supported host covers users. Do not label it equivalent to the durable host.
- Check backup/restore work including #2104 and its base: prove restore of representative data, exact-byte preservation and operational ownership. Backup code existing is not recovery proof.
- Reconcile herdr/session lifecycle experiments, approval-inbox fragments and wake lease remedies as coherent features. Tests designed to fail must travel with fixes. Schema, APIs, UI, auth and recovery need one end-to-end check before rollout.
- Existing native build holds and explicit feature holds remain until their evidence is met. Sounds/motion can wait for the core interaction; do not wire a held module merely because its unit tests pass.
- For each selected batch, use a known source head and serialized merge/deploy ownership. Release web and native artifacts with compatible protocol versions, smoke checks and rollback. Install one stable app bundle; verify actual running build and Dock target.

Done: exact-head hosted checks green, production smoke verified, native artifact installed/qualified where applicable, and a concise receipt tells users what became available.

## Keep, combine, retire or defer

**Finish now:** reliable host connection and Stop; minimal recoverable auth; chat/drafts/uploads/search; truthful updates; source/installed/deployed consistency.

**Combine:** competing Connect flows; overlapping Updates/catch-up surfaces; duplicated result navigation; protocol wrappers around the same Room operation; tests-only reproductions with their owning repair.

**Review for retirement:** superseded PR carriers; unsupported scratch execution paths; abandoned alternative state stores; duplicated tutorials and technical status surfaces. Close only with an explicit replacement or documented decision; do not delete persisted data/history.

**Keep later, deliberately:** voice/video using LiveKit, shared editable artifacts using Yjs, optional ACP/AG-UI adapters when an actual host needs them, marketplace/app distribution and billing, sophisticated work-fit rankings, graph memory, new orchestration frameworks. These may be valuable, but none should delay a dependable shared work session. Existing #1995 work-fit remains advisory; do not turn inferred strengths into hard assignment rules.

## Backlog reconciliation method

For every open carrier record: user outcome, current owner/hold, relevant source paths, dependency/replacement PR, actual missing behavior, acceptance test, and next action. Classify as finish / combine / already covered / deliberate defer / retire candidate. A title match is only a candidate; inspect diffs and behavior before concluding duplication.

Use the existing Room board as the live work tracker. This document orders completion; it is not a second task database. Do not create hundreds of new cards from the PR inventory. Start with Batch 1 plus a small set of independently owned account/privacy or recovery repairs. Pull the next item when a useful result is qualified.

Each checkpoint records prepared → tested → merged → deployed → installed where relevant → live verified. A task is not user-ready merely because its coding claim says done. Close outdated carriers and update documentation after replacement is qualified. No blanket merge of the backlog.

## Work started during this pass

- Captured all 385 currently open PR titles/base relationships, including 38 drafts.
- Rechecked 10 current host/native/recovery PRs and identified real hosted failures and pending checks.
- Added concrete large-diff justifications to 2630,2625 and 2629 using the existing documented policy; no check disabled or threshold changed. Hosted reevaluation remains required.
- Continued supervisor coverage qualification and Stop-review ownership coordination with the existing workers.
- Preserved source holds and explicitly deferred optional feature expansion behind complete user journeys.

Supervisor release update: PR2612 now carries atomic fixture writes at `147c1027`. The prior coverage job aborted on partial JSON before evaluating thresholds. 43/43 tests pass with V8 coverage instrumentation; fresh hosted checks queued. No threshold changed.
