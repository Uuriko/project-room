# Delivery system implementation

John authorized the complete delivery system on 2026-10-25. The milestones below
sequence implementation and activation; none reduces the committed scope.
Implementation branch: `codex/delivery-system-1025`.

## Completion checklist

- [ ] Durable repository coordinator: versioned SQLite schema, atomic ownership,
  fencing, revision guards, durable attempts, inbox/outbox, restart recovery.
- [ ] Platform integration: Node storage and a repository-keyed Workers coordinator;
  account/pool admission authority shared across repositories. Room-local stores
  cannot arbitrate the same repository across Rooms.
- [ ] Authorized API: installation/repository binding, Room audience checks, operator
  policy, user and agent operations, request idempotency, bounded response sizes.
- [ ] Scheduler: priority with aging, dependency graph and cycle rejection, fair
  admission, account-wide capacity reservations, cancellation reconciliation.
- [ ] GitHub adapter: signed webhook inbox, delivery deduplication, installation
  tokens, pagination, rate limits, periodic reconciliation, dispatch correlation.
- [ ] Exact integration: immutable head/base/candidate evidence, required check app
  provenance, stale evidence rejection, protected-branch-compatible landing.
- [ ] Throughput: bounded speculation, batch eligibility, failure bisection,
  descendant invalidation, adaptive concurrency and budget limits.
- [ ] Failure handling: infra/test/auth/policy classifications, bounded backoff,
  flaky history without silently waiving required checks, manual recovery.
- [ ] Release: schema gate, deployment ownership, source-to-artifact receipt,
  smoke checks, rollback and recovery evidence, independent live verification.
- [ ] Execution providers: GitHub Actions implementation, provider contract and
  conformance tests, configurable additional pools; no automatic purchases.
- [ ] Delivery workspace: queue, dependencies, capacity, attempts, actionable
  failure reasons, work/PR/release links, pause/resume/cancel and audit views.
- [ ] Operations: notifications on meaningful change, metrics, cost estimates
  distinguished from measured cost, retention, backup and restore runbook.
- [ ] Qualification: authorization and race tests, crash/fault injection, old/new
  schema compatibility, Workers tests, browser checks, benchmark and hosted CI.
- [ ] Rollout: shadow reconciliation, controlled live execution, verified full
  activation; existing queue remains disabled until replacement is qualified.

## Invariants

Repository identity includes provider installation, normalized owner/repository,
and case-sensitive target ref. Workers ownership must route this identity to one
durable authority, irrespective of requesting Room. Account capacity has a separate
shared authority. A process-local Map or separate per-Room SQLite table is insufficient.

Every mutation uses a transaction. Lease generations increase after expiration
or release, and stale holders cannot commit. Provider mutations are journaled
before dispatch. An expired dispatch becomes outcome-unknown and must be reconciled
before any retry; a lease cannot fence an already-sent GitHub request. Provider
receipts and authoritative reads resolve ambiguous outcomes.

Checks bind to the current candidate, base, head, required check names and trusted
app identities. PR head matching alone does not guard base movement. Production
landing must preserve repository protections and never push directly to main.
Until the protected merge operation can enforce the required integration invariant,
live merging fails closed; do not advertise exact candidate landing as solved.

Webhook bodies cannot authorize work. Room membership cannot grant repository
installation privileges. Untrusted PR code never receives coordinator credentials.
Store only necessary provider metadata, never tokens, private message bodies or
unbounded webhook payloads in the delivery audit.

## Implementation and activation order

1. Build storage and pure scheduling logic; inject time/provider failures in tests.
2. Connect durable authority, authenticated API and read-only reconciliation.
3. Build UI against those actual read models; wire operator controls and audit.
4. Add dispatch, candidate validation, merge, release and recovery adapters.
5. Qualify every failure boundary and throughput feature before live activation.
6. Run repository checks and benchmarks, open PR with exact evidence, wait for
   required hosted CI, then coordinate merge/deploy and verify production.

## Compatibility

Delivery tables are additive and independent of the Room event stream. Existing
Room history continues to replay unchanged. Old binaries ignore new tables and
must not run delivery workers. New readers reject future delivery schema versions
before writing. Rollback pauses dispatch, reconciles in-flight effects, then runs
an older binary with delivery disabled. Never drop the journal during rollback.
Backup/restore must include coordinator and capacity state; restored live effects
require provider reconciliation before execution resumes.

## Research basis

- [Rust Bors design](https://github.com/rust-lang/bors/blob/main/docs/design.md):
  candidate testing and landing consistency.
- [Zuul gating](https://zuul-ci.org/docs/zuul/latest/gating.html): speculative
  dependency windows and failure invalidation.
- [Uber CI research](https://www.uber.com/us/en/blog/slashing-ci-costs-at-uber/):
  resource-aware queue admission; their results are not forecasts for this system.
- [DataFusion Comet discussion](https://github.com/apache/datafusion-comet/issues/6386):
  practical concurrency and rebuild-cost tradeoffs.
- [GitHub webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks):
  asynchronous processing and stable delivery identifiers.

## Current status

Implementation started. No replacement endpoint is mounted and no live dispatch,
merge or deployment has been activated. Passing storage tests will establish only
the storage invariants, not completion of the system above.


## First implementation checkpoint

Available locally: `npm run delivery:shadow -- --help`. Supply a private SQLite
path, an observation installation identifier, repository, ref, explicit illustrative
capacity and optional slots per PR. The command uses `GITHUB_TOKEN` or existing
`gh auth token` credentials in memory, performs only GitHub GET requests, and
persists observations in a mode-0600 local database. Do not share that database.
The observation identifier is not verified installation authorization.

The current shadow planner does **not** import existing GitHub runner usage or PR
dependencies. Its admission list is therefore illustrative, not permission to
dispatch. No production API, UI or mutation worker is mounted. The SQLite journal,
capacity accounting, execution/reconciliation boundary and scheduler are available
for the next integration steps. Capacity reservations currently share a bounded
record; indexed per-reservation storage and retention are required before scale
qualification. Node tests do not establish Workers compatibility.

A live read on 2026-10-25 found 263 open PRs targeting main, including 218 with
ready-to-land and no draft flag. These are an observation, not a standing count.
The shadow command successfully persisted that real backlog without mutations.

Validation at this checkpoint: 21 focused tests pass, final affected suite 238 pass,
repository lint passes with existing warnings. Full suite: 11,629 passed, 31 skipped, two failures. One is the unchanged-base
OG PNG hash. The other exposed the separate coordinator database being placed
under Room-owned server modules; moving it into top-level `delivery/` fixes that
ownership mismatch without changing the Room recovery guard. Focused recovery
and delivery checks verify the correction. Local runtime was Node 26.8.2; hosted CI qualifies Node 24.
The candidate manifest also repairs existing deploy-workflow hash drift; the
workflow itself is unchanged.

Benchmark below measures the existing Room workload, not delivery throughput.
The delivery backend is not wired into that workload. Six interleaved runs per
side, Node 26.8.2, Apple M5; all comparisons inconclusive (~).

| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 3.69 [3.60–3.76] | 3.63 [3.61–3.74] | 0.99x | 1.000 | ~ |
| write p95 (ms) | 6.93 [6.85–7.41] | 6.84 [6.72–7.26] | 0.99x | 0.621 | ~ |
| storedProjection (ms) | 0.87 [0.85–0.92] | 0.87 [0.77–0.90] | 1.00x | 1.000 | ~ |
| cold room() (ms) | 0.98 [0.97–1.03] | 0.99 [0.97–1.10] | 1.01x | 1.000 | ~ |
| projection (KB) | 1211 [1211–1211] | 1211 [1211–1211] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 1.55 [1.47–1.75] | 1.56 [1.53–1.59] | 1.00x | 1.000 | ~ |
| GET full room (KB) | 1323 [1323–1323] | 1323 [1323–1323] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 4.64 [3.87–4.79] | 4.61 [4.35–4.66] | 0.99x | 1.000 | ~ |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 2.06 [2.03–2.17] | 2.10 [2.04–2.28] | 1.02x | 1.000 | ~ |
| replay from log (ms) | 72.0 [71.0–72.0] | 71.0 [70.0–71.0] | 0.99x | 0.260 | ~ |

## Protected landing design to qualify

Use a coordinator-owned integration branch and PR for the tested candidate when
batching multiple original PRs; never rewrite contributors' branches. The required
checks must bind to trusted GitHub App identities and the exact integrated tree.
A protected merge path must require the branch to be current with main, with no
coordinator bypass. GitHub's merge endpoint binds the PR head but provides no
base-SHA compare-and-swap argument. Consequently, reading main immediately before
calling merge is insufficient by itself. Qualify strict protection plus the tested
integration PR in a disposable repository before enabling this path here. Preserve
the mapping back to original PRs and do not report them merged based solely on a
batch result. Squash/merge commits may have a different commit SHA; report and
verify tested tree equivalence explicitly instead of claiming SHA identity.

[GitHub's protected branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
describes strict up-to-date checks and trusted status-check sources. That documents
available controls; the end-to-end race and tree-equivalence guarantee remains a
qualification requirement for this implementation.

## Incident research and durable rechecks (2026-10-26 UTC)

The lander's one-pass skip behavior is Grokbot's reported diagnosis; its running
four-minute loop has not been inspected here. This is distinct from CI saturation
and actual code failures. Do not turn the report into a verified root cause for
all queued runs.

Direct GitHub evidence:

- PR #4952's gates job 121314699111 explicitly rejected 3,521 changed lines with
  a missing large-diff justification. Browser job 121317091730 also observed a
  429 response where its test expected 200, and job 121317091751 timed out waiting
  for a dialog to close. These failures do not by themselves establish flakiness.
- PR #4941 advanced to head `3d8063c370a51abf874141f0213937ec794bcdc0`
  during research. Failure records from its previous head must not determine the
  new head's state. The new workflow runs were queued.
- PR #4946 had attempt-2 runs queued. PR #4954's current workflow run
  40243002231 was reported queued, while the concurrency-group API showed it as
  the sole in-progress holder of `test-refs/pull/4954/merge`. Therefore a workflow
  status alone cannot distinguish concurrency waiting from runner capacity.
- PR #4948 has failing browser annotations. Its completed contract job log, fetched
  directly through the job-log API while the overall run remained incomplete,
  confirms unregistered GET bootstrap and messages routes. The gh run log command
  refused the incomplete run, but the completed-job endpoint supplied the evidence.

Sources and consequences:

- [GitHub workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  now documents `queue: max`, allowing up to 100 pending entries in one serial
  concurrency group. It cannot be combined with `cancel-in-progress: true`.
  Use this native capability where appropriate for serialized deploy workflows;
  it does not replace cross-repository capacity or exact integration checks.
- [Concurrency-group API](https://docs.github.com/en/rest/actions/concurrency-groups)
  exposes group members and blocking relationships. Its listing uses cursor
  pagination, so the existing page-number helper must not be reused for it.
- [Failed webhook delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
  says GitHub does not automatically redeliver failures. Keep periodic provider
  reconciliation even after event-driven wakeups are implemented.

Implemented follow-up: `--inspect-pr 4953,4954` registers durable PR observations.
Subsequent shadow-command invocations recheck due entries without repeating that
argument. Waiting, failed, cancelled and observation-error entries remain due
for later checks; closed/merged entries stop. The default next-check interval is
four minutes. This records a due time; it does not install a background service
or automation. A hosted scheduler remains required.

The reader selects workflow path, PR event, exact head, run number and attempt;
a later queued attempt supersedes old cancellation/failure evidence. It reads the
PR again after observing runs and discards evidence if head/base/state moved.
All observations explicitly say `mergeAuthorized: false`: successful workflows
are not proof of trusted job provenance, integration safety or release authority.
Workflow-level state can remain waiting while some jobs have failed; job-level
failure drilldown and actual runner occupancy are still required integrations.


Firsthand reports also qualify the native-queue recommendation:
[discussion #206259](https://github.com/orgs/community/discussions/206259)
describes job-level queue:max stalls on self-hosted runners, while
[discussion #208347](https://github.com/orgs/community/discussions/208347)
traces unexpected cancellation to a separate job-level group still using the
single-pending default. These are reported cases, not proof of our incident's
cause. Inspect both workflow and job concurrency, and qualify queue:max before
changing production. No concurrency setting was changed during this research.

Reconciliation follow-up validation: 25 focused delivery tests and 242 affected
tests pass; lint passes. Live shadow observation covered PRs 4948, 4952, 4941,
4946, 4953 and 4954. Full suite result remains recorded separately in the PR.

Follow-up room benchmark (complete table; existing workload, not delivery
throughput). Both sides ran during concurrent verification; all verdicts remain
inconclusive and are retained rather than rerun for better numbers.

| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 8.32 [6.34–8.85] | 8.18 [6.32–8.79] | 0.98x | 1.000 | ~ |
| write p95 (ms) | 17.1 [12.2–36.1] | 15.2 [11.2–29.2] | 0.89x | 1.000 | ~ |
| storedProjection (ms) | 1.55 [1.23–3.43] | 1.71 [0.99–1.95] | 1.10x | 1.000 | ~ |
| cold room() (ms) | 1.57 [1.42–2.00] | 2.25 [1.54–2.69] | 1.43x | 0.173 | ~ |
| projection (KB) | 1211 [1211–1211] | 1211 [1211–1211] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 3.41 [2.27–6.22] | 2.66 [2.12–3.70] | 0.78x | 1.000 | ~ |
| GET full room (KB) | 1323 [1323–1323] | 1323 [1323–1323] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 7.95 [6.31–9.71] | 8.84 [5.53–11.42] | 1.11x | 1.000 | ~ |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 4.80 [4.47–6.00] | 5.17 [3.07–6.57] | 1.07x | 1.000 | ~ |
| replay from log (ms) | 159 [127–252] | 168 [102–273] | 1.06x | 1.000 | ~ |

## Adoption and enforcement design

Require coordination at shared side effects, not at every local thought or edit.
Isolated research, branches, tests and drafts stay independent. Shared resource
leases, merge admission and production deployment use the delivery authority.
Submitting once should automatically preserve waiting state, observe CI, explain
failures and produce a verifiable receipt. Reduce tool calls and manual follow-up
rather than rewarding chat volume, claim count or PR count.

Enforcement must be external to agent instructions:

1. Issue each agent its own scoped identity. Room membership alone grants no
   repository installation or production credential access.
2. Keep merge/deploy credentials in an isolated delivery service. Agents submit
   exact-revision requests; the service independently reads provider evidence.
   Unrestricted agents on the owner's Mac can read owner credentials, so local
   hooks and prompts alone cannot establish this boundary. Account/environment
   isolation is a prerequisite for adversarial bypass resistance.
3. Require the Room policy check on the protected target and pin its issuing
   GitHub App. Test the eligible actor restrictions supported by this repository.
   If a restriction ruleset exempts the coordinator, keep mandatory CI in a
   separate non-bypassed ruleset: exemption from an actor restriction must not
   waive checks. Qualify exact-head/base behavior before activation.
4. Production credentials and deployment environments enforce equivalent policy.
   Record provider receipts for completed side effects; an agent's self-reported
   completion is insufficient.
5. Provide a human-controlled emergency path with explicit scope, expiry, reason
   and audit. Keep routine agent tokens unable to invoke it. Preserve durable
   queued work through outages rather than pretending an offline action passed.

Current observed settings (2026-10-26): required check room/release-lease has
app_id:null; strict up-to-date mode is false; enforce_admins is true; push
restrictions are null; repository rulesets are empty. This is a configuration
snapshot, not evidence that anyone forged or bypassed a check. No settings or
credentials were changed by this task.

[GitHub protected checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
allow selecting the expected issuing App.
[Repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
provide additional actor/policy controls; validate exact availability and combined
rules on this personal-owned repository before promising exclusive merge actors.

Roll out per project: observe first, make the integrated path useful, qualify
recovery and latency, then enforce merge/deploy boundaries. Existing agents can
use a thin CLI/MCP adapter rather than moving their entire working environment
into Room. External contributions remain possible: import a PR into Room's
policy flow without requiring its author to join a Room or disclose private
reasoning. Measure verified deliveries, collisions, queue delay, wasted CI work
and recovery success. Avoid punitive scores that discourage reporting failures.

Final follow-up full suite: 11,634 passed, 31 skipped, one failed (the same
unchanged-base OG PNG hash mismatch on Node 26.8.2). The prior Room table-registry
failure is absent. No hosted scheduler, live mutation or enforcement switch has
been activated.
