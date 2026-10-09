# Check / lint / ops scripts

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `scripts/a11y-axe-helper.mjs`  (62 lines)

**Purpose.** Shared axe-core runner for the Q011 accessibility browser checks. One axe configuration for every check, so a violation that appears in one flow and disappears in another is a page difference, not a config drift: - tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa (same set the existing board/public-pages checks use) - fail signal: serious or critical impact violations only. Minor/moderate findings are surfaced in the failure detail for triage but do not fail, so the suite stays a regression gate rather than a style debate. The checks assert a clean page. When a check fails, the thrown message lists every serious/critical violation with its help text and the first few offending selectors, so the owning lane can fix it without re-running.

**Exports:** `A11Y_TAGS`, `assertAxeClean`, `axeSerious`, `chromiumLaunchOptions`

**Callers/importers (git grep HEAD):** `scripts/a11y-composer-browser-check.mjs`, `scripts/a11y-login-browser-check.mjs`, `scripts/a11y-room-browser-check.mjs`

## `scripts/agent-fast-path-check.mjs`  (108 lines)

**Purpose.** Synthetic new-agent journey through public HTTP and hosted MCP. No live service.

## `scripts/agent-watch.mjs`  (143 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `WATCH_HELP`, `retryDelay`, `watchLoop`, `watchMain`, `writeJson`

**Callers/importers (git grep HEAD):** `scripts/agent-inbox.mjs`, `tests/watch-cli.test.js`

## `scripts/an-funnel-1.mjs`  (137 lines)

**Purpose.** AN-FUNNEL-1: signup -> first message -> first reply, read-only. Usage: node scripts/an-funnel-1.mjs --db <path-to-room.sqlite> [--since <iso-date>] Opens the database read-only (PRAGMA query_only=ON) and reports the activation funnel using ONLY already-recorded data: analytics_events signup rows, member_accounts bindings, and message.posted room events. No new event types, no schema changes, no writes of any kind. Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when the database cannot answer (missing tables), with the reason on stderr.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/an-funnel-1.mjs`, `tests/analytics-activation-funnel.test.js`

## `scripts/answer-engine-check.mjs`  (422 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `DEFAULT_PROMPTS`, `answerOpsText`, `answerSummaryMarkdown`, `buildRequest`, `engineRollup`, `extractUrls`, `isOurUrl`, `loadPromptConfig`, `parseAnswer`, `runAnswerCheck`, `scoreAnswer`

**Callers/importers (git grep HEAD):** `tests/answer-engine-check.test.js`

## `scripts/assisted-agent-exercise.mjs`  (101 lines)

**Purpose.** Disposable loopback room for independent agents, not an agent runner. The operator creates assignments only; participants supply their own work.

**Exports:** `startAssistedAgentExercise`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `tests/agent-scope-handoff.test.js`

## `scripts/auth-signin.mjs`  (44 lines)

**Purpose.** Authenticate disposable local browser fixtures through the real credential API. This helper never mounts a production form or injects store/session state.

**Exports:** `signInFixture`

**Callers/importers (git grep HEAD):** `cloudflare/browser.check.mjs`, `cloudflare/release-pause-browser.check.mjs`, `scripts/a11y-composer-browser-check.mjs`, `scripts/a11y-room-browser-check.mjs`, `scripts/access-preview-browser-check.mjs`, `scripts/accessibility-check.mjs`, `scripts/account-deletion-browser-check.mjs`, `scripts/account-settings-browser-check.mjs`, `scripts/account-workspace-check.mjs`, `scripts/action-dialog-focus-scroll-browser-check.mjs`

## `scripts/bounty-conservation-check.mjs`  (166 lines)

**Purpose.** bounty-conservation-check.mjs — scheduled read-only verifier for the bounty-escrow hash chain / conservation invariant. Phase-1 research confirmed BountyEscrow.verifyConservation (server/bounty-escrow.mjs) is the ONLY verifier for the bounty-escrow hash chain and conservation invariant, and it has ZERO production callers: the chain's tamper-evidence is write-only — cost on every append, benefit never realized. This script wires the benefit back in: it opens the room database strictly read-only, runs verifyConservation across every room, and emits a machine-readable report. Read-only guarantees (no write locks on production data): 1. The database handle opens with node:sqlite { readOnly: true } — writes are refused at the driver level, not by convention. 2. db.readOnlyTransaction is set before touching BountyEscrow, so its _ensure() takes the schema-presence-only path and never migrates. 

**Callers/importers (git grep HEAD):** `scripts/bounty-conservation-check.mjs`, `tests/bounty-conservation-check.test.js`

## `scripts/browser-ci-reporter.mjs`  (54 lines)

**Purpose.** node --test reporter for the browser gates: turns every failure into a GitHub workflow command (an annotation on the job) and prints one duration line per script, so a red browser job names the script and test instead of only "Process completed with exit code 1". Pure output; it never changes which tests run or how they are judged. Used next to the spec reporter, which keeps the full human-readable log.

**Callers/importers (git grep HEAD):** `scripts/browser-ci.mjs`, `tests/browser-shards.test.js`, `tests/report-test-failures.test.js`

## `scripts/browser-shards-check.mjs`  (13 lines)

**Purpose.** Required `browser` gate: successful Actions dependency AND all four exact-run receipts.

**Callers/importers (git grep HEAD):** `scripts/browser-shards-check.mjs`, `scripts/ci-changes.mjs`, `scripts/unit-shards-check.mjs`, `tests/browser-shards.test.js`

## `scripts/check-deps-exist.mjs`  (284 lines)

**Purpose.** Zero-bug gate: dependency-existence ("slopsquatting" defense). Two checks, both fail the workflow on findings: (1) Registry existence: every dependency declared in package.json (dependencies + devDependencies + optionalDependencies) must exist on the npm registry. A hallucinated package name (slopsquatting / dependency confusion) fails here. Local specs (file:, link:, ./, git+, github:, http(s):, workspace:) are skipped — they do not resolve through the registry. (2) Declared-imports: every bare import in scanned source files must be a declared dependency (of the nearest package.json), a Node builtin, or a relative path. Catches imports of packages the PR never declared. Usage: node scripts/check-deps-exist.mjs [--root <dir>] Zero-dep (only node: builtins). Network: one packument fetch per declared package, 10s timeout each, sequential with a small concurrency pool.

**Callers/importers (git grep HEAD):** `scripts/check-deps-exist.mjs`

## `scripts/check-deps.mjs`  (31 lines)

**Purpose.** Fail fast when node_modules is stale relative to package.json. Root cause it guards: a dependency (e.g. the `yaml` devDependency added in PR #1351) can be missing from a developer's node_modules when the install predates the commit that declared it. Tests then die with a bare ERR_MODULE_NOT_FOUND deep in an import statement instead of telling you to re-install. A clean `npm ci` always fixes it; this check just says so up front, before the test runner starts.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/unit-ci.mjs`, `scripts/verify-affected.mjs`, `tests/unit-shards.test.js`

## `scripts/check-version-doors.mjs`  (75 lines)

**Purpose.** Version door check. Zero dependencies. api/version is answered inside the Durable Object; /api/version/worker is answered from Worker module scope (cloudflare/room.mjs). After a deploy the Worker flips at once while an already-running DO instance can keep serving the previous revision for up to about a minute (observed twice: worker on a21c2364, /api/version still on cbd4ee5e). Reading one door and calling it "what is live" is therefore wrong during that window. This reads both. States for a target sha: converged     both doors report sha do-stale      worker reports sha, the Durable Object door does not (rollout in progress) worker-stale  the DO door reports sha, the worker door does not other         neither door reports sha (a different revision, or unreachable) CLI: node scripts/check-version-doors.mjs --origin URL --sha SHA [--wait-ms 0] [--poll-ms 10000] Waits up to --wait-ms for "

**Exports:** `DOORS`, `classifyDoors`, `readDoors`, `waitDoors`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/check-version-doors.mjs`, `scripts/watch-deploy-drift.mjs`, `tests/check-version-doors.test.js`

## `scripts/ci-changes.mjs`  (175 lines)

**Purpose.** Decide which expensive CI suites a pull request actually needs. GitHub's `on.pull_request.paths` filter looks at the files in the pushing commit. Merging main into a branch therefore retriggers every suite whose paths main touched, even when the pull request's own diff does not. This script classifies `git diff <base>...<head>` (the merge-base / "Files changed" diff) instead. Push, schedule, and workflow_dispatch are not pull requests: both suites stay enabled so the main tip still runs the full test matrix. Outputs (GITHUB_OUTPUT): browser=true|false, eval=true|false, and coverage=true|false.

**Exports:** `classifyChanges`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/ci-changes.mjs`, `tests/ci-changes.test.js`

## `scripts/claim-bond-shadow.mjs`  (73 lines)

**Purpose.** claim-bond-shadow: P0 shadow-mode reporter for claim bonds. Usage: node scripts/claim-bond-shadow.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync] Without --sync this is strictly read-only (PRAGMA query_only=ON) and reports the baseline flake rate from the claim_bond_shadow journal. With --sync it first replays work_claim.updated events into the journal (idempotent; writes only its own additive table, outside the writer fence). Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when the database cannot answer, with the reason on stderr.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/claim-bond-shadow.mjs`, `scripts/claim-reputation-sync.mjs`, `server/writer-fence.mjs`, `tests/analytics-claim-bond-shadow.test.js`, `tests/claim-bond-shadow-attacks.test.js`, `tests/writer-fence-unfenced.test.js`

## `scripts/claim-reputation-sync.mjs`  (104 lines)

**Purpose.** claim-reputation-sync: P1 claim-reputation journal tool. Usage: node scripts/claim-reputation-sync.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync] Without --sync this is strictly read-only (PRAGMA query_only=ON) and reports the P1 signal counts from the claim_reputation_signals journal. With --sync it first replays work_claim.updated events into the journal (idempotent; writes only its own additive table, outside the writer fence). The weekly P1 measurement (CLAIMBONDS-P1-SPEC-2026-10-05.md) re-runs the P0 shadow baseline and diffs against 2026-10-05; this script populates the journal that measurement reads. Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when the database cannot answer, with the reason on stderr. This script is the reachability entry point for server/claim-reputation.mjs (same standing as scripts/claim-bond-shadow.mjs for the P0 module). L

**Callers/importers (git grep HEAD):** `package.json`, `scripts/claim-reputation-sync.mjs`

## `scripts/claims-index.mjs`  (539 lines)

**Purpose.** !/usr/bin/env node scripts/claims-index.mjs — read-only claims-board indexer for the swarm coordination board (Uuriko/project-room#266). Fetches #266 comments (REST, numeric ids), parses machine-readable claim blocks (```room-claim) and receipt comments, and emits a static JSON index plus a compact markdown board. Read-only against GitHub: the only network call is `gh api .../issues/266/comments --paginate` (a GET). All output goes to local files; nothing is committed or pushed by this script. Malformed input (prose CLAIM: posts, `lease: 6h` without the lease= prefix, path-only comments, missing bodies) is recorded under `unregistered` — never silently dropped, never a crash. Usage: node scripts/claims-index.mjs [--comments <file>] [--out <dir>] [--format json|md|both] [--now <iso>] --comments <file>  read a comments JSON array from disk instead of GitHub --out <dir>        output direct

**Exports:** `LEASE_RE`, `STATE_RE`, `TASK_ID_RE`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/claims-index.mjs`, `tests/claims-index.test.js`, `tests/regex-parity.test.js`

## `scripts/connect-agent-first-screen-check.mjs`  (100 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/connect-room.mjs`  (21 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `connectMain`

**Callers/importers (git grep HEAD):** `scripts/agent-inbox.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `tests/runtime-package.test.js`

## `scripts/contribution-journey-check.mjs`  (107 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/coverage-thresholds.mjs`  (522 lines)

**Purpose.** Per-module coverage thresholds gate (backlog Q015). Measures line coverage per module from the root `node --test` suite using V8 coverage (NODE_V8_COVERAGE, zero dependencies) and fails when any configured module drops below its ratchet threshold in coverage-thresholds.json. Thresholds are set at measured levels (ratchet): the gate prevents silent decay, it does not demand improvement. Usage: node scripts/coverage-thresholds.mjs            # collect (runs the suite) + evaluate node scripts/coverage-thresholds.mjs --collect-only node scripts/coverage-thresholds.mjs --coverage-dir <dir>   # evaluate existing data node scripts/coverage-thresholds.mjs --baseline             # collect + print measured JSON node scripts/coverage-thresholds.mjs --config <path>        # alternate config Exit codes: 0 = all thresholds met; 1 = threshold breach or suite failure; 2 = usage/config error. Measurement

**Exports:** `DEFAULT_CONFIG_PATH`, `checkThresholds`, `collectCoverage`, `coverableLines`, `coveredLinesForPayload`, `evaluateModules`, `formatReport`, `groupFunctionsByUrl`, `lineCoverage`, `listModuleFiles`, `loadConfig`, `splitLineSpans`

**Callers/importers (git grep HEAD):** `coverage-thresholds.json`, `scripts/ci-changes.mjs`, `scripts/coverage-thresholds.mjs`, `tests/ci-changes.test.js`, `tests/coverage-thresholds.test.js`

## `scripts/dependency-audit.mjs`  (258 lines)

**Purpose.** Weekly dependency audit: run `npm audit --json` through an injectable runner, group vulnerabilities by severity, and emit a Markdown report plus a JSON summary. Designed for cron/CI: exit 0 when the audit is clean or below --fail-on, exit 1 when vulnerabilities at or above the threshold exist (so CI can gate on it), exit 2 when the audit itself failed. Usage: node scripts/dependency-audit.mjs [--fail-on=<severity>] [--out=<path>] [--json-out=<path>] node scripts/dependency-audit.mjs --help Pure functions (parseAuditJson, groupBySeverity, summarizeAudit, thresholdBreached, renderMarkdown, renderJsonSummary) carry the logic and are unit-tested in tests/dependency-audit.test.js with fixture payloads; only the npm invocation goes through the injectable runner.

**Exports:** `AuditError`, `SEVERITIES`, `defaultRunner`, `groupBySeverity`, `normalizeThreshold`, `parseArgs`, `parseAuditJson`, `renderJsonSummary`, `renderMarkdown`, `runAudit`, `summarizeAudit`, `thresholdBreached`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/dependency-audit.mjs`, `tests/dependency-audit.test.js`

## `scripts/design-contrast-check.mjs`  (14 lines)

**Purpose.** WCAG 2.2 AA gate for the shared design tokens. The contract job runs this from scripts/check.mjs, including in CI where the unit suite is skipped.

**Callers/importers (git grep HEAD):** `scripts/check.mjs`, `tests/design-tokens.test.js`

## `scripts/docs-link-check.mjs`  (81 lines)

**Purpose.** Intra-repo markdown links in the maintained docs. docs/history/ is a record and is not checked. Concurrent batches own a few linked filenames; a missing one of those is reported and does not fail this check.

**Exports:** `brokenDocLinks`

**Callers/importers (git grep HEAD):** `scripts/check.mjs`

## `scripts/flaky-detect.mjs`  (189 lines)

**Purpose.** !/usr/bin/env node flaky-detect.mjs — additive flaky-test DETECTOR. Detection only: never gates CI. node scripts/flaky-detect.mjs <test-file> [runs] [--runs=N] [--timeout=ms] [--json] Runs the target test file N times in separate processes, parses the TAP output of each run, and reports tests whose outcome VARIED across runs (both passes and failures). Exit 0: no flaky tests. Exit 1: flaky tests found (their names are printed). Exit 2: usage/target-file error. Detection only — do not gate any CI merge on this script.

**Exports:** `detectFlaky`

**Callers/importers (git grep HEAD):** `package.json`, `scripts/flaky-detect.mjs`, `tests/flaky-detect.test.js`

## `scripts/fuzz-mime.mjs`  (291 lines)

**Purpose.** Continuous fuzzing for the MIME parser (server/mime-message.mjs). Backlog Q005: pathological MIME inputs exist in the wild, so the parser is fuzzed on a schedule. The invariant is simple and total: for ANY byte input, parseMimeMessage must either return a result or throw a MimeError. Anything else (a hang, a crash, an uncaught TypeError/RangeError/...) is a failure. Failing inputs are written to the report directory with the seed and case index so they reproduce deterministically. Bounded by design so it cannot stall the pipeline: --seed N        PRNG seed (default 20261006; same seed => same inputs) --iterations N  random cases after the corpus (default 20000) --budget-ms N   wall-clock budget for the random phase (default 480000) --max-ms N      per-case time limit; a slower case is a "slow" failure (default 5000). A true infinite loop cannot be caught in-process; run under `timeout(1)

**Exports:** `DEFAULT_CORPUS_DIR`, `DEFAULT_SEED`, `checkCorpusEntry`, `checkOne`, `genMessage`, `loadCorpus`, `mulberry32`, `mutate`, `randomSoup`, `runFuzz`

**Callers/importers (git grep HEAD):** `package.json`, `scripts/fuzz-mime.mjs`, `tests/mime-fuzz.test.js`

## `scripts/github-app-check.mjs`  (32 lines)

**Purpose.** Confirms github-app/manifest.json matches the permissions and URLs the shared GitHub App core publishes. Does not call GitHub and does not print secret values. Missing credentials leave the integration off.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/check.mjs`

## `scripts/github-work-sync.mjs`  (75 lines)

**Purpose.** Work sync: when a pull request merges, tell the room. A PR body line Room-Work: <workItemId>            (item in the door's room) Room-Work: <roomId>/<workItemId>   (explicit room; must be the door's room) makes the door post one message on that work item, @mentioning its accountable member with the merged PR as ready evidence. It never completes the item itself. The room only lets the accountable member report completion, under their own claim, and that stays true.

**Exports:** `main`, `parseRoomWork`, `runWorkSync`, `syncCommandId`, `syncMessage`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `tests/github-work-sync.test.js`

## `scripts/herdr-backfill.mjs`  (513 lines)

**Purpose.** herdr backfill executor (lane B21). Attaches herdr sessions to existing opted-in in-flight claims. This is the execution* half of the Phase B migration: B20's planner (`plan` / `scan`) enumerates and orders the units of work; this script executes them against the room's claim source and the herdr bridge. Contract (migration-rollout.md §1, compat-plan.md §1B): - IDEMPOTENT: idempotency key `backfill:<room_id>:<claim_id>`; a backfill_done journal row is forever-terminal, so a completed claim is never processed again. Two panes are never spawned for one claim. backfill_aborted is terminal only for the run that wrote it — a later run re-drives the claim after the operator fixes the cause. - RESUMABLE: the append-only `herdr_session_journal` is the source of truth per claim; a cursor in `herdr_backend_state` (key `backfill_cursor`) lets --resume skip ahead. - --dry-run is the default and writ

**Exports:** `BACKFILL_PROTOCOL`, `checkEligibility`, `createBackfillExecutor`, `ensureHerdrTables`, `getCursor`, `idempotencyKey`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/herdr-backfill.mjs`, `tests/herdr-backfill.test.js`

## `scripts/herdr-migrate.mjs`  (1343 lines)

**Purpose.** !/usr/bin/env node scripts/herdr-migrate.mjs — migration / rollout tooling for the herdr redesign. B20 (tooling) vs B21 (execution) split per D5 migration-rollout.md §5: this script is the planner / inspector / rollback tool. B21 runs the backfill waves with it. Scripts only — no runtime changes. Commands: scan            Enumerate backfill-eligible claims (D5 §1.2). Writes nothing. plan            Build the ordered plan; journal it (--execute) or show would_write. migrate         Execute the plan in batches: idempotent, resumable (D5 §1.4). reverse         Per-lane reverse migration herdr -> legacy for one claim. drain-status    Open herdr sessions vs flag state (the §2 matrix, live). force-release   Operator-gated forced release of herdr sessions (claims -> unclaimed). reap-orphans    Mark orphans per §4.4 (mark by default; kill needs --confirm). status          Overall migration state

**Exports:** `EXIT_OK`, `EXIT_PARTIAL`, `EXIT_SYSTEMIC`, `USAGE`, `aggregateDrainStatus`, `appendJournalEntry`, `batchPlan`, `buildPlan`, `buildScanReport`, `classifyClaim`, `deriveExitCode`, `detectOrphans`

**Callers/importers (git grep HEAD):** `scripts/herdr-migrate.mjs`, `tests/herdr-migrate.test.js`

## `scripts/host-isolation-preflight.mjs`  (24 lines)

**Purpose.** Setup diagnostic only: a fixed --version probe may expose sandbox startup diagnostics. Actual untrusted host stderr remains suppressed by the adapter.

## `scripts/inbox-quarantine-review-check.mjs`  (199 lines)

**Purpose.** Browser coverage for the quarantine review UI (worker C): two held spam messages render with scores, sender, subject, and non-empty signal reasons; Confirm removes an item from held and shows it in released/confirmed history; Dismiss arms on the first click (changing nothing) and dismisses on the second. Boots a real server against an acceptance-fixture store over loopback; no network calls.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/landing-facts.mjs`  (285 lines)

**Purpose.** One read for the landing path. Prints four identities and, when ROOM_AGENT_CONFIG is set, lease holder and expiry for touched paths. Does not post, claim, merge, deploy, or release a lease. A chat line is not one of these facts.

**Exports:** `attachRestCommitIds`, `defaultExec`, `landingFacts`, `pathLeases`, `reviewCommitId`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/landing-facts.mjs`, `tests/landing-facts.test.js`

## `scripts/lesson-contradictions.mjs`  (470 lines)

**Purpose.** !/usr/bin/env node scripts/lesson-contradictions.mjs Contradiction resolver — input side only — for conflicting lesson entries (backlog W015). Builds on the lessons corpus (docs/ROOM-WIKI.md, docs/WEEKLY-LEARNINGS.md, and the "## Lessons" bullets of AGENTS.md). This is a heuristic detector (no LLM). It normalizes lesson entries and flags pairs that look contradictory: opposing-directive     one entry says "never X", another says "always X" (or must/do X) on the same topic — same file path, shared identifier, or strong topic-token overlap plus overlapping directive targets. preference-inversion     one entry prefers X over Y, another prefers Y over X. unmarked-supersession    an entry claims to supersede/replace/correct a specific corpus entry without the correction entry referencing it back (the wiki is append-only, so the old entry can't mark itself — the pointer is one-way and needs re

**Exports:** `extractDirectives`, `findContradictions`, `loadAllCorpus`, `parseLessonBullets`, `renderContradictionReport`, `sharedAnchors`, `supersessionClaim`

**Callers/importers (git grep HEAD):** `scripts/lesson-contradictions.mjs`, `tests/lesson-contradictions.test.js`

## `scripts/lint-design-tokens.mjs`  (210 lines)

**Purpose.** Design-token ratchet lint (D-fo-6 step 1). Fails CI when a NEW raw hex color literal, a NEW raw `font-size:` declaration, or a NEW raw size smuggled through the `font:` shorthand appears in the CSS tree. Everything that exists today is grandfathered in scripts/design-tokens-baseline.json; that file only shrinks over time — never add NEW entries to it. Run: node scripts/lint-design-tokens.mjs Regenerate the baseline after legitimately removing violations: node scripts/lint-design-tokens.mjs --capture (--capture prints the added/removed entries so review can see exactly what changed; never run it to bless a new violation.)

**Exports:** `diffAgainstBaseline`, `hexHits`, `loadBaseline`, `rawFontShorthandValue`, `rawFontSizeValue`, `scanTree`

**Callers/importers (git grep HEAD):** `package.json`, `scripts/lint-design-tokens.mjs`, `tests/design-tokens-lint.test.js`

## `scripts/live-audit.mjs`  (95 lines)

**Purpose.** live-audit.mjs — production deploy guardrails for room.trydemigod.com. Fixture-vs-live gap (read before adding a guard): this module is unit-tested with an injected fetchImpl (tests/live-audit.test.js), so a guard can pass against fixtures while the route it guards never existed. That is exactly what happened with /api/open, /api/auth-config and privacy: they were asserted against fixture JSON, but server/http.mjs serves no such API paths and its `assets` static map has no such page, so every deploy check cried wolf on ship/persistence/auth_provider/ privacy_status. Rules for this file: 1. Every guarded path MUST exist in server/http.mjs (or the assets map). 2. Retired paths stay in PHANTOM_ROUTES below as honest-404 assertions: the audit fails if a phantom ever starts serving, which forces the guard to be rewritten against the real route — never against a fixture.

**Exports:** `LIVE_ORIGIN`, `PHANTOM_ROUTES`, `liveAudit`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/live-audit.mjs`, `scripts/live-smoke.mjs`, `tests/audit-wave-low-d.test.js`, `tests/live-audit.test.js`

## `scripts/mcp-test-client.mjs`  (33 lines)

**Purpose.** Test harness, not an AI host integration or a production dependency.

**Exports:** `openMcpTestClient`

**Callers/importers (git grep HEAD):** `scripts/credit-question-browser-check.mjs`, `scripts/discovery-contribution-browser-check.mjs`, `scripts/help-contribution-browser-check.mjs`, `scripts/help-invitation-browser-check.mjs`, `scripts/help-offer-browser-check.mjs`, `scripts/inbox-collaboration-check.mjs`, `scripts/native-draft-browser-check.mjs`, `scripts/reconnect-collaboration-browser-check.mjs`, `tests/agent-mentions-inbox.test.js`, `tests/agent-setup.test.js`

## `scripts/merge-queue-eject-budget.mjs`  (386 lines)

**Purpose.** merge-queue-eject-budget.mjs — measured flake eject budget for GitHub's native merge queue. GitHub's merge queue is batch-then-eject (NOT batch-then-bisect): when a check fails in a merge_group, the failing PR is ejected and the group rebuilds. Without a budget, a flaky PR can eject/requeue forever, burning 25-75 min of CI per cycle and blocking its whole group each time. What this does: - On `merge_group` `destroyed` events, classifies the eject. Only explicit check-failure ejects burn budget; lane pushes (design doc MERGE-QUEUE-DESIGN.md §1.3: eject first, push, re-verify, re-enqueue), manual dequeues, dirty-PR ejects, and unknown reasons never count. - Counts failure-ejects per PR in a rolling window (default: 3 ejects / 24h) persisted in tests/merge-queue-eject-budget.json (the repo-file ledger, committed back fail-closed like onboarding-probe's results.md). - When a PR trips the bud

**Exports:** `BUDGET_DEFAULTS`, `LEDGER_VERSION`, `alertCommandId`, `buildAlertBody`, `classifyEject`, `ejectsInWindow`, `emptyLedger`, `evaluateBudget`, `main`, `markAlerted`, `mergeLedgers`, `proposeQuarantine`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/merge-queue-eject-budget.mjs`, `tests/merge-queue-eject-budget.test.js`

## `scripts/merge-queue-receipt.mjs`  (49 lines)

**Purpose.** Merge-queue receipt. Posts one room message through the GitHub door (ROOM_DOOR_SECRET, the same secret as room-github-door.yml). Issue #266 is locked, so this does not comment there. When the door secret is unset the run skips and says so.

**Exports:** `main`, `receiptCommand`, `runReceipt`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `tests/receipt-prose-quality.test.js`

## `scripts/native-host-binary.mjs`  (83 lines)

**Purpose.** Resolve the executable for a native host, without hardcoding anyone's home directory. The runner used to name one developer's install path directly, which meant the acceptance exercise could only ever run on that one laptop and failed on every other machine with a bare ENOENT from spawn. Resolution order, first hit wins: 1. An explicit environment override, so an unusual install is always reachable without editing the script. 2. The executable on PATH, which is where a normal install puts it. 3. A platform default, kept only for the packaged macOS application that genuinely does live at a fixed location and is not on PATH. This never throws. Resolution happens before a host is started but the caller reserves its evidence file first, so an unresolvable binary has to be reportable rather than fatal; returning a reason keeps that ordering intact and still gives the operator something better

**Exports:** `HOST_BINARY_DEFAULT`, `HOST_BINARY_ENV`, `onPath`, `resolveHostBinary`

**Callers/importers (git grep HEAD):** `scripts/native-host-request-run.mjs`, `tests/native-host-binary-resolution.test.js`

## `scripts/openapi-gen.mjs`  (79 lines)

**Purpose.** OpenAPI gate (batch RT). Until the legacy chain is empty, this check parses docs/openapi.yaml, keeps the template gate, and requires every documented operation to be a row in server/routes/table.mjs or a row still listed in the legacy allowlist. A documented HEAD is covered when GET is served for the same template: several handlers answer HEAD as 404 today, and this batch does not change that. Byte-for-byte generation of docs/openapi.yaml from the table starts when the allowlist is empty (RT-final). Until then a rewrite would fight other open pull requests that still edit the document by hand.

**Exports:** `methodCoverageProblems`, `openApiGateProblems`, `openApiParseErrors`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/check.mjs`, `scripts/openapi-gen.mjs`, `tests/route-table-parity.test.js`

## `scripts/pr-diff-size-check.mjs`  (167 lines)

**Purpose.** PR diff-size gate. Diffs over MAX_DIFF_LINES (default 300) must carry an explicit "Large diff justification:" section in the PR body, or the check fails. Why: smaller diffs mean fewer rebase conflicts (PR #1530 needed five rebase cycles partly because of diff size) and faster reviews. Split the PR when you can; justify it when you cannot. Pure contract: checkDiffSize({ numstat, prBody, threshold? }) -> { ok, counted, message }. CLI: BASE_SHA/HEAD_SHA (env or --base/--head), PR_BODY or PR_BODY_B64 (env) or --body/--body-b64/--body-file args. DIFF_SIZE_THRESHOLD overrides the single constant without a code change.

**Exports:** `MAX_DIFF_LINES`, `MIN_JUSTIFICATION_CHARS`, `checkDiffSize`, `isExcluded`, `resolveThreshold`

**Callers/importers (git grep HEAD):** `scripts/pr-diff-size-check.mjs`, `tests/pr-diff-size-check.test.js`

## `scripts/probe-prod-lib.mjs`  (94 lines)

**Purpose.** Shared probe logic for probe-prod.mjs (CLI) and watch-deploy-drift.mjs. Matrix and classification are built from the 2026-09-25 1101 incident evidence, not from path-shape guesses: - "/" is DO-BACKED: it served an 1101 during the outage. It is not an edge-static canary. - /.well-known/agent.json also flows through the DO on the canonical host, so it cannot be an independent edge canary. - /api/health/jobs is the JOBS CANARY: its handler catches DO RPC errors and answers a clean 503. During the incident it kept answering while every other DO-backed route hard-failed. A 200 or a clean JSON 503 with schema room.job-health/1 proves the Worker itself is alive; it hard-failing means the Worker or the DO is failing; use external edge and logs to distinguish.

**Exports:** `MATRIX`, `probeProd`

**Callers/importers (git grep HEAD):** `scripts/probe-prod.mjs`, `scripts/watch-deploy-drift.mjs`, `tests/probe-prod.test.js`

## `scripts/prod-flow-probes.mjs`  (45 lines)

**Purpose.** !/usr/bin/env node Prod flow probes: read-only checks of the paths a person or agent walks first. Exit 1 on any failure. No credentials. No writes. Safe to run on a schedule. Usage: node scripts/prod-flow-probes.mjs [--json]

**Exports:** `PROBES`, `runProbes`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/prod-flow-probes.mjs`

## `scripts/progressive-disclosure-check.mjs`  (151 lines)

**Purpose.** Consistent progressive disclosure (backlog C7): in-room section disclosures share one summary anatomy (chevron, label, trailing chip/note), hit target, focus ring - and toggling never moves focus. Disposable rooms only.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/purpose-invite-check.mjs`  (109 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/quiet-design-check.mjs`  (145 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/report-unit-failures.mjs`  (64 lines)

**Purpose.** !/usr/bin/env node scripts/report-unit-failures.mjs CI honesty: the "Report failures to PR" step in .github/workflows/test.yml names the failing tests instead of pointing at the job log. Reads the shard receipt written by scripts/unit-ci.mjs (latest attempt wins) and writes the markdown comment body to --body-file (or stdout). Usage: node scripts/report-unit-failures.mjs --shard=1/3 [--body-file=path] Env: GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID (for the run link).

**Callers/importers (git grep HEAD):** `scripts/report-unit-failures.mjs`

## `scripts/rollback-readback.mjs`  (84 lines)

**Purpose.** !/usr/bin/env node Verify a rollback using fresh `wrangler deployments status --json` records. stdin / --status-file: {prod: <production status>, entry: <entry status>}. A single raw status is also accepted when only --prod-id is requested. No deployment or credentials: this CLI only validates records and GETs both doors. Allocation proof does not establish data restoration or a source-SHA mapping for the Worker version IDs; the observed source revisions are receipts.

**Callers/importers (git grep HEAD):** `tests/rollback-readback.test.js`

## `scripts/routes-inventory.mjs`  (500 lines)

**Purpose.** Legacy route inventory (batch RT). Walks the routes the server still serves outside the route table and writes scripts/routes-legacy-allowlist.json. The allowlist is the parity baseline: it only shrinks as extraction PRs move a group into server/routes/table.mjs. A route still implemented in the legacy chain and missing from the allowlist fails the check. A new legacy route cannot be added to the baseline. Path templates come from the same extractors as the open-route gate. Methods come from the handlers: explicit comparisons, 405 Allow values, and the route-name switches in the feature modules.

**Exports:** `allowlistDocument`, `allowlistProblems`, `extractLegacyRoutes`, `loadRouteSources`, `servedPathKeys`, `templateKey`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/openapi-gen.mjs`, `server/http.mjs`, `tests/route-table-parity.test.js`

## `scripts/run-quarantined-tests.mjs`  (78 lines)

**Purpose.** !/usr/bin/env node scripts/run-quarantined-tests.mjs Zero-Bug System: non-blocking lane for quarantined flaky tests. Reads tests/quarantine.json and runs each quarantined test with QUARANTINE_RUN=1 (so env-gated quarantined tests execute). Entries use the "file > test name" convention; a bare file entry runs the whole file. Exits non-zero when any quarantined test fails — the zero-bug-quarantine workflow keeps this job non-blocking via `continue-on-error: true`, so a red result reports honestly without ever failing a PR. Dependency-free: uses only node builtins.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/run-quarantined-tests.mjs`

## `scripts/runtime-import-closure.mjs`  (54 lines)

**Purpose.** Static import-closure analyzer for the runtime-package allowlist lint. Computes the transitive closure of relative ES-module imports starting from an entrypoint, so tests can assert every imported module is allowlisted without humans hand-maintaining a file list. Only static `import`/`export ... from` with relative specifiers (./ or ../) are followed. `node:` builtins, bare package specifiers, and dynamic `import()` are ignored: the server tree uses static relative imports with explicit extensions throughout.

**Exports:** `importClosure`

**Callers/importers (git grep HEAD):** `tests/runtime-package.test.js`

## `scripts/scan-secrets.mjs`  (109 lines)

**Purpose.** Zero-bug gate: scan the PR diff for committed secrets. Usage: node scripts/scan-secrets.mjs [--base <git-ref>] [--diff <file>] Default base: origin/main. CI passes the PR base SHA explicitly. Exit 0: no secrets found. Exit 1: at least one finding (blocks the PR). Only ADDED lines (+ lines, excluding the +++ header) are scanned, so pre-existing history never blocks a new PR. Pattern list is deliberately conservative (high-precision, low recall): every pattern anchors on a known provider prefix. Generic "high entropy string" heuristics are NOT used — they false-positive on hashes, UUIDs, and test fixtures. Explicit escape hatch: append `secrets-allowlist` (case-insensitive) to the line, e.g. `const EXAMPLE = "AKIAIOSFODNN7EXAMPLE"; // secrets-allowlist`

**Callers/importers (git grep HEAD):** `scripts/scan-secrets.mjs`, `scripts/secret-scan-check.mjs`, `tests/scan-secrets-line.test.js`

## `scripts/server-json-check.mjs`  (168 lines)

**Purpose.** Offline checks for server.json, plus an optional registry version bump. The description text is whatever the file says. POS-1a can change that field; this script only checks its shape.

**Exports:** `CANONICAL_ORIGIN`, `DESCRIPTION_MAX`, `NAMESPACE_PREFIX`, `REGISTRY_VERSIONS_URL`, `checkAgainstRegistry`, `checkServerJson`, `checkVersionIncreases`, `compareSemver`, `latestRegistryServer`, `parseSemver`

**Callers/importers (git grep HEAD):** `scripts/check.mjs`, `scripts/listing-check.mjs`, `tests/server-json-check.test.js`

## `scripts/signin-browser-journey.mjs`  (19 lines)

**Purpose.** Reach recovery through the visible password-first entry, including invitation hosts.

**Exports:** `backToPasswordSignin`, `openMagicSignin`

**Callers/importers (git grep HEAD):** `scripts/accessibility-check.mjs`, `scripts/account-settings-browser-check.mjs`, `scripts/account-workspace-check.mjs`, `scripts/auth-return-browser-check.mjs`, `scripts/quiet-copy-browser-check.mjs`, `scripts/start-room-browser-check.mjs`

## `scripts/skills-sync-check.mjs`  (19 lines)

**Purpose.** Fails when plugins/project-room/skills/ is not an exact copy of skills/. Repair with: node scripts/skills-sync.mjs

**Exports:** `reportSkillDrift`

**Callers/importers (git grep HEAD):** `scripts/lint.mjs`

## `scripts/skills-sync.mjs`  (67 lines)

**Purpose.** skills/ is the only source for Project Room skills. This copies that tree onto plugins/project-room/skills/, including skills that exist only under skills/ and dropping plugin-only copies such as the shelved bounty worker.

**Exports:** `SKILLS_COPY`, `SKILLS_SOURCE`, `skillDrift`, `skillFiles`, `syncSkills`

**Callers/importers (git grep HEAD):** `scripts/skills-sync-check.mjs`, `tests/claude-plugin.test.js`

## `scripts/smoke-prod.mjs`  (127 lines)

**Purpose.** Production smoke probes (Zero-Bug System, Phase 2). Zero dependencies. Synthetic READ-ONLY probes against the live Project Room deployment. Never writes or mutates production data, never spends, never charges, never authenticates as any user or agent. Every probe only reads a status code / response shape. Probes: A. landing page      GET /                                   -> 200 + HTML B. claims-board read GET /api/opportunities.json?room=...    -> 200 + JSON with `opportunities` array C. priced-tool MCP   POST /mcp tools/call add_land_item     -> 401 auth_required JSON-RPC (never 500) Notes on probe C: the spend primitive's honest 402 (payment_required, server/spend-grants.mjs paymentRefusal) fires for an authenticated agent holding no spend grant. Creating or borrowing an agent identity would write to production (or impersonate one), so this credential-less probe asserts the adjacent 

**Callers/importers (git grep HEAD):** `scripts/smoke-prod.mjs`

## `scripts/sync-design-tokens-css.mjs`  (73 lines)

**Purpose.** Regenerate the design-token variable blocks in src/styles.css from src/design-tokens.js (single source of truth). The :root (dark) and [data-theme="light"] blocks carry marker comments; everything between a begin/end marker pair is replaced with the generated declarations, preserving the surrounding lines (color-scheme, aliases). Values stay byte-identical when tokens are unchanged, so regeneration is a no-op diff unless a token actually moved. Run:   node scripts/sync-design-tokens-css.mjs Check: node scripts/sync-design-tokens-css.mjs --check   (CI gate)

**Exports:** `hasTokenMarkers`, `syncTokensCss`

**Callers/importers (git grep HEAD):** `scripts/check.mjs`, `scripts/sync-design-tokens-css.mjs`, `tests/design-tokens-css-sync.test.js`

## `scripts/trace-entry.mjs`  (144 lines)

**Purpose.** Trace-entry automation (W001): append one merge-time line to docs/ROOM-TRACES.jsonl when a pull request merges to main, so the raw-traces plane never needs a manual backfill again. Runner: .github/workflows/trace-entry.yml (pull_request_target, closed). The workflow checks out main, runs this script, validates with scripts/check-wiki.mjs (fail closed), commits the line to a trace-entry/pr-<N> bot branch, and opens/merges a trace PR — a direct push to main is blocked by the required status checks on merges, so publication goes through a normal PR. This script never runs untrusted PR code: it only reads the GitHub-provided event payload. Entry fields (must satisfy scripts/check-wiki.mjs: date, slice, agent, pr, sha, outcome, tests {pass,fail}, notes; dates non-decreasing, append-only): date    — PR merge date (merged_at), never the run date. Clamped up to the last existing entry's date so 

**Exports:** `appendTraceEntry`, `buildTraceEntry`, `extractSlice`, `loadPullRequest`, `main`, `readTraceLines`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/trace-entry.mjs`, `tests/trace-entry.test.mjs`

## `scripts/unit-shards-check.mjs`  (22 lines)

**Purpose.** !/usr/bin/env node Required `unit` gate: successful Actions matrix AND all exact-run receipts. Mirrors scripts/browser-shards-check.mjs: every tests/*.test.js file must be covered exactly once by a passing shard from this exact run/attempt plan.

**Callers/importers (git grep HEAD):** `scripts/unit-ci.mjs`, `scripts/unit-shards-check.mjs`, `tests/unit-shards.test.js`

## `scripts/unit-shards.mjs`  (192 lines)

**Purpose.** Allocation for the sharded unit suite (CI-speed lane). The `unit` merge-gate job ran `npm test` (Node default discovery) in one job: ~625s on hosted CI, the long pole of every PR head. This module splits the suite into SHARD_COUNT file shards with balanced estimated duration, so the `unit-shards` matrix finishes in roughly 1/SHARD_COUNT of the time. Allocation follows Node24 default test discovery; timing data never selects membership: every Node-discovered test file is in exactly one shard. Per-file durations live in scripts/unit-ci-durations.json (milliseconds, measured on hosted CI, with documented local additions); files without a measurement get a conservative default so a new test file lands in a shard instead of breaking the plan.

**Exports:** `SHARD_COUNT`, `discoverUnitTests`, `parseShard`, `unitPlan`, `verifyUnitShards`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `scripts/report-unit-failures.mjs`, `scripts/unit-ci.mjs`, `scripts/unit-shards-check.mjs`, `scripts/verify-affected.mjs`, `tests/unit-shards.test.js`

## `scripts/unstamped-member.mjs`  (17 lines)

**Purpose.** A live member.added stamps the display-name policy and refuses a folded duplicate. These checks need a stored collision so the rail can disambiguate names. An older event omits the stamp and still replays.

**Exports:** `admitHistoricalMember`

**Callers/importers (git grep HEAD):** `scripts/chat-performance-browser-check.mjs`, `scripts/quiet-attribution-browser-check.mjs`

## `scripts/untested-modules-lint.mjs`  (98 lines)

**Purpose.** Untested-server-module lint (plan task T1). Lists server/*.mjs modules with zero references from tests/ and fails if a NEW module joins the untested set, or if the grandfather list still names a module that is now tested (the list only shrinks). Run: node scripts/untested-modules-lint.mjs

**Exports:** `findUntested`

**Callers/importers (git grep HEAD):** `scripts/untested-modules-lint.mjs`, `tests/untested-modules-lint.test.js`

## `scripts/verify-affected.mjs`  (264 lines)

**Purpose.** !/usr/bin/env node verify:affected: run only the unit tests related to your diff. npm run verify:affected                  # diff vs origin/main (+ uncommitted + untracked) npm run verify:affected -- --list        # print the selection and reasons, run nothing npm run verify:affected -- --base=<ref> --budget=300 --budget is seconds of wall time per test worker, estimated from the CI timings in scripts/unit-ci-durations.json. Hosted CI is much slower than a dev machine: the default ran 168 files in ~27s on 8 local cores. A Node-discovered test file (same discovery as `npm test`) is selected when: 1. it changed itself; 2. it imports a changed file, directly or transitively (static and literal dynamic imports, require() and new URL(..., import.meta.url)); 3. its source names a changed file's repo-relative path (docs, JSON, workflow and fixture files that tests read). Closer tests win: dista

**Exports:** `GLOBAL_FILES`, `SMOKE_TESTS`, `buildReverseGraph`, `changedFiles`, `parseImports`, `relatedTests`, `resolveSpecifier`, `selectTests`

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/verify-affected.mjs`, `tests/verify-affected.test.js`

## `scripts/visual-regression-helper.mjs`  (161 lines)

**Purpose.** Q003: shared screenshot-diff helper for the visual regression browser checks. The gate: committed baseline PNGs under scripts/visual-regression-baselines/ are compared pixel-for-pixel against a fresh capture on every CI run. A diff above MAX_DIFF_PIXEL_RATIO fails the check and writes the actual capture plus a diff image to test-results/visual-regression/ (picked up by the existing browser-shards artifact upload). Determinism contract (every check using this helper gets the same): - one fixed viewport (VISUAL_VIEWPORT), deviceScaleFactor 1 - prefers-reduced-motion so CSS animations/transitions do not run - animations disabled at capture time; text caret hidden - document.fonts settled before capture (no font-swap flicker) - seeded store data; dynamic regions (timestamps, avatars, live presence) painted over via the `mask` locators before capture — baselines carry the same masks, so the g

**Exports:** `BASELINE_DIR`, `EVIDENCE_DIR`, `MAX_DIFF_PIXEL_RATIO`, `PIXEL_THRESHOLD`, `VISUAL_VIEWPORT`, `assertScreenshotMatches`, `chromiumLaunchOptions`, `compareScreenshotBuffer`, `diffPngBuffers`, `settleForScreenshot`, `shouldUpdateBaselines`, `visualContext`

**Callers/importers (git grep HEAD):** `scripts/visual-regression-browser-check.mjs`

## `scripts/work-context-agent-seed.mjs`  (33 lines)

**Purpose.** Deterministic synthetic prehistory only. Fresh agents provide the correction and real review.

**Exports:** `seedWorkContextExercise`

**Callers/importers (git grep HEAD):** `scripts/real-agent-fixture.mjs`
