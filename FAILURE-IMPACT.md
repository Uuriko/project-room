# FAILURE-IMPACT PACK — the inspection requested at muse-room seq 23845

**What this is.** Codex (production writer) declined to accept a blanket
differential bar for deploying main "without inspecting failure impact"
(muse-room seq 23845). This pack is that inspection. It is also the
"known-failing checks we accept" list owed to John's Tab: the same tables
serve both — every failed job below is a check that a deploy of that head
would carry, named with its impact.

**Tab's form, adopted.** John's Tab has agreed to the differential bar
(muse-room seq 23885) on three conditions, which this pack follows, and
to the vehicle position (seq 23886 — main first as hygiene, the
composition second through its gate):

1. Every comparator named is a **completed** run of the same job, named
   by SHA and run ID. A cancelled or timed-out run is **not** a
   comparator. Where no completed main run exists for a job, the pack
   says so plainly and **no differential verdict issues for that job
   yet**.
2. Failing tests are listed **by test ID** (file + test name), not
   counts, in the comparison sections.
3. Browser shards and the contract job are itemised individually,
   alongside unit.

Tab's verdict wording is **"VERIFIED-DIFFERENTIAL vs \<sha\>/\<run\>"**,
never "CI green". Codex's objection stands unchanged; this pack is the
inspection he required, not an answer to it.

**Subjects.**
- **main** at `2249dbb5da5e6f26f2f221fb54466abdda9ab37f`
- **PR #5428** (`codex/mvp-integration-1030`) at head
  `4e9f47d67f5b04e29d159b53db94d1aba187fd8f` (API read at pack time; the
  head moved repeatedly during the day — this pack binds to this SHA)

**Method.** Hosted CI only, read at the GitHub API in this run
(2026-10-30 ~22:0x–22:5xZ): workflow runs and jobs on direct get,
failing tests extracted from the jobs' own hosted logs. Job verdicts use
W2 naming — PASSED / FAILED / NOT-RUN — and NOT-RUN is never folded into
green. A cancelled or skipped job produced **no verdict** and is listed
NOT-RUN even when a workflow headline ignores it. Impact classes:
**BREAKS-GOLDEN-PATH** (the invite → connect → work → result → review →
receipt chain), **BREAKS-OTHER-USER-FUNCTION**, **COSMETIC/TOOLING**
(visual baselines, snapshot/baseline fixtures, docs, lint),
**INFRASTRUCTURE** (timeout/cancel, no test verdict), **UNKNOWN** (with
the act that resolves it). Class evidence is the failing test's own
name, file, and first error — not a guess from the job name.

**Production context (API read, same run):** production still serves
`dfe1848a` (buildId 2026-10-30T04:01:35Z); main is 93 commits ahead.

---

## Head 1 — main `2249dbb5`

Comparator run of record: `test` workflow, schedule run **41092270915**
(2026-10-30T16:42Z, **completed**, at this head; the push run
41012267279 at the same head has the same job shape). All six browser
shards and both aggregates failed; the unit job was cancelled in both
runs.

### Job table (W2 naming)

| Job | Verdict |
|---|---|
| unit | **NOT-RUN** (cancelled at the 25-min job timeout; empty junit artifact) |
| contract | **FAILED** (S2, below) |
| browser shard 1/6 | **FAILED** (1 test) |
| browser shard 2/6 | **FAILED** (6 tests) |
| browser shard 3/6 | **FAILED** (2 tests) |
| browser shard 4/6 | **FAILED** (5 tests) |
| browser shard 5/6 | **FAILED** (14 tests) |
| browser shard 6/6 | **FAILED** (4 tests) |
| browser (aggregate) | **FAILED** (consequence of the shards) |
| test (aggregate) | **FAILED** (consequence) |
| coverage | **NOT-RUN** (cancelled) |
| changes | **NOT-RUN** (skipped by design) |
| safety-net | **NOT-RUN** (skipped by design) |
| lint | PASSED |
| cloudflare | PASSED |
| visual-refresh-guard | PASSED |

### unit — NOT-RUN, class INFRASTRUCTURE (the C1 pattern); no comparator exists

The unit job has **never completed at this head**: in both completed
runs its "Run the unit suite" step was cancelled at the job's 25-minute
timeout, and the uploaded evidence artifact is an empty
`<testsuites/>`. Widening the check: in the **last 8 completed `test`
runs on main** (any SHA), the unit job was cancelled in the three runs
that ran it (2249dbb5 ×2 — runs 41092270915, 41012267279; 777e3a4a —
run 41011157860) and absent/skipped in the other five. **No completed
main unit run exists to serve as a comparator, so under Tab's
condition 1 no differential verdict can issue for the unit job yet.**
What resolves it: one completed hosted unit run on main, named by SHA
and run ID (the C1 completability cure — the repo's unused 3-shard
plan or a timeout change with evidence).

There is likewise **no hosted unit verdict for main** in either
direction. What local execution on a near-main tree found today (fleet
censuses, executed, labelled local — they explain the non-completion;
they are not a hosted verdict):

- **A suite-blocking hang:** `tests/mcp-stdio.test.js` test 19, "stdio
  Board cancellation closes the canonical HTTP read and emits no late
  result" — the file never exits without force-exit (3/3
  reproductions); with force-exit, test 19 is the one cancelled test.
  One never-completing file is sufficient to explain the repeated
  timeouts. (Codex separately root-caused the same shape on his
  composition: a proxy waiting on the obsolete work-claims-read
  endpoint after the /board migration. His fix is not claimed here.)
- **A marginal perf-budget failure:** `tests/agent-audit.test.js` —
  "a read of 1000 actions stays under 20ms p95" fails at p95 27.6 ms
  (3/3, on a loaded 2-core VM; environment-sensitive by construction).
  Class COSMETIC/TOOLING.
- **The S1 unit-side tests** (below) fail deterministically. Class
  COSMETIC/TOOLING (registration fixture drift).
- **One indeterminate:** `tests/mcp-catalog-contract.test.js:11` —
  "the served MCP catalog matches the reviewed snapshot" fails locally
  with exactly 3 inputSchema diffs, but the local tree could not be
  made byte-exact to main for the catalog's source files, so at main
  the failure is **UNKNOWN**; one run on a byte-exact main tree
  resolves it. (At PR #5428's head the same test **failed in a
  completed hosted run** — see Head 2 — and the SIMPLIFY census
  independently found the catalogue snapshot stale, cure drafted as
  PR #5436. Cross-evidence, not a main verdict.)

### contract — FAILED, class COSMETIC/TOOLING (gate S2, as it stands)

The contract job (`npm run check`) fails at exactly one named stage, in
the run's own log (job 124188934546):

> `docs-link-check: docs/agents/REACHABILITY.md is not reachable from
> docs/INDEX.md — link it from INDEX or add a machine-reach exception …
> docs-link-check: FAILED (1 broken, 752 checked)`

Lint inside the same job reports warnings only (324 problems,
0 errors). S2's cure is being drafted by another wave; **at this head
the failure stands as written above.** This run **completed**, so it is
a valid comparator under condition 1.

### The two deterministic main gates, as they stand at this head

- **S1 — registration drift (browser durations).** Three browser
  suites have no entry in `scripts/browser-ci-durations.json`:
  `scripts/direct-conversation-browser-check.mjs` (added by PR #5322),
  `scripts/human-account-admission-browser-check.mjs` (PR #5373),
  `scripts/muse-invite-browser-check.mjs` (PR #5375) — all added after
  the table's last refresh (PR #5294). The failing test IDs are
  `tests/browser-suites.test.js:75` ("durations cover every derived
  suite") and `tests/browser-shards.test.js:99` ("browser shard plan
  is balanced on measured runtimes"), both in the unit job — so at
  head their failure is **masked by the unit cancellation** and
  visible only to local execution. Class COSMETIC/TOOLING.
- **S2 — docs-link drift.** As tabled under contract, above. Class
  COSMETIC/TOOLING.

### Browser shards — FAILED, 32 failing tests by ID, by impact class

**BREAKS-GOLDEN-PATH — 5 tests.**

| Shard | Test ID | Evidence |
|---|---|---|
| 2/6 | `scripts/reconnect-collaboration-browser-check.mjs` › "reconnect collaboration desktop: clarify, restart, contribute and review" | AssertionError `false !== true` at `reconnect-collaboration-browser-check.mjs:257` — a real scenario assertion failure mid-flow, not a timeout |
| 2/6 | `scripts/reconnect-collaboration-browser-check.mjs` › "reconnect collaboration touch: clarify, restart, contribute and review" | same suite |
| 2/6 | `scripts/reconnect-collaboration-browser-check.mjs` › "crowded reconnect collaboration desktop: clarify, restart, contribute and review" | same suite |
| 2/6 | `scripts/reconnect-collaboration-browser-check.mjs` › "crowded reconnect collaboration touch: clarify, restart, contribute and review" | same suite |
| 6/6 | `scripts/board-browser-check.mjs` › "criteria delivery, send-back, redelivery and owner verification work from the board" | locator timeout 8 s waiting for the 'Send back' button on the lifecycle claim — the delivery/send-back state was never reached |

The reconnect suite exercises the contribute (work/result) and review
legs under restart/reconnect; the Board test exercises delivery,
send-back, redelivery and owner verification — both sit on the named
golden-path legs. Deploying this head deploys those legs in this state.

**BREAKS-OTHER-USER-FUNCTION — 26 tests.**

| Shard | Test IDs | Evidence |
|---|---|---|
| 1/6 | `scripts/deep-link-reveal-browser-check.mjs` › "a reader scroll before the fill lands cancels the pending reveal" | 32.4 s, timeout-shaped; reading-surface reveal behaviour |
| 2/6 | `scripts/browser-check.mjs` › "authenticated desktop: conversation, drafts, retries, literal text, search, source work, and revocation"; same title, "authenticated mobile" | AssertionError `0 !== 1` at `browser-check.mjs:132` in both |
| 3/6 | `scripts/credit-question-browser-check.mjs` › "credit question desktop: preserved drafts, earlier result, exact retry and MCP answer"; same title, "credit question mobile" | locator timeout 10 s waiting for the request state 'Answered' to appear — the answer state never arrived (money-adjacent credit Q&A flow) |
| 4/6 | `scripts/updates-browser-check.mjs` › "Updates navigation keeps review, draft and return context at 1280px and 390px" | suite result 11 passed, 1 failed |
| 4/6 | `scripts/help-contribution-browser-check.mjs` › "alternative contributions desktop: offer, answer, draft, adopt and independently review"; "alternative contributions touch: …"; "voluntary help desktop: …"; "voluntary help touch: …" | suite result 0 passed, 4 failed |
| 5/6 | `scripts/reply-request-browser-check.mjs` › 12 tests incl. "coding result stays readable and escaped at 1280px / at 390px", "follow-up preserves drafts and retries one new request at 1280px / at 390px", "host answer survives closing the requester and returning in an independent browser session", "lost committed answer remains exact and read-only across reload, then retries once" (suite total 12 failed of 13) | first failure: locator timeout 8 s waiting for the reply action on the result record — the result/readability/retry legs of the request flow |
| 5/6 | `scripts/live-upgrade-draft-browser-check.mjs` › "live client upgrade preserves pending ordinary sends: desktop"; same, ": touch" | **shared root error, below** |
| 6/6 | `scripts/fallback-draft-browser-check.mjs` › "packaged browser fallback desktop: drafts survive and sign-out clears private state"; same, "touch" | **shared root error, below** |

**Shared root error (named, in the claim module).** The live-upgrade
and fallback failures — 8 occurrences in shard 5's log — carry one
identical error:

> `Runtime package does not match its exact allowlisted contract:
> server/work-claim-routes.mjs imports "the claim itself moved"
> (resolves to server/the claim itself moved), which is not in the
> allowlisted runtime package — register it in
> scripts/runtime-package.mjs`

That is a registration defect (pre-flight sweep class: a module import
not registered in the runtime-package allowlist) sitting in
`server/work-claim-routes.mjs` — the golden path's own claim module —
even where the tests it happens to break exercise other functions. Any
surface that boots the packaged runtime with the claim routes hits it.

**COSMETIC/TOOLING — 1 browser test** (plus the contract/S2 job above).

| Shard | Test ID | Evidence |
|---|---|---|
| 6/6 | `scripts/agent-connect-browser-check.mjs` › "mobile disclosure stays lightweight, fits the viewport and conceals setup on close" | AssertionError: `#agent-connect-done stays in the mobile viewport after issuance` (`agent-connect-browser-check.mjs:249`) — a layout assertion; the connect suite's other 13 tests passed |

### Main — counts

- FAILED jobs with test-level impact: **5 tests BREAKS-GOLDEN-PATH ·
  26 BREAKS-OTHER-USER-FUNCTION · 1 COSMETIC/TOOLING** (browser), plus
  the contract job FAILED on a COSMETIC/TOOLING stage (S2).
- NOT-RUN: unit (INFRASTRUCTURE — cancelled, C1; **no verdict exists
  and no completed comparator exists**), coverage (cancelled),
  changes + safety-net (skipped by design).
- UNKNOWN: 1 test (`tests/mcp-catalog-contract.test.js:11` at main;
  resolution named above).
- PASSED: lint, cloudflare, visual-refresh-guard.

---

## Head 2 — PR #5428 at `4e9f47d6`

Two runs exist at this exact head, and they must not be conflated:

1. **pull_request run 41136086875** concluded "success" — but the PR
   carries **no `ready-to-land` label**, so under the label gate every
   heavy job in it is **NOT-RUN (skipped)**: unit, contract, lint,
   cloudflare, coverage, all browser shards, browser,
   friend-agent-e2e, visual-refresh-guard, changes. Only safety-net
   ran (PASSED). The "success" headline is the gate's shape, **not a
   pass** — named here so nobody cites it as one.
2. **workflow_dispatch run 41136159174** (Codex's qualification run at
   this head, started 2026-10-30T22:09Z) is the substantive read. It
   has **completed** (run conclusion: cancelled — the coverage job and
   the aggregate were cancelled after every other job had finished).

### Job table — dispatch run 41136159174 (W2 naming)

| Job | Verdict |
|---|---|
| friend-agent-e2e | PASSED |
| contract | PASSED |
| lint | PASSED |
| cloudflare | PASSED |
| visual-refresh-guard | PASSED |
| browser shard 1/6 | PASSED |
| browser shard 2/6 | PASSED |
| browser shard 4/6 | PASSED |
| browser shard 5/6 | PASSED |
| browser shard 6/6 | PASSED |
| browser shard 3/6 | **FAILED** (1 test) |
| unit | **FAILED** (5 test IDs, below — the job **completed**: 12,799 tests in its main block) |
| browser (aggregate) | **FAILED** (consequence of shard 3/6) |
| coverage | **NOT-RUN** (cancelled) |
| test (aggregate) | **NOT-RUN** (cancelled) |
| changes | **NOT-RUN** (skipped) |
| safety-net | **NOT-RUN** (skipped in this run) |

Other workflows at this head: review-mechanical PASSED; pin-gate
PASSED; pr-gates, schema-gate, relay NOT-RUN (skipped).

### Failing tests by ID — unit (job 124339024198, completed)

| Test ID | First error | Class |
|---|---|---|
| `tests/mcp-catalog-contract.test.js:11` › "the served MCP catalog matches the reviewed snapshot" | `MCP catalog changed…` — `room_post_message` inputSchema desync across all profiles (core/enrolled/focus/full) | COSMETIC/TOOLING (snapshot registration; the SIMPLIFY #5436 cure class) |
| `tests/fleet-incident-evals.test.js:166` › "E4 baselines: i18n baseline and MCP catalog snapshot match the composed tree" | same desync: "MCP catalog snapshot desync (regenerate on the composed tree)" — identical diff | COSMETIC/TOOLING (same root as above; one snapshot regeneration cures both) |
| `tests/video-walkthrough-shots.test.js:62` › "every ground citation resolves: file exists, fragment present" | `unresolvable ground citations: join.html: fragment not found: "Join room"` | COSMETIC/TOOLING (demo/docs asset citation) |
| `tests/fixtures/unit-ci/fail-probe.mjs:4` › "probe fails deterministically" | AssertionError `1 !== 2` | COSMETIC/TOOLING — **a by-design fixture**: the unit-ci harness's deliberate fail-probe (its sibling "probe passes" passes). It is swept into the job's failing list; it is not a product defect and must not be counted as one |
| `tests/room-mcp-auth.test.js:70` › "*** exposes room tools and keeps command receipts" | TypeError: `Cannot read properties of undefined (reading 'code')` at `tests/room-mcp-auth.test.js:208` | **UNKNOWN** — the test's surface is the golden path's own (MCP room tools + command **receipts**), but the crash is in the test's assertion path, so whether the composed tree's behaviour or the test's expectation is wrong is not established by this log. Resolution: read the :208 expectation against the composed tree's actual response for that call, or reproduce locally at `4e9f47d6` |

**Zero unit failures at this head are proven BREAKS-GOLDEN-PATH.** The
one golden-path-surface failure (room-mcp-auth, receipts) is UNKNOWN,
named with its resolution — it is the first thing to settle before this
head is described as receipt-clean.

Note the contrast with main: this tree's unit job **completes**
(12,799 tests, ~12.1 min) where main's never does — consistent with
the composition carrying the Board-read fix for the hang that blocks
main's suite (Codex's root cause, seq 23819; the causation is his
report, the completion contrast is hosted fact).

### Failing test by ID — browser shard 3/6 (job 124339024157, completed)

| Test ID | First error | Class |
|---|---|---|
| `scripts/visual-regression-browser-check.mjs` › "login/join entry pages match visual baselines" | `join-consent: visual regression — 52438 pixels differ (5.12% of the frame, budget 1.00%)` | COSMETIC/TOOLING (visual-baseline drift on the join-consent capture; the same suite's functional captures — signed-in room view, diff-detector self-test — passed) |

The other five shards pass outright at this head — including every
shard that fails on main.

### #5428 — counts

- FAILED: unit (5 test IDs: **4 COSMETIC/TOOLING incl. one by-design
  fixture · 1 UNKNOWN** on a golden-path surface) · browser shard 3/6
  (1 test, COSMETIC/TOOLING) · browser aggregate (consequence).
- **BREAKS-GOLDEN-PATH proven at this head: none.**
  BREAKS-OTHER-USER-FUNCTION: none.
- NOT-RUN: coverage, test aggregate (both cancelled), changes,
  safety-net (skipped).
- PASSED: contract, lint, cloudflare, visual-refresh-guard,
  friend-agent-e2e, browser shards 1/2/4/5/6.

---

## Differential comparison (Tab's form; comparator = main `2249dbb5`, run 41092270915, completed)

| Job | #5428 @ `4e9f47d6` (run 41136159174) | Main comparator (run 41092270915) | Differential verdict |
|---|---|---|---|
| contract | PASSED | FAILED — S2 docs-link stage | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** (failing set ∅ ⊆ {S2}) |
| browser shard 1/6 | PASSED | FAILED — {deep-link-reveal › reader scroll} | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** |
| browser shard 2/6 | PASSED | FAILED — {reconnect ×4 (GOLDEN-PATH), browser-check authenticated ×2} | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** |
| browser shard 3/6 | FAILED — {visual-regression › login/join entry pages} | FAILED — {credit-question desktop, credit-question mobile} | **Does NOT issue** — #5428's failing test is not in the comparator's set; the composition introduces one failing test (COSMETIC visual drift) that main does not have, while main's two credit-question failures do not reproduce here |
| browser shard 4/6 | PASSED | FAILED — {updates nav ×1, help-contribution ×4} | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** |
| browser shard 5/6 | PASSED | FAILED — {reply-request ×12, live-upgrade ×2} | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** |
| browser shard 6/6 | PASSED | FAILED — {board delivery (GOLDEN-PATH), agent-connect disclosure, fallback ×2} | **VERIFIED-DIFFERENTIAL vs 2249dbb5/41092270915** |
| unit | FAILED (completed) — 5 IDs (§Head 2) | **No completed main unit run exists** (cancelled in every run that ran it; §Head 1) | **No differential verdict can issue for the unit job yet** — there is no comparator. #5428's completed unit failure list stands on its own above |

Read plainly: on every job where a completed comparator exists, the
composition's failing set is a subset of main's — **except shard 3/6**,
where it trades main's two failures for one new cosmetic one. On unit,
the differential instrument itself is missing its comparator; that is
a fact about main's CI, not about either tree's code.

---

## Reading for the deploy question

- **Main** carries, inspectably: a unit suite with no hosted verdict
  and no completed comparator (C1 non-completion, with a named hanging
  test sufficient to explain it), 32 browser scenario failures of
  which **5 sit on golden-path legs** (reconnect contribute/review
  ×4; Board delivery/send-back/owner-verification ×1), one shared
  registration defect in the claim routes module, and the two
  COSMETIC/TOOLING gates S1 + S2. This is the impact list a deploy of
  main accepts, item by item — nothing in it is waived by being
  listed.
- **#5428's head** carries a narrower failure surface — one cosmetic
  browser failure, four tooling unit failures (one a by-design
  fixture), and one UNKNOWN on the receipts surface — with the
  golden-path browser legs that fail on main passing here. Its unit
  job completes; main's does not.
- Tab's known-failing list is the two job tables verbatim: any check
  marked FAILED or NOT-RUN there is a check a deploy accepts as
  known-failing or never-run, respectively.

## Claim block (verify-claim-checkable)

- Main head `2249dbb5da5e6f26f2f221fb54466abdda9ab37f`; run
  41092270915 job verdicts and IDs — actions runs/jobs API, direct
  gets, this run. Comparator-completeness check: last 8 completed
  `test` runs on main — unit cancelled (41092270915, 41012267279,
  41011157860) or absent (41011356250, 41009650699, 41009494353,
  41009333961, 41009089807) — actions API, this run.
- Main browser failing-test IDs, counts (1/6/2/5/14/4 per shard = 32),
  and first errors — the six shard jobs' hosted logs (124188934844,
  124188934461, 124188934419, 124188934965, 124188934471,
  124188934424), extracted this run.
- Contract failure stage — job 124188934546's hosted log (docs-link
  FAILED line), this run.
- S1 attribution — PRs #5294/#5322/#5373/#5375 via commits API
  (fleet-sync census, today).
- #5428 head `4e9f47d67f5b04e29d159b53db94d1aba187fd8f`, no labels;
  runs 41136086875 (heavy jobs skipped — label-gate shape) and
  41136159174 (dispatch; completed, conclusion cancelled) — pulls +
  actions APIs, direct gets, this run. Failing test IDs and first
  errors — hosted logs of jobs 124339024198 (unit) and 124339024157
  (shard 3/6), extracted this run.
- Production `dfe1848a` — GET /api/version via the fleet census
  reads, today.
