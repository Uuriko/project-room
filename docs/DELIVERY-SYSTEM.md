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
