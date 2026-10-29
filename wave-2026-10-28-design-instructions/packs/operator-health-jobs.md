# Instruction Pack — Health & Jobs Dashboard (operator view of `/api/health/jobs`)

## 1. The piece

**What it is.** The public, unauthenticated job-health surface of Project Room and every
display/consumer of it. It is the only liveness signal for the background jobs (integrity,
backups, store growth, claim/land queues) and the feed for the fleet's SPILL/storage gauges.
There is **no dedicated HTML dashboard page in source** (verified: no `health/jobs` consumer
under `client/` at the tree below) — the "dashboard" today is the raw JSON, the owner-overview
read model, the token-gated operator status, and two fleet tools that parse the JSON. This
pack instructs a trustworthy operator view built on those existing surfaces, not a new page.

**Verified against source:** `git archive` of main
`aaa749065a6451321a949ddcb923f3174504fe35` into the lane scratch (read 2026-10-28).
Production is build `ca37fee4` (`GET /api/version`, live read below); this instruction
targets **main `aaa749065a`**, with post-deploy verification against production.

**Where it lives:**

| Surface | File (at `aaa749065a`) | Behaviour |
|---|---|---|
| Worker route | `cloudflare/room.mjs` (`/api/health/jobs` branch, before the visitor-address guard) → `readJobHealth()` on the Durable Object | One DO RPC reads heartbeat storage key `cron:job-heartbeats:v1`, returns `jobHealthResponse(...)` |
| Worker view | `cloudflare/job-heartbeat.mjs` — `jobHealthView()`, `jobHealthResponse()`, `applyOutcomes()`, `compactSummary()`, `sanitizeFailureDetail()` | Schema `room.job-health/1`; HTTP 200 for `ok`/`degraded`, **503 for `stale`/`failing`/`unavailable`**; `Cache-Control: no-store`; stale = no success within 3× `periodSeconds` (`STALE_PERIODS = 3`) |
| Node route | `server/legal-routes.mjs` (`/api/health/jobs` branch) → `nodeJobHealth()` in `server/jobs.mjs` | Always 200, `servedBy: "node"`, adds `publicReports` + `workItemBoard` divergence; **no rollup status** (documented in `docs/openapi.yaml` `/api/health/jobs`: "does not invent a cron status") |
| Job registry | `server/jobs.mjs` — `JOBS` (14 jobs), `defineJob()`, Node scheduler `jobHealth()` / `record()` | Live job set: gmail-sync, channel-drain, webhook-dispatch, land-queue, claim-prs, retention, **integrity** (hourly, `slow`), public-read-model, public-work-reseed, escrow-epochs, room-backup (required), patrol, project-map, **store-growth** (hourly, `slow`) |
| Integrity job | `server/jobs.mjs` `integrity` job | Summary keys include `errors`, `blockedRooms`, `quarantinedEvents`, `deferredSkips`, `blockReason`, `blockComponent`; failure detail is sanitised tokens only (`code`, `subcheck`, `errorClass`, `recordClass`, `reason`, `component`); the failing room's id is stored for operator surfaces but **deliberately withheld from the public view** (`integrity-block-health`) |
| Store-growth job | `server/jobs.mjs` `store-growth` job, `measureStoreGrowth()`, `STORE_GROWTH_LIMITS` | Summary: `rooms`, `events`, `maxProjectionBytes` (largest single room projection), `dbBytes`. Limits: projection escalates at **3,500,000 B** against the **4 MiB (4,194,304 B)** per-room cap; DB at 8 GB against the 10 GB DO limit. A breach first attempts guarded archive relief, then fails the tick (`store_growth_limit`) |
| Displays / consumers | `server/owner-overview.mjs` `jobHealthRows()` + `collectJobExceptions()` (feeds `GET /api/owner/overview`; drill = `GET /api/health/jobs`; alert at ≥3 consecutive failures, integrity failing = critical) · `server/operator-status.mjs` / `GET /api/operator/status` (operator-token gated; says only `jobs: "see /api/health/jobs"` but carries `integrityFailures`, `messagesBackfillBlocks`, `patrolBlocks`, largest tables **by row count**) · `cloudflare/external-probe.mjs` jobs check (5-min external watcher; failing and stale are distinct alarms) · fleet tools `~/workspace/fleet-tools/trigger-gauges.mjs` and `door-monitor.mjs` (parse the JSON body, judge by shape, not the 503 envelope) | See §2 for where each one is misled today |

**Already-bound work this pack must not duplicate** (bindings:
`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`):

- **#4930 @ `7163d55d`** and **#4931 @ `909446af`** — the integrity cures. Bound,
  REBIND-WITH-NAMED-RED (red = main's 3 manifest-drift tests; discharge on #4960 landing).
  #4930's binding note carries an owed §7 discharge read: *post-land integrity errors stay 3*.
  This pack does **not** re-cure integrity; it makes the still-failing state readable.
- **SPILL chain #4900 @ `e455e83c` → #4543 @ `e5ce7c32` (BUY-TIME 4→5 MiB, LAND ONLY ON
  TRIGGER: a room ≥3.8 MB before SPILL-1's first live run) → #4265 @ `156eb4b0`** — bound.
  This pack supplies the trustworthy gauge read those triggers are judged from; it does not
  land, arm, or re-price any of them.
- **PR #5127 @ `7092a7a8`** (consult-build TEL lane, `~/workspace/wave-2026-10-27-consult-build/SYNTHESIS.md` §TEL) — draft, **not in the bindings file**: adds a 15th job,
  `request-telemetry`, whose `lastSummary` feeds four PERF-50 trigger gauges. If it lands
  first, this pack's view must show the new job automatically (registry enumeration) — §4
  step 8 covers the fixture-enumeration sweep its critic already caught once.

No fork: this piece touches neither of John's two pending decisions (verified-delivery
vocabulary; sponsor human surface).

## 2. Current state

**Fresh executed evidence — this lane, read-only GETs, 2026-10-28 18:19–18:21 UTC**
(`curl -sS https://room.trydemigod.com/api/health/jobs`, repeated on
`https://www.getdasha.com/room/api/health/jobs`; both doors byte-equivalent in every field
cited; production `sourceRevision` `ca37fee4`):

- HTTP **503**, top-level `status: "stale"`, `generatedAt` current, 14 jobs.
- **integrity: `status: "failing"`, `consecutiveFailures: 364`, `lastSuccessAt:
  2026-10-11T19:30:55.702Z`, `secondsSinceSuccess: 1,464,519` (≈17 days).**
  `lastError: "scanError: integrity messages_parity failed (messages_parity_failed)"`,
  `lastErrorCurrent: true`, code `messages_parity_failed`, subcheck `messages_parity`,
  class `integrity_mismatch`, recordClass `message`.
  `lastSummary: { errors: 3, blockedRooms: 0, quarantinedEvents: 1, deferredSkips: 2,
  blockReason: "reducer_rejected", blockComponent: "board", matched: 0, verified: 0 }`.
  (The 360+ failures / errors 3 / blockedRooms 0 in the charter are confirmed and still
  moving: +1 failure per hourly tick.)
- **store-growth: `status: "ok"`, `lastSummary: { rooms: 600, events: 36,919,
  maxProjectionBytes: 1,458,013, dbBytes: 0 }`, `lastSummaryAt: 2026-10-28T18:04:04Z`.**

What is broken, degraded, or missing:

1. **The rollup lies by omission and by precedence.** Top-level `status: "stale"` names no
   driver. The jobs actually driving it are claim-prs (`stale`, 48 consecutive failures),
   webhook-dispatch (`stale`), and patrol (`stale`), while the worst job on the page —
   integrity, failing for 17 days — is invisible in the rollup because `jobHealthView()`
   ranks `stale` above `failing`. A reader of the headline concludes "something is late";
   the truth is "integrity has failed 364 consecutive times."
2. **Per-job status masks failure the same way.** claim-prs has `consecutiveFailures: 48`
   and a current error (`unsupported public claim writer: SQLITE_CONSTRAINT_TRIGGER`,
   `lastErrorAt` = its last run) but reads `status: "stale"`, not `"failing"`, because the
   per-job status chain checks `stale` before `failing`. (Its stale `lastSummaryAt` —
   2026-10-27, the last *success* summary — compounds this: the summary shown is not from
   the failing ticks.)
3. **Stale grading is structurally false for hourly-dispatched jobs.** webhook-dispatch and
   patrol both *succeeded* at 18:00 UTC in the same hourly tick cluster as every other job
   (all live `lastRunAt` values cluster at ~18:00), yet both read `stale` 19 minutes later:
   registry `periodSeconds: 60` × 3 = 180 s stale window against an actual Durable Object
   alarm dispatch that runs them roughly hourly. In steady state these jobs are "stale" for
   most of every hour, the endpoint 503s most of the time, and a real stall is
   indistinguishable from the false one. UT wave 2 found the same shape earlier
   (`~/workspace/wave-2026-10-27-user-testing-2/SYNTHESIS.md`: `/api/health/jobs` 503
   `status:"stale"` 6/6, the stale-required job unnamed — S3, escalating if a required job
   had not run since ~Oct 2).
4. **`dbBytes: 0` is a placeholder printed as a measurement.** `measureStoreGrowth()`
   returns 0 when the `PRAGMA page_count/page_size` reads are unavailable, which is always
   on the production DO runtime. The fleet already knows this
   (`~/workspace/fleet-tools/README-trigger-gauges.md`: "placeholder 0 in production today →
   UNMEASURED"; the tool refuses to present it as storage), but the endpoint itself — the
   thing an operator or a new tool reads first — presents a bare `0` next to `rooms: 600`.
5. **The SPILL gauge has a level but no rate, no distance, and no date.** The payload
   carries `maxProjectionBytes` only inside store-growth's `lastSummary`. Nothing computes
   growth rate or days-to-threshold, and no surface holds the history to compute it from
   (trigger-gauges keeps `maxProjectionBytes` as *auxiliary only*, one append-only snapshot
   per manual run). The operator arithmetic the fleet currently does by hand, from executed
   reads: **1,244,333 B at 2026-10-28T01:17:55Z** (trigger-gauges state file,
   `~/workspace/fleet-tools/state/trigger-gauges.jsonl`) → **1,458,013 B at
   2026-10-28T18:04:04Z** (live read above) = **+213,680 B in 16.77 h ≈ 306 KB/day**,
   consistent with the recorded 2026-10-28 morning gauge (1,433,781 B, +302,963 B
   day-over-day; MEMORY.md storage line). At ≈306 KB/day from 1,458,013 B: **3,500,000 B
   store-growth escalation ≈ 6.7 days (≈4 Nov), 3,800,000 B BUY-TIME trigger for #4543
   ≈ 7.7 days (≈5 Nov), 4 MiB cap ≈ 9.0 days (≈6 Nov)** — and none of those three dates
   appears on any surface. A trigger judged from a level alone, sampled by hand, is how a
   9-day fuse gets discovered on day 8.
6. **No surface names the largest room, even behind the operator token.**
   `operatorStatus()` reports largest *tables by row count*, `integrityFailures`,
   `messagesBackfillBlocks`, and `patrolBlocks` — but no rooms-by-projection-bytes list.
   The public view correctly withholds room ids; the result is that *nobody* can answer
   "which room is approaching the cap, and is it the one relief would archive?" from a
   product surface.
7. **Worker/Node divergence on the same URL.** The Node scheduler's `jobHealth()`
   (`server/jobs.mjs`) omits `lastSummary` entirely — the field that carries `errors`,
   `blockedRooms`, and `maxProjectionBytes` — and omits the first-failure age. Same path,
   two runtimes, materially different truth. (The Node view's lack of a rollup *status* is
   documented and intentional; the missing summaries are not.)
8. **Legacy-record artefacts read as data.** Disabled jobs with pre-#3855 heartbeat records
   (gmail-sync, channel-drain, land-queue, public-read-model) show a `lastSummary` with
   `lastSummaryAt: null`, and `secondsSinceSuccess: null` despite a present
   `lastSuccessAt`. An operator cannot tell record age from job age.
9. **No `firstFailureAt`.** `applyOutcomes()` and the Node `record()` track
   `consecutiveFailures` and `lastErrorAt` but not when the current failure streak began;
   outage age must be inferred from `lastSuccessAt`, which is wrong for jobs that fail,
   succeed once, and fail again.

## 3. What fantastic means

One operator view — the JSON at `/api/health/jobs` plus the owner-overview/operator-status
read models that render it — from which an operator answers, **in under 10 seconds, with no
hand arithmetic and no second tool**:

1. **"What is wrong, in one line?"** A headline that names its drivers:
   `failing: integrity (364×, since 2026-10-11) · stale: claim-prs, patrol` — worst first,
   failing before stale, every non-ok job named. Zero unnamed rollups.
2. **"How bad is integrity?"** One block: last success as an *age* ("17d ago,
   2026-10-11T19:30:55Z"), consecutive failures, streak start, subcheck + code
   (`messages_parity` / `messages_parity_failed`), `errors: 3`, `blockedRooms: 0`,
   `quarantinedEvents: 1`, and a drill to the token-gated `/api/operator/status`
   `integrityFailures` rows that name the record.
3. **"When do we hit the storage wall?"** One gauge block: largest room projection
   **1,458,013 B**, measured-at timestamp, growth rate **≈306 KB/day over a stated window
   with a stated sample count**, and **days-to + projected date for each of 3,500,000 B
   (escalation), 3,800,000 B (BUY-TIME trigger, #4543), and 4,194,304 B (cap)**. When
   history is too thin, the rate reads `null` with the reason — never an invented number.
   Total storage reads **UNMEASURED**, never `0`. Behind the operator token, the block
   names the top rooms by projection bytes.
4. **"Can I trust any of this?"** Every number carries its timestamp; stale means *missed
   its real schedule* (zero false-stale jobs in a 24 h steady-state window); a job that is
   both failing and stale reads `failing`; disabled jobs say why and are visually inert;
   Worker and Node doors return the same summaries; the external probe and trigger-gauges
   parse the new payload unchanged.

Numbers that prove it: rollup names 100% of non-ok jobs; false-stale rate 0 over a 24 h
fixture replay of the live tick pattern; gauge rate present whenever ≥2 samples span ≥6 h;
payload stays one GET, `Cache-Control: no-store`, and the added top-level blocks add
≤2 KB to the response; the view renders from data already in the heartbeat record plus one
bounded history key — no new per-request store scans (the store-growth measurement query
already runs hourly inside the job, not per request).

Exemplars worth matching: **healthchecks.io** period/grace semantics (a job is late only
against the schedule it actually runs on, and the lateness is displayed as such);
**GitHub Actions** job lists (the failing step is named in the summary line, not only
discoverable by expansion); the fleet's own **trigger-gauges** honesty convention
(`UNMEASURED` with the missing instrumentation named, placeholder zero never presented as
a measurement) applied to the product surface itself.

## 4. The instruction

Target tree: **main `aaa749065a`** (rebase onto current main at start; the bound queue
moves fast). Vanilla JS / existing modules only; extend, don't create, modules wherever
possible. Work in this order; each step lands as its own commit on one branch.

0. **Preconditions and non-interference.** Do not wait for #4930/#4931, the SPILL chain, or
   #5127, and do not touch their surfaces: no integrity-verification logic
   (`server/store.mjs` verify paths), no claim-prs writer fix, no `STORE_GROWTH_LIMITS`
   change, no cap change. This pack changes *grading, naming, and presentation* of health
   data only. If #5127 lands mid-lane, re-run step 8 before filing.
1. **Reproduce the live shape as fixtures first.** In `tests/job-heartbeat.test.js` add the
   2026-10-28 live pattern as a fixture: a 60 s-period job whose ticks cluster hourly with
   a success 19 min ago; a job with `consecutiveFailures: 48` and `lastSuccessAt` 24 h ago;
   integrity with 364 failures, errors 3, blockedRooms 0. Each fixture must fail against
   the current `jobHealthView()` grading in the way §2 describes (false stale, masked
   failure, unnamed rollup) before you change grading.
2. **Fix stale semantics (`cloudflare/job-heartbeat.mjs`).** A job may be graded stale only
   when it was *due and did not succeed*: use the registry's existing due logic
   (`jobNextDue()` in `server/jobs.mjs`, already consulted for the `waiting` flag when a
   store is passed) so the effective window is the job's real next-due time, not
   `3 × periodSeconds` alone. Where next-due cannot be computed (no store), fall back to
   an effective period of at least the observed dispatch cadence for alarm-dispatched jobs
   — determine that cadence from `cloudflare/room.mjs`'s alarm/cron wiring and name the
   constant you derive; do not hard-code "hourly" unexplained. Keep `staleAfterSeconds`
   in the output but report the *effective* value used. Acceptance shape: the step-1
   fixture's hourly-clustered job reads `ok` at +19 min and `stale` only after its next
   due time + grace passes with no success.
3. **Name the drivers; fix precedence (same file).** (a) Per-job `status`: `failing`
   outranks `stale` (a job with `consecutiveFailures > 0` and a current error is
   `failing`; keep the separate boolean `stale` truthful alongside it). (b) Top-level:
   precedence becomes `failing` > `stale` > `degraded` > `ok` (required-disabled still
   fails the rollup per #3894). (c) Add an additive top-level `drivers` array:
   `[{ name, status, consecutiveFailures, lastSuccessAt }]` for every non-ok, non-disabled
   job, worst-first (failing by failures desc, then stale). Additive only: keep `schema:
   "room.job-health/1"`, keep every existing field. (d) Check the consumers of the old
   precedence before changing it: `cloudflare/external-probe.mjs` (accepts `stale`/
   `failing` rollups — still valid), `~/workspace/fleet-tools/trigger-gauges.mjs` and
   `door-monitor.mjs` (judge by body shape — still valid); state the check result in the PR.
4. **Add `firstFailureAt` (both runtimes).** In `applyOutcomes()`
   (`cloudflare/job-heartbeat.mjs`) and the Node scheduler's `record()`
   (`server/jobs.mjs`): set `firstFailureAt` when `consecutiveFailures` transitions 0→1,
   preserve it across subsequent failures and across unobserved ticks, clear it on an
   observed success. Project it in `jobHealthView()` and in the Node `jobHealth()` rows.
5. **Node parity for summaries (`server/jobs.mjs`, `server/legal-routes.mjs`).** The Node
   scheduler must retain each job's last summary with the same numbers/booleans-only rule
   as the Worker's `compactSummary()` (port that rule, do not invent a second one) and
   `jobHealth()` must project `lastSummary` + existing `lastSummaryAt`. The Node route
   keeps its documented no-rollup behaviour. Result: `integrity.lastSummary.errors /
   blockedRooms` and `store-growth.lastSummary.maxProjectionBytes` are present on both
   runtimes.
6. **Storage gauge block with an honest rate (the SPILL feed).**
   (a) History: in `cloudflare/room.mjs` `recordCronTick()`, when an outcome for
   `store-growth` carries a summary, append `{ at, maxProjectionBytes, rooms, events }`
   to a new Durable Object storage key `cron:store-growth-history:v1`, pruned to the last
   72 samples, inside the existing serialised persist (no new write path, no new race).
   Node runtime: keep the equivalent samples in the scheduler record (process-local is
   acceptable there; label the gauge `window` accordingly).
   (b) View: add a top-level `storage` block to the Worker view (and to the Node response
   in `server/legal-routes.mjs` when a store-growth summary exists):
   `{ maxProjectionBytes, measuredAt, rooms, events, dbBytes, dbBytesMeasured,
   thresholds: { escalationBytes: 3500000, buyTimeBytes: 3800000, capBytes: 4194304 },
   rate: { bytesPerDay, windowHours, samples, daysToEscalation, daysToBuyTime,
   daysToCap, projectedCapAt } | null, rateNote }`.
   `dbBytesMeasured` is `false` when `dbBytes === 0 && rooms > 0` (the trigger-gauges
   placeholder rule) and the block then carries `dbBytes: null`. Rate = (last − first)
   over the retained window when ≥2 samples span ≥6 h, else `rate: null` and
   `rateNote: "insufficient_history"`. Days-to values are `(threshold − current) /
   bytesPerDay`, `null` when rate is null or ≤0; `projectedCapAt` is the ISO date at the
   cap. Source the threshold constants from `STORE_GROWTH_LIMITS` /
   the #4543 trigger / the 4 MiB cap — do not retype literals in the view layer.
   (c) The largest-room *identity* stays off the public view (settled privacy rule, §1).
7. **Operator-gated largest rooms (`server/operator-status.mjs`).** Add `largestRooms` to
   `operatorStatus()`: top 5 rooms `[{ roomId, projectionBytes, events }]` ordered by
   `LENGTH(projection)` DESC, using the existing deadline-guard pattern of
   `collectLargestTables()` (1,500 ms budget, partial results reported, never fail the
   whole status). This is the surface an operator uses to confirm the gauge's room is the
   room relief/SPILL would act on.
8. **Display pass-through (`server/owner-overview.mjs`).** Extend `jobHealthRows()` rows
   with `status`, `firstFailureAt`, `lastErrorCode`, `lastErrorSubcheck`, and a whitelisted
   summary subset (`errors`, `blockedRooms`, `maxProjectionBytes` — numbers only), and add
   the `storage` block to the overview's deployment section when present.
   `collectJobExceptions()` keeps its thresholds (≥3 = critical, integrity any-failure =
   critical) but its `detail` must include the subcheck/code when present
   (`…failed 364 times in a row (messages_parity_failed)`). No client rewrite: the
   overview's existing client renders the JSON fields it already consumes; if a field
   needs a label, follow the existing label pattern in that surface. **Job-set sweep:** if
   the registry job count differs from what any test/fixture enumerates (the class
   #5127's critic caught — grep `tests/` and `cloudflare/*.check.mjs` for literal job-name
   lists), update every enumeration site in the same diff.
9. **Docs.** Update `docs/openapi.yaml` `/api/health/jobs` (new `drivers`, `storage`,
   `firstFailureAt` fields; the precedence change; Node summary parity) as a bare-path
   operation edit, and `ROOM-HEALTH.md` with the operator reading order: headline/drivers
   → integrity block → storage gauge → per-job table. No new error codes anywhere in this
   pack — presentation and additive fields only.

**Explicit non-goals.** No fix to the integrity root cause (bound: #4930/#4931 + the owed
operator read), the claim-prs `SQLITE_CONSTRAINT_TRIGGER` failure, or the messages-parity
mismatch. No SPILL landing, arming, or trigger change. No new job, no new route, no new
HTML page, no React. No room ids, record bodies, or error text beyond the existing
sanitised token fields on the public view. No change to the external probe's alert
thresholds. No deploy: landings and deploys ride the normal seat discipline.

## 5. Acceptance

The coordinator/Jill runs these at the PR head; all must pass or be named.

**Executed probes (post-merge, post-deploy, both doors):**

```sh
curl -sS https://room.trydemigod.com/api/health/jobs | jq '{status, drivers, storage}'
curl -sS https://www.getdasha.com/room/api/health/jobs | jq '{status, drivers, storage}'
curl -sS https://room.trydemigod.com/api/version   # build pair recorded with the read
```

- Both doors agree on `drivers`, integrity's row, and `storage.maxProjectionBytes` within
  one tick; the read is recorded with its `sourceRevision` (two agreeing reads rule).
- `drivers` names **every** non-ok, non-disabled job, worst-first; while integrity is
  still failing, top-level `status` is `"failing"` and `drivers[0].name` is `"integrity"`
  with its live `consecutiveFailures` and `firstFailureAt` ≈ its post-#4930-discharge
  streak start (or `lastSuccessAt` + one period for the current streak).
- `storage.maxProjectionBytes` equals store-growth's `lastSummary.maxProjectionBytes` in
  the same payload; `dbBytes` is `null` with `dbBytesMeasured: false` while the production
  runtime reports the placeholder zero; once ≥2 samples span ≥6 h, `rate.bytesPerDay` is
  present and hand-verified against two raw samples from
  `cron:store-growth-history:v1` / trigger-gauges state (show the arithmetic in the PR).
- claim-prs (or any fixture job that is failing + stale) reads `status: "failing"` with
  `stale: true` still present as a boolean.

**Test suites by name** (`TMPDIR` pointed at the lane scratch; `npm run verify:affected`
plus these by name, because affected-selection has missed enumeration suites before):

`tests/job-heartbeat.test.js` · `tests/job-health-required.test.js` ·
`tests/node-jobs-health.test.js` · `tests/jobs-parity.test.js` ·
`tests/store-growth.test.js` · `tests/store-relief.test.js` ·
`tests/integrity-block-health.test.js` (public view still carries **no** room id) ·
`tests/owner-cockpit-jobs.test.js` · `tests/owner-overview.test.js` ·
`tests/external-probe.test.js` · `tests/r36-job-health-last-error-current.test.js` ·
`tests/r35-operator-status-backfill-blocks.test.js` ·
`cloudflare/jobs-alarm.check.mjs` · `cloudflare/health-probe.check.mjs`, and
`node --test ~/workspace/fleet-tools/trigger-gauges.test.mjs` plus one live
`node ~/workspace/fleet-tools/trigger-gauges.mjs --dry-run --json` against the deployed
payload (must parse; gauges unchanged or better).

**Fixture verdicts required:** hourly-clustered 60 s job not stale at +19 min, stale after
missed due+grace; failing+stale job graded `failing`; rollup drivers complete and ordered;
rate `null` + `insufficient_history` below 2 samples / 6 h; `dbBytes` placeholder rule;
`firstFailureAt` set/preserved/cleared across success and unobserved ticks.

**Registration sweep** (per `~/AGENTS.md` "Pre-flight registration sweep"):

- Runtime-package closure — **n/a if** no new `server/**` module is created (this pack
  extends existing modules); if one is created, REQUIRED: allowlist +
  candidate-runtime-fixture + closure test.
- Error-code catalogue, both copies — **n/a**: no new error code is introduced (any new
  code stops the lane until both copies + `skills-sync` are done).
- Route triple — **no new route**, so table/OpenAPI-parity rows are n/a, **except**:
  `docs/openapi.yaml` `/api/health/jobs` operation update is REQUIRED (response shape
  changed) and `node scripts/route-docs-check.mjs` must pass.
- Harness copy sets — **REQUIRED check**: `cloudflare/job-heartbeat.mjs` and
  `server/jobs.mjs` are copied/transformed by the Cloudflare test harnesses
  (`cloudflare/jobs-alarm.check.mjs`, `cron-isolation.check.mjs` fixtures); run both
  checks by name.
- Store registries — **n/a for SQL tables** (no new table); the new DO key
  `cron:store-growth-history:v1` is REQUIRED to be versioned, pruned (≤72 samples), and
  written only inside `recordCronTick()`'s serialised persist — state this in the PR.
- Generated/mirrored artifacts — **n/a**: no EVENT_TYPES, MCP catalog, or error-catalog
  growth. Job-set enumeration fixtures are the live risk instead: grep evidence (step 8)
  REQUIRED in the PR body.
- Close-out — `npm run verify:affected` **and** `CI=1 npm run check` (diff touches
  `server/**`); any suite that cannot run locally is NAMED in the PR body. Diff >300 lines
  requires the `## Large diff justification:` section.

**Separate, not this pack's acceptance:** the #4930 binding's owed discharge read
(post-land integrity errors stay 3) is executed at #4930's landing; this pack's view is
how that read is taken, not a substitute for it.

## 6. Routing

- **Implementer: Codex** — this is server/core work (`server/jobs.mjs`,
  `cloudflare/job-heartbeat.mjs`, `cloudflare/room.mjs`, `server/operator-status.mjs`,
  `server/owner-overview.mjs`): grading semantics, heartbeat storage, and the registry are
  his surface, and he holds the landing path from John's Mac. Handover channel:
  `room_request_reply` in Project Room to the Codex member, with a concrete ask, a
  `workItemId`, and the expected result = a PR at an exact head passing §5's suites.
- **Landing: Grok Bot's seat, singly.** Health/heartbeat is shared-core: no batching,
  green at exact head, Ruling 41 does not apply below that line for this surface.
- **Verification: Jill's fleet** — settle/price the PR, run §5's probes at the bound head,
  and own the post-deploy two-door read; fix lanes never merge.
- **Post-deploy verification: John's Tab** — the two-door `curl | jq` acceptance read and
  the trigger-gauges dry-run against production, reported back into the room.
- **Fo** — only if the owner-overview client rendering changes shape (browser-shard
  evidence); **Claude** — not routed: no client-surface or design-token work in this pack.
