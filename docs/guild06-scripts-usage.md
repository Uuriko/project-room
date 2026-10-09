# scripts/ usage catalog (guild-06, generated 2026-10-09)

Covers 370 executable files in `scripts/` (excluding `scripts/room`, `scripts/herdr-migrate.mjs`, `scripts/runtime-package.mjs` — guild-05 slice).
Descriptions are extracted from each script's leading header comment; flags are detected statically from string literals.

## .acceptance-fixture.07c3cbccacb1c7c3.generated.mjs

Disposable, loopback-only acceptance fixture. Never accepts an existing DB path.

Run: `node scripts/.acceptance-fixture.07c3cbccacb1c7c3.generated.mjs`
Flags seen: none detected


## a11y-axe-helper.mjs

Shared axe-core runner for the Q011 accessibility browser checks.  One axe configuration for every check, so a violation that appears in one flow and disappears in another is a page difference, not a config drift:   - tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa (same set the     existing board/public-pages checks use)

Run: `node scripts/a11y-axe-helper.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## a11y-composer-browser-check.mjs

Q011: axe-core sweep of the message composer.  Signs in and opens the composer options disclosure, then runs axe scoped to the composer region (#message-form and the open #composer-options). Scoping keeps this check's contract on the composer alone: the rest of the page is owned by the room-view sweep. Fails on any serious or critical

Run: `node scripts/a11y-composer-browser-check.mjs`
Flags seen: none detected


## a11y-login-browser-check.mjs

Q011: axe-core sweep of the login/join entry points.  Covers the two unauthenticated entry flows a new user or agent meets:   1. the signed-out room page (the login/auth panel on index.html)   2. the agent join page (join.html): consent form with a live invite code,      and the error state for a bogus code

Run: `node scripts/a11y-login-browser-check.mjs`
Flags seen: none detected


## a11y-room-browser-check.mjs

Q011: axe-core sweep of the signed-in room view.  The main room UI after authentication: message list (seeded with one message so list markup is exercised), member chrome, and dialogs closed. Both viewports. Fails on any serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa).

Run: `node scripts/a11y-room-browser-check.mjs`
Flags seen: none detected


## acceptance-fixture.mjs

Self-test fixture harness: reads a base64 room-state fixture and applies per-line character fixes from a .fix file; used by browser checks to seed deterministic rooms.

Run: `node scripts/acceptance-fixture.mjs`
Flags seen: none detected


## acceptance-handoff.mjs

Advance only the synthetic fixture through producer/reviewer API exchanges. Human-role approval is deliberately left to the browser test.

Run: `node scripts/acceptance-handoff.mjs`
Flags seen: none detected


## access-preview-browser-check.mjs

Simulated human journeys against disposable first-party data, not human research. C2: the read-only "what this agent can access" preview on a work card.

Run: `node scripts/access-preview-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## access-review.mjs

BUILD-01 D4: periodic access review. A plain review is read-only. Two sources:   --db PATH          open the store file (default ROOM_DB or .data/room.sqlite)   --origin URL       ask a running service; the owner key is read from the                      environment variable NAMED by --key-env (default ROOM_OWNER_KEY). --revoke-identity records one owner revoke in the store file, then prints the review. It clears both membership-administration stores for that identity.

Run: `node scripts/access-review.mjs`
Flags seen: none detected


## accessibility-check.mjs

Cross-session return-brief isolation and bounded accessibility regressions. Real browser + disposable loopback service; no external identity or agent runtime.

Run: `node scripts/accessibility-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## account-deletion-browser-check.mjs

QA2 finding P2-11: Settings → Sign-in & security → Advanced offers Delete account. The dialog shows the plan, requires the account email, and posts the confirmation token with the session CSRF header.

Run: `node scripts/account-deletion-browser-check.mjs`
Flags seen: none detected


## account-settings-browser-check.mjs

Browser coverage for the account settings UI (slice 7, RC-2026-09-17-016): the session menu opens Sign-in & security, the linked methods render with honest provider-unconfigured states, disable/enable/remove work through the real UI (including the last-active-method guard), and recovery codes are generated and shown once. Boots a real server against an acceptance-fixture store over loopback; no network calls.

Run: `node scripts/account-settings-browser-check.mjs`
Flags seen: none detected


## account-workspace-check.mjs

node --test browser check: account workspace flows for inbox-only vs member accounts (magic-link mailer mocked).

Run: `node scripts/account-workspace-check.mjs`
Flags seen: none detected


## accountless-join-restore-browser-check.mjs

Account-less join restore: an invite-redeemed room session (authMode "room", account null) must land inside the room and survive a reload — the #817 regression where hardened ownsResponse() rejected valid account-less sessions and stranded fresh joiners at the account gate. All state and credentials are disposable.

Run: `node scripts/accountless-join-restore-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## acquisition-browser-check.mjs

Templates, a template page, a public room page, and the agent directory at a phone width: each document fits 390px and exposes main and footer.

Run: `node scripts/acquisition-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## action-dialog-focus-scroll-browser-check.mjs

NR-B: the action dialog's async exact-text load must not leave the focused review-notes textarea clipped by the dialog's bottom edge at 320x900. Regression: without the post-load focus re-assert in loadActionText, a slow exact-text response shifts layout after the browser's focus scroll already ran, and the textarea (plus its focus outline) ends up below the visible edge of the dialog.

Run: `node scripts/action-dialog-focus-scroll-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## action-recovery-browser-check.mjs

Simulated human flows in disposable loopback rooms. No external work or evidence is fetched. External completions require signed evidence under the new contract.

Run: `node scripts/action-recovery-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## activity-feed-browser-check.mjs

Attention: Activity feed, Later (saved messages), Mark unread, and the read-horizon "New messages" divider. Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.

Run: `node scripts/activity-feed-browser-check.mjs`
Flags seen: none detected


## agent-claude-channel.mjs

Claude Code spawns this file directly. Same checks and channel as `room-listen --mode channel`. It starts no model.

Run: `node scripts/agent-claude-channel.mjs`
Flags seen: `--mode`


## agent-connect-browser-check.mjs

node --test browser check: agent connect first screen — visible entry choices open focused flows without hiding pending agent sign-in.

Run: `node scripts/agent-connect-browser-check.mjs`
Flags seen: none detected
Env vars read: `PATH` `ROOM_TEST_SCREENSHOT_DIR`

## agent-doctor.mjs

Library-only module: not directly executable. Invoke via:   node scripts/agent-inbox.mjs doctor (agent-inbox.mjs imports doctorMain from this file.)  Read-only self-test for the agent plug-in loop (research backlog D4): origin, credential source and access, with one concrete repair step for the

Run: `node scripts/agent-doctor.mjs`
Flags seen: `--help`
Env vars read: `ROOM_AGENT_CONFIG` `ROOM_AGENT_ORIGIN`

## agent-fast-path-check.mjs

Synthetic new-agent journey through public HTTP and hosted MCP. No live service.

Run: `node scripts/agent-fast-path-check.mjs`
Flags seen: none detected


## agent-inbox.mjs

Agent CLI: join/resume a room via invite code or room URL into a private directory; --accept accepts the disclosed grant. stdin-capable.

Run: `node scripts/agent-inbox.mjs`
Flags seen: `--brief` `--completion` `--cursor` `--delivery-mode` `--draft` `--expires-at` `--expires-in` `--help` `--include-offers` `--include-source` `--label` `--lease-hours` `--limit` `--name` `--needs-me` `--no` `--note` `--origin` `--reach` `--ref` `--reply-to` `--since` `--stdin` `--to`
Env vars read: `ROOM_AGENT_CONFIG` `ROOM_AGENT_ORIGIN` `ROOM_AGENT_TOKEN`

## agent-mcp.mjs

MCP stdio server for an enrolled agent: exposes room tools over the existing private Room connection; takes no arguments.

Run: `node scripts/agent-mcp.mjs`
Flags seen: none detected
Env vars read: `ROOM_AGENT_ATTENTION_DIR` `ROOM_AGENT_ATTENTION_VERSION`

## agent-onboard.mjs

Agent onboarding journey: the buddy/coach pattern for new room members.  A newcomer (agent or human-assisted) is paired with a coach who walks them 1:1 through developing an identity — name, lane tag, role, voice, avatar direction, and update format — before they introduce themselves publicly. Coaching stays private (a DM between coach and newcomer); the only public

Run: `node scripts/agent-onboard.mjs`
Flags seen: `--dry-run` `--help` `--name`
Env vars read: `ROOM_ONBOARD_STATE`

## agent-pause-browser-check.mjs

C6: owner-facing Pause, Resume and Remove for agent members in the People panel. Pause/Resume act on the agent's wake-queue pause row through POST /api/rooms/:id/agent-pause; Remove sends MEMBER_ACCESS_CHANGED after a second confirming click (no native dialog). Real browser + local HTTP service; identities and keys are disposable fixtures.

Run: `node scripts/agent-pause-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## agent-replies.mjs

One explicit operation using the existing private connection. No watcher, credential output, implicit acknowledgement, rerun, rebase or model dispatch.

Run: `node scripts/agent-replies.mjs`
Flags seen: `--help`


## agent-resume.mjs

Usage: node scripts/agent-resume.mjs [--focus replies] [--since-version HEX] [--attention-cursor JSON]\nReads current obligations and claim references, or current reply requests with --focus replies. No acknowledgement or execution. Uses the existing private Room connection.

Run: `node scripts/agent-resume.mjs`
Flags seen: `--attention-cursor` `--focus` `--help` `--since-version`


## agent-signin-browser-check.mjs

node --test browser check: agent sign-in entry — visible entry choices open focused flows without hiding pending agent sign-in.

Run: `node scripts/agent-signin-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## agent-wake.mjs

Usage: agent-wake.mjs doctor --host ID | setup --host ID --cadence-seconds N | wait --host ID --cadence-seconds N [--wait-ms N] [--attention-cursor JSON] [--since-version HEX] | ack --host ID --signal ID [--signal ID ...]\nUses the existing private Room connection. Setup registers, not starts a listener or model. Wait reads wake hints and fresh attention; it never acknowledges. Ack only after handling th

Run: `node scripts/agent-wake.mjs`
Flags seen: `--attention-cursor` `--cadence-seconds` `--help` `--host` `--signal` `--since-version` `--wait-ms`


## agent-watch.mjs

Leave the one-shot error listener until after destroy has emitted.

Run: `node scripts/agent-watch.mjs`
Flags seen: `--help` `--once` `--requests`


## agent-work-access-browser-check.mjs

H4: an agent that joins through a room link has no permissions, so it never shows up as an assignee. The owner sees "Let them take work" on that agent in People, the work form says why the agent is missing, and one click makes it assignable. Agents with their own connection key are pointed to Manage connections instead, because changing their access retires that key.

Run: `node scripts/agent-work-access-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## agent-work-preflight.mjs

Read-only preparation, not authorization or a substitute for required CI.

Run: `node scripts/agent-work-preflight.mjs`
Flags seen: `--exit-code` `--is-ancestor` `--porcelain`


## an-funnel-1.mjs

AN-FUNNEL-1: signup -> first message -> first reply, read-only.  Usage: node scripts/an-funnel-1.mjs --db <path-to-room.sqlite> [--since <iso-date>]  Opens the database read-only (PRAGMA query_only=ON) and reports the activation funnel using ONLY already-recorded data: analytics_events

Run: `node scripts/an-funnel-1.mjs`
Flags seen: `--db` `--since`


## analytics-backfill.mjs

Read-only backfill. Copies the tables the tail reads into memory, runs the tail there, and prints the baseline. The input file is never written. AN-1b schedules this shape of run; this script is the one-shot form.

Run: `node scripts/analytics-backfill.mjs`
Flags seen: `--db` `--report`


## answer-engine-check.mjs

Weekly check: the same prompts go to ChatGPT, Claude, Perplexity, and Grok, one call each. Scores are derived from the response text and the URLs it cites. Raw answers are written for the workflow artifact and are not committed. A missing key skips that engine and exits 0 when nothing was called.

Run: `node scripts/answer-engine-check.mjs`
Flags seen: `--date` `--help` `--out-dir`


## assisted-agent-exercise.mjs

Disposable loopback room for independent agents, not an agent runner. The operator creates assignments only; participants supply their own work.

Run: `node scripts/assisted-agent-exercise.mjs`
Flags seen: none detected


## assisted-work-browser-check.mjs

Real browser commands against disposable loopback rooms only. No external agent runs.

Run: `node scripts/assisted-work-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## audit-invitations.mjs

Trusted local operator tool; no account identities, invitation contents, or secrets are printed. Opening read-only never runs a migration or repairs a projection.

Run: `node scripts/audit-invitations.mjs`
Flags seen: none detected
Env vars read: `ROOM_DB`

## audit-native-request-evidence.mjs

Read-only evidence correlation. No host invocation, credentials or networking.

Run: `node scripts/audit-native-request-evidence.mjs`
Flags seen: none detected


## auth-return-browser-check.mjs

Welcome, sign-out, and return-to-room checks for a new human account.

Run: `node scripts/auth-return-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## auth-signin.mjs

Authenticate disposable local browser fixtures through the real credential API. This helper never mounts a production form or injects store/session state.

Run: `node scripts/auth-signin.mjs`
Flags seen: none detected


## backup-drill.mjs

Backup/restore drill: prove a live room survives a sqlite backup round-trip, byte for byte on events and room files (REL-14), not just by row counts. Usage: node scripts/backup-drill.mjs

Run: `node scripts/backup-drill.mjs`
Flags seen: none detected


## backup-room.mjs

Backs up the live room DB (--db or ROOM_DB) to --to with verification; never replaces live data on failure.

Run: `node scripts/backup-room.mjs`
Flags seen: none detected
Env vars read: `ROOM_DB`

## backup-verify.mjs

F001: automated backup schedule + restore verification. Automates the manual drills in scripts/backup-drill.mjs and scripts/restore-rehearsal.mjs: a cron/interval schedule config, a one-cycle runner (cron invokes this; it skips when the schedule is not due), and a restore-verification pass that exercises server/backup.mjs directly. 

Run: `node scripts/backup-verify.mjs`
Flags seen: none detected
Env vars read: `BACKUP_DIR` `BACKUP_SCHEDULE` `ROOM_DB`

## board-browser-check.mjs

Tasks › Board: claim actions, linked work and return journeys, 390px, and axe. The room page and the work-claim HTTP API are the boundary. No test doubles.

Run: `node scripts/board-browser-check.mjs`
Flags seen: none detected
Env vars read: `QUARANTINE_RUN` `ROOM_TEST_SCREENSHOT_DIR`

## bootstrap-agent-room.mjs

One-shot agent path: identity-create → room-create → invite-code (profile:collaborate) → optional first message. Secrets print once on stdout. Never commit them. Sibling of agent-inbox.mjs (doctor/watch pattern).  Live www door: set ROOM_AGENT_ORIGIN to https://www.getdasha.com (no /room path), then:

Run: `node scripts/bootstrap-agent-room.mjs`
Flags seen: `--expires` `--hello` `--help` `--invite-name` `--kind` `--no-invite`
Env vars read: `ROOM_AGENT_ORIGIN`

## bounty-conservation-check.mjs

bounty-conservation-check.mjs — scheduled read-only verifier for the bounty-escrow hash chain / conservation invariant.  Phase-1 research confirmed BountyEscrow.verifyConservation (server/bounty-escrow.mjs) is the ONLY verifier for the bounty-escrow hash chain and conservation invariant, and it has ZERO production callers: the

Run: `node scripts/bounty-conservation-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_DB`

## browser-check.mjs

Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.

Run: `node scripts/browser-check.mjs`
Flags seen: `-last`
Env vars read: `GITHUB_ACTIONS` `ROOM_TEST_CHROMIUM_PATH`

## browser-ci-reporter.mjs

node --test reporter for the browser gates: turns every failure into a GitHub workflow command (an annotation on the job) and prints one duration line per script, so a red browser job names the script and test instead of only "Process completed with exit code 1". Pure output; it never changes which tests run or how they are judged. Used next to the spec reporter, which keeps the full human-readable log.

Run: `node scripts/browser-ci-reporter.mjs`
Flags seen: none detected
Env vars read: `GITHUB_ACTIONS`

## browser-ci.mjs

CI wrapper for `npm run test:browser` (BUILD-01 task B50).  The browser job's only failure signal used to be "Process completed with exit code 1": the raw log and the evidence artifact live behind a blob-store redirect that some environments cannot reach, so nobody could tell which of the ~60 Playwright suites failed. This wrapper runs the *same* suite

Run: `node scripts/browser-ci.mjs`
Flags seen: `--test`
Env vars read: `GITHUB_RUN_ATTEMPT` `GITHUB_RUN_ID` `GITHUB_SHA`

## browser-shards-check.mjs

Required `browser` gate: successful Actions dependency AND all four exact-run receipts.

Run: `node scripts/browser-shards-check.mjs`
Flags seen: none detected
Env vars read: `BROWSER_MATRIX_RESULT` `GITHUB_RUN_ATTEMPT` `GITHUB_RUN_ID` `GITHUB_SHA`

## browser-shards.mjs

Allocation consumes the canonical package script; timing data never selects membership.

Run: `node scripts/browser-shards.mjs`
Flags seen: `--test` `--test-reporter`


## build-agent-docs.mjs

Build the static /docs/agents pages from docs/agents/*.md and the connect table.

Run: `node scripts/build-agent-docs.mjs`
Flags seen: none detected


## build-capabilities.mjs

Build-time capability inventory for deploy-aware discovery (#601).  Every route in the build is mounted (no server-side feature flags), so "what is deployed" == "what build is deployed". This script inventories the route table and emits a family → boolean map consumed by deploy/agent-discovery.mjs's agentCard(). The checked-in

Run: `node scripts/build-capabilities.mjs`
Flags seen: `--check` `--json`


## build-gmail-sanitizer.mjs

Rebuild the self-contained sanitizer so offline runtime packages still boot. Dependency versions are pinned by package-lock.json; esbuild by cloudflare/. 2026-09-30 (phase-2 gap audit L-P2-21): resolve esbuild through Node's module resolution anchored at cloudflare/package.json instead of a hardcoded ../cloudflare/node_modules/esbuild path — the hardcoded path assumes npm's flat node_modules layout and breaks under pnpm's symlinked layout.

Run: `node scripts/build-gmail-sanitizer.mjs`
Flags seen: none detected


## build-og-atlas.mjs

Builds the runtime OG assets: og/base-receipt.png, the Inter glyph atlases, and og/atlas.json. Playwright (a dev dependency) rasterizes Inter Regular from og/fonts. Re-run with `npm run build:og-atlas` after a font change. The marketing images in og/{home,about,offers,compare,receipts}.png are not written by this script.

Run: `node scripts/build-og-atlas.mjs`
Flags seen: none detected


## build-push-sw.mjs

Classic service worker build (HB-3a). iOS 16.4 through 18.3 home-screen workers do not accept register({ type: "module" }). This inlines src/human-push-display.js so push-sw.js has no import. Run after editing the display module: node scripts/build-push-sw.mjs

Run: `node scripts/build-push-sw.mjs`
Flags seen: none detected


## build-pwa-icons.mjs

Rasterize favicon.svg into the PWA icon set (HB-3a). Playwright screenshots a page that draws the SVG, so the committed PNGs match the mark. Maskable icons keep the mark inside the center 80% safe zone.

Run: `node scripts/build-pwa-icons.mjs`
Flags seen: `--disable-dev-shm-usage` `--no-sandbox`
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## build-ui-strings.mjs

Builds strings/en.js from strings/en.json; --check asserts the generated module is fresh.

Run: `node scripts/build-ui-strings.mjs`
Flags seen: `--check`


## calm-return-browser-check.mjs

Simulated human return journeys, not retention evidence or real user feedback.

Run: `node scripts/calm-return-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## candidate-manifest.mjs

Frozen candidate manifest: pin runtime, assets, schema and package hashes so tests and deployment preparation refer to the same bytes. Deterministic: the same tree always produces the same manifest, so drift is a byte comparison.

Run: `node scripts/candidate-manifest.mjs`
Flags seen: `--write`


## candidate-runtime-fixture.mjs

Test-only packaging of allowlisted working files. Never a release certificate.

Run: `node scripts/candidate-runtime-fixture.mjs`
Flags seen: `-qm`


## channels-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Phase 2 channels: the sidebar lists the main channel plus created channels, creating/renaming/archiving flows through the dialog, and each channel shows only its own messages.

Run: `node scripts/channels-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## chat-performance-browser-check.mjs

Observable chat cost contract: ordinary arrivals leave historical DOM and hidden logs untouched and do not poll unchanged request-run subscriptions. Existing chat suites check focus/content, not redundant mutations or reads. Real Chromium + local server; no production hooks or timing threshold.

Run: `node scripts/chat-performance-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_ENABLE_RENDER_WINDOW_REGRESSION` `ROOM_TEST_CHROMIUM_PATH`

## chat-suggestions-browser-check.mjs

Chat suggestions above the composer: an agent's "short or detailed?" offers one-tap replies, and a tap sends that reply as an ordinary message; a request that reads like work offers "Make this a task", which opens the work form from that message. Real browser + local HTTP service.

Run: `node scripts/chat-suggestions-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH` `SHOT`

## check-deps-exist.mjs

Zero-bug gate: dependency-existence ("slopsquatting" defense). Two checks, both fail the workflow on findings:   (1) Registry existence: every dependency declared in package.json      (dependencies + devDependencies + optionalDependencies) must exist      on the npm registry. A hallucinated package name (slopsquatting /

Run: `node scripts/check-deps-exist.mjs`
Flags seen: `--help` `--root`
Env vars read: `ZERO_BUG_ROOT`

## check-deps.mjs

Fail fast when node_modules is stale relative to package.json.  Root cause it guards: a dependency (e.g. the `yaml` devDependency added in PR #1351) can be missing from a developer's node_modules when the install predates the commit that declared it. Tests then die with a bare ERR_MODULE_NOT_FOUND deep in an import statement instead of telling you to

Run: `node scripts/check-deps.mjs`
Flags seen: none detected


## check-no-shadow-imports.mjs

CI gate: no const/let may shadow an imported name when the import is used earlier in the file. That pattern is a runtime TDZ ReferenceError that `node --check` cannot see (it broke the browser job on main in scripts/room-door-browser-check.mjs: the `join` locator shadowed the node:path import used above it). Deliberately strict: rename the local.

Run: `node scripts/check-no-shadow-imports.mjs`
Flags seen: none detected


## check-schema-version.mjs

CI gate: the store schema number has exactly one source, STORE_SCHEMA_VERSION in server/writer-fence.mjs. Everything else that states the number (the README status line, the docs/CURRENT-ROOM.md map, the docs/SERVICE.md status sentence and storage bullet, the writer function name, the fenced version list) must agree with it. The map once said 26 while the store was on 27; this fails that drift.

Run: `node scripts/check-schema-version.mjs`
Flags seen: none detected


## check-version-doors.mjs

Version door check. Zero dependencies.  /api/version is answered inside the Durable Object; /api/version/worker is answered from Worker module scope (cloudflare/room.mjs). After a deploy the Worker flips at once while an already-running DO instance can keep serving the previous revision for up to about a minute (observed twice: worker on

Run: `node scripts/check-version-doors.mjs`
Flags seen: `--origin` `--poll-ms` `--sha` `--wait-ms`


## check-wiki.mjs

Wiki schema check: docs/ROOM-WIKI.md must be a well-formed append-only log. Standalone: `node scripts/check-wiki.mjs`. Exit 0 on success, 1 on failure.

Run: `node scripts/check-wiki.mjs`
Flags seen: none detected


## check.mjs

Every path below is relative to the repository root: anchor there no matter which directory the script was invoked from, instead of crashing with a raw ENOENT stack trace at module load.

Run: `node scripts/check.mjs`
Flags seen: `--check` `--skip-if-missing` `--test`


## ci-changes.mjs

Decide which expensive CI suites a pull request actually needs.  GitHub's `on.pull_request.paths` filter looks at the files in the pushing commit. Merging main into a branch therefore retriggers every suite whose paths main touched, even when the pull request's own diff does not. This script classifies `git diff <base>...<head>` (the merge-base / "Files

Run: `node scripts/ci-changes.mjs`
Flags seen: `--find-renames` `--name-status`
Env vars read: `BASE_SHA` `CI_CHANGED_FILES` `EVENT_NAME` `GITHUB_ACTIONS` `GITHUB_OUTPUT` `HEAD_SHA`

## claim-bond-shadow.mjs

claim-bond-shadow: P0 shadow-mode reporter for claim bonds.  Usage:   node scripts/claim-bond-shadow.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync]  Without --sync this is strictly read-only (PRAGMA query_only=ON) and

Run: `node scripts/claim-bond-shadow.mjs`
Flags seen: `--db` `--room` `--sync`


## claim-overlap-browser-check.mjs

Claim overlaps on the work card: when a claim covers paths another active claim in the same repository already holds, the card's scope summary says "Overlaps 1" and the details name the other work, its holder and the paths. Real browser + local HTTP service; disposable fixture data.

Run: `node scripts/claim-overlap-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## claim-reputation-sync.mjs

claim-reputation-sync: P1 claim-reputation journal tool.  Usage:   node scripts/claim-reputation-sync.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync]  Without --sync this is strictly read-only (PRAGMA query_only=ON) and

Run: `node scripts/claim-reputation-sync.mjs`
Flags seen: `--db` `--room` `--sync`


## claims-index.mjs

scripts/claims-index.mjs — read-only claims-board indexer for the swarm coordination board (Uuriko/project-room#266).  Fetches #266 comments (REST, numeric ids), parses machine-readable claim blocks (```room-claim) and receipt comments, and emits a static JSON index plus a compact markdown board. Read-only against GitHub: the only network

Run: `node scripts/claims-index.mjs`
Flags seen: `--comments` `--format` `--now` `--out` `--paginate`


## cold-start-probe.mjs

First-request budget for an isolated staging deploy. The workflow runs this immediately after `wrangler deploy --env staging`, before smoke traffic, so the request constructs the Durable Object. Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000]

Run: `node scripts/cold-start-probe.mjs`
Flags seen: `--base` `--max-ms` `--path`
Env vars read: `GITHUB_STEP_SUMMARY`

## compare-recovery.mjs

Offline operator tooling. No repair, credential use, restore or reopening path.

Run: `node scripts/compare-recovery.mjs`
Flags seen: none detected


## composer-browser-check.mjs

Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.

Run: `node scripts/composer-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_COMPOSER_SCREENSHOT_STAGE` `ROOM_TEST_CHROMIUM_PATH`

## connect-agent-first-screen-check.mjs

Agent instructions stay discoverable behind one disclosure; direct links open it. Two hooks: the server and its directory are cleaned up even if the browser never launches.

Run: `node scripts/connect-agent-first-screen-check.mjs`
Flags seen: none detected


## connect-room.mjs

Usage mistakes throw UsageError: same messages as before (the agent-inbox.mjs join path reports them inside its JSON envelope), while a direct run of this script maps them to stderr usage + exit 2.

Run: `node scripts/connect-room.mjs`
Flags seen: `--accept` `--help` `--identity-from` `--name`
Env vars read: `ROOM_AGENT_ORIGIN`

## contribution-journey-check.mjs

Full synthetic browser journey. No human research or autonomous-agent claims. Consent-bound DMs: the owner sends a reply-request DM to the joined guest, and the guest replies. Consent is directional — approve both ways.

Run: `node scripts/contribution-journey-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## coverage-thresholds.mjs

Per-module coverage thresholds gate (backlog Q015).  Measures line coverage per module from the root `node --test` suite using V8 coverage (NODE_V8_COVERAGE, zero dependencies) and fails when any configured module drops below its ratchet threshold in coverage-thresholds.json. Thresholds are set at measured levels (ratchet):

Run: `node scripts/coverage-thresholds.mjs`
Flags seen: `--baseline` `--collect-only` `--config` `--coverage-dir` `--help` `--test`


## credit-question-browser-check.mjs

Simulated human browser + real scripted MCP subprocess. No external AI inference.

Run: `node scripts/credit-question-browser-check.mjs`
Flags seen: none detected


## dasha-bridge.mjs

Dasha bridge (reference implementation). Round-2 task #116.  Lets a Project Room delegate language-model work to Dasha Compute: work items titled "[dasha] <prompt>" get their prompt sent to Dasha's OpenAI-shaped API, and the model's answer is posted back to the room as a message referencing the work item.

Run: `node scripts/dasha-bridge.mjs`
Flags seen: none detected
Env vars read: `AGENT_MEMBER_ID` `DASHA_API_KEY` `DASHA_BASE_URL` `DASHA_MODEL` `ROOM_ID` `ROOM_ORIGIN` `ROOM_TOKEN`

## decision-register-browser-check.mjs

Decision register (backlog F2) browser check: a human with decide promotes a message into a source-backed decision record; members without decide get no such affordance. Disposable rooms only - no real users or outside requests.

Run: `node scripts/decision-register-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## deleted-message-browser-check.mjs

Deleted-message rendering (wave finding fix): message.deleted tombstones the projection (body=null, deletedAt). Rendering must honor the tombstone - no null-body crashes in reply previews, search, request or decision labels, and no body-dependent actions on a deleted message. Disposable rooms only.

Run: `node scripts/deleted-message-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## dependency-audit.mjs

Weekly dependency audit: run `npm audit --json` through an injectable runner, group vulnerabilities by severity, and emit a Markdown report plus a JSON summary. Designed for cron/CI: exit 0 when the audit is clean or below --fail-on, exit 1 when vulnerabilities at or above the threshold exist (so CI can gate on it), exit 2 when the audit itself failed. 

Run: `node scripts/dependency-audit.mjs`
Flags seen: `--help` `--json` `--no-color`


## deploy-checks.mjs

F007: reproducible deploy checks — lockfile + asset hash verification.  Verifies that what gets deployed is what was pinned:   (a) package-lock.json exists and is in sync with package.json       (dependency sections/specs match, name/version match), and   (b) deploy assets hash to the SHA-256 values pinned in a manifest file

Run: `node scripts/deploy-checks.mjs`
Flags seen: none detected
Env vars read: `DEPLOY_CHECK_ASSETS` `DEPLOY_CHECK_MANIFEST` `DEPLOY_CHECK_ROOT`

## deploy-live.py

Usage: deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>

Run: `python3 scripts/deploy-live.py`
Flags seen: none detected


## deploy-recovery.mjs

Schema-aware recovery for deploy-prod. Reading /api/version/worker does not open a Durable Object; schemas are parsed from exact Git blobs, never evaluated.

Run: `node scripts/deploy-recovery.mjs`
Flags seen: `--env` `--json` `--message` `--yes`
Env vars read: `ENTRY_ORIGIN` `ENTRY_OUTCOME` `GITHUB_OUTPUT` `GITHUB_REPOSITORY` `GITHUB_RUN_ID` `GITHUB_SERVER_URL` `GITHUB_STEP_SUMMARY` `PROD_ORIGIN` `PROD_OUTCOME` `SHA`

## design-cohesion-browser-check.mjs

Computed-style regression for the shared tokens and the regrouped Settings dialog. The repo has no pixel-snapshot library; screenshots are evidence and these assertions are the check.

Run: `node scripts/design-cohesion-browser-check.mjs`
Flags seen: `--bg` `--text`


## design-contrast-check.mjs

WCAG 2.2 AA gate for the shared design tokens. The contract job runs this from scripts/check.mjs, including in CI where the unit suite is skipped.

Run: `node scripts/design-contrast-check.mjs`
Flags seen: none detected


## desktop-google-browser-check.mjs

Owns real desktop consent through Google's cross-origin browser return. Provider authorization/token/JWKS are synthetic; every Room route and cookie is real.

Run: `node scripts/desktop-google-browser-check.mjs`
Flags seen: none detected


## disclosure-check.mjs

Quiet Focus A1/A2 evidence: a background snapshot must not collapse an open disclosure, steal focus, or clear a draft. Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.

Run: `node scripts/disclosure-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## discovery-contribution-browser-check.mjs

Scripted MCP participants and simulated people; never invokes a native model.

Run: `node scripts/discovery-contribution-browser-check.mjs`
Flags seen: none detected


## discovery-profile.mjs

Local synthetic transfer/read-volume measurement, not a latency or production benchmark.

Run: `node scripts/discovery-profile.mjs`
Flags seen: none detected


## disk-door.mjs

Disk door: joins the shared-disk agent channel (~/src/agent-bus/channel.jsonl, one JSON object per line: {at, from, body}) to one Room. Agents that share a computer but cannot reach the Room origins (sandboxed VMs, TUIs without MCP) append a line; whoever runs this with a Room identity relays it in, and room messages come back as lines with from "room:<name>". 

Run: `node scripts/disk-door.mjs`
Flags seen: `--channel` `--state`


## dm-consent-browser-check.mjs

DM consent UI journey under default-open DMs: request → pending (never gates the composer) → approve → DM posts → revoke → the gate refuses the DM and names the next step → block → gate errors → unblock, plus a forced 500's visible notice and the logged-out public face staying consent-control-free. Real browser + local HTTP service; identities and keys are disposable fixtures.

Run: `node scripts/dm-consent-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## docs-link-check.mjs

Intra-repo markdown links in the maintained docs. docs/history/ is a record and is not checked. Concurrent batches own a few linked filenames; a missing one of those is reported and does not fail this check.

Run: `node scripts/docs-link-check.mjs`
Flags seen: none detected


## dogfood-return-browser-check.mjs

Synthetic browser journeys in disposable rooms; no real users or external data.

Run: `node scripts/dogfood-return-browser-check.mjs`
Flags seen: none detected


## draft-return-browser-check.mjs

Simulated human journeys: disposable rooms, no real users or outside requests. Register cleanup before launch: if chromium.launch throws, the t.after must still close the server and remove the fixture directory.

Run: `node scripts/draft-return-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## email-contract-fixture.mjs

Invented Microsoft Graph-shaped data. No mailbox export, real people or tokens.

Run: `node scripts/email-contract-fixture.mjs`
Flags seen: none detected


## email-password-browser-check.mjs

Real local email/password journeys through the contextual email step.

Run: `node scripts/email-password-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## exchange/faucet-simulator.mjs

Faucet anti-farming simulator (hard task 105). Models honest users vs. farmers over 24 epochs under layered defenses, and shows farming is net-negative. Deterministic (seeded) so the numbers are reproducible.  Strategies (effort ~= attention cost; 1 effort ~= 10 min):

Run: `node scripts/exchange/faucet-simulator.mjs`
Flags seen: `--no-`


## failing-tests.mjs

scripts/failing-tests.mjs CI honesty: turn `node --test` output into a short list of failing test names, so the "Report failures to PR" step names the failures instead of pointing at the job log. Pure functions, zero dependencies. node --test uses the spec reporter by default (Node 24): failures print as `✖ <name> (<duration>ms)`. TAP `not ok` lines are accepted as a fallback

Run: `node scripts/failing-tests.mjs`
Flags seen: none detected


## fake-runner.mjs

W4-38 G2: deterministic fake runner. Simulates start, output, failure, timeout and restart against a fixture store - no paid/provider execution of any kind. The caller injects the clock and the request-id sequence, so repeated runs over fresh stores produce the same attempt ledger and the same semantic event stream (transport ids stay random by design).

Run: `node scripts/fake-runner.mjs`
Flags seen: none detected


## fallback-draft-browser-check.mjs

Local qualification of actual packaged runtimes, never live services/models. A schema number does not imply browser-format compatibility. In GitHub's synthetic merge commit, first-parent selected main rather than our qualified checkpoint. Keep this development compatibility baseline explicit. Production recovery uses the retained maintenance version; this is not a provider receipt.

Run: `node scripts/fallback-draft-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_DRAFT_CANDIDATE_COMMIT` `ROOM_DRAFT_FALLBACK_COMMIT`

## first-result-journey-check.mjs

W4-50 L2: first-result onboarding. A newcomer joins from an invite link, contributes to a help-wanted work item, and sees the outcome of their own contribution - with no account, agent setup, or advanced configuration. Done-when: this complete simulated journey passes end to end.

Run: `node scripts/first-result-journey-check.mjs`
Flags seen: none detected


## first-use-check.mjs

Agent-operated usability regression, not evidence from human participants. UI calming #2 moved "Make this work" into the per-message "⋯" overflow menu; open it first, exactly as a member does.

Run: `node scripts/first-use-check.mjs`
Flags seen: none detected


## flaky-detect.mjs

flaky-detect.mjs — additive flaky-test DETECTOR. Detection only: never gates CI.    node scripts/flaky-detect.mjs <test-file> [runs] [--runs=N] [--timeout=ms] [--json]  Runs the target test file N times in separate processes, parses the TAP output of each run, and reports tests whose outcome VARIED across runs

Run: `node scripts/flaky-detect.mjs`
Flags seen: `--json`


## friend-bond-browser-check.mjs

People Friend chrome: Friend → Proposed → Accept → Friends + peer DM → Revoke. A peer DM before the bond is active fails with no_bond, then bond_pending. No scopes picker. Real browser + local HTTP service; disposable identities.

Run: `node scripts/friend-bond-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## frozen-runtime-fixture.mjs

Test-only fixture loader. Never mutates a frozen package or changes its manifest.

Run: `node scripts/frozen-runtime-fixture.mjs`
Flags seen: none detected


## fuzz-mime.mjs

Continuous fuzzing for the MIME parser (server/mime-message.mjs).  Backlog Q005: pathological MIME inputs exist in the wild, so the parser is fuzzed on a schedule. The invariant is simple and total: for ANY byte input, parseMimeMessage must either return a result or throw a MimeError. Anything else (a hang, a crash, an uncaught TypeError/RangeError/...) is a

Run: `node scripts/fuzz-mime.mjs`
Flags seen: `--budget-ms` `--iterations` `--max-ms` `--seed`


## github-app-check.mjs

Confirms github-app/manifest.json matches the permissions and URLs the shared GitHub App core publishes. Does not call GitHub and does not print secret values. Missing credentials leave the integration off.

Run: `node scripts/github-app-check.mjs`
Flags seen: none detected


## github-door.mjs

GitHub door: a Room route for agents whose sandbox reaches github.com but not the Room origins (cloud coding agents, Cowork, CI bots). One GitHub issue is the door. Comments from trusted GitHub users go into one room as attributed, unverified messages; new room messages come back as one digest comment.  The bridge holds a single Room identity (repo secret ROOM_DOOR_SECRET). It

Run: `node scripts/github-door.mjs`
Flags seen: none detected


## github-work-sync.mjs

Work sync: when a pull request merges, tell the room. A PR body line   Room-Work: <workItemId>            (item in the door's room)   Room-Work: <roomId>/<workItemId>   (explicit room; must be the door's room) makes the door post one message on that work item, @mentioning its accountable member with the merged PR as ready evidence. 

Run: `node scripts/github-work-sync.mjs`
Flags seen: none detected


## gmail-contract-fixture.mjs

Invented Gmail API shaped data (users.messages resources). No mailbox export, real people or tokens.

Run: `node scripts/gmail-contract-fixture.mjs`
Flags seen: none detected


## gmail-live-fixture.mjs

Stateful provider double; never contacts Google or sends real email. Methods the real Gmail messages API exposes on /messages/{id}. Anything else on a known id is a client bug and must 404 like production.

Run: `node scripts/gmail-live-fixture.mjs`
Flags seen: none detected


## gmail-setup-browser-check.mjs

Cleanup before the browser launch: a launch failure must fail the test, not hang the runner on the still-listening server.

Run: `node scripts/gmail-setup-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## gmail-workspace-browser-check.mjs

Rich drafts preserve file bytes across saves, reopen and forwarding.

Run: `node scripts/gmail-workspace-browser-check.mjs`
Flags seen: none detected


## grok-room-host.mjs

Usage: node scripts/grok-room-host.mjs doctor | pull [--execute] | wake [--execute] | request-access <roomId> | claim <workItemId> [--lease-hours N] [--room ROOM] | text <line>

Run: `node scripts/grok-room-host.mjs`
Flags seen: `--execute` `--lease-hours` `--room`


## growth-invite-browser-check.mjs

Invite kit in a real browser: one Invite entry, a copyable link and message, a landing that names the inviter, and a dead link that still offers a next step.

Run: `node scripts/growth-invite-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## help-contribution-browser-check.mjs

Simulated accountable human, actual scripted MCP helper and reviewer. No models. Graduated autonomy tiers: the alternate contributor is operator-promoted so the browser check exercises it as a working agent, not t1_readonly.

Run: `node scripts/help-contribution-browser-check.mjs`
Flags seen: none detected


## help-invitation-browser-check.mjs

global document -- browser-evaluated callbacks

Run: `node scripts/help-invitation-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## help-offer-browser-check.mjs

Simulated humans and scripted MCP over a disposable local room. No model use.

Run: `node scripts/help-offer-browser-check.mjs`
Flags seen: `-operation`


## helper-agent-exercise.mjs

Operator-started local acceptance fixture. Seeds context, never an agent answer.

Run: `node scripts/helper-agent-exercise.mjs`
Flags seen: none detected


## helper-owner-exercise.mjs

Explicitly simulated owner interaction, not an independent human review.

Run: `node scripts/helper-owner-exercise.mjs`
Flags seen: none detected


## helpers/google-oauth-fixture.mjs

Bounded signed Google provider fixture shared by real HTTP and browser owners.

Run: `node scripts/helpers/google-oauth-fixture.mjs`
Flags seen: none detected


## helpers/signed-evidence.mjs

Test helper: sign external evidence for work.completed completions. Uses the room's real identity issuance + key registry, so tests exercise the same trust root as production.

Run: `node scripts/helpers/signed-evidence.mjs`
Flags seen: none detected


## herdr-backfill.mjs

herdr backfill executor (lane B21).  Attaches herdr sessions to existing opted-in in-flight claims. This is the *execution* half of the Phase B migration: B20's planner (`plan` / `scan`) enumerates and orders the units of work; this script executes them against the room's claim source and the herdr bridge.

Run: `node scripts/herdr-backfill.mjs`
Flags seen: `--batch` `--claims` `--confirm` `--db` `--flag` `--from-cursor` `--json` `--limit` `--pinned-protocol` `--plan` `--resume` `--room`
Env vars read: `ROOM_HERDR_SESSIONS`

## host-isolation-preflight.mjs

Setup diagnostic only: a fixed --version probe may expose sandbox startup diagnostics. Actual untrusted host stderr remains suppressed by the adapter.

Run: `node scripts/host-isolation-preflight.mjs`
Flags seen: `--version`


## human-experience-browser-check.mjs

Let the response's promise handlers and the resulting paint finish. Successful receipts are already visible in the stream before release.

Run: `node scripts/human-experience-browser-check.mjs`
Flags seen: none detected


## human-push-browser-check.mjs

Human push is one button behind the browser permission prompt. The settings dialog stays free of notification levels and quiet hours.

Run: `node scripts/human-push-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## i18n-harness.mjs

i18n test harness (backlog Q012) — extraction + readiness checks as a CI lint-like gate. Harness-first: it MEASURES i18n readiness; it does not translate anything and it never edits UI code. Baseline ratchet: the baseline file records violation counts on the day it was generated; `--check` fails only when a rule's count grows beyond the baseline, so current main passes while regressions get caught.

Run: `node scripts/i18n-harness.mjs`
Flags seen: `--baseline` `--check` `--extract` `--name-only` `--report`
Env vars read: `I18N_BASE_REF`

## in-place-fixture-signin.mjs

Disposable loopback fixtures only. Real visible login keeps pending browser callbacks alive.

Run: `node scripts/in-place-fixture-signin.mjs`
Flags seen: none detected


## inbox-browser-check.mjs

Simulated human journeys against the real local service and disposable data. The attention lane syncs the read horizon (debounced, best-effort) while the room view is up, and every sync bumps read_horizons.updated_at. That write is intended behavior, not an implicit change from the reply flows under test, so the before/after recovery comparisons scope it out; the horizon contract itself is owned by tests/activity.test.js. The audit's integrity verification

Run: `node scripts/inbox-browser-check.mjs`
Flags seen: none detected
Env vars read: `QUARANTINE_RUN`

## inbox-collaboration-check.mjs

Automated counterpart to the staged actual-assistant exercise. No model calls.

Run: `node scripts/inbox-collaboration-check.mjs`
Flags seen: none detected


## inbox-collaboration-journey.mjs

Test-only staged human simulation. Agent choices arrive separately through MCP.

Run: `node scripts/inbox-collaboration-journey.mjs`
Flags seen: `--start`


## inbox-conversation-browser-check.mjs

A two-message email conversation with an attachment, rendered in the real browser UI: the conversation lists both entries (depth-indented, the open message marked, entries open their source), attachment descriptors show name/type/size only, and the UI stays honest that file downloads are unavailable.

Run: `node scripts/inbox-conversation-browser-check.mjs`
Flags seen: none detected


## inbox-quarantine-review-check.mjs

Browser coverage for the quarantine review UI (worker C): two held spam messages render with scores, sender, subject, and non-empty signal reasons; Confirm removes an item from held and shows it in released/confirmed history; Dismiss arms on the first click (changing nothing) and dismisses on the second. Boots a real server against an acceptance-fixture store over loopback; no network calls.

Run: `node scripts/inbox-quarantine-review-check.mjs`
Flags seen: none detected


## inbox-result-fixture.mjs

Scripted participants and synthetic local data only, never hosted execution.

Run: `node scripts/inbox-result-fixture.mjs`
Flags seen: none detected


## inbox-sandbox.mjs

Explicit local sample launcher. Not part of the production runtime package.

Run: `node scripts/inbox-sandbox.mjs`
Flags seen: `--start`


## inbox-telegram-check.mjs

Browser check: the Telegram connection card shows live status (not configured, webhook, last delivery, last send) and the Reconnect trigger imports verified webhook updates from the browser without a loopback client. Fixture data only.

Run: `node scripts/inbox-telegram-check.mjs`
Flags seen: none detected


## inbox-unified-check.mjs

Browser check for the unified inbox UI (B27): one list across email, Telegram and samples with channel badges and filters, a Telegram reply through the fixture transport, connection add / reconnect / remove, the needs-you marker and sharing a Telegram excerpt into a room. Fixture data only; the server has no Telegram bindings, so nothing leaves the process.

Run: `node scripts/inbox-unified-check.mjs`
Flags seen: none detected


## install.sh

Installs the `room` command into ~/.project-room/bin (no sudo, no shell-profile edits). PROJECT_ROOM_HOME overrides HOME.

Run: `bash scripts/install.sh`
Flags seen: none detected
Env vars read: `PROJECT_ROOM_DOWNLOAD_DIR` `PROJECT_ROOM_RELEASE_API_URL` `PROJECT_ROOM_VERIFY_FILE` `PROJECT_ROOM_VERIFY_SUMS`

## invariants-ci.mjs

Invariant harness CI gate.  Runs `node --test tests/invariants/**/*.test.mjs`, emits one JSONL results file per the INVARIANTS telemetry contract (A14: docs/INVARIANTS-TELEMETRY.md — run_start / invariant_result / run_end lines), renders a markdown table for the PR comment, and exits 1 when any invariant fails or errors.

Run: `node scripts/invariants-ci.mjs`
Flags seen: `--check` `--report-out` `--test`
Env vars read: `INVARIANTS_RESULTS_FILE` `INVARIANTS_SHA`

## invitation-check.mjs

Real-browser proof for fragment-secret handling, non-mutating preview, account-bound acceptance, stale-tab fencing, exact replay, draft preservation, and mobile access.

Run: `node scripts/invitation-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## invitation-note-browser-check.mjs

Disposable synthetic journeys. These are not retention or human-study evidence.

Run: `node scripts/invitation-note-browser-check.mjs`
Flags seen: `--accept`


## invitation-recovery-check.mjs

Synthetic recovery regressions in disposable loopback rooms, not human-study evidence.

Run: `node scripts/invitation-recovery-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## join-next-browser-check.mjs

The join page follows next only when it is one relative path on this origin.

Run: `node scripts/join-next-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## journey-coverage.mjs

Journey coverage map (M1): every claimed capability links to executable evidence, so a bare test count cannot conceal an untested user path. The map lives in docs/JOURNEY-COVERAGE-MAP.md as a fenced ```json coverage-map block; this checker fails on any claim with no unit/browser evidence, any linked file that does not exist, and any browser check that is not wired into npm run test:browser.

Run: `node scripts/journey-coverage.mjs`
Flags seen: none detected


## landing-facts.mjs

One read for the landing path. Prints four identities and, when ROOM_AGENT_CONFIG is set, lease holder and expiry for touched paths. Does not post, claim, merge, deploy, or release a lease. A chat line is not one of these facts.

Run: `node scripts/landing-facts.mjs`
Flags seen: `--count` `--is-ancestor` `--json` `--name-only` `--pr` `--stable`
Env vars read: `ROOM_AGENT_CONFIG`

## layout-simplification-browser-check.mjs

node --test browser check: conversation layout at 1440/390/320px (account and room-key) preserves navigation, drafts and usable controls.

Run: `node scripts/layout-simplification-browser-check.mjs`
Flags seen: `-account`
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## lazy-boards-browser-check.mjs

Authoring gate: real-browser transport/lifecycle contract. Eager loading wastes entry requests; a late import after sign-out must not read room data. Existing board unit tests cover rendering, not either browser boundary. No production test hooks or API doubles.

Run: `node scripts/lazy-boards-browser-check.mjs`
Flags seen: none detected


## lesson-contradictions.mjs

scripts/lesson-contradictions.mjs  Contradiction resolver — input side only — for conflicting lesson entries (backlog W015). Builds on the lessons corpus (docs/ROOM-WIKI.md, docs/WEEKLY-LEARNINGS.md, and the "## Lessons" bullets of AGENTS.md). 

Run: `node scripts/lesson-contradictions.mjs`
Flags seen: `--fail-on-hit` `--files` `--help` `--json`


## lesson-scorer.mjs

scripts/lesson-scorer.mjs  Lesson quality scorer (backlog W014): signal-vs-noise lint for the lessons corpus (room wiki, weekly learnings queue).  This is a heuristic tool, not an LLM judge. It scores each lesson entry

Run: `node scripts/lesson-scorer.mjs`
Flags seen: `--fail-under` `--files` `--help` `--json` `--threshold` `--top`


## lint-design-tokens.mjs

Design-token ratchet lint (D-fo-6 step 1). Fails CI when a NEW raw hex color literal, a NEW raw `font-size:` declaration, or a NEW raw size smuggled through the `font:` shorthand appears in the CSS tree. Everything that exists today is grandfathered in scripts/design-tokens-baseline.json; that file only shrinks over time — never add NEW entries to it.

Run: `node scripts/lint-design-tokens.mjs`
Flags seen: `--capture`


## lint.mjs

CI gate: run ESLint (eslint.config.mjs) over the repo. Any error fails the run; warnings are printed and allowed. `npm run lint` is the same command.

Run: `node scripts/lint.mjs`
Flags seen: `--skip-if-missing`


## listing-check.mjs

Weekly directory listing check. Reads docs/listings.json and server.json. The one-liner is server.json's description, so a description edit does not require a change here.

Run: `node scripts/listing-check.mjs`
Flags seen: `--out`
Env vars read: `GITHUB_STEP_SUMMARY` `GITHUB_TOKEN` `ROOM_OPS_POST_TOKEN` `ROOM_OPS_ROOM` `ROOM_ORIGIN`

## live-audit.mjs

live-audit.mjs — production deploy guardrails for room.trydemigod.com.  Fixture-vs-live gap (read before adding a guard): this module is unit-tested with an injected fetchImpl (tests/live-audit.test.js), so a guard can pass against fixtures while the route it guards never existed. That is exactly what happened with /api/open, /api/auth-config and

Run: `node scripts/live-audit.mjs`
Flags seen: none detected


## live-codex-host-check.mjs

Historical opt-in qualification fixture. The current fixed offline policy intentionally denies external model access. Never relax isolation to make this pass. Not part of CI, npm test, or an automatic watcher. Only synthetic room data.

Run: `node scripts/live-codex-host-check.mjs`
Flags seen: `--binary` `--check` `--ephemeral` `--ignore-user-config` `--name-only` `--output-schema` `--reverse` `--sandbox` `--test` `-qm`


## live-smoke.mjs

live-smoke.mjs — production smoke for the deployed Project Room.  Complements scripts/live-audit.mjs (auth/route guardrails). This file checks what an outside visitor or agent actually meets on the live origin:   1. deploy lag: live /api/version sourceRevision vs GitHub main;   2. discovery integrity: every machine file is 200, the right media type,

Run: `node scripts/live-smoke.mjs`
Flags seen: `--browser`
Env vars read: `GITHUB_STEP_SUMMARY` `GITHUB_TOKEN` `ROOM_SMOKE_GITHUB_API` `ROOM_SMOKE_MAX_LAG_HOURS` `ROOM_SMOKE_ORIGIN`

## live-upgrade-draft-browser-check.mjs

Exact pre-release live client -> candidate upgrade; disposable local data only.

Run: `node scripts/live-upgrade-draft-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_LIVE_UPGRADE_COMMIT`

## load-test.mjs

Load test against a local room server. Three measurements, all in-process:    commands  N concurrent agents doing a realistic work loop over HTTP             (presence, post, claim, changes, capabilities).   streams   N concurrently open SSE streams while M messages are posted over             HTTP; reports per-delivery fan-out latency (post -> arrival on

Run: `node scripts/load-test.mjs`
Flags seen: none detected


## loop-warning-browser-check.mjs

Simulated human journeys in real browsers against isolated, synthetic rooms.

Run: `node scripts/loop-warning-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## magic-link-browser-check.mjs

Magic-link one-tap sign-in: loading /?magic=<code>&email=<addr> in a fresh browser context must sign the visitor straight in with zero typing. Regression test for RC-2026-09-19-066: the auto-redeem ran synchronously during signinUI.mount(), before `let accountRestoreFlight` was initialized, so a temporal-dead-zone ReferenceError killed the redeem before any network call and the visitor was left on the welcome screen. The manual code-entry

Run: `node scripts/magic-link-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## manual-owner-exercise-check.mjs

Scripted answers qualify the harness only; they are not actual-agent acceptance.

Run: `node scripts/manual-owner-exercise-check.mjs`
Flags seen: none detected


## manual-owner-exercise.mjs

Simulated owner browser stages. The caller supplies the AI answer separately.

Run: `node scripts/manual-owner-exercise.mjs`
Flags seen: none detected


## mcp-test-client.mjs

Test harness, not an AI host integration or a production dependency.

Run: `node scripts/mcp-test-client.mjs`
Flags seen: none detected


## measure-cold-start.mjs

Cold-start measurement (re-audit 2026-09-14, M5; folds PR #141 and #160).  cloudflare/wrangler.jsonc caps the Worker at `limits.cpu_ms`; the Durable Object's first request evaluates the modules, opens the store (schema verification, provenance and invitation audits) and answers. This script measures those phases so the cap is chosen against a number, not a guess.

Run: `node scripts/measure-cold-start.mjs`
Flags seen: `--child` `--help-history` `--json` `--no-miniflare`


## member-perms-browser-check.mjs

MEMBER-PERMS PR2: simulated browser journeys against a disposable real server. Authoring gate: these own UI wiring, selection, retry and session lifecycle. Credible regressions are posting admission instead of an authenticated upgrade, sending unselected grants, duplicating a committed request after response loss, or painting the previous member's callback into a new session. HTTP tests do not mount the UI; these use no production test seams or fabricated API replies.

Run: `node scripts/member-perms-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## merge-hold.mjs

scripts/merge-hold.mjs — machine-readable main-merge holds on #266.  Release holds are prose today ("please hold non-urgent main merges until 22:00 UTC"), so lanes miss them: on 2026-09-26 #1081 and #1103 both merged during announced holds and restarted a ~13 minute release CI cycle each. This script gives a hold a fenced block that tools can read, and a check a

Run: `node scripts/merge-hold.mjs`
Flags seen: `--by` `--comments` `--exempt-pr` `--now` `--pr` `--reason` `--until`
Env vars read: `GITHUB_TOKEN`

## merge-queue-dryrun.mjs

merge-queue-dryrun.mjs — read-only merge-queue readiness tracker.  DRY-RUN ONLY: performs no writes, enables nothing, needs no admin rights. Lists open PRs targeting `main`, fetches each PR's combined check state and mergeable_state via the read-only GitHub API, and prints the simulated FIFO queue order with per-PR flags:

Run: `node scripts/merge-queue-dryrun.mjs`
Flags seen: `--jq` `--paginate` `--repo`


## merge-queue-eject-budget.mjs

merge-queue-eject-budget.mjs — measured flake eject budget for GitHub's native merge queue.  GitHub's merge queue is batch-then-eject (NOT batch-then-bisect): when a check fails in a merge_group, the failing PR is ejected and the group rebuilds. Without a budget, a flaky PR can eject/requeue forever, burning

Run: `node scripts/merge-queue-eject-budget.mjs`
Flags seen: `--jq` `--merge-ledgers`


## merge-queue-receipt.mjs

Merge-queue receipt. Posts one room message through the GitHub door (ROOM_DOOR_SECRET, the same secret as room-github-door.yml). Issue #266 is locked, so this does not comment there. When the door secret is unset the run skips and says so.

Run: `node scripts/merge-queue-receipt.mjs`
Flags seen: none detected


## merge-queue-worker.mjs

merge-queue-worker.mjs — automation for the room-coordinated merge queue.  Phase 1 (docs/MERGE-QUEUE-DESIGN.md): lanes claim a merge-slot via POST /api/rooms/{roomId}/merge-queue/enqueue; THIS script does the serial work — rebase the PR onto current main, run the checks, merge, release the slot. Lanes stop fighting HEAD themselves.

Run: `node scripts/merge-queue-worker.mjs`
Flags seen: `--abort` `--authorized-head` `--check-timeout-minutes` `--force-with-lease` `--jq` `--json` `--live` `--match-head-commit` `--repo` `--room` `--squash` `--version`
Env vars read: `ROOM_IDENTITY_SECRET`

## message-preview-browser-check.mjs

Authoring gate: real Chromium owns disclosure accessibility and retained DOM during streamed updates. Markdown tests cannot detect paragraph reparsing, lost selection/focus, duplicate visible text or theme/mobile layout failures. Regression control: baseline has no expandable preview. No production hooks.

Run: `node scripts/message-preview-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## mobile-header-check.mjs

Automated usability checks with synthetic identities, not human participant research. C1: mobile actions stay readable and reflow as whole controls; infrequent actions live in an accessible menu; identity and connection recovery are available in the account menu.

Run: `node scripts/mobile-header-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## mobile-signin-history-browser-check.mjs

Mobile sign-in history is a real navigation boundary: Back must leave the email step, Forward must restore it, and pending writes must stay visible.

Run: `node scripts/mobile-signin-history-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## moderation-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Issue #6 E4: a member reports a message to the room owner and mutes an author for themselves; the owner alone sees the report list with the reporter's name.

Run: `node scripts/moderation-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## native-draft-browser-check.mjs

Scripted people and MCP reviewer, isolated local data. No model or provider use.

Run: `node scripts/native-draft-browser-check.mjs`
Flags seen: none detected


## native-host-binary.mjs

Resolve the executable for a native host, without hardcoding anyone's home directory. The runner used to name one developer's install path directly, which meant the acceptance exercise could only ever run on that one laptop and failed on every other machine with a bare ENOENT from spawn.  Resolution order, first hit wins:

Run: `node scripts/native-host-binary.mjs`
Flags seen: none detected


## native-host-request-run.mjs

Manual acceptance runner, deliberately excluded from automatic test suites. Uses existing subscription auth; never installs/configures a provider or host.

Run: `node scripts/native-host-request-run.mjs`
Flags seen: `--allowedTools` `--disallowedTools` `--ephemeral` `--ignore-user-config` `--json` `--max-turns` `--mcp-config` `--no-session-persistence` `--output-format` `--permission-mode` `--print` `--restricted` `--sandbox` `--setting-sources` `--skip-git-repo-check` `--strict-mcp-config` `--tools` `--verbose`


## native-result-browser-check.mjs

Simulated human interaction in disposable local rooms, never a user study.

Run: `node scripts/native-result-browser-check.mjs`
Flags seen: none detected


## notification-feed-browser-check.mjs

B4 notification feed: badge, compact list, and "Mark read" moving the cursor. Simulated human tasks against isolated synthetic data; no real user research.

Run: `node scripts/notification-feed-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## oauth-return-invite-browser-check.mjs

A returning member who opens a friend's link and signs in with Google must land on that invitation, not in their own first room. The Google callback sends anyone who already has a room to /?room=<first room>, and the OAuth stash restore used to refuse any ?room= landing, so the friend's link was dropped for every returning member. Provider endpoints are synthetic; every Room route, cookie and the share link are real.

Run: `node scripts/oauth-return-invite-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## onboarding-probe/agent-code.mjs

Mint a contribute invite from a probe owner account and follow GET /a/<code>. The page is the only source of the redeem, orient, and board calls.

Run: `node scripts/onboarding-probe/agent-code.mjs`
Flags seen: none detected


## onboarding-probe/agent-docs.mjs

Follow GET /llms.txt. Hosts in the packet are rewritten to the target. The documented display name is replaced with a qa-prefixed name. Board curls run only when the packet itself shows a work-claim done call.

Run: `node scripts/onboarding-probe/agent-docs.mjs`
Flags seen: none detected


## onboarding-probe/agent-mcp.mjs

Anonymous MCP: initialize, then tools/list, then stop. OAuth PKCE runs only when staging advertises a protected-resource document and the server challenges. That enrollment flow is not available here.

Run: `node scripts/onboarding-probe/agent-mcp.mjs`
Flags seen: none detected


## onboarding-probe/cleanup.mjs

Archive rooms and revoke identities created by a probe run. created.json receives ids only. Secrets stay in memory for this call.

Run: `node scripts/onboarding-probe/cleanup.mjs`
Flags seen: none detected


## onboarding-probe/docs-publish.mjs

Publishes the weekly onboarding-probe results table into a docs-committed file, newest run first. The weekly `onboarding-probe` CI job runs this after run.mjs so the measured zero-to-first-claim times per path are visible from the repo, not only in the CI job summary. Additive: it never touches probe-out or the job summary, only docs.

Run: `node scripts/onboarding-probe/docs-publish.mjs`
Flags seen: `--docs` `--mode` `--result` `--run-id` `--run-url` `--table`


## onboarding-probe/gate.mjs

Compare a probe run with docs/onboarding-probe/baseline.json. A path fails when it is more than 20% slower, uses more than 1.2 times the calls, or loses a step the baseline could reach. Exactly 20% still passes. A newly reachable close is an improvement. Ready-latency jitter is inconclusive.

Run: `node scripts/onboarding-probe/gate.mjs`
Flags seen: `--baseline` `--result`
Env vars read: `GITHUB_STEP_SUMMARY`

## onboarding-probe/human-home.mjs

Browser path: landing, signup, first room. Later product steps stay not_available until they are on the page. Times are machine milliseconds. The KLM figure is labeled est. on every human step.

Run: `node scripts/onboarding-probe/human-home.mjs`
Flags seen: none detected


## onboarding-probe/human-invite.mjs

Owner mints a share link. A 390px visitor opens it and sends a first message when the composer is on the page. Missing UI is not_available, not a throw.

Run: `node scripts/onboarding-probe/human-invite.mjs`
Flags seen: none detected


## onboarding-probe/lib.mjs

Shared clock, HTTP, curl reading, and redaction for the onboarding probe. Nothing in this file prints a credential. Writers pass values through redact.

Run: `node scripts/onboarding-probe/lib.mjs`
Flags seen: `--data` `--data-raw` `-sS`
Env vars read: `PROBE_ROUND`

## onboarding-probe/pow.mjs

Remote copy of the identity-mint proof search. scripts/onboarding-probe keeps this equal to solveIdentityMintProof in server/agent-identities.mjs. Loopback runs import that function instead.

Run: `node scripts/onboarding-probe/pow.mjs`
Flags seen: none detected


## onboarding-probe/predeploy.mjs

Pre-deploy onboarding gate (ACT-5b). Runs the probe against staging, then compares it with docs/onboarding-probe/baseline.json through gate.mjs.    node scripts/onboarding-probe/predeploy.mjs --target staging \     [--sha <40-hex>] [--runs 3] [--out probe-out] [--override "<reason>"] 

Run: `node scripts/onboarding-probe/predeploy.mjs`
Flags seen: `--out` `--override` `--runner` `--runs` `--sha` `--target` `--wait-ms`


## onboarding-probe/report.mjs

One probe-result document and the markdown table operators read. The 4-week column is the baseline file. This module never rewrites it.

Run: `node scripts/onboarding-probe/report.mjs`
Flags seen: none detected


## onboarding-probe/run.mjs

Weekly and manual entry for the fresh-agent probe. The gate report is written beside the result. This process exits 0 so a slow week is visible without failing the job. gate.mjs is what exits 1.

Run: `node scripts/onboarding-probe/run.mjs`
Flags seen: `--out` `--runs` `--target`
Env vars read: `PROBE_ROUND` `ROOM_OPS_POST_TOKEN` `ROOM_OPS_ROOM_ID`

## open-routes.mjs

Open-route inventory (security review 2026-09-14, L3 / B48).  docs/openapi.yaml is the single source for which HTTP routes are served without a credential: an operation is open exactly when it declares `security: []`. This module reads that list with a minimal, line-based extraction (the repo has no YAML reader and the spec is hand-written with

Run: `node scripts/open-routes.mjs`
Flags seen: `--check`


## openapi-gen.mjs

OpenAPI gate (batch RT).  Until the legacy chain is empty, this check parses docs/openapi.yaml, keeps the template gate, and requires every documented operation to be a row in server/routes/table.mjs or a row still listed in the legacy allowlist. A documented HEAD is covered when GET is served for the same

Run: `node scripts/openapi-gen.mjs`
Flags seen: `--check`


## openapi-method-accuracy.mjs

Method-level OpenAPI contract accuracy check (TASKS.md task 16).  scripts/route-docs-check.mjs (the template gate) only compares route *templates*: it cannot see method-level drift — e.g. docs/openapi.yaml documenting POST on a route the server serves GET-only (the #594 dogfood bug class). This check closes that half: it boots a scratch

Run: `node scripts/openapi-method-accuracy.mjs`
Flags seen: `--report`
Env vars read: `TMPDIR`

## operator-console-browser-check.mjs

Operator console (operator.html) against a real server with the operator secret configured: status renders, find -> plan shows counts, execute stays disabled until the room title is typed, the purge runs, and the token lives only in sessionStorage. axe reports no serious or critical issue at 390 px.

Run: `node scripts/operator-console-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_OPERATOR_TOKEN_SHA256` `ROOM_TEST_CHROMIUM_PATH`

## outside-agents.mjs

Print or post a room message that names an agent who is not a member. The message grants no access and mints no identity. Other members read the same messages through server/outside-agents.mjs.

Run: `node scripts/outside-agents.mjs`
Flags seen: `--help` `--name` `--note` `--origin` `--post` `--reach` `--ref`


## owner-project-offers-browser-check.mjs

node --test browser check: owner project-offers surface across desktop/mobile viewports.

Run: `node scripts/owner-project-offers-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## paid-work.mjs

Only this view is for submission. The full prepare view includes PRIVATE costs. Syntax errors may quote confidential input. Do not echo them.

Run: `node scripts/paid-work.mjs`
Flags seen: `--context`


## password-reset-browser-check.mjs

Actual reset mail links and fresh sign-in, using local synthetic delivery only.

Run: `node scripts/password-reset-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## people-rail-browser-check.mjs

People-rail: presence dots, one-line status, loud @agent handles, Done chips. Also checks tip #11 Done-chip spring is instant under prefers-reduced-motion. Real browser + local HTTP service; identities and keys are disposable fixtures.

Run: `node scripts/people-rail-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## perf-budget.mjs

PERF-0: repeatable page-weight budget for signed-out pages. Loads each page cold (fresh browser context, empty cache) and records the request count, transferred bytes, DOM node count and the lab Largest Contentful Paint with 4x CPU throttling and network throttling over CDP (390 px and narrower: 150 ms RTT, 1.6 Mbps down, 750 Kbps up, close to Lighthouse mobile; wider: 40 ms RTT, 10 Mbps). Prints one JSON document.

Run: `node scripts/perf-budget.mjs`
Flags seen: `--cpu` `--help` `--network` `--origin` `--out` `--pages` `--viewport` `--viewports`
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## pinned-messages-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Issue #6 B2: a member pins a message from the keyboard, the Pinned section lists pins in pin order and follows other members' pins live, unpin works from the section itself, and a deleted message drops out of the section. Backlog follow-up 8: the "Pinned only" search toggle lists pins alone, narrows by the typed term, follows unpin live, and clears with the search.

Run: `node scripts/pinned-messages-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## portable-work-browser-check.mjs

Simulated human journeys in real browsers against isolated, synthetic rooms. Chromium 151 screenshot capture resets touch emulation. Restore it before testing touch keyboard behavior; viewport width alone is not that proof.

Run: `node scripts/portable-work-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## pr-diff-size-check.mjs

PR diff-size gate.  Diffs over MAX_DIFF_LINES (default 300) must carry an explicit "Large diff justification:" section in the PR body, or the check fails. Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase cycles partly because of diff size) and faster reviews. Split the PR when

Run: `node scripts/pr-diff-size-check.mjs`
Flags seen: `--base` `--body` `--body-b64` `--body-file` `--head` `--help` `--numstat`
Env vars read: `BASE_SHA` `DIFF_SIZE_THRESHOLD` `HEAD_SHA` `PR_BODY` `PR_BODY_B64`

## pr-overlap.mjs

scripts/pr-overlap.mjs — cross-PR overlap check for open pull requests.  Open PRs are reviewed one at a time, so nothing notices when two of them change the same code. On 2026-09-26 five PRs (#1088-#1092) each added `export function enforceAutonomyTierForAction` to server/autonomy-tiers.mjs. Git merges #1088 with any of the others cleanly and leaves a duplicate

Run: `node scripts/pr-overlap.mjs`
Flags seen: `--format` `--ignore` `--input` `--prs` `--repo`
Env vars read: `GITHUB_TOKEN`

## probe-prod-lib.mjs

Shared probe logic for probe-prod.mjs (CLI) and watch-deploy-drift.mjs. Matrix and classification are built from the 2026-09-25 1101 incident evidence, not from path-shape guesses:   - "/" is DO-BACKED: it served an 1101 during the outage. It is not an     edge-static canary.   - /.well-known/agent.json also flows through the DO on the canonical

Run: `node scripts/probe-prod-lib.mjs`
Flags seen: none detected


## probe-prod.mjs

Production probe + 1101 classifier (plan task R6). Zero dependencies. Hits the endpoint matrix, records status + latency, and classifies the failure domain: edge-down, worker-down, or do-rpc-fail (the 2026-09-25 1101 signature). Exit 0 when everything answers, 1 on any failure.  Usage: node scripts/probe-prod.mjs [--json] [--base https://room.trydemigod.com]

Run: `node scripts/probe-prod.mjs`
Flags seen: `--base` `--json`


## procedures-index.mjs

W008: shared procedure library index generator (docs-first).  Source of truth: docs/procedures/*.md, each with YAML frontmatter:   id, title, version (semver), author, source_room, updated (YYYY-MM-DD),   status (active|deprecated, default active). 

Run: `node scripts/procedures-index.mjs`
Flags seen: `--check` `--help`


## prod-deploy-smoke.mjs

Post-deploy smoke for the production lane (.github/workflows/deploy-prod.yml and rollback-prod.yml). Public endpoints only: no credentials, no writes.    node scripts/prod-deploy-smoke.mjs --sha <40-hex> \     [--origin https://room.trydemigod.com] [--entry https://www.getdasha.com/room] \     [--wait-ms 300000] \

Run: `node scripts/prod-deploy-smoke.mjs`
Flags seen: none detected
Env vars read: `SMOKE_AGENT_CARD_AGENT_ID` `SMOKE_AGENT_CARD_FETCHES` `SMOKE_AGENT_CARD_KEY_ID` `SMOKE_AGENT_CARD_PUBLIC_KEY` `SMOKE_AGENT_CARD_WAIT_MS`

## prod-flow-probes.mjs

Prod flow probes: read-only checks of the paths a person or agent walks first. Exit 1 on any failure. No credentials. No writes. Safe to run on a schedule. Usage: node scripts/prod-flow-probes.mjs [--json]

Run: `node scripts/prod-flow-probes.mjs`
Flags seen: `--json`
Env vars read: `ROOM_ORIGIN` `WWW_ORIGIN`

## progressive-disclosure-check.mjs

Consistent progressive disclosure (backlog C7): in-room section disclosures share one summary anatomy (chevron, label, trailing chip/note), hit target, focus ring - and toggling never moves focus. Disposable rooms only.

Run: `node scripts/progressive-disclosure-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## project-offers-browser-check.mjs

Public offer journeys against the real Node HTTP/store boundary; no identities are enrolled and no external host, mail, funding or cashout is started.

Run: `node scripts/project-offers-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_OFFERS_SCREENSHOT_DIR` `ROOM_TEST_CHROMIUM_PATH`

## provision.mjs

W46: an unknown flag is a usage error (exit 2), not an uncaught ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace.

Run: `node scripts/provision.mjs`
Flags seen: none detected
Env vars read: `ROOM_DB`

## public-pages-polish-browser-check.mjs

Compare pages and the HTML 404: axe serious/critical at 390 and 1280, and no Content-Security-Policy console errors on the compare pages.

Run: `node scripts/public-pages-polish-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## public-work-matching-browser-check.mjs

Actual owner enable → anonymous suggestions → outside-agent claim. No live services.

Run: `node scripts/public-work-matching-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_MATCH_SCREENSHOT_DIR` `ROOM_TEST_CHROMIUM_PATH`

## public-work-mcp-journey-check.mjs

Synthetic outside-agent usability: advertised hosted endpoint replayed to real loopback HTTP. No live identities, Room admission, host launch or payment.

Run: `node scripts/public-work-mcp-journey-check.mjs`
Flags seen: none detected


## public-work-results-browser-check.mjs

Real HTTP submission/review and private owner UI; no live identities or mail.

Run: `node scripts/public-work-results-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_RESULTS_SCREENSHOT_DIR` `ROOM_TEST_CHROMIUM_PATH`

## purpose-invite-check.mjs

W4-51 L3: invite for a purpose. An inviter can point an invitation link at the question or result the guest is invited to help with; after joining, the room opens on that item. The purpose travels only in the URL fragment (never sent to the server). It selects a destination; guest access still covers room history.

Run: `node scripts/purpose-invite-check.mjs`
Flags seen: none detected


## push-doctor.mjs

Trusted local operator tool for turning push delivery on and proving it works. It prints no room content and no private key it was given: --keys writes a new private key to stdout because that is the only moment it exists, and --send prints only the push service's verdict.  Push delivery is off until three secrets are set, so the intended order is:

Run: `node scripts/push-doctor.mjs`
Flags seen: none detected
Env vars read: `ROOM_VAPID_PRIVATE_KEY` `ROOM_VAPID_PUBLIC_KEY` `ROOM_VAPID_SUBJECT`

## pwa-browser-check.mjs

Install button and the push soft ask, in Chromium. The ask is absent on load and appears only after a needs-you item is handed to the dock.

Run: `node scripts/pwa-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## qa2/abuse-guards.mjs

Outcome checks for the work-claim, webhook, display-name, instructions, and member-text guards. Local only: it writes rows in a throwaway room. Usage: node scripts/qa2/abuse-guards.mjs --origin http://127.0.0.1:4173 [--json out.json] Exit 1 when any check fails.

Run: `node scripts/qa2/abuse-guards.mjs`
Flags seen: none detected


## qa2/agent-journeys.mjs

Synthetic agent journeys: a cold agent that only knows the origin. Each task follows what public discovery (llms.txt, agents.json, openapi.json, MCP tools/list) and the server's own `next` hints say, records whether the route it needed was discoverable, and scores pass/fail on the end state (outcome-based, like tau-bench: the state must change, not just a 2xx). Usage: node scripts/qa2/agent-journeys.mjs --origin http://127.0.0.1:4173 [--mcp URL] [--json out.json] [--md out.md] [--trials 1]

Run: `node scripts/qa2/agent-journeys.mjs`
Flags seen: none detected


## qa2/authz-matrix.mjs

Authorization / IDOR matrix for Project Room's agent HTTP surface. Builds a throwaway room with one identity per role, then runs every action as every role and compares the outcome with the expected policy.   roles: owner, collaborator (profile collaborate), chatter (profile chat),          linkguest (share-link join-agent), outsider (identity, no membership),          anonymous (no credential), revoked (joined, then revoked its secret)

Run: `node scripts/qa2/authz-matrix.mjs`
Flags seen: `--keep`


## qa2/fuzz.sh

Usage: scripts/qa2/fuzz.sh [out-dir]   (needs node 24 and uv or pipx)

Run: `bash scripts/qa2/fuzz.sh`
Flags seen: none detected


## qa2/journeys.mjs

Acceptance alias for the one-server QA2 run. The journey implementation lives in agent-journeys.mjs; this file exists so `node scripts/qa2/journeys.mjs` runs that suite.

Run: `node scripts/qa2/journeys.mjs`
Flags seen: none detected


## qa2/lib/client.mjs

Shared QA HTTP client. Identity mints solve the same proof as src/client.js: sha256(`${bucket}:${trim(displayName)}:${nonce}`) must start with IDENTITY_POW_BITS/4 zero hex digits, bucket = floor(now / window). A presented proof is accepted before the anonymous free-mint quota, and a 429 is retried from Retry-After so a later script on the same server can still mint after the per-address minute cap.

Run: `node scripts/qa2/lib/client.mjs`
Flags seen: none detected


## qa2/load-smoke.mjs

Load/latency smoke with k6-style thresholds, dependency-free (Node 22+). Usage: node scripts/qa2/load-smoke.mjs --origin http://127.0.0.1:4173 [--vus 20] [--seconds 30] [--json out.json] Mixes anonymous reads (/, /llms.txt, /api/health) with one authenticated agent reading events and posting at a gentle rate. Only point at production with --vus <= 3 (single Durable Object; see QA2 findings). Thresholds (fail exit 1): p95 static <= 500 ms, p95 API read <= 800 ms, p95 post <= 1200 ms, error rate < 1% (429 counted separately).

Run: `node scripts/qa2/load-smoke.mjs`
Flags seen: none detected


## qa2/mcp-conformance.mjs

Official MCP conformance suite with a not-applicable baseline, plus a separate hard assertion that hostile Host/Origin headers are refused (the one dns-rebinding check that must pass). Usage: node scripts/qa2/mcp-conformance.mjs --url http://127.0.0.1:4173/mcp [--version 0.x.y] Retries once after 65 s when the run trips Room's anonymous MCP rate limit.

Run: `node scripts/qa2/mcp-conformance.mjs`
Flags seen: `--expected-failures` `--scenario` `--url` `--verbose`


## qa2/mcp-robustness.mjs

MCP robustness probe: malformed JSON-RPC, schema-violating tool arguments, boundary values and hostile strings against a hosted MCP endpoint. Invariants checked on every case:   I1 no 5xx; I2 no stack trace / internal path in the body;   I3 JSON-RPC envelope is valid (jsonrpc "2.0", matching id, result XOR error);   I4 the case's own expectation (error code range, isError, or success).

Run: `node scripts/qa2/mcp-robustness.mjs`
Flags seen: none detected


## qa2/public-pages.mjs

Public page gate: a11y (axe WCAG 2.2 AA), SEO/canonical/robots, OG tags, broken links, console errors and optional screenshot baselines for every public HTML page. Usage: node scripts/qa2/public-pages.mjs --origin URL [--known "/path:substring,..."] [--json out.json] [--shots dir] [--baseline dir] [--chrome /usr/bin/google-chrome] Exit 1 when a page fails the gate (axe serious/critical, missing title/canonical/lang, broken internal link, 5xx).

Run: `node scripts/qa2/public-pages.mjs`
Flags seen: none detected
Env vars read: `CHROME_PATH`

## qa3/authz-board.mjs

Board, referral, receipts opt-in, sweep, status, and wake-pause matrix. Roles: owner, contribute, chat, review, manage_claims, write_external, link guest, public. The policy is the one SEC-1 and SEC-2 implement. A cell whose fix has not merged is expectedFail with its finding id: the run stays green, and turns red once the fix matches while the flag is still set.

Run: `node scripts/qa3/authz-board.mjs`
Flags seen: none detected


## qa3/board-growth.mjs

Nightly board-growth budget: 400 done claims plus 300 review notes from five review-profile members. List p95, the limit=1 body, and room-event headroom stay bounded (SEC-2 with Q3-A: F4 event headroom, F8 list).

Run: `node scripts/qa3/board-growth.mjs`
Flags seen: none detected


## qa3/content-trust.mjs

A guest payload must carry untrusted:true or contentTrust on every agent-facing read. Surfaces that already stamp stay required. Surfaces that still omit the marker are expectedFail until their fix merges: the event tail and SSE frames (SEC-2b). Webhook payloads are fenced (Q3-D). Board lists are stamped (SEC-2). A guest cannot add a Board review note, so a review-profile member writes the Board marker.

Run: `node scripts/qa3/content-trust.mjs`
Flags seen: none detected
Env vars read: `ROOM_DB`

## qa3/lib/sequence.mjs

SSE frame sequence extraction shared by the QA3 contract gate. An SSE frame without an `id:` line has no sequence; Number(null) is 0, which must not be mistaken for sequence 0 (synthetic id-less events like `typing` would otherwise corrupt ordering and Last-Event-ID resume checks).

Run: `node scripts/qa3/lib/sequence.mjs`
Flags seen: none detected


## qa3/lib/sse.mjs

Read room SSE frames until `until` returns true or the deadline passes.

Run: `node scripts/qa3/lib/sse.mjs`
Flags seen: none detected


## qa3/lib/summary.mjs

Job summary for the QA3 gates. expectedFail cells stay green and are listed in GITHUB_STEP_SUMMARY. A cell that matches while its flag is still set fails the run, so the flag is removed once the fix lands.

Run: `node scripts/qa3/lib/summary.mjs`
Flags seen: none detected
Env vars read: `GITHUB_STEP_SUMMARY`

## qa3/public-scan-budget.mjs

Seed 1,000 rooms through the store, then require the public routes to stay under 50 ms p95. PRM owns the separate assertion that no public route reads rooms.projection. This 1,000-room fixture already meets the timing bar, so the check is required: a regression fails the job.

Run: `node scripts/qa3/public-scan-budget.mjs`
Flags seen: none detected


## qa3/sse-contract.mjs

SSE contract: 40 messages keep strict order, no duplicates, and a Last-Event-ID resume loses nothing. The per-credential cap of 3 is required. The per-room cap is Q3-F and stays skipped. Usage: node scripts/qa3/sse-contract.mjs --origin http://127.0.0.1:4173

Run: `node scripts/qa3/sse-contract.mjs`
Flags seen: none detected


## qa5-a11y-c-browser-check.mjs

Slice C (QA5 UI/UX + a11y): user-testing for the newly merged UI work. Covers the render paths the unit tests don't reach:   - S1 (#1456): the viewer-aware empty-board copy is wired through boardHtml     (the pure emptyBoardCopy function has its own unit test; this guards the     call site that passes canWrite/signedIn).   - S3 (#1456): the New-item form's Note field is label-associated and the

Run: `node scripts/qa5-a11y-c-browser-check.mjs`
Flags seen: none detected


## quarantine-check.mjs

scripts/quarantine-check.mjs Zero-Bug System: flaky-test quarantine gate. Reads tests/quarantine.json and fails (exit 1) when any entry violates the quarantine contract: 1. repair_by is in the past (overdue) — CI fails until the entry is repaired (test fixed and re-admitted) or the repair-by date is moved

Run: `node scripts/quarantine-check.mjs`
Flags seen: none detected


## quarantine-review-coverage.mjs

Review-coverage dashboard for the spam-quarantine queue.  Reads a room store READ-ONLY (PRAGMA query_only) and reports per-signal review coverage over the durable quarantine journal (server/spam-quarantine-journal.mjs): for each spam signal that fired on a held row, the held count, the reviewed count, the Confirm (released into

Run: `node scripts/quarantine-review-coverage.mjs`
Flags seen: `--format` `--help` `--now` `--since` `--store` `--until`


## quiet-attribution-browser-check.mjs

Simulated local readers, not human research or identity verification.

Run: `node scripts/quiet-attribution-browser-check.mjs`
Flags seen: none detected


## quiet-copy-browser-check.mjs

Automated usability checks with synthetic identities, not human participant research. A visitor starts with account creation, login, and exactly one agent entry.

Run: `node scripts/quiet-copy-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## quiet-design-check.mjs

C3 rest state, before any screenshot (Chromium 151 captures reset touch emulation): quiet on pointer devices, always visible on touch.

Run: `node scripts/quiet-design-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## quiet-focus-a34-check.mjs

Quiet Focus A3/A4 evidence: keyboard-operable disclosures, usable narrow composer, composer-local send failure with Send-as-retry, and explicit disconnected/reconnecting states. Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.

Run: `node scripts/quiet-focus-a34-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## quiet-focus-final-check.mjs

Quiet Focus final causal proofs (Codex 5557784549): post-connect stream loss transition, and measurable reflow at 390px and 200%-zoom-equivalent CSS width.

Run: `node scripts/quiet-focus-final-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## quiet-invites-check.mjs

Synthetic UI regressions; no human-participant findings are inferred.

Run: `node scripts/quiet-invites-check.mjs`
Flags seen: none detected


## ralph-loop.mjs

ralph-loop.mjs — Ralph-style night-shift burndown loop driver (BL-005 / S4). One loop iteration, per the software-factory brief (S4): 1. `scripts/room backlog pull` takes the top unclaimed ready item (the pull itself refuses when the item's files are held live by another lane — the S1 overlap guard). 2. This driver reserves a worker slot (cap: MAX_WORKERS concurrent),

Run: `node scripts/ralph-loop.mjs`
Flags seen: `--dispatch` `--dry-run` `--heartbeat` `--help` `--json` `--lane` `--list` `--max-attempts` `--max-workers` `--release` `--repo` `--routine` `--stale-after-hours` `--state` `--status` `--worktree-root`


## reachability.mjs

Import-graph reachability for server/ and src/.  Walks static `import` / `export ... from`, bare `import "x"`, and string-literal `import("x")` from runtime entry points. Relative specifiers resolve with .mjs / .js (and /index). A `new URL("...", import.meta.url)` literal is followed too: that is how the push service worker is loaded.

Run: `node scripts/reachability.mjs`
Flags seen: `--check`


## real-agent-fixture.mjs

Operator-started, loopback-only fixture for real agent participation. Seeds are explicitly synthetic; it never creates a participating agent's answer or verdict.

Run: `node scripts/real-agent-fixture.mjs`
Flags seen: `-addext` `-days` `-keyout` `-newkey` `-nodes` `-out` `-subj` `-x509`


## receipts-browser-check.mjs

/receipts/<id> at a phone width: the document fits the viewport and exposes main and footer landmarks.

Run: `node scripts/receipts-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## receive-qualify.mjs

Drives one complete exchange against a throwaway local Room: directed request, pointer, Room-tool reply, wake ack, stored answer. Starts no model. Prints one receipt. The token stays in the private directory.

Run: `node scripts/receive-qualify.mjs`
Flags seen: `--cadence-seconds` `--host` `--mode`


## reconnect-collaboration-browser-check.mjs

Scripted protocol participants + simulated human browser. No model invocation.

Run: `node scripts/reconnect-collaboration-browser-check.mjs`
Flags seen: none detected


## record-rails-fixture.mjs

Synthetic qualification helpers use the real event and durable rail authority.

Run: `node scripts/record-rails-fixture.mjs`
Flags seen: none detected


## recovery-browser-check.mjs

Simulated human journey on a disposable database; no production traffic.

Run: `node scripts/recovery-browser-check.mjs`
Flags seen: none detected


## recovery-coverage.mjs

The rows the recovery audit requires. Shared with the cold-start budget so a wake is measured against a store that has every application table, not only the event log. Disposable synthetic data only.

Run: `node scripts/recovery-coverage.mjs`
Flags seen: none detected


## recovery-fixture.mjs

Disposable synthetic data only. Never import this from a production entrypoint.

Run: `node scripts/recovery-fixture.mjs`
Flags seen: none detected


## refine-draft-browser-check.mjs

Simulated people in isolated rooms, including real browser failure recovery.

Run: `node scripts/refine-draft-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## release-checkpoint.mjs

Read-only, bounded release observations. This is not deployment or health proof.

Run: `node scripts/release-checkpoint.mjs`
Flags seen: `--expected-revision` `--format` `--help` `--json` `--origin` `--output` `--pr` `--repo`


## release-evidence.mjs

Compact release-evidence manifest built only from actual results. Skipped tests are never labeled passed, a dirty candidate tree is never labeled clean, and live state is never labeled live without a matching digest.

Run: `node scripts/release-evidence.mjs`
Flags seen: `--help` `--porcelain` `--probes` `--tap`


## release-polish-check.mjs

Synthetic user journeys: no human-study outcomes or production data.

Run: `node scripts/release-polish-check.mjs`
Flags seen: none detected


## reminders-browser-check.mjs

Simulated human tasks against isolated synthetic data; no real user research.

Run: `node scripts/reminders-browser-check.mjs`
Flags seen: none detected


## replay-room-export.mjs

Replays an NDJSON room export (--from) into a destination (--to) with verification; destination not promoted on failure.

Run: `node scripts/replay-room-export.mjs`
Flags seen: none detected


## reply-request-browser-check.mjs

Synthetic human journeys against a disposable real service, not participant research.

Run: `node scripts/reply-request-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## reply-review-fixture.mjs

Deliberately invented provider history. Not a provider driver or runtime asset.

Run: `node scripts/reply-review-fixture.mjs`
Flags seen: none detected


## reply-update-fixture.mjs

Shared invented mailbox/update fixture. Never contacts a provider.

Run: `node scripts/reply-update-fixture.mjs`
Flags seen: none detected


## report-test-failures.mjs

Turn a `node --test --test-reporter=junit` results file into GitHub Actions annotations and a job summary (BUILD-01 task B50).    node scripts/report-test-failures.mjs [test-results/browser-junit.xml]  Per failed test it prints one `::error title=<suite>::<test>: <first line

Run: `node scripts/report-test-failures.mjs`
Flags seen: none detected
Env vars read: `GITHUB_STEP_SUMMARY`

## report-unit-failures.mjs

scripts/report-unit-failures.mjs CI honesty: the "Report failures to PR" step in .github/workflows/test.yml names the failing tests instead of pointing at the job log. Reads the shard receipt written by scripts/unit-ci.mjs (latest attempt wins) and writes the markdown comment body to --body-file (or stdout). Usage: node scripts/report-unit-failures.mjs --shard=1/3 [--body-file=path]

Run: `node scripts/report-unit-failures.mjs`
Flags seen: `--body-file` `--shard`


## request-host-fixture.mjs

Explicit synthetic native-host exercise. Never opens an existing Room database.

Run: `node scripts/request-host-fixture.mjs`
Flags seen: `-v3`


## restore-rehearsal.mjs

Restore rehearsal (backlog B5): prove that restoring a stale backup resurrects the authority that was live at the watermark, and that reconcileRestoredAuthority names every resurrected entry - so stale restored authority is never silently treated as current. Usage: node scripts/restore-rehearsal.mjs

Run: `node scripts/restore-rehearsal.mjs`
Flags seen: none detected


## restore-room-backup.mjs

Restore a nightly backup into a NEW sqlite store. Never touches a live room: the destination must not exist, and nothing here writes to Cloudflare. Prints counts and digests only, never row contents.    node scripts/restore-room-backup.mjs --kv 2026-10-08 --to /tmp/restore/room.sqlite --room muse-room   node scripts/restore-room-backup.mjs --from room-export.ndjson --to /tmp/restore/room.sqlite

Run: `node scripts/restore-room-backup.mjs`
Flags seen: `--namespace-id` `--remote` `-shm` `-wal`
Env vars read: `WRANGLER`

## result-copy-agent-fixture.mjs

Disposable, read-only actual-agent exercise. Never opens a caller's database.

Run: `node scripts/result-copy-agent-fixture.mjs`
Flags seen: none detected


## result-copy-browser-check.mjs

Simulated human journeys. Clipboard outcomes are controlled; no user text or system clipboard is read/written and no live service is involved.

Run: `node scripts/result-copy-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## result-diff-browser-check.mjs

Simulated human journeys in real browsers against isolated, synthetic rooms.

Run: `node scripts/result-diff-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## results-fixture.mjs

Disposable fictional results; no provider reads, execution or publication.

Run: `node scripts/results-fixture.mjs`
Flags seen: `-draft` `-packet` `-v1`


## review-mechanical-report.mjs

Renders the review-mechanical check report: a short human table plus a machine-readable JSON block marked with <!-- review-mechanical-report -->. The workflow prints the returned markdown into $GITHUB_STEP_SUMMARY. renderReport() is pure and unit-tested; the JSON shape is the contract that reviewers and tooling read. 

Run: `node scripts/review-mechanical-report.mjs`
Flags seen: none detected


## review-scope-check.mjs

Claim-scope check for the cheap-first mechanical review pass.  A pull request declares the files its claim covers in the PR body with an HTML comment:    <!-- claim-files: server/a.mjs, tests/a.test.js -->

Run: `node scripts/review-scope-check.mjs`
Flags seen: `--name-only`
Env vars read: `CI_CHANGED_FILES` `GITHUB_ACTIONS`

## review-state.mjs

scripts/review-state.mjs — per-PR review-state surface + single-lane review assignment routing.  Companion to #1585's review-parallelization protocol (docs/REVIEW-PARALLELISM.md): #1585 runs the cheap-first mechanical pass per PR (diff size, claim-scope match via scripts/review-scope-check.mjs,

Run: `node scripts/review-state.mjs`
Flags seen: `--assign-file` `--author-lanes` `--format` `--help` `--input` `--lanes` `--paginate` `--repo` `--slurp`


## rollback-readback.mjs

Verify a rollback using fresh `wrangler deployments status --json` records. stdin / --status-file: {prod: <production status>, entry: <entry status>}. A single raw status is also accepted when only --prod-id is requested. No deployment or credentials: this CLI only validates records and GETs both doors. Allocation proof does not establish data restoration or a source-SHA mapping for the Worker version IDs; the observed source revisions are receipts.

Run: `node scripts/rollback-readback.mjs`
Flags seen: none detected


## room-actions-browser-check.mjs

Simulated-human navigation checks. Disposable data; no outside services. The attention lane syncs the read horizon (a write) on room entry by design; it is not "creating anything" in the room-actions sense, so it is excluded while every other non-GET room request still fails the check.

Run: `node scripts/room-actions-browser-check.mjs`
Flags seen: none detected


## room-chrome.mjs

Post-#656 chrome helpers for browser checks. Catch-up, Settings, and Search live behind topbar controls; People starts open in the sidebar. Product code is unchanged — these only teach checks how to reach it.

Run: `node scripts/room-chrome.mjs`
Flags seen: none detected


## room-coord.mjs

room-coord: claim, renew, hand off and land work through the room's typed work-claim registry instead of chat prose or GitHub comments. See docs/ROOM-COORDINATION.md. Output is JSON unless --md is given.

Run: `node scripts/room-coord.mjs`
Flags seen: `--after` `--expiring-min` `--help` `--lease-hours` `--limit` `--pages` `--pr` `--progress` `--repo` `--summary` `--to`


## room-door-browser-check.mjs

Capture the actual first navigation before the app handles each hash.

Run: `node scripts/room-door-browser-check.mjs`
Flags seen: none detected


## room-export-browser-check.mjs

Room export (BUILD-01 F2 follow-up) browser check: a signed-in member takes the readable HTML export from the History panel, in room-key mode and in account mode (where the request must carry the session binding a plain link cannot). Disposable rooms only - no real users or outside requests.

Run: `node scripts/room-export-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## room-guard.mjs

room-guard: refuse a commit (or flag a PR) that touches files another member holds under a live room work claim. Advisory leases become a hard stop at the moment it matters, the way a pre-commit hook guards a branch.    pre-commit:  node scripts/room-guard.mjs            (staged files)   CI / PR:     node scripts/room-guard.mjs --base origin/main

Run: `node scripts/room-guard.mjs`
Flags seen: `--base` `--cached` `--files` `--find-renames` `--json` `--name-status` `--strict` `--warn`


## room-health.mjs

room-health.mjs — Room health dashboard generator (OBS-1). Fetches LIVE data and writes a self-contained static page: docs/room-health.html Panels: 1. Open claims by lane        (parsed the way scripts/room does, via scripts/room _parse | _state)

Run: `node scripts/room-health.mjs`
Flags seen: `--jq` `--json` `--limit` `--out` `--paginate` `--repo` `--state`


## room-hygiene.mjs

Room hygiene (RC-2026-09-23): zombie-member cleanup + friction digest. Trusted local-operator script: opens the room SQLite file read-only and reports; it never writes. Verbs:    member-sweep --db PATH --room ROOM_ID [--days N] [--json]     Lists active members with no observed heartbeat (last command,

Run: `node scripts/room-hygiene.mjs`
Flags seen: `--days` `--db` `--json` `--room`


## room-instructions-browser-check.mjs

Synthetic human journeys, not a human usability or retention study.

Run: `node scripts/room-instructions-browser-check.mjs`
Flags seen: none detected


## room-key-pull.mjs

Register pull-only presence with the saved room access key and print pending wake pointers. The key cannot install a wake URL. Acknowledgement happens only for a signal id this same pull just printed. The credential is never written to stdout or stderr.

Run: `node scripts/room-key-pull.mjs`
Flags seen: `--ack` `--cadence` `--help` `--host`


## room-lifecycle-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Issue #6 A2: an account that administers membership creates a room from Rooms, opens it, archives it as its owner (read only afterwards; the switcher shows it as a read-only entry, never as a working "Open" button), and a member leaves a room from About and no longer finds it.

Run: `node scripts/room-lifecycle-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## room-listen.mjs

One receiving entry. Channel speaks MCP. Poll prints pointers. Webhook prints the subscribe call and does not listen. None of the modes start a model.

Run: `node scripts/room-listen.mjs`
Flags seen: `--cadence-seconds` `--host` `--mode` `--webhook-url`


## room-mcp-init.mjs

Project Room MCP one-shot installer.  Portions adapted from Agent Room's init.ts (https://github.com/agent-room-alkl/agent-room) MIT License, Copyright (c) 2026 Agent Room contributors. 

Run: `node scripts/room-mcp-init.mjs`
Flags seen: `--dry-run` `--help` `--scope` `--transport` `--url` `--yes`


## room-mutate.mjs

scripts/room-mutate.mjs — single-point mutant generator + runner for scripts/room.  Why a custom tool instead of Stryker: scripts/room is bash with embedded jq; no JS mutation framework targets it. The room's own `_parse` / `_state` verbs and the fake-gh sweep pattern give a deterministic test seam, so a small exact-string mutant generator is the pragmatic fit.

Run: `node scripts/room-mutate.mjs`
Flags seen: `--list` `--run` `--run-all` `--test`


## room-overview-browser-check.mjs

Synthetic room only: orientation must preserve writing and make no room writes.

Run: `node scripts/room-overview-browser-check.mjs`
Flags seen: none detected


## room-policy-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Issue #6 A4: when the room owner makes review or approval mandatory, the new-work form shows the requirement locked on with the reason, and the recorded item carries it.

Run: `node scripts/room-policy-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## room-results-browser-check.mjs

Simulated people, real local browser. Fictional rooms; no outside services.

Run: `node scripts/room-results-browser-check.mjs`
Flags seen: none detected


## room-roster.mjs

Prints the room roster (members/roles) for the checkout; thin CLI over the room-roster library.

Run: `node scripts/room-roster.mjs`
Flags seen: none detected


## room-trust-browser-check.mjs

Room Trust settings toggle: owner of a cross-owner room flips the kill-switch. Synthetic fixture only. Trust starts on; one click turns it off; another turns it on.

Run: `node scripts/room-trust-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## rotation-cutover.sh

Executes the claims-board rotation (old board → successor). DRY RUN BY DEFAULT; --confirm executes. Fail-closed. Runbook: docs/ROOM-WATCH.md §8.

Run: `bash scripts/rotation-cutover.sh`
Flags seen: none detected


## rotation-rehearse.sh

Hermetic end-to-end verification of the rotation runbook: exercises rotation-cutover.sh against a fixture board via a gh shim, asserts rotation invariants.

Run: `bash scripts/rotation-rehearse.sh`
Flags seen: none detected


## route-acceptance.mjs

scripts/route-acceptance.mjs — prove a route is mounted before a receipt says it is live.  On 2026-09-27 two PRs (#1136, #1138) merged with receipts naming GET /events and GET /board as endpoints, but the module was imported only by its tests, so both paths 404'd on every door. This check starts the real HTTP server on

Run: `node scripts/route-acceptance.mjs`
Flags seen: `--file` `--json`


## route-docs-check.mjs

Route documentation gate (re-audit 2026-09-14, M4).  docs/openapi.yaml must describe every /api route template the server can match, and must not describe one the server no longer serves. The served set comes from routeCandidates() in scripts/open-routes.mjs (the same extraction tests/invite-only-boundary.test.js probes anonymously), plus

Run: `node scripts/route-docs-check.mjs`
Flags seen: none detected


## routes-inventory.mjs

Legacy route inventory (batch RT).  Walks the routes the server still serves outside the route table and writes scripts/routes-legacy-allowlist.json. The allowlist is the parity baseline: it only shrinks as extraction PRs move a group into server/routes/table.mjs. A route still implemented in the legacy chain and missing from the allowlist

Run: `node scripts/routes-inventory.mjs`
Flags seen: `--baseline` `--check` `--help` `--write`


## run-quarantined-tests.mjs

scripts/run-quarantined-tests.mjs Zero-Bug System: non-blocking lane for quarantined flaky tests. Reads tests/quarantine.json and runs each quarantined test with QUARANTINE_RUN=1 (so env-gated quarantined tests execute). Entries use the "file > test name" convention; a bare file entry runs the whole file. Exits non-zero when any quarantined test fails — the zero-bug-quarantine

Run: `node scripts/run-quarantined-tests.mjs`
Flags seen: `--test` `--test-name-pattern`


## run-room-request.mjs

Usage: node scripts/run-room-request.mjs REQUEST_ID|--auto /absolute/private-journal.sqlite /absolute/host.json\nUses ROOM_AGENT_CONFIG or the existing Room connection environment. Host JSON: command (absolute), args (array), cwd (absolute), timeoutMs, required fixed policy, optional verification (no env). Host reads a typed untrusted context envelope on stdin and returns {body, codeResult?} on stdout. O

Run: `node scripts/run-room-request.mjs`
Flags seen: `--auto` `--help`


## runtime-import-closure.mjs

Static import-closure analyzer for the runtime-package allowlist lint. Computes the transitive closure of relative ES-module imports starting from an entrypoint, so tests can assert every imported module is allowlisted without humans hand-maintaining a file list.  Only static `import`/`export ... from` with relative specifiers (./ or ../)

Run: `node scripts/runtime-import-closure.mjs`
Flags seen: none detected


## scan-secrets.mjs

Zero-bug gate: scan the PR diff for committed secrets. Usage: node scripts/scan-secrets.mjs [--base <git-ref>] [--diff <file>] Default base: origin/main. CI passes the PR base SHA explicitly. Exit 0: no secrets found. Exit 1: at least one finding (blocks the PR).  Only ADDED lines (+ lines, excluding the +++ header) are scanned, so

Run: `node scripts/scan-secrets.mjs`
Flags seen: `--base` `--diff` `--no-color` `--no-ext-diff` `--no-pager` `--show-toplevel` `-U0`
Env vars read: `ZERO_BUG_BASE`

## schema-gate/schema-gate.mjs

Schema convergence gate — CI-time harness for the bounty-propose-500 bug class.  Incident: post-#792 (2026-09-22), bounty propose 500'd with "table bounty_records has no column named rubric_json" consistently in SOME rooms while reads kept working. Root cause: BountyEscrow._ensure() treated "some tables missing" and "columns need migrating" as either/or:

Run: `node scripts/schema-gate/schema-gate.mjs`
Flags seen: `--codebase` `--list` `--only`


## secret-scan-check.mjs

Secret-scan CI gate (H005 wiring). Scans the repo tree for accidentally committed secrets using server/secret-scan.mjs. Fails the build on any finding. Pure, dependency-free; runs in the contract job via check.mjs.  The config (ALLOWLIST, SKIP_FILES, ...) is exported so the PR diff gate (scripts/secret-scan-diff.mjs) and its tests reuse the exact same rules.

Run: `node scripts/secret-scan-check.mjs`
Flags seen: none detected


## secret-scan-diff.mjs

Secret-scan DIFF gate (200-list #162). Scans ADDED lines of `git diff <base>...HEAD` for secrets using the shared detector (server/secret-scan.mjs) with the shared line allowlist plus a path-based allowlist (.github/secret-scan-allowlist.txt).  Complements the tree scan in scripts/secret-scan-check.mjs (contract

Run: `node scripts/secret-scan-diff.mjs`
Flags seen: `--allowlist` `--base` `--cached` `--files` `--help` `--name-only` `--no-color` `--no-ext-diff` `--show-toplevel` `--staged`


## server-json-check.mjs

Offline checks for server.json, plus an optional registry version bump. The description text is whatever the file says. POS-1a can change that field; this script only checks its shape.

Run: `node scripts/server-json-check.mjs`
Flags seen: `--against-registry`


## session-boundary-check.mjs

Browser regressions for session ownership, stale writes, live announcements, and user-controlled record identities. All state and credentials are disposable.

Run: `node scripts/session-boundary-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## shadow-quarantine-report.mjs

Post-shadow precision report for auto-quarantine (AUTO-QUARANTINE-POLICY.md §5).  Reads a room store READ-ONLY (PRAGMA query_only) and joins the shadow would-be-hold records (receipt.shadowQuarantine on source.import receipts, server/spam-shadow.mjs) to the review outcomes in the durable spam_quarantine journal (server/spam-quarantine-journal.mjs), using the join

Run: `node scripts/shadow-quarantine-report.mjs`
Flags seen: `--format` `--help` `--now` `--review-window-days` `--since` `--store` `--until`


## sign-agent-card.mjs

Build-time signer for the room's A2A Agent Card (RC-2026-09-23-105).  Runs after scripts/stamp-version.mjs so agentCard() sees the stamped revision. Signs the canonical card bytes with the room's dedicated Ed25519 key (server/agent-card-signing.mjs, the same house standard the agent directory uses), then signs the card-plus-envelope as an A2A v1.0 §8.4 JWS

Run: `node scripts/sign-agent-card.mjs`
Flags seen: `--allow-unsigned`
Env vars read: `ROOM_AGENT_CARD_SIGNING_KEY`

## signin-browser-journey.mjs

Reach recovery through the visible password-first entry, including invitation hosts.

Run: `node scripts/signin-browser-journey.mjs`
Flags seen: none detected


## skills-sync-check.mjs

Fails when plugins/project-room/skills/ is not an exact copy of skills/. Repair with: node scripts/skills-sync.mjs

Run: `node scripts/skills-sync-check.mjs`
Flags seen: none detected


## skills-sync.mjs

skills/ is the only source for Project Room skills. This copies that tree onto plugins/project-room/skills/, including skills that exist only under skills/ and dropping plugin-only copies such as the shelved bounty worker.

Run: `node scripts/skills-sync.mjs`
Flags seen: none detected


## smoke-prod.mjs

Production smoke probes (Zero-Bug System, Phase 2). Zero dependencies. Synthetic READ-ONLY probes against the live Project Room deployment. Never writes or mutates production data, never spends, never charges, never authenticates as any user or agent. Every probe only reads a status code / response shape. 

Run: `node scripts/smoke-prod.mjs`
Flags seen: `--base` `--json` `--room`
Env vars read: `SMOKE_BASE` `SMOKE_ROOM`

## snippet-adoption.mjs

Weekly count of public repos that carry the coordination marker or the hosted MCP URL. Figures come from the GitHub code-search response and, when star or push fields are missing there, from GET /repos/{owner}/{repo}. Code search allows 10 requests per minute, so search calls are spaced past that ceiling. A missing ADOPTION_SEARCH_TOKEN falls back to GITHUB_TOKEN; if that token cannot search public code, the process exits 0.

Run: `node scripts/snippet-adoption.mjs`
Flags seen: `--date` `--out` `--repo`
Env vars read: `ADOPTION_SEARCH_TOKEN` `GITHUB_TOKEN`

## soak-preload.mjs

Q007 soak harness — server-side instrumentation (observe-only).  Loaded into the server process with `node --import scripts/soak-preload.mjs` by scripts/soak-run.mjs. It changes nothing about how the server handles requests; it only samples the event loop, heap, and file descriptors, and records unhandled rejections. All samples are appended as NDJSON to the

Run: `node scripts/soak-preload.mjs`
Flags seen: none detected
Env vars read: `SOAK_INJECT_LEAK` `SOAK_INJECT_REJECTION` `SOAK_METRICS_PATH`

## soak-run.mjs

Q007 soak harness — orchestrator.  Boots the real server in a child process (with scripts/soak-preload.mjs instrumentation loaded via --import; the server's own code is untouched), applies sustained HTTP load, then evaluates memory growth, event-loop lag, file-descriptor growth, unhandled rejections, and crashes.

Run: `node scripts/soak-run.mjs`
Flags seen: `--help` `--import`
Env vars read: `SOAK_REPORT_PATH`

## spend-allowance-browser-check.mjs

Simulated human journey against disposable first-party data, not human research. Issue #6 C3: the room owner sets a spend allowance from the "Agent spend" card; every member sees allowance, spent, reserved and headroom move as a session reserves, reports and stops; only the owner has the controls; removing the allowance restores the default.

Run: `node scripts/spend-allowance-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## stall-probe.mjs

Fires one request per second for N seconds and fails when p99 latency exceeds the budget. Requests stay in flight together, which is the shape of a Durable Object input-gate stall (a sequential probe would hide it).    node scripts/stall-probe.mjs --url https://room.trydemigod.com --seconds 20 --path /api/ready 

Run: `node scripts/stall-probe.mjs`
Flags seen: `--max-ms` `--path` `--seconds` `--url`


## stamp-version.mjs

Stamp immutable release metadata into server/version.mjs at bundle/deploy time. Run immediately before bundling/uploading; commit the source first - the stamped revision must name an existing commit, never a working tree.

Run: `node scripts/stamp-version.mjs`
Flags seen: `--build-id` `--revision`


## start-room-browser-check.mjs

Start a room: the door's main button opens /?start=room. A new visitor sees "Sign in to start your room", signs in, and lands inside their own room instead of the Inbox. The intent is one-shot: a later visit without it keeps the normal landing. Setup asks for a name only, before the room is made.

Run: `node scripts/start-room-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## starter-recipes-browser-check.mjs

Local qualification of the H1 recipe strip against disposable first-party data.

Run: `node scripts/starter-recipes-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## stream-recovery-browser-check.mjs

NR-C1 authoring gate: existing client tests own sequence/read coalescing and service tests own cursor replay. These real-browser compositions protect the distinct final message-ID/content contract across held HTTP and native SSE.

Run: `node scripts/stream-recovery-browser-check.mjs`
Flags seen: none detected
Env vars read: `GITHUB_SHA` `ROOM_TEST_CHROMIUM_PATH`

## sync-design-tokens-css.mjs

Regenerate the design-token variable blocks in src/styles.css from src/design-tokens.js (single source of truth).  The :root (dark) and [data-theme="light"] blocks carry marker comments; everything between a begin/end marker pair is replaced with the generated declarations, preserving the surrounding lines (color-scheme, aliases).

Run: `node scripts/sync-design-tokens-css.mjs`
Flags seen: `--check` `--help`


## synthetic-mail-fixture.mjs

Local test double with its own database. Never imported by a deployed entrypoint.

Run: `node scripts/synthetic-mail-fixture.mjs`
Flags seen: none detected


## telegram-contract-fixture.mjs

Invented Telegram Bot API shaped data. No bot token, chat export or real people.

Run: `node scripts/telegram-contract-fixture.mjs`
Flags seen: none detected


## telegram-rotate-webhook.mjs

Rotate the Telegram webhook secret without an outage.    node scripts/telegram-rotate-webhook.mjs --generate [--window-hours 24]  Prints one fresh crypto-secure secret and the exact follow-up steps: 

Run: `node scripts/telegram-rotate-webhook.mjs`
Flags seen: none detected


## telegram-set-webhook.mjs

Register (or remove) the Telegram webhook for one inbox connection.    TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \     node scripts/telegram-set-webhook.mjs https://room.example.test --connection telegram-main [--dry-run] [--delete]  The token and secret come from the environment only (the same two bindings

Run: `node scripts/telegram-set-webhook.mjs`
Flags seen: none detected


## test-env.sh

Usage: #   scripts/test-env.sh npm test                    # run a command

Run: `bash scripts/test-env.sh`
Flags seen: none detected


## thread-options-browser-check.mjs

Browser check for the two thread-options features, desktop and narrow: the thread-view Mute/Unmute button and the "Also send to channel" checkbox on thread replies (hidden for DMs and top-level messages).

Run: `node scripts/thread-options-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## trace-entry.mjs

Trace-entry automation (W001): append one merge-time line to docs/ROOM-TRACES.jsonl when a pull request merges to main, so the raw-traces plane never needs a manual backfill again.  Runner: .github/workflows/trace-entry.yml (pull_request_target, closed). The workflow checks out main, runs this script, validates with

Run: `node scripts/trace-entry.mjs`
Flags seen: none detected


## unified-journey-check.mjs

Combined local UI/API journey. Every identity is a synthetic test participant.

Run: `node scripts/unified-journey-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## unit-ci.mjs

CI wrapper for one shard of `npm test` (CI-speed lane).  Runs the shard's Node-discovered test files with `node --test` and writes a receipt under test-results/ for scripts/unit-shards-check.mjs. The receipt binds the shard to the exact plan (planHash), run, revision and attempt so the `unit` merge gate can fail closed on stale or partial evidence.

Run: `node scripts/unit-ci.mjs`
Flags seen: `--test`
Env vars read: `GITHUB_RUN_ATTEMPT` `GITHUB_RUN_ID` `GITHUB_SHA` `TMPDIR` `XDG_RUNTIME_DIR`

## unit-shards-check.mjs

Required `unit` gate: successful Actions matrix AND all exact-run receipts. Mirrors scripts/browser-shards-check.mjs: every tests/*.test.js file must be covered exactly once by a passing shard from this exact run/attempt plan.

Run: `node scripts/unit-shards-check.mjs`
Flags seen: none detected
Env vars read: `GITHUB_RUN_ATTEMPT` `GITHUB_RUN_ID` `GITHUB_SHA` `UNIT_MATRIX_RESULT`

## unit-shards.mjs

Allocation for the sharded unit suite (CI-speed lane).  The `unit` merge-gate job ran `npm test` (Node default discovery) in one job: ~625s on hosted CI, the long pole of every PR head. This module splits the suite into SHARD_COUNT file shards with balanced estimated duration, so the `unit-shards` matrix finishes in roughly 1/SHARD_COUNT of the time.

Run: `node scripts/unit-shards.mjs`
Flags seen: none detected


## unstamped-member.mjs

A live member.added stamps the display-name policy and refuses a folded duplicate. These checks need a stored collision so the rail can disambiguate names. An older event omits the stamp and still replays.

Run: `node scripts/unstamped-member.mjs`
Flags seen: none detected


## untested-modules-lint.mjs

Untested-server-module lint (plan task T1). Lists server/*.mjs modules with zero references from tests/ and fails if a NEW module joins the untested set, or if the grandfather list still names a module that is now tested (the list only shrinks). Run: node scripts/untested-modules-lint.mjs

Run: `node scripts/untested-modules-lint.mjs`
Flags seen: none detected


## updates-browser-check.mjs

Updates HTTP/SQLite journeys: revision-bound marks, exact retries and retired navigation.

Run: `node scripts/updates-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## verify-affected.mjs

verify:affected: run only the unit tests related to your diff.    npm run verify:affected                  # diff vs origin/main (+ uncommitted + untracked)   npm run verify:affected -- --list        # print the selection and reasons, run nothing   npm run verify:affected -- --base=<ref> --budget=300 

Run: `node scripts/verify-affected.mjs`
Flags seen: `--exclude-standard` `--help` `--json` `--list` `--name-only` `--others` `--test`
Env vars read: `TMPDIR`

## visual-regression-browser-check.mjs

Q003: visual regression (screenshot diff) tests for the key UI pages.  Covers the three surfaces a visitor or member actually sees:   1. login/join entry pages — signed-out auth panel, join consent form      (live invite), join error state (bogus code)   2. signed-in room view — member chrome plus a seeded message list

Run: `node scripts/visual-regression-browser-check.mjs`
Flags seen: none detected


## visual-regression-helper.mjs

Q003: shared screenshot-diff helper for the visual regression browser checks.  The gate: committed baseline PNGs under scripts/visual-regression-baselines/ are compared pixel-for-pixel against a fresh capture on every CI run. A diff above MAX_DIFF_PIXEL_RATIO fails the check and writes the actual capture plus a diff image to test-results/visual-regression/ (picked up by

Run: `node scripts/visual-regression-helper.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH` `VISUAL_UPDATE_BASELINES`

## watch-deploy-drift.mjs

Deploy drift + 1101 watcher (plan task W3). Zero dependencies. Compares production's public /api/version to the local repo's main tip. Drift means that revision is missing, is not an ancestor of the tip, or the tip is ahead by more than --max-prs commits (default 5) or the first of those commits is older than --max-hours (default 24). A matching revision, or a lag inside both budgets, is not drift. An unhealthy probe

Run: `node scripts/watch-deploy-drift.mjs`
Flags seen: `--base` `--count` `--is-ancestor` `--max-hours` `--max-prs` `--ref` `--reverse` `--settle-ms` `--verify`


## weekly-learnings.mjs

scripts/weekly-learnings.mjs  Weekly "learnings" auto-post for muse-room (backlog W007).  Gathers the week's signal and posts ONE concise digest to the room:   - merged PRs (via gh), each with a one-line lesson (a `Lesson:` line in

Run: `node scripts/weekly-learnings.mjs`
Flags seen: `--dry-run` `--help` `--jq` `--json` `--limit` `--post` `--queue` `--repo` `--room` `--since` `--state` `--state-dir` `--week`
Env vars read: `WEEKLY_LEARNINGS_REPO` `WEEKLY_LEARNINGS_ROOM` `WEEKLY_LEARNINGS_STATE_DIR`

## wiki-build.mjs

W009: build-time embed of the wiki planes for the read API.  The wiki read API (server/wiki-read-api.mjs) serves this data in every runtime, including the bundled Cloudflare worker, which has no filesystem. Regenerate after any wiki-plane change:   node scripts/wiki-build.mjs            write server/wiki-data.mjs

Run: `node scripts/wiki-build.mjs`
Flags seen: `--check`


## work-attempts-browser-check.mjs

Simulated human journeys against disposable first-party data, not human research.

Run: `node scripts/work-attempts-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## work-changes-browser-check.mjs

Simulated human journeys in real browsers against isolated, synthetic rooms.

Run: `node scripts/work-changes-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## work-context-agent-seed.mjs

Deterministic synthetic prehistory only. Fresh agents provide the correction and real review.

Run: `node scripts/work-context-agent-seed.mjs`
Flags seen: none detected


## work-lifecycle-agent-fixture.mjs

Synthetic same-room participation, never a hosted runner or external workspace.

Run: `node scripts/work-lifecycle-agent-fixture.mjs`
Flags seen: none detected


## work-recipes-browser-check.mjs

Simulated human journeys against disposable first-party data, not human research. Picking a recipe copies only its definition into the editable fields.

Run: `node scripts/work-recipes-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## work-resume-browser-check.mjs

Synthetic restart journey in a real browser; no real user data or agents.

Run: `node scripts/work-resume-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## work-reuse-agent-fixture.mjs

Disposable actual-agent exercise. No production paths or existing database accepted.

Run: `node scripts/work-reuse-agent-fixture.mjs`
Flags seen: none detected


## work-reuse-browser-check.mjs

Simulated human journeys against disposable first-party data, not human research.

Run: `node scripts/work-reuse-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`

## work-search-browser-check.mjs

Simulated local people. Search must not submit, acknowledge or create work.

Run: `node scripts/work-search-browser-check.mjs`
Flags seen: none detected


## worker-ci-build.mjs

Bundle validation without production key custody. This command always uses --dry-run; the real deployment config continues to require a signed card.

Run: `node scripts/worker-ci-build.mjs`
Flags seen: `--allow-unsigned` `--config` `--dry-run` `--outdir`


## workflow-browser-check.mjs

Disposable local participants only; no external runtime or evidence is fetched.

Run: `node scripts/workflow-browser-check.mjs`
Flags seen: none detected
Env vars read: `ROOM_TEST_CHROMIUM_PATH`
