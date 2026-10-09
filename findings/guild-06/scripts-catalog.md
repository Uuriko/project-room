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

---

## docs-08 — recovery-fixture … room-lifecycle (chunk 07)

### recovery-fixture.mjs
- **P**: `createRecoveryFixture(filename)` — disposable synthetic data only (store init, work claims, signed evidence, tiers). **Never import from a production entrypoint.**

### refine-draft-browser-check.mjs
- **P**: Refine-draft journeys (desktop+mobile): separate edits, source link, exact retry, result. Simulated people in isolated rooms, incl. real browser failure recovery.

### release-checkpoint.mjs
- **P**: Read-only, bounded release observations. Not deployment or health proof.
- **I**: Bounded by construction: `TIMEOUT_MS=10000`, `MAX_BYTES=256*1024`, control-char stripping, 40-hex SHA validation (contrast with the unbounded gh calls in claims-index.mjs — this is the pattern to follow).

### release-evidence.mjs
- **P**: Compact release-evidence manifest built only from actual results. Skipped tests are never labeled passed; a dirty candidate tree is never labeled clean; live state is never labeled live without a matching digest.
- **I**: Exports `parseTapSummary`, `suiteLabel` (pure, unit-tested).

### release-polish-check.mjs
- **P**: Release polish journeys (desktop+touch): quiet controls, stable reading, usable History. Synthetic user journeys.

### reminders-browser-check.mjs
- **P**: Private reminders (desktop+mobile): schedule, due clock, privacy, recovery after resolution, keyboard, reflow. Simulated human tasks, isolated synthetic data.

### replay-room-export.mjs
- **P**: Replays a room export NDJSON into a new store via `replayNdjson`.
- **U**: `node scripts/replay-room-export.mjs --from export.ndjson --to /path/room.sqlite`
- **F**: Missing paths → error; verification failure → "Replay failed verification. The destination was not promoted." + exit 1.
- **I**: `process.umask(0o077)`; prints only `{verified, events}` JSON.

### reply-request-browser-check.mjs
- **P**: Synthetic human journeys against a disposable real service for reply requests (uses `hostReplyBody`). Not participant research.

### reply-review-fixture.mjs
- **P**: `seedRecordedReply({store, token, binding, sourceId})` — deliberately invented provider history (draft save → reserve → reply). Not a provider driver or runtime asset.

### reply-update-fixture.mjs
- **P**: `createReplyUpdateFixture(t)` — shared invented mailbox/update fixture (Graph reply update prepare/inspect). Never contacts a provider; cleans up in `t.after`.

### report-test-failures.mjs
- **P**: Turns a `node --test --test-reporter=junit` results file into GitHub Actions annotations + job summary (BUILD-01 B50).
- **U**: `node scripts/report-test-failures.mjs [test-results/browser-junit.xml]`
- **I**: One `::error title=<suite>::<test>: <first line>` per failure; Markdown table appended to `$GITHUB_STEP_SUMMARY` when set. Capped (`MAX_FAILURES`, `MAX_MESSAGE`). Exit 0 whenever the file was read — even missing (emits `::warning`): the step runs `if: always()` and the test step already decided the job's colour. A genuine bug in this script still throws so it can't silently rot.

### report-unit-failures.mjs
- **P**: CI honesty: the "Report failures to PR" step names failing tests instead of pointing at the job log. Reads the shard receipt from `scripts/unit-ci.mjs` (latest attempt wins); writes the markdown comment body to `--body-file` or stdout.
- **U**: `node scripts/report-unit-failures.mjs --shard=1/3 [--body-file=path]`; env `GITHUB_SERVER_URL/REPOSITORY/RUN_ID` for the run link.

### request-host-fixture.mjs
- **P**: Explicit synthetic native-host exercise (interactive: requires TTY + output path arg). Never opens an existing Room database.

### restore-rehearsal.mjs
- **P**: Restore rehearsal (backlog B5): restoring a stale backup resurrects the authority live at the watermark, and `reconcileRestoredAuthority` names every resurrected entry — stale restored authority is never silently treated as current.
- **U**: `node scripts/restore-rehearsal.mjs` (disposable temp dirs).

### restore-room-backup.mjs
- **P**: Restores a nightly backup into a NEW sqlite store. Never touches a live room: destination must not exist; nothing writes to Cloudflare. Prints counts + digests only, never row contents.
- **U**: `node scripts/restore-room-backup.mjs --kv 2026-10-08 --to /tmp/restore/room.sqlite --room muse-room` | `--from room-export.ndjson --to …`
- **I**: `--kv` reads the KV manifest + parts via `wrangler kv key get --remote` (caller's login), checks every part's sha256 + whole-file sha256, then replays. `--save` writes reassembled NDJSON mode 0600. `--audit report` restores even when the recovery audit flags drift, printing the audit result.

### result-copy-agent-fixture.mjs
- **P**: Disposable, read-only actual-agent exercise (copy-editor agent promoted through autonomy tiers). Never opens a caller's database.

### result-copy-browser-check.mjs
- **P**: Simulated human journeys: result copy flows. Clipboard outcomes are controlled — no user text or system clipboard read/written, no live service.

### result-diff-browser-check.mjs
- **P**: Simulated human journeys in real browsers against isolated synthetic rooms (result diff rendering).

### results-fixture.mjs
- **P**: `createResultsFixture()` — disposable fictional results; signs via the production API directly (not the test helper) for packaging safety. No provider reads, execution, or publication.

### review-mechanical-report.mjs
- **P**: Renders the review-mechanical check report: short human table + machine-readable JSON block (`<!-- review-mechanical-report -->`); the workflow prints it into `$GITHUB_STEP_SUMMARY`.
- **U**: `node scripts/review-mechanical-report.mjs --stage fast|full --pr <n> --head <sha> --lint <conclusion> --tests <conclusion> --additions <n> --deletions <n> --scope-json <path>`; `--annotations --scope-json <path>` prints escaped `::warning` annotations for scope drift.
- **I**: `renderReport()` is pure and unit-tested; the JSON shape is the contract reviewers/tooling read.

### review-scope-check.mjs
- **P**: Claim-scope check for the cheap-first mechanical review pass. A PR declares covered files in its body via `<!-- claim-files: server/a.mjs, tests/a.test.js -->` (comma/newline-separated; trailing `/` covers a directory).
- **F**: Verdicts: `clean` (all changed files declared), `drift` (changed file not declared), `undeclared` (no declaration — reviewer checks by hand).
- **I**: Drift is a reviewer signal, not a merge blocker (claims legitimately grow: lockfiles, generated files). Reported as a machine-readable check summary.

### review-state.mjs
- **P**: Per-PR review-state surface + single-lane review assignment routing. Companion to #1585's review-parallelization protocol (`docs/REVIEW-PARALLELISM.md`): for every open PR, which reviewers posted verdicts, the head SHA each verdict covered, whether each verdict is stale (head moved) — plus deterministic single-lane assignment so reviewers neither block each other nor re-review stale heads.
- **I**: Verdict provenance (reviewer + exact head SHA + timestamp) binds judgment to the inspected version.

### rollback-readback.mjs
- **P**: Verifies a rollback using fresh `wrangler deployments status --json` records (stdin / `--status-file`).
- **I**: No deployment, no credentials — validates records + GETs both doors. Allocation proof ≠ data restoration; observed source revisions are receipts, not a source-SHA mapping.

### room-actions-browser-check.mjs
- **P**: Simulated-human navigation checks (sidebar/chrome actions), asserting expected message-write counts. Disposable data; no outside services.

### room-chrome.mjs
- **P**: Post-#656 chrome helpers for browser checks: `ensureSidebarOpen`, catch-up, Settings, Search helpers.
- **I**: Product code unchanged — only teaches checks how to reach it. Sidebar always on screen at desktop widths, behind Menu below 900px. `/* global document */` — page.waitForFunction runs in the browser, not here.

### room-coord.mjs
- **P**: `room-coord`: claim, renew, hand off, land work through the room's typed work-claim registry instead of chat prose or GitHub comments. Output JSON unless `--md`.
- **U**: `room-coord status|claim|renew|handoff|land|tail|…` (full USAGE in-file).
- **I**: Pure coordination client over `client/room-coord.mjs` (`CoordError`, `claimAndVerify`, `closeClaim`, `land`, …).

### room-door-browser-check.mjs
- **P**: Public /room door (desktop+touch): canonical minimal auth, preserved deep links, separate agent packets.

### room-export-browser-check.mjs
- **P**: Room export (BUILD-01 F2 follow-up): a signed-in member takes the readable HTML export from the History panel — room-key mode and account mode (where the request must carry the session binding a plain link can't). Disposable rooms only.

### room-guard.mjs
- **P**: Refuses a commit (or flags a PR) touching files another member holds under a live room work claim — advisory leases become a hard stop at the moment it matters, like a pre-commit hook.
- **U**: pre-commit: `node scripts/room-guard.mjs` (staged files); CI/PR: `--base origin/main`; explicit: `--files a.mjs,b.mjs`.
- **F**: Exit 0 clean, 1 conflict, 2 usage, 3 Room unreachable with `--strict`.
- **I**: Without `--strict`, an unreachable Room prints a notice and passes — a network blip never blocks local work; `--warn` reports conflicts and passes.

### room-health.mjs
- **P**: Room health dashboard generator (OBS-1): fetches LIVE data, writes a self-contained static page `docs/room-health.html`. Panels: open claims by lane, PR age distribution, hosted CI health, board comment count vs the 2500 cap (+projection), upcoming lease expirations.
- **U**: `TMPDIR=<wt>/.tmp node scripts/room-health.mjs [--out <path>]`
- **I**: Read-only against the board: never posts. Run on demand or from cron.

### room-hygiene.mjs
- **P**: Room hygiene (RC-2026-09-23): zombie-member cleanup + friction digest. Trusted local-operator script: opens the room SQLite read-only, reports, never writes.
- **U**: `member-sweep --db PATH --room ROOM_ID [--days N] [--json]` (members with no heartbeat in N days, default 30); `friction-digest --db PATH --room ROOM_ID [--json]` (untriaged friction-labeled work items).
- **I**: Read-only: deactivation happens via the owner path, not here.

### room-instructions-browser-check.mjs
- **P**: Room instructions/charter journeys (seeded/unseeded, owner/member, noStream variants). Synthetic human journeys.

### room-key-pull.mjs
- **P**: Register pull-only presence with the saved room access key; prints pending wake pointers. The key cannot install a wake URL. Ack only for a signal id this same pull just printed.
- **U**: `node scripts/room-key-pull.mjs --host HOST [--cadence SECONDS] [--ack SIGNAL_ID]`
- **I**: Reads `ROOM_AGENT_CONFIG` or `ROOM_AGENT_ORIGIN/ROOM/TOKEN`. Sends mode pull-only; never starts a listener. Credential never written to stdout/stderr.

### room-lifecycle-browser-check.mjs
- **P**: Issue #6 A2: an account administering membership creates a room from Rooms, opens it, archives it as owner (read-only afterwards; switcher shows it as read-only, never a working "Open"), and a member leaves from About and no longer finds it. Disposable first-party data.

---

## docs-09 — room-listen … stream-recovery (chunk 08)

### room-listen.mjs
- **P**: Room listen loop: `--mode channel|poll|webhook`. `agent-claude-channel.mjs` delegates here (`main(['--mode','channel',…])`).
- **F**: Strict argv: first two args must be `--mode <mode>`; every flag needs a value, else `usage_error`.

### room-mcp-init.mjs
- **P**: Project Room MCP one-shot installer. Detects installed AI clients, registers the hosted MCP server in each client's MCP config. Idempotent.
- **U**: `node scripts/room-mcp-init.mjs [client ...] [--url <mcp-url>] [--dry-run] [--yes]`
- **I**: Portions adapted from Agent Room's init.ts (MIT). Unlike upstream (local stdio via npx), Project Room's hosted MCP is a plain HTTPS URL — every client gets a remote entry, no local install, no Node version dance.

### room-mutate.mjs
- **P**: Single-point mutant generator + runner for `scripts/room` (guild-05's file; this tool lives in my slice). Why custom instead of Stryker: `scripts/room` is bash with embedded jq; no JS mutation framework targets it. The room's `_parse`/`_state` verbs + fake-gh sweep give a deterministic test seam.
- **U**: `node scripts/room-mutate.mjs --list | --run M1,M7 [--jobs 4] [--workdir DIR] | --run-all …`
- **I**: Every run first executes the suite against an UNMUTATED overlay (baseline); if the baseline fails, exits 3 without attributing kills — a broken harness must never masquerade as mutant kills.

### room-overview-browser-check.mjs
- **P**: Room overview (desktop+mobile): source-backed orientation preserves writing, makes no room writes, updates live. Synthetic room only.

### room-policy-browser-check.mjs
- **P**: Issue #6 A4: when the owner makes review/approval mandatory, the new-work form shows the requirement locked on with the reason, and the recorded item carries it. Disposable first-party data.

### room-results-browser-check.mjs
- **P**: Room results (desktop+mobile, member/guest): simulated people, real local browser, fictional rooms.

### room-roster.mjs
- **P**: Thin CLI wrapper: `roomRosterMain(process.argv.slice(2), …)` from `src/room-roster.js`; prints to stdout, exit 1 on error.

### room-trust-browser-check.mjs
- **P**: Room Trust settings toggle: owner of a cross-owner room flips the kill-switch. Trust starts on; one click off, another on. Synthetic fixture only.

### rotation-cutover.sh
- **P**: Executes the claims-board rotation (old board → successor). DRY RUN BY DEFAULT; `--confirm` executes. Fail-closed at every step.
- **I**: Order: preflight (gh+jq present; old-board count re-verified TWICE via REST, strictly above --threshold default 1500; no pre-existing successor) → quiet-window notice → wait --quiet-seconds (600) → re-read → … (runbook docs/ROOM-WATCH.md §8).

### rotation-rehearse.sh
- **P**: Hermetic end-to-end verification of the rotation runbook: exercises rotation-cutover.sh against a fixture board (no network/live state) through a `gh` shim, asserting every invariant — fail-closed gates, successor lineage title, header + carry-over ledger order, ledger = live unexpired claims only, zero lost stragglers, exactly-once comment processing, atomic watermark update, clean 266→N cron-repoint.

### route-acceptance.mjs
- **P**: Proves a route is mounted before a receipt says it is live. On 2026-09-27 two PRs (#1136, #1138) merged with receipts naming GET /events and GET /board, but the module was imported only by its tests — both paths 404'd on every door.
- **U**: `node scripts/route-acceptance.mjs "GET /api/rooms/{roomId}/board" "POST /a2a"` | `--file routes.txt` | `--json …`
- **I**: Starts the real HTTP server on a fresh local store; a route passes on anything but the generic unmatched-route 404 ("Not found"). 401/403/405/409/422 and resource-specific 404s all prove wiring.

### route-docs-check.mjs
- **P**: Route documentation gate (re-audit 2026-09-14, M4): `docs/openapi.yaml` must describe every /api route template the server can match, and none it no longer serves.
- **I**: Served set from `routeCandidates()` (scripts/open-routes.mjs) + agent plug-in surface via single delegation in server/http.mjs. Path params reduced to {} both sides. A new route fails `npm run check` until documented with security scheme, request body, responses.

### routes-inventory.mjs
- **P**: Legacy route inventory (batch RT): walks routes served outside the route table; writes `scripts/routes-legacy-allowlist.json`. The allowlist is the parity baseline — only shrinks as extraction PRs move groups into `server/routes/table.mjs`.
- **U**: No flag → prints the inventory; `--check` fails on drift; `--write` regenerates (`--baseline` resets the baseline).
- **F**: A legacy route missing from the allowlist fails the check; a new legacy route cannot be added to the baseline.
- **I**: Fuzz note: ~20s startup (import stall) — slow, not hung.

### run-quarantined-tests.mjs
- **P**: Zero-Bug System: non-blocking lane for quarantined flaky tests. Reads `tests/quarantine.json`; runs each entry with `QUARANTINE_RUN=1` ("file > test name" convention; bare file = whole file).
- **F**: Exits nonzero when any quarantined test fails — the workflow keeps it non-blocking via `continue-on-error: true`, so red reports honestly without failing a PR. Dependency-free.

### run-room-request.mjs
- **P**: Runs one room request: `REQUEST_ID|--auto`, absolute private journal sqlite, absolute host.json.
- **U**: `node scripts/run-room-request.mjs REQUEST_ID|--auto /absolute/private-journal.sqlite /absolute/host.json`
- **I**: Uses `ROOM_AGENT_CONFIG` or existing connection env. Host JSON: command (absolute), args, cwd (absolute), timeoutMs, fixed policy, optional verification (no env). Host reads a typed untrusted context envelope on stdin.

### runtime-import-closure.mjs
- **P**: Static import-closure analyzer for the runtime-package allowlist lint: transitive closure of relative ES-module imports from an entrypoint, so tests assert every imported module is allowlisted without hand-maintained lists.
- **I**: Only static `import`/`export … from` with relative specifiers; `node:` builtins, bare specifiers, dynamic `import()` ignored.

### scan-secrets.mjs
- **P**: Zero-bug gate: scans the PR diff for committed secrets.
- **U**: `node scripts/scan-secrets.mjs [--base <git-ref>] [--diff <file>]` (default base origin/main; CI passes the PR base explicitly).
- **F**: Exit 0 clean; 1 finding (blocks the PR).
- **I**: Only ADDED lines (+, excluding +++ header) — history never blocks a new PR. Deliberately conservative: known provider prefixes only; NO generic high-entropy heuristics (they false-positive on hashes/UUIDs/fixtures). Escape hatch: `secrets-allowlist` on the line.

### secret-scan-check.mjs
- **P**: Secret-scan CI gate (H005): scans the repo tree via `server/secret-scan.mjs`; fails the build on any finding. Pure, dependency-free; runs in the contract job via check.mjs.
- **I**: Config (ALLOWLIST, SKIP_FILES, SKIP_DIRS: node_modules/.git/coverage/…, extensions) exported so the diff gate and tests reuse the exact same rules. Tree walk only runs when executed directly.

### secret-scan-diff.mjs
- **P**: Secret-scan DIFF gate (200-list #162): scans ADDED lines of `git diff <base>...HEAD` with the shared detector + line allowlist + path allowlist (`.github/secret-scan-allowlist.txt`).
- **U**: `[--base <ref>]` (default origin/main) | `--staged` (pre-commit) | `--files a b c`
- **I**: Complements the tree scan (PR-focused, fast); findings never include secret values — redacted previews only. Recent commits: "removed lines starting with -- no longer shift line numbers" (8172fe0f1), "keep an added ++ source line" (bd6b36d3f), "keep a real provider key when a placeholder word is elsewhere" (f19ab4c3d).

### server-json-check.mjs
- **P**: Offline checks for server.json + optional registry version bump. The description is whatever the file says (POS-1a may change it; this checks shape only).
- **I**: Exports `CANONICAL_ORIGIN`, `NAMESPACE_PREFIX="io.github.Uuriko/"`, `DESCRIPTION_MAX=100`, `REGISTRY_VERSIONS_URL`, `parseSemver`.

### session-boundary-check.mjs
- **P**: Browser regressions for session ownership, stale writes, live announcements, user-controlled record identities. All state/credentials disposable.

### shadow-quarantine-report.mjs
- **P**: Post-shadow precision report for auto-quarantine (AUTO-QUARANTINE-POLICY.md §5): reads the store READ-ONLY, joins shadow would-be-hold records to review outcomes in the durable spam_quarantine journal.
- **U**: `node scripts/shadow-quarantine-report.mjs --store /path/to/room.db [--since …] [--until …] [--review-window-days 14] [--now …] [--format text|json]`

### sign-agent-card.mjs
- **P**: Build-time signer for the room's A2A Agent Card (RC-2026-09-23-105). Runs after stamp-version.mjs; signs canonical card bytes with the room's Ed25519 key, then card-plus-envelope as A2A v1.0 §8.4 JWS; writes `deploy/agent-card-signed.mjs`, honored only when the signature covers exactly the served build's revision.
- **F**: Key from `ROOM_AGENT_CARD_SIGNING_KEY` (base64 seed) or `~/.config/project-room/agent-card-signing.key`. Never committed/logged/transmitted. Missing keys stop the build; local unsigned builds need explicit `--allow-unsigned`.

### signin-browser-journey.mjs
- **P**: Shared journey helpers: `openMagicSignin(page)` (visible password-first entry → forgot-password → magic option), `backToPasswordSignin(page)`. Reach recovery through the visible entry, incl. invitation hosts.

### skills-sync-check.mjs
- **P**: Fails when `plugins/project-room/skills/` is not an exact copy of `skills/`. Repair: `node scripts/skills-sync.mjs`. (Runs first inside `lint.mjs`.)

### skills-sync.mjs
- **P**: `skills/` is the only source for Project Room skills: copies the tree onto `plugins/project-room/skills/`, including skills existing only under `skills/`, dropping plugin-only copies (e.g. the shelved bounty worker).

### smoke-prod.mjs
- **P**: Production smoke probes (Zero-Bug, Phase 2). Zero deps. Synthetic READ-ONLY probes against live prod: never writes/mutates, never spends/charges, never authenticates as any user/agent.
- **I**: Probes: A. landing 200+HTML; B. claims-board read 200+JSON `opportunities`; C. priced-tool MCP `tools/call add_land_item` → 401 auth_required (never 500). Note: the spend primitive's honest 402 needs an authenticated agent with no grant — creating/borrowing an identity would write or impersonate, so the probe doesn't.

### snippet-adoption.mjs
- **P**: Weekly count of public repos carrying the coordination marker or hosted MCP URL (GitHub code search + /repos fallback).
- **I**: Exports `SEARCH_INTERVAL_MS=6500` (10 req/min ceiling), `SEARCH_PAGE_SIZE=100`, `SEARCH_RESULT_CAP=1000`, `GITHUB_API`, `ADOPTION_QUERIES`. Missing `ADOPTION_SEARCH_TOKEN` falls back to `GITHUB_TOKEN`; if the token can't search public code, exits 0.

### soak-preload.mjs
- **P**: Q007 soak harness — server-side instrumentation (observe-only). Loaded via `node --import` by soak-run.mjs; changes nothing about request handling; samples event loop, heap, FDs, unhandled rejections as NDJSON to `SOAK_METRICS_PATH`.
- **I**: Fault-injection (failing-first proof only, set by the harness): `SOAK_INJECT_LEAK=1` (~1MiB retained/sample window), `SOAK_INJECT_REJECTION=1` (one unhandled rejection ~2s after load). Timers unref'd — never keep the process alive.

### soak-run.mjs
- **P**: Q007 soak harness — orchestrator. Boots the real server in a child (with soak-preload instrumentation; server code untouched), applies sustained HTTP load, evaluates memory growth, event-loop lag, FD growth, rejections, crashes.
- **U**: `SOAK_DURATION_S=900 SOAK_LOAD_RPS=10 node scripts/soak-run.mjs` (86400 = full 24h).
- **F**: Exit 0 PASS; 1 FAIL (threshold/rejection/crash); 2 harness error.

### spend-allowance-browser-check.mjs
- **P**: Issue #6 C3: room owner sets a spend allowance from the "Agent spend" card; every member sees allowance/spent/reserved/headroom move as a session reserves, reports, stops; only the owner has controls; removing the allowance restores the default. Disposable first-party data.

### stall-probe.mjs
- **P**: Fires one request/second for N seconds; fails when p99 latency exceeds budget. Requests stay in flight together — the shape of a Durable Object input-gate stall (a sequential probe would hide it).
- **U**: `node scripts/stall-probe.mjs --url https://room.trydemigod.com --seconds 20 --path /api/ready`
- **I**: CI: `.github/workflows/stall-probe.yml` (workflow_dispatch). Verdict function covered by `tests/edge-stall.test.js` without network. Exports `percentile`.

### stamp-version.mjs
- **P**: Stamps immutable release metadata into `server/version.mjs` at bundle/deploy time. Run immediately before bundling/uploading; commit first — the stamped revision must name an existing commit, never a working tree.
- **I**: M-55: `--flag value` pairs parsed structurally (`KNOWN_FLAGS = --revision/--build-id`); the old `args.find(a => !a.startsWith("--"))` mistook option values for the positional target. Writes via tmp+rename (atomic). Fuzz: no partial writes.

### start-room-browser-check.mjs
- **P**: Start-a-room: the door's main button opens `/?start=room`; a new visitor sees "Sign in to start your room", signs in, lands inside their own room. One-shot intent; setup asks for a name only, before the room is made.

### starter-recipes-browser-check.mjs
- **P**: H1 recipe strip: catch-up and next-work chips render from committed state; dismissal is local only. Disposable first-party data.

### stream-recovery-browser-check.mjs
- **P**: Native EventSource reconnects after temporary storage failure without losing identity, unsent draft, or selection (synthetic `StorageUnavailableError` driver). Recent change (1db3e71f1, 751545238): snapshot routes match the path, so stream-open re-reads are caught — live refreshes re-read only the newest messages.

---

## docs-10 — sync-design-tokens-css … workflow (chunk 09)

### sync-design-tokens-css.mjs
- **P**: Regenerates the design-token variable blocks in `src/styles.css` from `src/design-tokens.js` (single source of truth). The `:root` (dark) and `[data-theme="light"]` blocks carry marker comments; everything between begin/end markers is replaced, preserving surrounding lines.
- **U**: `node scripts/sync-design-tokens-css.mjs` | `--check` (CI gate).
- **I**: Byte-identical output when tokens are unchanged → regeneration is a no-op diff.

### synthetic-mail-fixture.mjs
- **P**: Local test double with its own SQLite DB. NEVER imported by a deployed entrypoint. Kind "synthetic"; modes accepted/rejected/before; correlation-conflict detection on mismatched envelopes.

### telegram-contract-fixture.mjs
- **P**: Invented Telegram Bot API shaped data (no bot token, chat export, or real people): fixture connection/chat/users/updates.

### telegram-rotate-webhook.mjs
- **P**: Rotates the Telegram webhook secret without outage. Prints one fresh crypto-secure secret + exact follow-up steps (store via wrangler secret put; re-register with the new secret; Reconnect starts a rotation window — default 24h, dual-accepts old+new until it ends).
- **U**: `node scripts/telegram-rotate-webhook.mjs --generate [--window-hours 24]`
- **F**: Secrets are printed to the terminal for operator handoff — never in chat/email.

### telegram-set-webhook.mjs
- **P**: Registers (or removes) the Telegram webhook for one inbox connection.
- **U**: `TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-set-webhook.mjs https://room.example.test --connection telegram-main [--dry-run] [--delete]`
- **F**: Token/secret from environment only, never printed. Exit 1 when Telegram answers ok:false; 2 for usage/config. `--dry-run` shows the request with the secret redacted.

### test-env.sh
- **P**: Safe test environment wrapper: `/tmp` is a 512MB tmpfs shared by all agents and actively reaped (files vanish; parallel runs die SQLITE_FULL). This wrapper points TMPDIR at a worktree-local `.tmp/` (persistent, gitignored) and ensures it exists.
- **U**: `scripts/test-env.sh npm test` | `scripts/test-env.sh node --test tests/foo.test.js` | `source scripts/test-env.sh`

### thread-options-browser-check.mjs
- **P**: Thread-view Mute/Unmute + "Also send to channel" checkbox on thread replies (hidden for DMs and top-level messages); desktop and narrow (320px) viewports.

### trace-entry.mjs
- **P**: Trace-entry automation (W001): appends one merge-time line to `docs/ROOM-TRACES.jsonl` when a PR merges to main. Runner: `.github/workflows/trace-entry.yml` (pull_request_target, closed) — checks out main, validates with `scripts/check-wiki.mjs` (fail closed), commits to a `trace-entry/pr-<N>` bot branch, opens/merges a trace PR (direct push to main is blocked by status checks). Never runs untrusted PR code — reads only the GitHub event payload.
- **I**: Entry fields (date, slice, agent, pr, sha, outcome, tests {pass,fail}, notes); dates non-decreasing, append-only.

### unified-journey-check.mjs
- **P**: Combined local UI/API journey: unified guest entry, account-bound draft recovery, catch-up, and agent handoff share one room. Every identity is a synthetic test participant.

### unit-ci.mjs
- **P**: CI wrapper for one shard of `npm test` (CI-speed lane). Runs the shard's Node-discovered test files with `node --test`; writes a receipt under `test-results/` for `scripts/unit-shards-check.mjs`, binding the shard to the exact plan (planHash), run, revision, attempt.
- **U**: `node scripts/unit-ci.mjs --shard=1/3` (from repo root). Worktree-local scratch by default.

### unit-shards-check.mjs
- **P**: Required `unit` gate: successful Actions matrix AND all exact-run receipts. Mirrors browser-shards-check: every `tests/*.test.js` must be covered exactly once by a passing shard from this exact run/attempt plan.
- **U**: `node scripts/unit-shards-check.mjs RECEIPT_DIRECTORY`

### unit-shards.mjs
- **P**: Allocation for the sharded unit suite (CI-speed lane). The old `unit` job ran `npm test` in one job (~625s on hosted CI, the long pole of every PR head); this splits into SHARD_COUNT file shards with balanced estimated duration (~1/SHARD_COUNT of the time).
- **I**: Allocation follows Node24 default test discovery; timing never selects membership — every discovered file is in exactly one shard. Per-file durations in `scripts/unit-ci-durations.json` (hosted CI ms); files without a measurement get a conservative default so a new test file lands in a shard instead of breaking the plan.

### unstamped-member.mjs
- **P**: Historical-member rail helper: a live `member.added` stamps the display-name policy and refuses a folded duplicate; these checks need a stored collision to disambiguate names. An older event omits the stamp and still replays. Exports `admitHistoricalMember(store, roomId, actorId, data)`.

### untested-modules-lint.mjs
- **P**: Untested-server-module lint (plan task T1): lists `server/*.mjs` modules with zero references from `tests/`; fails if a NEW module joins the untested set, or if the grandfather list still names a module that is now tested (the list only shrinks).
- **U**: `node scripts/untested-modules-lint.mjs`
- **I**: Grandfather list captured 2026-09-25 (15 modules); entries removed as tests land, never added.

### updates-browser-check.mjs
- **P**: Updates HTTP/SQLite journeys: revision-bound marks, exact retries, retired navigation.

### verify-affected.mjs
- **P**: `verify:affected` — run only the unit tests related to your diff. A Node-discovered test file is selected when: (1) it changed itself; (2) it imports a changed file directly or transitively (static/literal dynamic imports, require(), `new URL(..., import.meta.url)`); (3) its source names a changed file's repo-relative path.
- **U**: `npm run verify:affected` | `-- --list` (print selection) | `-- --base=<ref> --budget=300`
- **I**: `--budget` is seconds of wall time per test worker, estimated from `scripts/unit-ci-durations.json`. AGENTS.md lesson: this can hang (>180s vs the "~30s" claim) — when it does, run targeted `node --test` directly.

### visual-regression-browser-check.mjs
- **P**: Q003 visual regression (screenshot diff) for the three surfaces a visitor/member actually sees: login/join entry pages (signed-out auth panel, join consent, join error), signed-in room view, `#message-list` region alone (a message-markup regression can't hide behind chrome pixels). Deterministic capture (fixed 1280x800, reduced motion, fonts settled, seeded store); dynamic regions (timestamps, avatars, presence, invite expiry) masked before capture; diff vs committed baselines in `scripts/visual-regression-baselines/`.

### visual-regression-helper.mjs
- **P**: Q003 shared screenshot-diff helper. Gate: committed baseline PNGs vs fresh capture each CI run; diff above `MAX_DIFF_PIXEL_RATIO` fails and writes actual+diff to `test-results/visual-regression/` (picked up by the browser-shards artifact upload). Determinism contract: fixed viewport, deviceScaleFactor 1, reduced motion, animations disabled at capture, caret hidden, fonts settled, seeded store data.

### watch-deploy-drift.mjs
- **P**: Deploy drift + 1101 watcher (plan task W3). Zero deps. Compares prod's public `/api/version` to the local main tip. Drift = revision missing, not an ancestor of the tip, or the tip ahead by > `--max-prs` (5) commits, or the first of those older than `--max-hours` (24). Matching revision or lag inside both budgets = not drift. Unhealthy probe still fails. Exit 0 = no drift and healthy.
- **U**: `node scripts/watch-deploy-drift.mjs [--base URL] [--ref origin/main] [--max-prs 5] [--max-hours 24]` (git fetch first). Intended for cron/CI.

### weekly-learnings.mjs
- **P**: Weekly "learnings" auto-post for muse-room (backlog W007). Gathers the week's signal and posts ONE concise digest: merged PRs (via gh, one-line lesson each — a `Lesson:` line in the PR body when present, else the title), room DONE/BUG CONFIRMED posts, curated lessons lanes append to `docs/WEEKLY-LEARNINGS.md`.
- **U**: `node scripts/weekly-learnings.mjs [--since ISO] [--week 2026-W41] [--queue PATH] [--repo OWNER/REPO] [--room ROOM] [--state-dir DIR] [--dry-run] [--post]`
- **F**: Anti-spam: skips weeks with nothing material; hard-caps post length; never posts twice for the same ISO week (idempotency via sent log, default `~/.config/weekly-learnings/`). Default is a dry run.

### wiki-build.mjs
- **P**: W009 build-time embed of the wiki planes for the read API. `server/wiki-read-api.mjs` serves this data in every runtime incl. the bundled Cloudflare worker (no filesystem).
- **U**: `node scripts/wiki-build.mjs` (writes `server/wiki-data.mjs`) | `--check` (fail if stale; CI gate). Regenerate after any wiki-plane change. Parsers live in `server/wiki-parse.mjs` (pure).

### work-attempts-browser-check.mjs
- **P**: Simulated human journeys (disposable first-party data): work attempts against real browsers.

### work-changes-browser-check.mjs
- **P**: F3: a draft based on an older revision gets a "what changed" explanation — a derived, read-time list from the item's own revision events. A draft at the current revision gets no prompt. Neither blocks any action. Simulated humans, real browsers, isolated synthetic rooms.

### work-context-agent-seed.mjs
- **P**: Deterministic synthetic prehistory only (fresh agents provide the correction and real review). `seedWorkContextExercise({store, keys, artifactOrigin, artifactDirectory})` builds a 'cancellation-checklist' scenario with revision-bound mutations (`expectedRevision` from live state).

### work-lifecycle-agent-fixture.mjs
- **P**: Synthetic same-room participation — never a hosted runner or external workspace. `startWorkLifecycleFixture()`: disposable tmpdir RoomStore + server, self-closing.

### work-recipes-browser-check.mjs
- **P**: Work recipes journeys: simulated humans, disposable first-party data, real browsers.

### work-resume-browser-check.mjs
- **P**: Synthetic restart journey in a real browser: resume handoff (phone + desktop) — visible next step, opt-in export, no writes.

### work-reuse-agent-fixture.mjs
- **P**: Disposable actual-agent exercise (no production paths or existing DB). Module-evaluated seed: repeat-planner agent, `repeat-source` work item with `repeat` cadence fields.

### work-reuse-browser-check.mjs
- **P**: Work-reuse journeys (simulated humans, disposable data) incl. in-place signin (`in-place-fixture-signin.mjs`) and signed evidence (`helpers/signed-evidence.mjs`).

### work-search-browser-check.mjs
- **P**: Work search (touch + desktop): return to outcomes without losing context. Simulated local people. Search must not submit, acknowledge, or create work. Imports `discovery-contribution-browser-check.mjs` for shared setup.

### worker-ci-build.mjs
- **P**: Bundle validation WITHOUT production key custody. Always `--dry-run`; the real deploy config keeps requiring a signed card. Asserts `wrangler.jsonc`'s build command includes `sign-agent-card.mjs` and not `--allow-unsigned`, then rebuilds the command with `--allow-unsigned` for the validation bundle.
- **F**: Accepts no deployment arguments (throws otherwise).

### workflow-browser-check.mjs
- **P**: Workflow journeys (desktop + mobile 390x844): lighter checks, exact retries, truthful status. Disposable local participants only; no external runtime or evidence fetched.

---

## docs-10b — subdirectories (helpers, onboarding-probe, qa2, qa3, schema-gate)

### helpers/google-oauth-fixture.mjs
- **P**: Bounded signed Google provider fixture shared by real-HTTP and browser owners. Fixed dummy clientId/sub; RSA-2048 keys generated per process; references `GOOGLE_ISSUER`/`GOOGLE_SCOPES` from `server/google-oauth.mjs`.

### helpers/signed-evidence.mjs
- **P**: Test helper: signs external evidence for `work.completed` completions using the room's real identity issuance + key registry — tests exercise the same trust root as production. Exports `issueTestIdentity`, and (via server) `issueSignedEvidence`/`contentHashOf`.

### onboarding-probe/agent-code.mjs
- **P**: Mints a contribute invite from a probe owner account and follows `GET /a/<code>` — the page is the only source of the redeem/orient/board calls.

### onboarding-probe/agent-docs.mjs
- **P**: Follows `GET /llms.txt`; hosts in the packet rewritten to the target; documented display name replaced with a qa-prefixed name. Board curls run only when the packet itself shows a work-claim done call.

### onboarding-probe/agent-mcp.mjs
- **P**: Anonymous MCP: initialize, then tools/list, then stop. OAuth PKCE runs only when staging advertises a protected-resource document and the server challenges (that enrollment flow is not available here).

### onboarding-probe/cleanup.mjs
- **P**: Archives rooms and revokes identities created by a probe run. `created.json` receives ids only; secrets stay in memory for this call.

### onboarding-probe/docs-publish.mjs
- **P**: Publishes the weekly onboarding-probe results table into a docs-committed file, newest run first. The weekly `onboarding-probe` CI job runs this after `run.mjs` so zero-to-first-claim times per path are visible from the repo, not only the job summary. Additive: never touches probe-out or the job summary.

### onboarding-probe/gate.mjs
- **P**: Compares a probe run with `docs/onboarding-probe/baseline.json`. A path fails when >20% slower, >1.2x the calls, or loses a reachable step (exactly 20% still passes). A newly reachable close is an improvement; ready-latency jitter is inconclusive. Exports `classifyReady`, `pathMetric`.

### onboarding-probe/human-home.mjs
- **P**: Browser path: landing, signup, first room. Later product steps stay `not_available` until on the page. Times are machine ms; the KLM figure is labeled `est.` on every human step.

### onboarding-probe/human-invite.mjs
- **P**: Owner mints a share link; a 390px visitor opens it and sends a first message when the composer is on the page. Missing UI is `not_available`, not a throw.

### onboarding-probe/lib.mjs
- **P**: Shared clock, HTTP, curl reading, redaction for the probe. Nothing prints a credential; writers pass values through `redact`. Exports `PROBE_VERSION="0.1.0"`, `USER_AGENT`, `qaStamp`, `klmEst`, `probePassword`. W3-F7: one random password per process — never the hardcoded public string; memory-only.

### onboarding-probe/pow.mjs
- **P**: Remote copy of the identity-mint proof search. `scripts/onboarding-probe` keeps this equal to `solveIdentityMintProof` in `server/agent-identities.mjs` (BITS=12, WINDOW_MS=10min). Loopback runs import the server function instead.

### onboarding-probe/predeploy.mjs
- **P**: Pre-deploy onboarding gate (ACT-5b): runs the probe against staging, compares with the baseline via `gate.mjs`.
- **U**: `node scripts/onboarding-probe/predeploy.mjs --target staging [--sha <40-hex>] [--runs 3] [--out probe-out] [--override "<reason>"]`

### onboarding-probe/report.mjs
- **P**: One probe-result document + the markdown table operators read. 4-week column is the baseline file; this module never rewrites it. Paths: agentDocs, agentMcp, agentCode, humanHome, humanInvite.

### onboarding-probe/run.mjs
- **P**: Weekly and manual entry for the fresh-agent probe. The gate report is written beside the result; this process exits 0 so a slow week is visible without failing the job. `gate.mjs` is what exits 1.

### qa2/abuse-guards.mjs
- **P**: Outcome checks for the work-claim, webhook, display-name, instructions, and member-text guards. Local only: writes rows in a throwaway room.
- **U**: `node scripts/qa2/abuse-guards.mjs --origin http://127.0.0.1:4173 [--json out.json]` — exit 1 when any check fails.

### qa2/agent-journeys.mjs
- **P**: Synthetic agent journeys: a cold agent that only knows the origin. Each task follows public discovery (llms.txt, agents.json, openapi.json, MCP tools/list) and the server's own `next` hints, records whether the needed route was discoverable, and scores pass/fail on the END STATE (outcome-based, like tau-bench: state must change, not just a 2xx).
- **U**: `node scripts/qa2/agent-journeys.mjs --origin http://127.0.0.1:4173 [--mcp URL] [--json out.json]`

### qa2/authz-matrix.mjs
- **P**: Authorization/IDOR matrix for the agent HTTP surface. Builds a throwaway room with one identity per role (owner, collaborator, chatter, linkguest, outsider, anonymous, revoked), runs every action as every role, compares with the expected policy.

### qa2/journeys.mjs
- **P**: Acceptance alias — the journey implementation lives in `agent-journeys.mjs`; this file exists so `node scripts/qa2/journeys.mjs` runs that suite.

### qa2/lib/client.mjs
- **P**: Shared QA HTTP client. Identity mints solve the same PoW as `src/client.js` (sha256(`${bucket}:${trim(displayName)}:${nonce}`) with `IDENTITY_POW_BITS/4` leading zero hex digits); a presented proof is accepted before the anonymous free-mint quota; 429s retried from Retry-After (POW_BITS=12).

### qa2/load-smoke.mjs
- **P**: Load/latency smoke with k6-style thresholds, dependency-free (Node 22+). Mixes anonymous reads (/, /llms.txt, /api/health) with one authenticated agent reading events + posting gently. Only point at production with `--vus <= 3` (single Durable Object; see QA2 findings).
- **U**: `node scripts/qa2/load-smoke.mjs --origin http://127.0.0.1:4173 [--vus 20] [--seconds 30] [--json out.json]`
- **F**: Thresholds (fail exit 1): p95 static <= 500ms, p95 API read <= 800ms.

### qa2/mcp-conformance.mjs
- **P**: Official MCP conformance suite with a not-applicable baseline (`qa2/baselines/mcp-conformance-baseline.yml`), plus a separate hard assertion that hostile Host/Origin headers are refused (the one dns-rebinding check that must pass). Retries once after 65s when the run trips Room's anonymous MCP rate limit.
- **U**: `node scripts/qa2/mcp-conformance.mjs --url http://127.0.0.1:4173/mcp [--version 0.x.y]`

### qa2/mcp-robustness.mjs
- **P**: MCP robustness probe: malformed JSON-RPC, schema-violating tool args, boundary values, hostile strings against a hosted MCP endpoint. Invariants on every case: I1 no 5xx; I2 no stack trace/internal path in the body; I3 valid JSON-RPC envelope (jsonrpc "2.0", matching id, result XOR error); I4 the case's own expectation.
- **U**: `node scripts/qa2/mcp-robustness.mjs --url http://127.0.0.1:4173`

### qa2/public-pages.mjs
- **P**: Public page gate: a11y (axe WCAG 2.2 AA), SEO/canonical/robots, OG tags, broken links, console errors, optional screenshot baselines for every public HTML page.
- **U**: `node scripts/qa2/public-pages.mjs --origin URL [--known "/path:substring,..."] [--json out.json] [--shots dir] [--baseline dir] [--chrome /usr/bin/google-chrome]`
- **F**: Exit 1 on axe serious/critical, missing title/canonical/lang, broken internal link, 5xx.

### qa2/fuzz.sh
- **P**: qa2 fuzz entry (bash). Companion to the node probes above.

### qa2/baselines/mcp-conformance-baseline.yml
- **P**: Not-applicable baseline for the official MCP conformance suite (the suite's N/A cases, versioned).

### qa3/authz-board.mjs
- **P**: Board, referral, receipts opt-in, sweep, status, wake-pause matrix. Roles: owner, contribute, chat, review, manage_claims, write_external, link guest, public. The policy is the one SEC-1 and SEC-2 implement. A cell whose fix has not merged is `expectedFail` with its finding id: the run stays green, and turns red once the fix matches while the flag is still set.
- **U**: `node scripts/qa3/authz-board.mjs --origin http://127.0.0.1:4173`
- **F**: **BROKEN by 6146ae702 (BUG-3):** its "release claim" action now sends `expectedClaimedAt`/`expectedHistoryLength` in the POST /release body, which the route's strict shape rejects with 422 — releases through this harness fail outright.

### qa3/board-growth.mjs
- **P**: Nightly board-growth budget: 400 done claims + 300 review notes from five review-profile members. List p95, the limit=1 body, and room-event headroom stay bounded (SEC-2 with Q3-A: F4 event headroom, F8 list).

### qa3/content-trust.mjs
- **P**: A guest payload must carry `untrusted:true` or `contentTrust` on every agent-facing read. Surfaces that already stamp stay required; surfaces that still omit the marker are `expectedFail` until their fix merges (event tail and SSE frames — SEC-2b). Webhook payloads fenced (Q3-D); board lists stamped (SEC-2). A guest cannot add a Board review note, so a review-profile member writes the Board marker.
- **U**: `node scripts/qa3/content-trust.mjs --origin http://127.0.0.1:4173`

### qa3/lib/sequence.mjs
- **P**: SSE frame sequence extraction for the QA3 contract gate. An SSE frame without an `id:` line has no sequence; `Number(null)` is 0, which must not be mistaken for sequence 0 (synthetic id-less events like `typing` would otherwise corrupt ordering and Last-Event-ID resume checks).

### qa3/lib/sse.mjs
- **P**: Reads room SSE frames until `until` returns true or the deadline passes. `parseSseFrame`: skips `:` comments; parses id/event/data lines (one leading space stripped after `data:`).

### qa3/lib/summary.mjs
- **P**: Job summary for the QA3 gates. `expectedFail` cells stay green and are listed in GITHUB_STEP_SUMMARY; a cell that matches while its flag is still set fails the run, so the flag is removed once the fix lands. `assertLocalOrigin`: qa3 gates are local-only (127.0.0.1/localhost) — exit 2 otherwise.

### qa3/public-scan-budget.mjs
- **P**: Seeds 1,000 rooms through the store, then requires public routes under 50ms p95. PRM owns the separate assertion that no public route reads `rooms.projection`. The fixture already meets the bar, so the check is required: a regression fails the job.

### qa3/sse-contract.mjs
- **P**: SSE contract: 40 messages keep strict order, no duplicates, and a Last-Event-ID resume loses nothing. The per-credential cap of 3 is required; the per-room cap is Q3-F and stays skipped.
- **U**: `node scripts/qa3/sse-contract.mjs --origin http://127.0.0.1:4173`

### schema-gate/schema-gate.mjs
- **P**: Schema convergence gate — CI-time harness for the bounty-propose-500 bug class. Incident: post-#792 (2026-09-22), bounty propose 500'd with "table bounty_records has no column named rubric_json" in SOME rooms while reads worked. Root cause: `BountyEscrow._ensure()` treated "some tables missing" and "columns need migrating" as either/or — schema converge now handles both.

### schema-gate/README.md
- **P**: Documents the schema-gate harness and the incident class it covers.

### room-digest
- **P**: `scripts/room-digest` (no extension, executable) — room digest helper. (Entry exists; header dump covered it as a shell/node executable; see chunk files for usage.)

### vendor-licenses/apostrophe.txt
- **P**: Vendored license text (Apostrophe — MIT-adjacent attribution). Static data, no code.
