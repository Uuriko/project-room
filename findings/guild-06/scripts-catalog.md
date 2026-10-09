# scripts/ catalog — guild-06 (scripts-rest)

Slice: everything under `scripts/` except `scripts/room`, `scripts/*migrate*.mjs`,
`scripts/runtime-package.mjs` (guild-05). Head: `a436d0cac` (2026-10-08).

Conventions used below: **P**urpose, **U**sage, **F**ailure modes, **I**nvariants/gotchas.
`* -browser-check.mjs` files are `node:test` Playwright suites run by the browser CI
shard (`scripts/browser-ci.mjs`); unless noted they boot a disposable local server
against a fixture store over loopback, use disposable identities/keys, and clean up
(`rmSync` temp dirs, `server.close()`) in `t.after`. Common env: `ROOM_TEST_CHROMIUM_PATH`.

---

## docs-01 — a11y … agent-work-preflight (chunk 00)

### a11y-axe-helper.mjs
- **P**: Shared axe-core runner/config for the Q011 accessibility browser checks.
- **U**: Imported by `a11y-*-browser-check.mjs`; exports `A11Y_TAGS`, `chromiumLaunchOptions()`, `axeSerious`, `assertAxeClean`.
- **I**: One axe config everywhere (wcag2a/2aa/21a/21aa/22aa) so cross-check diffs are page diffs, not config drift. Fail signal = serious/critical impacts only; minor/moderate are reported in the failure detail but don't fail. Honors `ROOM_TEST_CHROMIUM_PATH`.

### a11y-composer-browser-check.mjs
- **P**: Q011 axe sweep scoped to the message composer (`#message-form`, open `#composer-options`).
- **F**: Any serious/critical axe violation fails; message lists every violation with help text + first offending selectors.

### a11y-login-browser-check.mjs
- **P**: Q011 axe sweep of the two unauthenticated entry points: signed-out room page auth panel and `join.html` (consent form with live invite code + bogus-code error state), desktop 1280 + mobile 390.

### a11y-room-browser-check.mjs
- **P**: Q011 axe sweep of the signed-in room view (message list seeded with one message, member chrome, dialogs closed), both viewports.

### acceptance-fixture.mjs
- **P**: Builds the shared disposable fixture (`createAcceptanceFixture`) used by browser checks: reads base64+gzip payload from `.acceptance-fixture.b64`, applies char-level fixes from `.acceptance-fixture.b64.fix` if present, verifies via sha256-derived filename, gunzips to a generated module (written once, reused).
- **I**: Generated module is content-addressed (`.acceptance-fixture.<digest>.generated.mjs`); fixture edits ship as `.b64` + `.fix`, never by editing generated output. Gotcha: the `.fix` format is `pos:char` lines — a wrong offset silently corrupts the payload (digest changes, new module generated).

### acceptance-handoff.mjs
- **P**: CLI that advances only the synthetic fixture through producer/reviewer API exchanges (`first-review` | `correction`).
- **U**: `node scripts/acceptance-handoff.mjs TEST-CREDENTIALS.json first-review|correction`
- **F**: Refuses anything but an isolated localhost fixture (`http:` + `localhost` + exact origin match); aborts unless the snapshot is the disposable acceptance room with `test-handoff` work item. Human-role approval is deliberately left to the browser test.

### access-preview-browser-check.mjs
- **P**: C2 journey — the read-only "what this agent can access" preview on a work card, with pending-request counts. Uses `helpers/signed-evidence.mjs` test signer.
- **I**: Simulated human journeys against disposable first-party data, not human research.

### access-review.mjs
- **P**: BUILD-01 D4 periodic access review CLI. Plain review is read-only. Sources: `--db PATH` (store file) or `--origin URL` (running service, owner key from env var named by `--key-env`).
- **U**: `node scripts/access-review.mjs [--db PATH | --origin URL --key-env NAME] [--room ID ...] [--json]`; `--revoke-identity` records one owner revoke in the store file (clears both membership-administration stores) then prints the review.
- **F**: `--db` + `--origin` together → error; `--revoke-identity` requires `--db` (not `--origin`) and exactly one `--room`. Credentials never accepted on the CLI and never printed; report contains no tokens/secrets/hashes.
- **I**: Mutation-verified (guild-06): conflict rejection and revoke arity are test-guarded.

### accessibility-check.mjs
- **P**: Cross-session return-brief isolation + bounded accessibility regressions via real browser against disposable loopback service (uses acceptance fixture, email contract fixture, magic-link signin journey, composer options).
- **I**: No external identity or agent runtime.

### account-deletion-browser-check.mjs
- **P**: QA2 P2-11 — Settings → Sign-in & security → Advanced → Delete account: dialog shows the plan, requires the account email, posts the confirmation token with the session CSRF header.

### account-settings-browser-check.mjs
- **P**: Account settings UI (slice 7, RC-2026-09-17-016): session menu → Sign-in & security; linked methods render with honest provider-unconfigured states; disable/enable/remove through the real UI incl. last-active-method guard; recovery codes generated and shown once.

### account-workspace-check.mjs
- **P**: Non-test CLI? Header shows fixture-style imports (`openMagicSignin`, synthetic mail fixture, magic links) — account workspace exercise against disposable data. (Entry truncated in header dump; full read deferred to re-verify pass.)

### accountless-join-restore-browser-check.mjs
- **P**: Regression for #817 — account-less invite join (authMode "room", account null) must land inside the room and survive reload; previously hardened `ownsResponse()` rejected valid account-less sessions and stranded fresh joiners at the account gate.

### acquisition-browser-check.mjs
- **P**: Templates, template page, public room page, agent directory at 390px width: each document fits and exposes main + footer.

### action-dialog-focus-scroll-browser-check.mjs
- **P**: NR-B regression — the action dialog's async exact-text load must not leave the focused review-notes textarea clipped by the dialog's bottom edge at 320×900 (post-load focus re-assert in `loadActionText`; slow exact-text response shifted layout after the browser's focus scroll).

### action-recovery-browser-check.mjs
- **P**: Simulated human flows in disposable loopback rooms for action recovery (uses signed-evidence test signer). No external work or evidence fetched.

### activity-feed-browser-check.mjs
- **P**: Attention surfaces — Activity feed, Later (saved messages), Mark unread, read-horizon "New messages" divider; desktop + mobile.

### agent-claude-channel.mjs
- **P**: Thin entry point: Claude Code spawns this file directly; delegates to `room-listen.mjs` `main(['--mode','channel', ...])`. Starts no model.

### agent-connect-browser-check.mjs
- **P**: Agent connect journey in a real browser (spawns flows, collects `pageerror`s, asserts none leak). Disposable fixture + local HTTP service.

### agent-doctor.mjs
- **P**: Library module (not directly executable — invoked via `node scripts/agent-inbox.mjs doctor`). Read-only self-test of the agent plug-in loop: origin, credential source/access, one concrete repair step for the first failure, then a symptom→check→fix table.
- **I**: Never prints secrets (only origin, room id, member id). Never writes to the room. One-probe-one-repair. Mutation-verified: usage-arity guard and credential-source detection are test-guarded.

### agent-fast-path-check.mjs
- **P**: Synthetic new-agent journey through public HTTP + hosted MCP against a local fixture server (no live service); records timings — the "fast path" latency probe.

### agent-inbox.mjs
- **P**: The agent CLI multiplexer: inbox, doctor, reply, watch, room-templates, etc. subcommands over the existing private connection (`ROOM_AGENT_CONFIG` or env vars).
- **F**: `reply` reads JSON tool args from stdin capped at 16KB; invalid tool name → error. Never outputs credentials.
- **I**: One explicit operation per invocation; no watcher/implicit ack/rerun/rebase/model dispatch in reply path.

### agent-mcp.mjs
- **P**: Serves the room MCP over stdio (`serveRoomMcp` from `client/mcp-stdio.mjs`) using the existing private connection. Usage: no args (any argv → `usage_error`); `member_required` if no member id.
- **I**: Optional attention dir (`ROOM_AGENT_ATTENTION_DIR` + `ROOM_AGENT_ATTENTION_VERSION` 2|3). SIGINT/SIGTERM stop cleanly.

### agent-onboard.mjs
- **P**: Agent onboarding journey CLI — buddy/coach pattern: `start`, `coach`, `check`, `checklist`, `intro`, `status`.
- **U**: `node scripts/agent-onboard.mjs start <identityId> [--name <display>]` etc.
- **I**: State lives in a local JSON file (`ROOM_ONBOARD_STATE`, default `./.room-onboarding.json`); nothing is written to the room — local checklist + template renderer only. Gotcha: state file is CWD-relative; run from the intended directory.

### agent-pause-browser-check.mjs
- **P**: C6 — owner-facing Pause/Resume/Remove for agent members in the People panel via `POST /api/rooms/:id/agent-pause`; Remove sends `MEMBER_ACCESS_CHANGED` after a second confirming click (no native dialog).

### agent-replies.mjs
- **P**: Library module for `agent-inbox.mjs reply`: one explicit reply-tool operation over the existing private connection; JSON args on stdin (16KB cap), exact input + requestId preserved for uncertain writes.

### agent-resume.mjs
- **P**: CLI: `node scripts/agent-resume.mjs [--focus replies] [--since-version HEX] [--attention-cursor JSON]` — reads current obligations/claim references or reply requests. No acknowledgement, no execution.
- **I**: Strict arg parsing: unknown flags, missing values, or duplicate flags → `usage_error`; `--focus` accepts only `replies`. Mutation-verified.

### agent-signin-browser-check.mjs
- **P**: Visible entry choices open focused flows without hiding pending agent sign-in; 1280 + 390 widths.

### agent-wake.mjs
- **P**: CLI for the agent wake queue: `doctor | setup --host ID --cadence-seconds N | wait --host ID ... | ack --host ID --signal ID`.
- **I**: Setup registers, never starts a listener/model. Wait reads wake hints + fresh attention, never acknowledges. Ack only after handling the signal.

### agent-watch.mjs
- **P**: Library module (`WATCH_HELP`) for `agent-inbox.mjs watch`: read-only assignment watcher — `start PRIVATE_DIRECTORY [--once]`, `status`, `stop`, `pull`, `ack` (+ v3 `--requests` variants).
- **I**: Start takes `ROOM_AGENT_CONFIG` or `ROOM_AGENT_ORIGIN/ROOM/TOKEN` (+optional member); never mix sources.

### agent-work-access-browser-check.mjs
- **P**: H4 — a link-joined agent has no permissions so never appears as assignee; owner sees "Let them take work" in People, work form explains the absence, one click makes the agent assignable. Agents with their own connection key are pointed to Manage connections (changing access retires that key).

### agent-work-preflight.mjs
- **P**: Read-only preparation helper, not authorization and not a substitute for required CI. `readPreparation(client, workItemId, since=0)` pages `workDiscussion` (limit 50, ≤100 pages), returns items + checkpoint.
- **F**: Non-safe-integer or negative `since` → "Invalid checkpoint"; cursor that doesn't advance → "Discussion cursor did not advance"; >100 pages without checkpoint → "Discussion exceeds preparation limit". Mutation-verified.


---

## docs-02 — an-funnel-1 … check-deps (chunk 01)

### an-funnel-1.mjs
- **P**: AN-FUNNEL-1: signup → first message → first reply activation funnel, read-only.
- **U**: `node scripts/an-funnel-1.mjs --db <path-to-room.sqlite> [--since <iso-date>]`
- **F**: Exit 0 + JSON report on stdout; exit 2 on bad args; exit 1 when the DB can't answer (missing tables), reason on stderr.
- **I**: Opens the DB with `PRAGMA query_only=ON`; uses only already-recorded data (analytics_events signup rows, member_accounts bindings, message.posted events). No new event types, no schema changes, no writes.

### analytics-backfill.mjs
- **P**: Read-only one-shot analytics backfill: copies the tail's tables into memory, runs the tail there, prints the baseline. The input file is never written.
- **I**: AN-1b schedules this shape; this script is the one-shot form. Mutation-verified (empty-table handling, loop guard, unfinished-tail throw, sql-presence check).

### answer-engine-check.mjs
- **P**: Weekly check: same prompts go to ChatGPT, Claude, Perplexity, Grok, one call each; scores derived from response text + cited URLs.
- **F**: A missing API key skips that engine; exits 0 when nothing was called. Raw answers written for the workflow artifact, never committed.
- **I**: Mutation-verified (prompt validation, span-sort order).

### assisted-agent-exercise.mjs
- **P**: Disposable loopback room for independent agents (operator creates assignments only; participants supply their own work). Exports `startAssistedAgentExercise()`; temp dir chmod 0700, torn down after.

### assisted-work-browser-check.mjs
- **P**: Assisted work journeys (desktop+mobile): scope conflict, explicit release, exact retry, quiet catch-up. Real browser commands against disposable loopback rooms only; no external agent runs.

### audit-invitations.mjs
- **P**: Trusted local operator tool: verifies the invitation audit journal for consistency, read-only.
- **U**: `node scripts/audit-invitations.mjs [--db <path>] [--help]`
- **I**: Never prints account identities, invitation contents, or secrets. Read-only open never runs a migration or repairs a projection; schema-v8 DB required.

### audit-native-request-evidence.mjs
- **P**: Read-only evidence correlation across 4 evidence files (Room, Codex clarification, Codex production, Claude review): parses host `item.completed` mcp_tool_call events, asserts exit code 0, correlates results.
- **F**: Takes exactly 4 JSON file args; throws otherwise. No host invocation, credentials, or networking.

### auth-return-browser-check.mjs
- **P**: Welcome, sign-out, and return-to-room checks for a new human account (magic-link signin journey, account setup dialog dismiss).

### auth-signin.mjs
- **P**: Shared helper: authenticates disposable local browser fixtures through the real credential API (`signInFixture(page, accessKey, {returnTo})`).
- **I**: Refuses non-local servers (only localhost/127.0.0.1/[::1]); fixture return URL must stay on the same origin. Never mounts a production form or injects store/session state.

### backup-drill.mjs
- **P**: Backup/restore drill: proves a live room survives a sqlite backup round-trip byte-for-byte on events and room files (REL-14), not just row counts. `node scripts/backup-drill.mjs`; disposable temp dir.

### backup-room.mjs
- **P**: Production backup CLI: `node scripts/backup-room.mjs --db PATH --to DEST` (or `$ROOM_DB`).
- **F**: On verification failure prints "Backup failed verification. Live data was not replaced…" and exits 1. Sets `process.umask(0o077)` so backup files are owner-only.
- **I**: Emits JSON result on stdout.

### backup-verify.mjs
- **P**: F001: automated backup schedule + restore verification (automates backup-drill.mjs and restore-rehearsal.mjs): cron/interval schedule config, one-cycle runner (skips when not due), restore-verification pass exercising `server/backup.mjs`.
- **U**: `node scripts/backup-verify.mjs --db room.sqlite --to /private/backups --schedule hourly [--state state.json] [--force] [--dry-run]`; `--print-cron` prints the cron line.
- **I**: Schedule spec validation (named intervals, durations, 5-field cron with `*` constraints). Mutation-verified (interval bound, cron arity, watermark version/attachment checks). Env fallbacks: ROOM_DB, BACKUP_DIR, BACKUP_SCHEDULE.

### board-browser-check.mjs
- **P**: Tasks › Board: claim actions, linked work, return journeys at 390px + axe. Boundary is the room page + work-claim HTTP API; no test doubles.

### bootstrap-agent-room.mjs
- **P**: One-shot agent path: identity-create → room-create → invite-code (profile chat|contribute|review|collaborate) → optional first message. Secrets print once on stdout — never commit them. Sibling of agent-inbox.mjs.
- **I**: Live www door: `ROOM_AGENT_ORIGIN=https://www.getdasha.com` (no /room path). Exports `slugRoomId`.

### bounty-conservation-check.mjs
- **P**: Scheduled read-only verifier for the bounty-escrow hash chain / conservation invariant. Phase-1 research found `BountyEscrow.verifyConservation` had zero production callers (tamper-evidence was write-only); this script wires the benefit back in across every room and emits a machine-readable report.
- **I**: DB opened with `node:sqlite { readOnly: true }`; `db.readOnlyTransaction` set before touching BountyEscrow — read-only at the driver level, not by convention. Mutation-verified (report `ok` flag, escrow branch).

### browser-check.mjs
- **P**: Generic browser check: real browser + local HTTP service, disposable fixtures; desktop (1440×1000) + mobile (390×844) matrix.

### browser-ci-reporter.mjs
- **P**: `node --test` reporter for the browser gates: turns every failure into a GitHub workflow command (job annotation) + one duration line per script. Pure output — never changes which tests run or how they're judged. Used next to the spec reporter. On non-Actions runs, same facts print as plain lines.

### browser-ci.mjs
- **P**: CI wrapper for `npm run test:browser` (BUILD-01 B50). Runs the same suite list as `test:browser` (read from package.json — journey-coverage keeps single source of truth) with `spec` (stdout) + `junit` (RESULTS_FILE for report-test-failures.mjs → GitHub annotations + job summary).
- **I**: `test:browser` itself is unchanged for local use.

### browser-shards-check.mjs
- **P**: Required `browser` gate: asserts successful Actions dependency AND all exact-run receipts.
- **U**: `node scripts/browser-shards-check.mjs RECEIPT_DIRECTORY`
- **I**: Reads `browser-shard-*.json` receipts; verifies via `browserPlan`/`verifyBrowserShards` against package.json's `test:browser`, with matrix result / revision / run id from env.

### browser-shards.mjs
- **P**: Library: 6-way shard allocation for the browser suite. `SHARD_COUNT=6`; `parseShard("2/6")` validated strictly; `browserPlan(script)` parses the `test:browser` command.
- **I**: Allocation consumes the canonical package script; timing data (`browser-ci-durations.json`) never selects membership — only ordering.

### build-agent-docs.mjs
- **P**: Builds static `/docs/agents` pages from `docs/agents/*.md` + the connect table (`server/connect-snippets.mjs`); origin pinned to `https://room.trydemigod.com`.

### build-capabilities.mjs
- **P**: Build-time capability inventory for deploy-aware discovery (#601): inventories the route table → family→boolean map consumed by `deploy/agent-discovery.mjs`'s `agentCard()`.
- **U**: `node scripts/build-capabilities.mjs --check` fails when the checked-in `deploy/capabilities.mjs` drifts from route sources.
- **I**: Every route in the build is mounted (no server-side feature flags), so "what is deployed" == "what build is deployed". Regenerated by the wrangler build.command next to stamp-version.mjs.

### build-gmail-sanitizer.mjs
- **P**: Rebuilds the self-contained gmail sanitizer (esbuild bundle of sanitize-html) so offline runtime packages still boot.
- **I**: Resolves esbuild through Node module resolution anchored at `cloudflare/package.json` — never a hardcoded `../cloudflare/node_modules/esbuild` path (breaks under pnpm's symlinked layout; phase-2 gap audit L-P2-21).

### build-og-atlas.mjs
- **P**: Builds runtime OG assets: `og/base-receipt.png`, Inter glyph atlases, `og/atlas.json`. Playwright rasterizes Inter Regular from `og/fonts`.
- **U**: Re-run via `npm run build:og-atlas` after a font change. Marketing images `og/{home,about,offers,compare,receipts}.png` are NOT written by this script.

### build-push-sw.mjs
- **P**: Classic service worker build (HB-3a): inlines `src/human-push-display.js` (export-stripped) so `push-sw.js` has no import — iOS 16.4–18.3 home-screen workers reject `register({type:"module"})`.
- **U**: Re-run after editing the display module: `node scripts/build-push-sw.mjs`.

### build-pwa-icons.mjs
- **P**: Rasterizes `favicon.svg` into the PWA icon set via Playwright screenshots (committed PNGs match the mark). Maskable icons keep the mark inside the center 80% safe zone.

### build-ui-strings.mjs
- **P**: Generates `strings/en.js` from `strings/en.json`.
- **U**: `node scripts/build-ui-strings.mjs --check` throws when the generated module is stale (used in CI).

### calm-return-browser-check.mjs
- **P**: Simulated human return journeys (desktop+mobile): current needs, personal reminders, frozen history, clock-only changes. Not retention evidence or real user feedback.

### candidate-manifest.mjs
- **P**: Frozen candidate manifest: pins runtime, assets, schema, package hashes so tests and deployment prep refer to the same bytes.
- **U**: Exports `MANIFEST_PATH="docs/CANDIDATE-MANIFEST.json"`.
- **I**: Deterministic — same tree always produces the same manifest; drift is a byte comparison. Covers deploy files, package files, and the runtime package (imports `publicAssets` from guild-05's runtime-package.mjs — read-only import, not modification).

### candidate-runtime-fixture.mjs
- **P**: Test-only packaging of allowlisted working files via `createRuntimePackage` at HEAD; adds `client/agent-setup.mjs`, `client/setup-journal.mjs`, `scripts/connect-room.mjs`.
- **I**: Never a release certificate.

### channels-browser-check.mjs
- **P**: Phase 2 channels journey: sidebar lists main + created channels; create/rename/archive through the dialog; each channel shows only its own messages. Disposable first-party data.

### chat-performance-browser-check.mjs
- **P**: Observable chat cost contract: ordinary arrivals leave historical DOM and hidden logs untouched, don't poll unchanged request-run subscriptions. Real Chromium + local server; no production hooks, no timing thresholds.

### chat-suggestions-browser-check.mjs
- **P**: Chat suggestions above the composer: one-tap replies send as ordinary messages; a work-like request offers "Make this a task" which opens the work form from that message. Desktop + mobile.

### check-deps-exist.mjs
- **P**: Zero-bug gate — dependency-existence ("slopsquatting" defense). (1) Registry existence: every declared dep (deps+devDeps+optionalDeps) must exist on the npm registry; hallucinated names fail. Local specs (file:, link:, git+, github:, http(s):, workspace:) skipped. (2) Declared-imports: every bare import in scanned sources must be a declared dep, a Node builtin, or relative.
- **U**: `node scripts/check-deps-exist.mjs [--root <dir>]`
- **I**: Zero-dep (only node: builtins). Network: one packument fetch per declared package.

### check-deps.mjs
- **P**: Fail fast when node_modules is stale vs package.json: missing deps (e.g. `yaml` added in PR #1351) otherwise die as bare ERR_MODULE_NOT_FOUND deep in an import; this check says "re-install" up front. A clean `npm ci` always fixes it.

---

## docs-03 — check-no-shadow-imports … dogfood-return (chunk 02)

### check-no-shadow-imports.mjs
- **P**: CI gate: no `const`/`let` may shadow an imported name when the import is used earlier in the file — that pattern is a runtime TDZ ReferenceError that `node --check` cannot see (broke the browser job on main in `room-door-browser-check.mjs` where the `join` locator shadowed the `node:path` import).
- **I**: Deliberately strict — rename the local. Scans server.mjs, src, server, client, scripts, tests, cloudflare/*.mjs.

### check-schema-version.mjs
- **P**: CI gate: the store schema number has exactly one source — `STORE_SCHEMA_VERSION` in `server/writer-fence.mjs`. Everything else stating the number (README status line, `docs/CURRENT-ROOM.md` map, `docs/SERVICE.md`, writer function name, fenced version list) must agree.
- **I**: The map once said 26 while the store was on 27; this fails that drift.

### check-wiki.mjs
- **P**: Wiki schema check: `docs/ROOM-WIKI.md` must be a well-formed append-only log.
- **U**: `node scripts/check-wiki.mjs` — exit 0 success, 1 failure. Validates `## YYYY-MM-DD · … · …` headers, fence balance.

### check.mjs
- **P**: Pre-test gate (`npm run check`): fails fast on Node <24.19.0 with a clear message (package.json engines; npm only warns without engine-strict), then syntax-checks the tree (`node --check` over server/src/client/scripts/tests/cloudflare).
- **F**: Old Node → stderr message + exit 1.

### ci-changes.mjs
- **P**: Decides which expensive CI suites a PR actually needs. GitHub's `on.pull_request.paths` looks at the pushing commit, so merging main into a branch retriggers every suite main touched; this classifies `git diff <base>...<head>` (the "Files changed" diff) instead.
- **I**: Push/schedule/workflow_dispatch are not PRs: browser+eval+coverage stay enabled so main tip runs the full matrix. Outputs `browser=`, `eval=`, `coverage=` to GITHUB_OUTPUT.

### claim-bond-shadow.mjs
- **P**: P0 shadow-mode reporter for claim bonds.
- **U**: `node scripts/claim-bond-shadow.mjs --db <room.sqlite> [--room <roomId>] [--sync]`
- **F**: Exit 0 + JSON on stdout; exit 2 bad args; exit 1 DB can't answer.
- **I**: Without `--sync` strictly read-only (`PRAGMA query_only=ON`), reports baseline flake rate from `claim_bond_shadow`. With `--sync` replays `work_claim.updated` events into the journal (idempotent; writes only its own additive table, outside the writer fence).

### claim-overlap-browser-check.mjs
- **P**: Claim overlaps on the work card: a claim covering paths another active claim in the same repo holds shows "Overlaps 1" naming the other work, holder, and paths. Real browser + local HTTP; disposable fixtures.

### claim-reputation-sync.mjs
- **P**: P1 claim-reputation journal tool; same shape as claim-bond-shadow (`--db`, `--room`, `--sync`; read-only without `--sync`; idempotent replay with `--sync`).
- **I**: Reachability entry point for `server/claim-reputation.mjs` (keeps the module from looking dead). Weekly P1 measurement (CLAIMBONDS-P1-SPEC-2026-10-05.md) re-runs the P0 baseline and diffs against 2026-10-05; this script populates the journal it reads.

### claims-index.mjs
- **P**: Read-only claims-board indexer for the swarm coordination board (Uuriko/project-room#266): fetches #266 comments (REST, numeric ids), parses ` ```room-claim ` blocks + receipt comments, emits a static JSON index + compact markdown board.
- **U**: `node scripts/claims-index.mjs [--comments <file>] [--out <dir>] [--format json|md|both] [--now <iso>]`
- **I**: Read-only against GitHub — only network call is `gh api .../issues/266/comments --paginate` (GET). Output to local files; nothing committed/pushed. Malformed input (prose CLAIM posts, `lease: 6h` without `lease=` prefix, path-only comments, missing bodies) recorded under `unregistered` — never silently dropped, never a crash. Mutation-verified (arg off-by-one, format validation).

### cold-start-probe.mjs
- **P**: First-request budget for an isolated staging deploy. The workflow runs this right after `wrangler deploy --env staging`, before smoke traffic, so the request constructs the Durable Object.
- **U**: `node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000]`
- **F**: Missing/invalid args → usage on stderr + exit 1; over-budget first request fails the check.

### compare-recovery.mjs
- **P**: Offline operator tooling for recovery comparison: canonicalizes values (sorted keys) → sha256 digests, compares recovery/audit outputs across sources.
- **I**: No repair, credential use, restore, or reopening path — comparison only.

### composer-browser-check.mjs
- **P**: Composer journeys (desktop 1440×1000 + narrow 320×780): keyboard recovery, discussion errors, composition, access cleanup. Synthetic browser fixtures — not a stand-in for physical-device or human AT runs.

### connect-agent-first-screen-check.mjs
- **P**: Agent instructions stay discoverable behind one disclosure; direct links open it. Sign-in stays minimal; connection guide opens post-login on request and via deep link. Desktop + touch.

### connect-room.mjs
- **P**: Library module (`connectMain`) for `agent-inbox.mjs join`: invite code/room URL → admission flow into a private directory.
- **U**: `node scripts/agent-inbox.mjs join INVITE_OR_ROOM_URL PRIVATE_DIRECTORY [--name NAME] [--accept] [--identity-from SAVED_CONNECTION]`
- **I**: An invite code alone needs `ROOM_AGENT_ORIGIN`. Preview first; `--accept` accepts the disclosed grant. Repeat same command+directory to resume. Secrets stored privately, never printed. A bare service URL registers/reuses identity and lists rooms.

### contribution-journey-check.mjs
- **P**: Full synthetic browser journey (desktop+touch): join, answer, return, review. No human research or autonomous-agent claims.

### coverage-thresholds.mjs
- **P**: Per-module coverage ratchet gate (backlog Q015): measures line coverage per module from the root `node --test` suite via V8 coverage (`NODE_V8_COVERAGE`, zero deps); fails when any configured module drops below its threshold in `coverage-thresholds.json`.
- **U**: `node scripts/coverage-thresholds.mjs [--collect-only] [--coverage-dir <dir>] [--baseline] [--config <path>]`
- **I**: Thresholds are set at measured levels (ratchet) — the gate prevents silent decay, it does not demand improvement. Exit 0 all met; 1 threshold breach; 2 usage.

### credit-question-browser-check.mjs
- **P**: Credit question journeys (desktop+mobile): preserved drafts, earlier result, exact retry, MCP answer. Simulated human browser + real scripted MCP subprocess; no external AI inference.

### dasha-bridge.mjs
- **P**: Dasha bridge (reference implementation, Round-2 task #116): delegates LM work to Dasha Compute — work items titled `[dasha] <prompt>` get their prompt sent to Dasha's OpenAI-shaped API; the answer is posted back as a message referencing the work item.
- **U**: `DASHA_API_KEY=... ROOM_TOKEN=... node scripts/dasha-bridge.mjs run-once` | `... prompt "Explain Raft in 3 sentences"`
- **I**: A reference, not a daemon: `run-once` handles one work item and exits. Polling/claiming is left to the operator — work-item claims carry real accountability.

### decision-register-browser-check.mjs
- **P**: Decision register (backlog F2): a human with `decide` promotes a message into a source-backed decision record; members without `decide` get no affordance. Disposable rooms only.

### deleted-message-browser-check.mjs
- **P**: Deleted-message rendering (wave finding fix): `message.deleted` tombstones the projection (body=null, deletedAt); rendering must honor the tombstone — no null-body crashes in reply previews, search, request/decision labels; no body-dependent actions on deleted messages.

### dependency-audit.mjs
- **P**: Weekly dependency audit: `npm audit --json` through an injectable runner, groups vulns by severity, emits Markdown report + JSON summary. Cron/CI: exit 0 clean or below `--fail-on`; exit 1 vulns at/above threshold; exit 2 audit itself failed.
- **U**: `node scripts/dependency-audit.mjs [--fail-on=<severity>] [--out=<path>] [--json-out=<path>]`
- **I**: Pure functions (`parseAuditJson`, `groupBySeverity`, `summarizeAudit`, `thresholdBreached`, `renderMarkdown`, `renderJsonSummary`) are unit-tested in `tests/dependency-audit.test.js`; only the npm invocation goes through the injectable runner. Mutation-verified (severity validation, error detection).

### deploy-checks.mjs
- **P**: F007 reproducible deploy checks — lockfile + asset hash verification: (a) package-lock.json exists and is in sync with package.json (dep sections/specs, name/version); (b) deploy assets hash to SHA-256 values pinned in a manifest (default `.asset-hashes.json`).
- **U**: `node scripts/deploy-checks.mjs [--root <dir>] [--assets <csv>] [--manifest <path>] [--check | --write] [--lockfile-only | --assets-only]`
- **F**: Exit 0 pass; 1 check failed; 2 usage. Env: DEPLOY_CHECK_ROOT/ASSETS/MANIFEST.

### deploy-live.py
- **P**: Uploads an existing Room Worker via the Cloudflare API (`api.cloudflare.com` only). Reads the checked-in Worker topology for metadata; preserves live text/secret bindings. Never changes migrations, schedules, routes, or custom domains.
- **U**: `deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>`
- **I**: Script name allowlisted to known project-room Worker names (deep audit 2026-09-27: an arbitrary name would deploy the bundle with production bindings to the wrong Worker). Gotcha: inserts `/opt/hatch/skills/skill-creator/bin` into `sys.path` — machine-specific path; the script only runs where that exists.

### deploy-recovery.mjs
- **P**: Schema-aware recovery for deploy-prod. Reading `/api/version/worker` never opens a Durable Object; schemas are parsed from exact git blobs, never evaluated. Exports `schemaAt(revision)`; validates 40-hex SHAs and UUIDs.

### design-cohesion-browser-check.mjs
- **P**: Computed-style regression for shared design tokens + the regrouped Settings dialog. No pixel-snapshot library — screenshots are evidence, assertions are the check.

### design-contrast-check.mjs
- **P**: WCAG 2.2 AA gate for shared design tokens: every `CONTRAST_PAIRS` entry must meet its minimum ratio.
- **U**: Runs from `scripts/check.mjs` (contract job), including in CI where the unit suite is skipped. Exit 1 lists failing pairs.

### desktop-google-browser-check.mjs
- **P**: Real desktop consent through Google's cross-origin browser return. Provider authorization/token/JWKS are synthetic (via `helpers/google-oauth-fixture.mjs`); every Room route and cookie is real. Covers outdated-terms, selection states, provider errors (e.g. `access_denied`).

### disclosure-check.mjs
- **P**: Quiet Focus A1/A2: a background snapshot must not collapse an open disclosure, steal focus, or clear a draft. Real browser + local HTTP; disposable fixtures.

### discovery-contribution-browser-check.mjs
- **P**: Discovery → contribution journeys (desktop+touch) with scripted MCP participants and simulated people; never invokes a native model.

### discovery-profile.mjs
- **P**: Local synthetic transfer/read-volume measurement comparing authority-read shapes (full vs narrow `json_extract` projection). Not a latency or production benchmark.

### disk-door.mjs
- **P**: Disk door: joins the shared-disk agent channel (`~/src/agent-bus/channel.jsonl`, one JSON object per line `{at, from, body}`) to one Room. Agents sharing a computer but unable to reach Room origins (sandboxed VMs, TUIs without MCP) append lines; whoever runs this with a Room identity relays them in, and room messages come back as lines from `room:<name>`.
- **U**: `node scripts/disk-door.mjs sync --channel ~/src/agent-bus/channel.jsonl` with `ROOM_AGENT_CONFIG` pointing at a saved connection.
- **I**: Run it where an identity already lives (e.g. next to the Grok host).

### dm-consent-browser-check.mjs
- **P**: DM consent UI journey under default-open DMs: request → pending (never gates the composer) → approve → DM posts → revoke → gate refuses with next step → block → gate errors → unblock; forced-500 visible notice; logged-out public face stays consent-control-free.

### docs-link-check.mjs
- **P**: Intra-repo markdown link check over maintained docs. `docs/history/` is a record and is not checked.
- **I**: Concurrent batches own a few linked filenames (`OPTIONAL_MISSING`: CLAUDE-CHANNEL, CONNECT-RECEIVE, WORK-CLAIMS, QA2-SYSTEMS) — a missing one of those is reported, not a failure.

### dogfood-return-browser-check.mjs
- **P**: Synthetic browser journeys in disposable rooms: a guest can reopen their original invitation in `full`/`cancelled`/`expired` states. No real users or external data.

---

## docs-04 — draft-return … in-place-fixture-signin (chunk 03)

### draft-return-browser-check.mjs
- **P**: Simulated human journeys (disposable rooms): draft return flows, human-work vs test-handoff variants, mobile.

### email-contract-fixture.mjs
- **P**: Invented Microsoft Graph-shaped data (`emailContractFixture()`): connection, message, headers with fixture addresses. No mailbox export, real people, or tokens.

### email-password-browser-check.mjs
- **P**: Real local email/password journeys through the contextual email step (synthetic password, hashed via `src/password-auth.mjs`).

### failing-tests.mjs
- **P**: CI honesty: turns `node --test` output into a short list of failing test names so the "Report failures to PR" step names failures instead of pointing at the job log. Pure functions, zero deps.
- **I**: Parses spec-reporter `✖ <name> (<ms>ms)` lines; TAP `not ok` as fallback. `MAX_FAILURES=20` caps names carried in a shard receipt/PR comment. Exports used by `report-test-failures.mjs`.

### fake-runner.mjs
- **P**: W4-38 G2 deterministic fake runner: simulates start, output, failure, timeout, restart against a fixture store — no paid/provider execution.
- **I**: Caller injects the clock (`steppedClock(startIso, stepMs)`; `jump()` crosses a runtime budget without waiting) and the request-id sequence (`fixedIds(prefix)`), so repeated runs over fresh stores produce the same attempt ledger and semantic event stream (transport ids stay random by design).

### fallback-draft-browser-check.mjs
- **P**: Local qualification of actual packaged runtimes, never live services/models (uses `createRuntimePackage`/`verifyRuntimePackage` — read-only import from guild-05's runtime-package.mjs).

### first-result-journey-check.mjs
- **P**: W4-50 L2 first-result onboarding: a newcomer joins from an invite link, contributes to a help-wanted work item, and sees the outcome of their own contribution — no account, agent setup, or advanced configuration. Done-when: this complete simulated journey passes end to end.

### first-use-check.mjs
- **P**: Agent-operated usability regression (not human-participant evidence): first-use flows incl. opening "Make this work" from the per-message "⋯" overflow menu, exactly as a member does.

### flaky-detect.mjs
- **P**: Additive flaky-test DETECTOR — detection only, never gates CI.
- **U**: `node scripts/flaky-detect.mjs <test-file> [runs] [--runs=N] [--timeout=ms] [--json]`
- **F**: Exit 0 no flaky tests; exit 1 flaky tests found (names printed); exit 2 usage/target error. Defaults: 5 runs, 120s timeout.
- **I**: Runs the target N times in separate processes, parses TAP per-test outcomes, reports tests whose outcome VARIED. Mutation-verified (stack-boundary, empty-suite branch).

### friend-bond-browser-check.mjs
- **P**: People Friend chrome: Friend → Proposed → Accept → Friends + peer DM → Revoke. A peer DM before the bond is active fails with `no_bond`, then `bond_pending`. No scopes picker. Disposable identities.

### frozen-runtime-fixture.mjs
- **P**: Test-only fixture loader: pinned baseline SHAs for frozen runtime versions (v8 connection … v16 send).
- **I**: Never mutates a frozen package or changes its manifest — loader only.

### fuzz-mime.mjs
- **P**: Continuous fuzzing for the MIME parser (`server/mime-message.mjs`, backlog Q005): pathological MIME inputs exist in the wild.
- **U**: `node scripts/fuzz-mime.mjs [--seed N] [--iterations N] [--budget-ms N] [--max-ms N]` (defaults: seed 20261006, 20000 iterations, 480s budget, 5000ms/case).
- **F**: Invariant is total: for ANY byte input, `parseMimeMessage` must return or throw `MimeError` — hang/crash/uncaught TypeError/RangeError is a failure. Failing inputs written to the report dir with seed + case index (deterministic repro). A case slower than `--max-ms` is a "slow" failure.
- **I**: Bounded by design so it cannot stall the pipeline.

### github-app-check.mjs
- **P**: Confirms `github-app/manifest.json` matches the permissions/URLs the shared GitHub App core publishes (`MANIFEST_EVENTS/PERMISSIONS/SETUP_URL/WEBHOOK_URL`).
- **I**: Does not call GitHub; does not print secret values. Missing credentials leave the integration off.

### github-door.mjs
- **P**: GitHub door: a Room route for agents whose sandbox reaches github.com but not Room origins (cloud coding agents, Cowork, CI bots). One GitHub issue is the door; comments from trusted GitHub users enter one room as attributed, unverified messages; room messages return as one digest comment.
- **I**: Single Room identity (repo secret `ROOM_DOOR_SECRET`). Never reads/posts anything a comment asks beyond "say this in the room", never runs code from a comment, never echoes a secret. Exports `OUT_MARKER`, `TRUSTED_ASSOCIATIONS`, `resolveConfig`.

### github-work-sync.mjs
- **P**: Work sync: when a PR merges, tell the room. A PR body line `Room-Work: <workItemId>` (or `<roomId>/<workItemId>`) makes the door post one message on that work item, @mentioning its accountable member with the merged PR as ready evidence.
- **I**: Never completes the item itself — only the accountable member reports completion, under their own claim. Exports `parseRoomWork`; `TERMINAL={"completed","superseded"}`.

### gmail-contract-fixture.mjs
- **P**: Invented Gmail API-shaped data (`users.messages` resources) via `gmailContractFixture()`. No mailbox export, real people, or tokens.

### gmail-live-fixture.mjs
- **P**: Stateful Gmail provider double (`gmailLiveFixture()`); never contacts Google or sends real email.
- **I**: Exposes only the methods the real Gmail messages API exposes on `/messages/{id}` (`KNOWN_MESSAGE_ACTIONS = modify/trash/untrash`) — anything else on a known id must 404 like production, so client bugs surface.

### gmail-setup-browser-check.mjs
- **P**: New account setup without Gmail is two steps, resumes, and ends in the room — at 390px and 1440px.

### gmail-workspace-browser-check.mjs
- **P**: Gmail compose, save, reply, send, triage, search at 390px + 1440px against the live fixture + `GmailMailbox`.

### grok-room-host.mjs
- **P**: Grok's room host process: journal-based attention/wake loop (imports `client/grok-host.mjs`: `parseNeedsMeBody`, `parseWakePing`, `wakeToAttentionItem`, `selectUnhandled`, `markHandled`, `buildRunPlan`, `assertPlanSafe`, `childEnvFor`, …).
- **I**: fsync'd journal writes; plan asserted safe before execution.

### growth-invite-browser-check.mjs
- **P**: Invite kit in a real browser: one Invite entry, copyable link + message, a landing naming the inviter, and a dead link that still offers a next step.

### help-contribution-browser-check.mjs
- **P**: Simulated accountable human + actual scripted MCP helper and reviewer. No models.

### help-invitation-browser-check.mjs
- **P**: Simulated human UI, actual scripted MCP. Disposable rooms; no model or external work. (Browser-evaluated callbacks marked `/* global document */`.)

### help-offer-browser-check.mjs
- **P**: Simulated humans and scripted MCP over a disposable local room. No model use.

### helper-agent-exercise.mjs
- **P**: Operator-started local acceptance fixture (`startHelperAgentExercise({humanReviewer})`). Seeds context, never an agent answer.

### helper-owner-exercise.mjs
- **P**: Explicitly simulated owner interaction (`select`/`adopt` stages against a fixture owner path), not an independent human review.
- **F**: Strict arg shape (6 argv); asserts fixture id `room-helper-exercise-v1`, origin exactly `http://127.0.0.1`.

### herdr-backfill.mjs
- **P**: herdr backfill executor (lane B21): attaches herdr sessions to existing opted-in in-flight claims — the execution half of the Phase B migration (B20's planner enumerates/orders; this executes against the room's claim source + herdr bridge).
- **I**: IDEMPOTENT — idempotency key `backfill:<room_id>:<claim_id>`; `backfill_done` journal row is forever-terminal (never reprocessed, never two panes per claim); `backfill_aborted` is terminal only for the run that wrote it. RESUMABLE — append-only `herdr_session_journal` is the per-claim source of truth; cursor in `herdr_backend_state`.

### host-isolation-preflight.mjs
- **P**: Setup diagnostic only: a fixed `--version` probe may expose sandbox startup diagnostics.
- **F**: If bubblewrap lacks mount/user/network namespaces → "Automatic host isolation is unavailable… no unsandboxed fallback is allowed."
- **I**: Actual untrusted host stderr remains suppressed by the adapter — the probe only diagnoses setup.

### human-experience-browser-check.mjs
- **P**: Human result/experience flows in the browser (deferred result responses, opening human results from work records).

### human-push-browser-check.mjs
- **P**: Human push is one button behind the browser permission prompt (desktop+mobile); the settings dialog stays free of notification levels and quiet hours. Uses generated VAPID keys (test constants in-file).

### i18n-harness.mjs
- **P**: i18n test harness (backlog Q012) — extraction + readiness checks as a CI lint-like gate. Harness-first: it MEASURES readiness; it does not translate and never edits UI code.
- **I**: Baseline ratchet — the baseline file records violation counts at generation time; `--check` fails only when a rule's count grows beyond baseline (current main passes, regressions caught). Scopes: UI strings (`src/**/*.js`, root `*.html`), email templates, server error literals. Rules: `hardcoded-ui-string`, `sentence-concatenation` (+ more).

### in-place-fixture-signin.mjs
- **P**: Disposable loopback fixtures only: `signInFixtureInPlace(page, store, accessKey, roomId)` authenticates via the real store, binds/completes a human account, caches logins in a WeakMap.
- **I**: Asserts the page is on localhost/127.0.0.1/[::1] and the member kind is "human". Real visible login keeps pending browser callbacks alive (the reason this exists alongside auth-signin.mjs).

---

## docs-05 — inbox-* … mcp-test-client (chunk 04)

### inbox-browser-check.mjs
- **P**: Simulated human journeys against the real local service + disposable data for the inbox (uses inbox-result-fixture, synthetic inbox transport, synthetic mail fixture, inbox sandbox, Graph email fixture).

### inbox-collaboration-check.mjs
- **P**: Automated counterpart to the staged actual-assistant exercise (desktop+mobile): excerpt, offer, draft, review, return, unknown-send recovery. No model calls.

### inbox-collaboration-journey.mjs
- **P**: Test-only staged human simulation (`createInboxCollaborationJourney({mobile})`) — agent choices arrive separately through MCP. Builds inbox sandbox + saved agent connection + seeded evidence.

### inbox-conversation-browser-check.mjs
- **P**: A two-message email conversation with an attachment, rendered in the real browser UI: depth-indented entries, open-message marking, attachment descriptors show name/type/size only, and the UI stays honest that file downloads are unavailable.

### inbox-quarantine-review-check.mjs
- **P**: Quarantine review UI (worker C): two held spam messages render with scores, sender, subject, non-empty signal reasons; Confirm releases + shows in released/confirmed history; Dismiss arms on first click (changing nothing), dismisses on second.

### inbox-result-fixture.mjs
- **P**: `prepareInboxResult(f, token, binding, {sourceId, ready, shareReceipt, selection})` — scripted participants and synthetic local data only, never hosted execution.

### inbox-sandbox.mjs
- **P**: `createInboxSandbox({includeEmailReview})` — explicit local sample launcher for inbox tests. Not part of the production runtime package.

### inbox-telegram-check.mjs
- **P**: Telegram connection card: live status (not configured / webhook / last delivery / last send); Reconnect trigger imports verified webhook updates from the browser without a loopback client. Fixture data only (fixture webhook secret in-file).

### inbox-unified-check.mjs
- **P**: Unified inbox UI (B27): one list across email, Telegram, samples with channel badges + filters; Telegram reply through the fixture transport; connection add/reconnect/remove; needs-you marker; sharing a Telegram excerpt into a room. Server has no Telegram bindings — nothing leaves the process.

### install.sh
- **P**: Installs the `room` command into `~/.project-room/bin` (override: `PROJECT_ROOM_HOME`). No sudo; does not edit shell profiles.
- **F**: Requires Node ≥24.19 (checked twice: shell + `node --input-type=module` eval). Supports `PROJECT_ROOM_TARBALL` for offline installs. `set -eu`; temp dir trapped for cleanup.

### invitation-check.mjs
- **P**: Real-browser proof for fragment-secret handling, non-mutating preview, account-bound acceptance, stale-tab fencing, exact replay, draft preservation, mobile access.

### invitation-note-browser-check.mjs
- **P**: Disposable synthetic invitation-note journeys. Not retention or human-study evidence.

### invitation-recovery-check.mjs
- **P**: Synthetic recovery regressions in disposable loopback rooms (clipboard/touch variants). Not human-study evidence.

### join-next-browser-check.mjs
- **P**: The join page follows `next` only when it is one relative path on this origin — ignores off-origin `next` (open-redirect guard), follows a relative one.

### journey-coverage.mjs
- **P**: Journey coverage map (M1): every claimed capability links to executable evidence, so a bare test count cannot conceal an untested user path. Map lives in `docs/JOURNEY-COVERAGE-MAP.md` as a fenced ` ```json coverage-map ` block.
- **F**: Fails on any claim with no unit/browser evidence, any linked file that doesn't exist, any browser check not wired into `npm run test:browser`. Exports `parseCoverageMap`.
- **I**: Mutation-verified (map version gate, duplicate-claim detection).

### landing-facts.mjs
- **P**: One read for the landing path: prints four identities and, when `ROOM_AGENT_CONFIG` is set, lease holder + expiry for touched paths.
- **I**: Does not post, claim, merge, deploy, or release a lease. A chat line is not one of these facts. `defaultExec` injectable for tests; git SHAs validated (`/^[0-9a-f]{40}$/`).

### layout-simplification-browser-check.mjs
- **P**: Conversation layout at 1440/390/320px × room-key/account: preserves navigation, drafts, usable controls.

### lazy-boards-browser-check.mjs
- **P**: Authoring gate — real-browser transport/lifecycle contract: eager loading wastes entry requests; a late import after sign-out must not read room data. No production test hooks or API doubles.

### lesson-contradictions.mjs
- **P**: Contradiction resolver — input side only — for conflicting lesson entries (backlog W015). Corpus: `docs/ROOM-WIKI.md`, `docs/WEEKLY-LEARNINGS.md`, AGENTS.md "## Lessons" bullets.
- **I**: Heuristic detector, no LLM. Normalizes entries; flags `opposing-directive` (never-X vs always-X on same topic), `preference-inversion` (X>Y vs Y>X), `unmarked-supersession`.

### lesson-scorer.mjs
- **P**: Lesson quality scorer (backlog W014): signal-vs-noise lint for the lessons corpus. Scores 0–100 on evidence (0–30), actionability (0–30), concreteness (0–20), …; vagueness subtracts.
- **I**: Heuristic, not an LLM judge. REPORTS ONLY — never edits, deletes, or reorders lessons. Flags low-signal entries for human review.

### lint-design-tokens.mjs
- **P**: Design-token ratchet lint (D-fo-6 step 1): fails CI when a NEW raw hex color literal, NEW raw `font-size`, or NEW raw size via `font:` shorthand appears in the CSS tree.
- **U**: `node scripts/lint-design-tokens.mjs`; `--capture` regenerates the baseline after legitimately removing violations (prints added/removed entries for review).
- **I**: Everything existing is grandfathered in `scripts/design-tokens-baseline.json`; that file only shrinks — never add NEW entries to bless a violation.

### lint.mjs
- **P**: CI gate: runs ESLint (`eslint.config.mjs`) over the repo. Any error fails; warnings printed and allowed. `npm run lint` is the same command.
- **I**: First runs `skills-sync-check.mjs` — its failure fails the gate too. `--skip-if-missing` (used by check.mjs) lets a checkout without `npm ci` finish with a notice; the dedicated CI lint job still enforces.

### listing-check.mjs
- **P**: Weekly directory listing check: reads `docs/listings.json` + `server.json` (via `server-json-check.mjs` `latestRegistryServer`); the one-liner is server.json's description so a description edit needs no change here.
- **F**: `STATUSES = listed|missing|stale|unknown`. Bot-wall detection (Cloudflare challenge regexes, 429) → distinct status. Custom UA `project-room-listing-check`.

### live-audit.mjs
- **P**: Production deploy guardrails for room.trydemigod.com. Complements live-smoke.mjs.
- **I**: Fixture-vs-live gap discipline (read before adding a guard): unit-tested with injected `fetchImpl`, so (1) every guarded path MUST exist in `server/http.mjs` (or the assets map); (2) retired paths stay in `PHANTOM_ROUTES` as honest-404 assertions — the audit fails if a phantom ever starts serving, forcing the guard to be rewritten. (This exact failure happened with /api/open, /api/auth-config, /privacy.)

### live-codex-host-check.mjs
- **P**: Historical opt-in qualification fixture for the Codex host (`<executable> <evidencePath>` args). Only synthetic room data.
- **I**: The current fixed offline policy intentionally denies external model access — never relax isolation to make this pass. Not part of CI, npm test, or any watcher.

### live-smoke.mjs
- **P**: Production smoke for the deployed Project Room: (1) deploy lag — live `/api/version` sourceRevision vs GitHub main; (2) discovery integrity — every machine file 200, right media type, parses, advertised same-host URLs resolve; (3) human doors — public pages 200 HTML, unknown paths 404; (4) optional `--browser` — page errors, CSP console errors, 390px overflow, axe WCAG 2.2 A/AA.
- **F**: Findings are `fail` (regression → exit 1) or `warn` (open, already-triaged, listed in KNOWN). When a KNOWN item is fixed, delete it here — the list only shrinks.

### live-upgrade-draft-browser-check.mjs
- **P**: Exact pre-release live client → candidate upgrade; disposable local data only. v36 schema note (#593/#597/#643): the hardcoded live commit predates v36 and can't open a v36 fixture — schema-bump PRs use a different entry.

### load-test.mjs
- **P**: Load test against a local room server, in-process. Three measurements: `commands` (N concurrent agents: presence/post/claim/changes/capabilities), `streams` (N SSE streams × M messages: fan-out latency + closed streams), `queue` (wake-queue enqueue-to-lease lag).
- **U**: `node scripts/load-test.mjs [agents=25] [iterations=5]` | `--mode streams|queue|commands|all [flags]`
- **I**: Safe defaults finish well under two minutes on a laptop.

### loop-warning-browser-check.mjs
- **P**: Coordination-loop signals are derived at read time and surface as a pause hint on the work card — never a block, write, or dispatch. Seeds one item with duplicate drafts, one with an acknowledgement chain, one clean item; checks what the owner sees.

### magic-link-browser-check.mjs
- **P**: Magic-link one-tap sign-in: loading `/?magic=<code>&email=<addr>` in a fresh context signs the visitor straight in with zero typing.
- **I**: Regression for RC-2026-09-19-066 — auto-redeem ran synchronously during `signinUI.mount()`, before `let accountRestoreFlight` initialized → TDZ ReferenceError killed the redeem; manual code-entry kept working (runs after module evaluation), which is why unit tests never caught it.

### manual-owner-exercise-check.mjs
- **P**: Scripted answers qualify the harness only — not actual-agent acceptance. Desktop+mobile: copy, reconnect, exact return, unknown producer. Asserts `exported.beforeSequence === exported.afterSequence` (export is read-only).

### manual-owner-exercise.mjs
- **P**: Simulated owner browser stages (`runManualOwnerExercise({ownerPath, stage: export|return, ...})`). The caller supplies the AI answer separately.
- **I**: Asserts fixture id + exact localhost origin.

### mcp-test-client.mjs
- **P**: Test harness: spawns `agent-mcp.mjs` as a child with `ROOM_AGENT_CONFIG` (+ optional attention dir/version), speaks MCP over stdio pipes, keeps last 4KB of stderr diagnostics.
- **I**: Test harness, not an AI host integration or production dependency.

---

## docs-06 — measure-cold-start … probe-prod-lib (chunk 05)

### measure-cold-start.mjs
- **P**: Cold-start measurement (re-audit 2026-09-14, M5; folds PR #141 and #160). The Worker's `limits.cpu_ms` cap must be chosen against a number: measures first-request phases (module eval, store open with schema verification/provenance/invitation audits, answer).
- **U**: `node scripts/measure-cold-start.mjs [phases] [runs=3] [--json] [--no-miniflare]`
- **I**: Results + reading-against-cap live in `docs/WORKER-LIMITS.md`. Each run is a fresh child process (import timing, fresh store, listen + first fetch).

### member-perms-browser-check.mjs
- **P**: MEMBER-PERMS PR2: simulated browser journeys against a disposable real server. Authoring gate owning UI wiring, selection, retry, session lifecycle.
- **F**: Credible regressions: posting admission instead of an authenticated upgrade, sending unselected grants, duplicating a committed request after response loss, painting the previous member's callback into a new session. Also: prelookup-throttle retry continuity, live ownership loss with open review, keyboard focus across stream-driven refreshes, Escape review dismissal restoring initiating focus.

### merge-hold.mjs
- **P**: Machine-readable main-merge holds on #266. Release holds were prose ("please hold non-urgent main merges until 22:00 UTC") and lanes missed them (2026-09-26: #1081 and #1103 merged during announced holds, restarting ~13min release CI each). This gives a hold a fenced ` ```room-hold ` block tools can read; a lane runs the check right before `gh pr merge`.
- **I**: Hold fields: scope/main-merges, until, by, exempt-pr, reason. Holds are advisory coordination data, NOT authenticated authority — by/exempt-pr never grant permission or bypass CI/branch protection. `scripts/room` has no merge verb; callers run this fresh and stop on a blocking hold or read failure.

### merge-queue-dryrun.mjs
- **P**: Read-only merge-queue readiness tracker. DRY-RUN ONLY: no writes, enables nothing, needs no admin rights. Lists open PRs targeting main, fetches combined check state + mergeable_state via read-only GitHub API, prints simulated FIFO order with per-PR flags: READY / NOT-GREEN / DIRTY / BEHIND.
- **I**: DIRTY = `mergeable_state == "dirty"` → would be ejected (GitHub creates NO pull_request workflow runs for dirty PRs, so a dirty PR may show no CI at all — rebase first, then re-verify, then enqueue).

### merge-queue-eject-budget.mjs
- **P**: Measured flake eject budget for GitHub's native merge queue. The queue is batch-then-eject (NOT batch-then-bisect): a failing PR is ejected and the group rebuilds; without a budget a flaky PR ejects/requeues forever, burning 25–75 min CI per cycle and blocking its group.
- **I**: On `merge_group` `destroyed` events, classifies the eject — only explicit check-failure ejects burn budget; lane pushes, manual dequeues, dirty-PR ejects, unknown reasons never count. Rolling window (default 3 ejects/24h) persisted in `tests/merge-queue-eject-budget.json` (committed repo-file ledger).

### merge-queue-receipt.mjs
- **P**: Merge-queue receipt: posts one room message through the GitHub door (`ROOM_DOOR_SECRET`). Issue #266 is locked, so it never comments there.
- **I**: Unset door secret → run skips and says so. Exports `receiptCommand({repo, action, headRef, headSha, baseRef, reason})` with sha256-derived idempotency id.

### merge-queue-worker.mjs
- **P**: Automation for the room-coordinated merge queue (Phase 1, `docs/MERGE-QUEUE-DESIGN.md`): lanes claim a merge-slot via `POST /api/rooms/{roomId}/merge-queue/enqueue`; THIS script does the serial work — rebase the PR onto current main, run checks, merge, release the slot.
- **U**: `node scripts/merge-queue-worker.mjs status|tick|sweep [--room muse-room] [--live] [--authorized-head <40-char SHA>]`
- **I**: `tick` processes the active slot once. Dry-run is the default (verifies + prints plan, no push/merge/release). `--live` performs rebase/push/check-wait/merge/release. Scheduling (cron) and `--live` are John's tap — until then run tick by hand.

### message-preview-browser-check.mjs
- **P**: Authoring gate: real Chromium owns disclosure accessibility + retained DOM during streamed updates. Long message preview (desktop+mobile): accessible expansion, complete safe text, retained reading state.
- **I**: Regression control: baseline has no expandable preview. Markdown tests can't detect paragraph reparsing, lost selection/focus, duplicate visible text, theme/mobile layout failures. No production hooks.

### mobile-header-check.mjs
- **P**: C1: mobile actions stay readable and reflow as whole controls; infrequent actions in an accessible menu; identity + connection recovery in the account menu. Synthetic identities, not human-participant research.

### mobile-signin-history-browser-check.mjs
- **P**: Mobile sign-in history is a real navigation boundary: Back leaves the email step, Forward restores it, pending writes stay visible — and a pending sign-in link is fenced.

### moderation-browser-check.mjs
- **P**: Issue #6 E4: a member reports a message to the room owner and mutes an author for themselves; the owner alone sees the report list with the reporter's name. Disposable first-party data.

### native-draft-browser-check.mjs
- **P**: Scripted people + MCP reviewer, isolated local data. No model or provider use.

### native-host-binary.mjs
- **P**: Resolves the executable for a native host without hardcoding anyone's home directory (the runner once named one developer's install path; acceptance could only run on that laptop, failing elsewhere with bare ENOENT).
- **I**: Resolution order: explicit env override → PATH → platform default (packaged macOS app only). Never throws: the caller reserves its evidence file first, so an unresolvable binary is reported as a reason, not fatal. Exports `resolveHostBinary`.

### native-host-request-run.mjs
- **P**: Manual acceptance runner, deliberately excluded from automatic test suites. `<host: codex|claude> <metadata> <phase: clarify|produce|review> <output>`.
- **I**: Uses existing subscription auth; never installs/configures a provider or host.

### native-result-browser-check.mjs
- **P**: Simulated human interaction in disposable local rooms, never a user study (native result rendering incl. exact-text bodies).

### notification-feed-browser-check.mjs
- **P**: B4 notification feed (desktop+mobile): badge counts unread, compact list, "Mark read" moves only the cursor. Simulated human tasks, isolated synthetic data.

### open-routes.mjs
- **P**: Open-route inventory (security review 2026-09-14, L3/B48). `docs/openapi.yaml` is the single source for which HTTP routes are served without a credential: an operation is open exactly when it declares `security: []`.
- **I**: Minimal line-based extraction (no YAML reader in repo; spec hand-written with two-space indent). `tests/invite-only-boundary.test.js` compares against what the server actually serves anonymously; `--check` verifies `docs/ROUTE-AUTH-TABLE.md` + `docs/INVITE-ONLY-CHECKLIST.md` §1 name every open route — a new open route cannot land undocumented.

### openapi-gen.mjs
- **P**: OpenAPI gate (batch RT). Until the legacy chain is empty: parses `docs/openapi.yaml`, keeps the template gate, requires every documented operation to be a row in `server/routes/table.mjs` or a row still listed in the legacy allowlist.
- **I**: A documented HEAD is covered when GET is served for the same template (several handlers answer HEAD as 404 today; this batch doesn't change that). Byte-for-byte generation of openapi.yaml from the table starts when the allowlist is empty (RT-final) — until then a rewrite would fight other PRs editing the document by hand.

### openapi-method-accuracy.mjs
- **P**: Method-level OpenAPI contract accuracy (TASKS.md task 16). `route-docs-check.mjs` only compares route templates — it can't see method-level drift (e.g. docs say POST, server serves GET-only — the #594 dogfood bug class). This boots a scratch server (temp dir, discarded; no fixture/production state) and probes every openapi.yaml operation with its documented method.
- **F**: Documented method → 405 `method_not_allowed` = method mismatch (FAIL). → 404 `not_found` + alternate method also 404s = route not served at all (FAIL). → 404 but alternate method doesn't 404 = served; the 404 is a resource miss (OK).
- **I**: Mutation-verified (verdict mapping, 404/405 body handling).

### operator-console-browser-check.mjs
- **P**: Operator console (`operator.html`) against a real server with the operator secret: status renders, find→plan shows counts, execute stays disabled until the room title is typed, purge runs, token lives only in sessionStorage. axe: no serious/critical at 390px.

### outside-agents.mjs
- **P**: Prints (or posts with `--post`) a room message naming an agent who is not a member.
- **U**: `node scripts/outside-agents.mjs --ref bus:cursor --name Cursor --origin bus --reach bus:cursor [--note text] [--post]`
- **I**: The message grants no access and mints no identity. Other members read the same messages through `server/outside-agents.mjs`.

### owner-project-offers-browser-check.mjs
- **P**: Owner project offers UI (`offerMinorUnits` from `src/owner-project-offers-ui.js`) in a real browser, owner/member × desktop/mobile.

### paid-work.mjs
- **P**: Paid-work offers CLI over `src/paid-work-offers.js` + contribution briefs.
- **U**: `node scripts/paid-work.mjs catalog | prepare|command|markdown|skill brief.json [--context context.json]`
- **F**: Brief > 32 KiB rejected; strict arg shape or usage error. `catalog` returns `PAID_WORK_OFFERS`.

### password-reset-browser-check.mjs
- **P**: Actual reset mail links + fresh sign-in, using local synthetic delivery only (synthetic passwords, magic-link mailer double).

### people-rail-browser-check.mjs
- **P**: People-rail: presence dots, one-line status, loud @agent handles, Done chips. Also tip #11: Done-chip spring is instant under `prefers-reduced-motion`. Disposable fixtures.

### perf-budget.mjs
- **P**: PERF-0 repeatable page-weight budget for signed-out pages: fresh browser context, empty cache; records request count, transferred bytes, DOM nodes, lab LCP with 4× CPU + network throttling over CDP (≤390px: 150ms RTT/1.6Mbps/750Kbps ≈ Lighthouse mobile; wider: 40ms/10Mbps). Prints one JSON document.
- **U**: `node scripts/perf-budget.mjs [--pages / --viewport 390] [--network none] [--origin https://room.trydemigod.com --out perf.json]`
- **I**: Without `--origin` starts a throwaway local server on an empty temp DB.

### pinned-messages-browser-check.mjs
- **P**: Issue #6 B2 + backlog follow-up 8: member pins from keyboard; Pinned section lists pins in pin order, follows others' pins live; unpin from the section; deleted messages drop out. "Pinned only" search toggle lists pins alone, narrows by term, follows unpin live, clears with search. Disposable first-party data.

### portable-work-browser-check.mjs
- **P**: Portable work (desktop+mobile): selected export, copy fallback, stale return, lost-response retry. Isolated synthetic rooms.

### pr-diff-size-check.mjs
- **P**: PR diff-size gate. Diffs over `MAX_DIFF_LINES` (default 300) must carry an explicit "Large diff justification:" section in the PR body, or the check fails.
- **U**: CLI: `BASE_SHA`/`HEAD_SHA` (env or `--base`/`--head`), `PR_BODY`/`PR_BODY_B64` (env) or `--body/--body-b64/--body-file`. `DIFF_SIZE_THRESHOLD` overrides without a code change.
- **I**: Why: smaller diffs → fewer rebase conflicts (PR #1530 needed five rebase cycles partly from size) + faster reviews. Pure contract `checkDiffSize({numstat, prBody, threshold?})`.

### pr-overlap.mjs
- **P**: Cross-PR overlap check for open PRs. PRs are reviewed one at a time, so nothing notices when two change the same code — 2026-09-26: five PRs (#1088–#1092) each added `export function enforceAutonomyTierForAction` to `server/autonomy-tiers.mjs`; git merged them cleanly leaving a duplicate declaration and the module failed to load.
- **F**: Reports `duplicateDeclarations` (same top-level fn/class/const/let added to the same file by ≥2 PRs), `overlappingHunks`, `sharedFiles`.
- **I**: Read-only; only network calls are GitHub REST GETs. Pure analysis in `analyzeOverlap()` so tests run offline.

### probe-prod-lib.mjs
- **P**: Shared probe logic for `probe-prod.mjs` (CLI) + `watch-deploy-drift.mjs`. Matrix/classification built from the 2026-09-25 1101 incident evidence, not path-shape guesses.
- **I**: `/` is DO-BACKED (served an 1101 during the outage — not an edge-static canary). `/.well-known/agent.json` flows through the DO on the canonical host — not an independent edge canary. `/api/health/jobs` is the JOBS CANARY: catches DO RPC errors and answers clean 503; a 200 or clean JSON 503 with schema `room.job-health/1` proves the Worker is alive; hard-fail means Worker or DO is failing (use external edge + logs to distinguish).

---

## docs-07 — probe-prod … recovery-coverage (chunk 06)

### probe-prod.mjs
- **P**: Production probe + 1101 classifier (plan task R6). Zero deps. Hits the endpoint matrix (from probe-prod-lib.mjs), records status + latency, classifies the failure domain: edge-down, worker-down, or do-rpc-fail (the 2026-09-25 1101 signature).
- **U**: `node scripts/probe-prod.mjs [--json] [--base https://room.trydemigod.com]`
- **F**: Exit 0 everything answers; 1 any failure.

### procedures-index.mjs
- **P**: W008 shared procedure library index generator (docs-first). Source of truth: `docs/procedures/*.md` with YAML frontmatter (id, title, version semver, author, source_room, updated YYYY-MM-DD, status active|deprecated).
- **U**: `node scripts/procedures-index.mjs`; `--check` for CI (exit 1 when stale). Run after adding/editing a procedure.
- **I**: Validates every file; bakes a frozen index into `deploy/procedures-index.mjs`, served at `GET /procedures` (read-only, global namespace). v1 is read-only by design — no write API; new versions land via PRs editing the markdown + regenerating.

### prod-deploy-smoke.mjs
- **P**: Post-deploy smoke for the production lane (deploy-prod.yml + rollback-prod.yml). Public endpoints only: no credentials, no writes.
- **U**: `node scripts/prod-deploy-smoke.mjs --sha <40-hex> [--origin …] [--entry …] [--wait-ms 300000] [--agent-card-public-key … …]`
- **I**: Test-only knobs via `SMOKE_*` env (inject signing key, shrink fetch counts/propagation window); the deploy pipeline never sets them, so production always pins the real key.

### prod-flow-probes.mjs
- **P**: Prod flow probes: read-only checks of the paths a person or agent walks first. Exit 1 on any failure. No credentials, no writes; safe on a schedule.
- **U**: `node scripts/prod-flow-probes.mjs [--json]`; `ROOM_ORIGIN`/`WWW_ORIGIN` env overrides; custom UA `project-room-prod-probe/1`. Exports `PROBES`.

### progressive-disclosure-check.mjs
- **P**: Consistent progressive disclosure (backlog C7): in-room section disclosures share one summary anatomy (chevron, label, trailing chip/note), hit target, focus ring — toggling never moves focus. `#record-panel`, `#decision-section` use the shared anatomy.

### project-offers-browser-check.mjs
- **P**: Public offer journeys against the real Node HTTP/store boundary; no identities enrolled, no external host/mail/funding/cashout started.

### provision.mjs
- **P**: Operator provisioning CLI: `--init`, `--account-key`, `--room`, `--member`, `--account`, `--name`, `--kind`, `--permissions`, `--print-key`, `--key-file`.
- **U**: `node scripts/provision.mjs …` (full usage via `--help`).
- **I**: Key files written with restricted perms (fchmodSync).

### public-pages-polish-browser-check.mjs
- **P**: Compare pages + the HTML 404: axe serious/critical at 390 and 1280, no CSP console errors on the compare pages (`/about`, `/receipts`, `/compare/*`, `/no-such-page`).

### public-work-matching-browser-check.mjs
- **P**: Actual owner enable → anonymous suggestions → outside-agent claim. No live services.

### public-work-mcp-journey-check.mjs
- **P**: Synthetic outside-agent usability: advertised hosted endpoint replayed to real loopback HTTP. Hosted discovery supports a zero-Room outside contributor through lost submission + own feedback. No live identities, Room admission, host launch, or payment.

### public-work-results-browser-check.mjs
- **P**: Real HTTP submission/review + private owner UI (human/agent-review modes, mixed, withdrawn). No live identities or mail.

### purpose-invite-check.mjs
- **P**: W4-51 L3 invite-for-a-purpose: an inviter points an invitation link at the question/result the guest is invited to help with; after joining, the room opens on that item.
- **I**: The purpose travels only in the URL fragment (never sent to the server). It selects a destination; guest access still covers room history.

### push-doctor.mjs
- **P**: Trusted local operator tool for turning push delivery on and proving it works. Prints no room content and no private key it was given.
- **U**: 1. `node scripts/push-doctor.mjs --keys` (generates VAPID pair — the only moment the private key exists, printed to stdout); 2. `wrangler secret put ROOM_VAPID_PRIVATE_KEY` (+ public key, subject); 3. `--check` (worker sees them); 4. `--send` (prints only the push service's verdict).
- **I**: Push delivery is off until the three secrets are set.

### pwa-browser-check.mjs
- **P**: Install button + the push soft ask in Chromium (mounted against a synthetic page): the ask is absent on load and appears only after a needs-you item is handed to the dock.

### qa5-a11y-c-browser-check.mjs
- **P**: Slice C (QA5 UI/UX + a11y) user-testing for newly merged UI work: S1 (#1456) viewer-aware empty-board copy wired through boardHtml; S3 (#1456) New-item form Note field label-associated, note reaches the created claim (F-parity-1); D-c (#1459) client boot() fail path shows error screen with back-to-sign-in for malformed invite; 320px no horizontal overflow; 44px touch-target floor on board controls for coarse pointers.

### quarantine-check.mjs
- **P**: Zero-Bug System: flaky-test quarantine gate. Reads `tests/quarantine.json`; fails (exit 1) when an entry violates the contract: (1) `repair_by` in the past (overdue — repair or move with justification); (2) `quarantined_at` older than 14 days with no owner.
- **I**: Also flags malformed entries, unparseable dates, future `quarantined_at`, `repair_by` beyond the 14-day cap. Dependency-free (node builtins only).

### quarantine-review-coverage.mjs
- **P**: Review-coverage dashboard for the spam-quarantine queue: reads a room store READ-ONLY (`PRAGMA query_only`) and reports per-signal review coverage over the durable quarantine journal — held/reviewed counts, Confirm(released)/Dismiss(confirmed spam)/Split(detached) breakdown, coverage ratio (the reviewCoverage metric from #567 shadow tooling).
- **U**: `node scripts/quarantine-review-coverage.mjs --store /path/to/room.db [--since …] [--until …] [--now …] [--format text|json]`

### quiet-attribution-browser-check.mjs
- **P**: Quiet attribution (desktop+touch): short summaries, exact choices, live duplicate names. Simulated local readers, not human research.

### quiet-copy-browser-check.mjs
- **P**: Automated usability checks with synthetic identities: quiet copy surfaces across viewports. Not human-participant research.

### quiet-design-check.mjs
- **P**: Quiet design (desktop+touch): disclosure, keyboard sending, modal focus, reflow.

### quiet-focus-a34-check.mjs
- **P**: Quiet Focus A3/A4: keyboard-operable disclosures, usable narrow composer, composer-local send failure with Send-as-retry, explicit disconnected/reconnecting states. Disposable fixtures.

### quiet-focus-final-check.mjs
- **P**: Quiet Focus final causal proofs (Codex 5557784549): post-connect stream-loss transition; measurable reflow at 390px and 200%-zoom-equivalent CSS width.

### quiet-invites-check.mjs
- **P**: Quiet invitations (desktop+touch): disclosure, truthful limits, late-list ordering, retry. Synthetic UI regressions; no human-participant findings inferred.

### ralph-loop.mjs
- **P**: Ralph-style night-shift burndown loop driver (BL-005/S4). One loop iteration: (1) `scripts/room backlog pull` takes the top unclaimed ready item (refuses when files are held live — S1 overlap guard); (2) reserves a worker slot (cap MAX_WORKERS), creates a PERSISTENT worktree (never /tmp), prints the worker brief (exact [lane][claim] post text + worker prompt template: claim → implement → test → open PR → receipt).
- **I**: The driver never implements, never merges, never deploys — a fresh worker (fresh context) does the work. Safety invariants: the gates are the product.

### reachability.mjs
- **P**: Import-graph reachability for server/ and src/: walks static imports, bare `import "x"`, string-literal `import("x")`, and `new URL("...", import.meta.url)` literals from runtime entry points (cloudflare/room.mjs, server.mjs, browser documents, package.json scripts, `node <file>` in .github/workflows, cloudflare checks/fixtures, runtime-package roots + public assets).
- **U**: `node scripts/reachability.mjs --check` fails when a server/src module is unreachable and not in KEEP.
- **I**: `KEEP` allowlist = modules other batches own / packaging permissions / not-yet-wired (with removal notes). Fuzz note: full-repo walk runs on every invocation (~slow); arg handling is lenient by design.

### real-agent-fixture.mjs
- **P**: Operator-started, loopback-only fixture for real agent participation (HTTPS server, seeded work-context exercise). Seeds are explicitly synthetic; never creates a participant's answer or verdict.

### receipts-browser-check.mjs
- **P**: `/receipts/<id>` at 390px: document fits viewport, exposes main + footer landmarks.

### receive-qualify.mjs
- **P**: Drives one complete exchange against a throwaway local Room: directed request, pointer, Room-tool reply, wake ack, stored answer. Starts no model. Prints one receipt. Token stays in the private directory.

### reconnect-collaboration-browser-check.mjs
- **P**: Scripted protocol participants + simulated human browser; reconnect collaboration flows. No model invocation.

### record-rails-fixture.mjs
- **P**: Synthetic qualification helpers over the real event + durable rail authority: `addRailMember`, `submittedTrial`, … (vetting receipts, trial tasks).

### recovery-browser-check.mjs
- **P**: Actual Node entrypoint pauses without touching populated data, then resumes the same Room in a browser (disposable DB; `auditRecovery` before/after). No production traffic.

### recovery-coverage.mjs
- **P**: `seedRecoveryCoverage(f)` — the rows the recovery audit requires, shared with the cold-start budget so a wake is measured against a store with every application table, not just the event log. Disposable synthetic data only (vetting receipts, spam flags, notify prefs, grants, operator actions, room assistant…).
