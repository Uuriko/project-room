# Delivery control: implementation plan

Updated 2026-10-28 (America/Los_Angeles). This is the implementation plan for
Project Room owning its development and maintenance workflow. It complements
[the product architecture plan](ARCHITECTURE-EXECUTION-PLAN.md); it does not
replace that backlog or make its unfinished work complete.

## Outcome and current evidence

A person or agent can ask what is ready, what is running, what failed, and what
to do next without reconstructing chat history. A disconnected laptop resumes
useful work without duplicating a deployment. Each production change has an
inspectable chain from intent to tested source, artifact, deployment and outcome.

At this checkpoint, production is f237176479f413756fbcc0898648da6c28f20571.
Its first deployment smoke failed readiness; later verification passed, followed
by another independent readiness failure. A successful sample does not close
incident #5177. Main contains additional UI and infrastructure changes that are
not deployed. PR #5199 implements verification without a second upload and has
passed local tests and a real public verification against f237176. These are
dated observations, not permanently current status.

The other laptop identified an existing-tag publication path that can promote
a release without checking its target and package. The peer confirmed ownership
of that repair and the runner inventory in Room message
`workflow-split-confirm-1029` (sequence 22321). This Mac owns the record composer.
The first joint deliverable is an exact-target verification record plus a
publisher that rejects mismatched existing tags and packages.

## Reuse and ownership

| Existing component | Responsibility retained | Extension |
| --- | --- | --- |
| `scripts/landing-facts.mjs` | Current landing observations | Feed source/PR facts into release records |
| `scripts/release-merge-gate.mjs` | Existing merge execution and checks | Adapter for composed candidates; do not create another gate |
| `scripts/release-evidence.mjs` | Test results and evidence classification | Digest and reference original evidence, retaining skips/failures |
| `scripts/release-checkpoint.mjs` | Source observations and #5199 verification | Produce bounded verification attempts |
| `scripts/runtime-package.mjs` | Runtime packaging | Stable artifact identity and verified publication |
| `scripts/deploy-recovery.mjs` | Recovery decisions | Preserve schema compatibility and failed attempts |
| Existing Room work/attempts/claims | Assignment and collaboration | Link release IDs and worker receipts rather than duplicate work state |
| Existing host/dispatch clients | Execution transport | Reuse after peer inventory; qualify disconnection and cancellation |

This Mac owns the plan, initial record composer and integration. The peer laptop
owns publication integrity, inventory of laptop execution primitives,
and independently review the record contract. Grok keeps current UI landing
ownership. Shared production deployment remains serialized, while tests and
read-only observations run independently. Each handoff names commit, tree,
changed paths, tests, failures and next action; chat is notification, not the
only place the evidence exists.

## 1. Finish the current delivery without coupling it to this overhaul

1. Reconcile current PR heads and merged trees, including the peer's frozen
   conversation candidate #5188. Preserve its actual browser evidence.
2. Integrate #5199 and publication integrity independently of UI work. Reuse
   focused evidence where code is unchanged; test actual composition boundaries.
3. Deploy the selected qualified product revision once. Check both serving
   origins and Worker/application version endpoints, readiness and signed cards.
4. Run authenticated agent and essential human journeys separately from public
   smoke. Record scope honestly; public health is not sign-in verification.
5. Publish only the matching artifact. Keep #5177 and the stream-recovery flake
   open until reproductions and fixes support closure.

Exit: a named production revision with distinct deployment, verification and
publication evidence, plus explicit remaining incidents. No platform feature is
a prerequisite merely because it appears in this plan.

## 2. First build: compose a release record from existing evidence

Start with a local, read-only CLI and versioned JSON, not a new service. Accept
explicit input files and full source identity; emit a record and concise summary.
Do not crawl arbitrary private directories or infer missing facts from filenames.

The first record contains:

- Repository, target commit and tree, candidate base and PR references when known.
- Evidence references with content digest, kind, producer/tool revision, recorded
  time and source identity. Preserve original files instead of rewriting results.
- Independent observations for merge, deployment, verification and publication.
  Each may be unknown, failed or observed; one cannot imply another.
- Verification attempt history, including original failed smoke, later checks,
  origin set, before/after source observations and warnings.
- Artifact digest and package manifest identity when supplied; publication URL
  alone does not prove package integrity.
- Explicit limitations and next actions. Unsupported evidence stays unknown.

Validate structure, identity and digest at ingestion. Refuse a receipt for a
different target. Hashes establish byte identity, not a trusted producer or
authority. Never treat a caller-created JSON field as permission to deploy.
Bound file sizes; do not embed logs, environment variables, credentials or room
content. Record evidence references relative to an export bundle when portable.

The first CLI is observational: no push, merge, upload, rollback or automatic
promotion. This allows us to exercise the contract on the real f237 failure and
retry immediately. Do not call a historic verification result current health.

Acceptance: mixed target rejection; missing/corrupt files; altered digests;
failed then successful attempts retained; publication unknown despite good
health; failed later attempt visible; stable output under reordered inputs;
real imported f237 evidence with no fabricated merge/publication facts.

## 3. Durable release controller and provider adapters

After the observational contract works, add a small persistent execution journal
using the existing work/attempt model. Model operations, not a single green flag:
prepare candidate, validate, package, deploy, verify, publish, observe, recover.
Every mutating operation has an idempotency key and input identity. On a lost
response, inspect the provider before retrying. A completed upload is not repeated
because publication or verification failed later.

Adapters expose inspect, execute and reconcile for GitHub and Cloudflare. Core
policy operates on typed facts; provider status names remain adapter details.
Acquire an existing deployment claim only around operations that need exclusive
control; use fencing/CAS so an expired owner cannot mutate newer work. Keep
secrets on the authorized executor, outside records and worker result bundles.

Publication checks tag target, downloaded package digest and package contents
before promoting an existing release. An immutable mismatch is an error, not an
invitation to overwrite an asset silently. Recheck live source before claiming a
runtime is the current production release. Rollback eligibility includes schema
compatibility; a forward fix may be the correct recovery.

Acceptance: kill after upload but before receipt; network loss after publication;
duplicate command delivery; stale lease; partial origin propagation; mismatched
existing tag/asset; recovery after incompatible schema. Each must converge to a
truthful state without duplicate effects.

## 4. Integration queue and evidence reuse

Extend the existing merge tooling. Snapshot base and candidate heads, compose
them in an isolated worktree and resolve generated metadata after source changes.
Produce one candidate tree identity and a test plan based on actual changed
dependencies. Preserve human review comments and real repository protections.

Evidence reuse key includes source tree or proven affected input closure, test
definition, dependency lock, runtime/toolchain and relevant environment. A green
PR head alone is insufficient for a different merged tree. Provider observations
such as production health are time-bound and cannot be reused like unit tests.

Use a small queue first. Validate independent candidates in parallel; serialize
main updates with a fresh base comparison. If the base advances, reuse only
evidence whose inputs remain identical. On batch failure, isolate the responsible
change with bounded subdivision and retain original failures. Avoid endlessly
retrying a flaky check until green; attach its reproduction and uncertainty.

Acceptance: concurrent base advance, incompatible candidates, manifest conflict,
unchanged-tree evidence reuse, changed test invalidation and worker disappearance.
Measure queue wait and repeated test time before claiming an improvement.

## 5. Laptop execution pool

First inventory the existing host clients, dispatch, portable jobs and receipts
on both laptops. Select one transport and job model already capable of executing
bounded tasks. Do not build a second generic scheduler or depend on Tailscale.

A job specifies exact source, command profile, toolchain, resource needs, timeout,
input digests and allowed outputs. A worker advertises capabilities, claims a
lease and reports heartbeats, progress, result digests and cancellation. Schedule
unit/browser/build work on suitable hosts; platform-specific checks stay labeled.
Untrusted branch tests run without deployment credentials and with isolation
appropriate to their access. A test worker cannot become a production executor
merely by returning a successful receipt.

Trial with two laptops and one test family. Disconnect/sleep a worker, expire its
lease, reschedule and reject its stale completion. Transfer source/artifacts by
verified content identity; cache dependencies by lockfile/toolchain, not by a
mutable branch name. Cap concurrency to protect interactive use and production.

Exit: a real two-laptop run with timing, duplicate-work count and recovery proof.
Remote success alone does not establish that distributed execution was faster.

## 6. Production feedback and maintenance

Connect existing health, readiness, error and deployment observations to release
IDs and incidents. Keep distinct cold-start, warm-request, authenticated journey
and browser evidence. Track latency distributions and sample counts, not only
the fastest successful sample. Respect Workers clock semantics in CPU analysis.

Deduplicate recurring failures by signature and affected source; route actionable
changes to existing work items. A closure links reproduction, regression test,
fix, deployment and a suitable observation window. Unknown causality remains
unknown. Low-confidence signals create investigation work, not automatic rollback.

Include backup/restore drills, schema recovery, dependency updates, credential
rotation references, artifact retention and deletion policies. Export the release
journal and artifacts so a provider outage does not erase operational knowledge.
Exercise restore on another machine; having a backup file is not restore proof.

## 7. Agent and human product surfaces

Expose release inspect, next action, evidence lookup, attempt watch and authorized
resume through existing discoverable agent actions. Return bounded structured
data, source/time provenance, stable IDs and continuation cursors. Events should
wake agents on a meaningful state change rather than require constant polling.
Make unsupported actions and missing access explicit. Test a cold agent using
discovery alone, with no pasted operator instructions.

Use the same record for a compact human release view: current production,
candidate, progress, failures and next action; details expand on demand. Keep
infrastructure controls out of ordinary consumer onboarding. Link releases to
work/results where useful rather than creating another dominant navigation area.
Test mobile, keyboard, screen reader and disconnected states before broad UI work.

Living docs explain decisions and link evidence. They do not manually mirror
every status already available from the record. Keep one current plan, append
checkpoints, link obsolete plans as historical, and measure maintenance overhead.

## Sequence, measures and stopping criteria

First parallel pair: record composer on this Mac; publication integrity on peer.
Then integrate existing verification and records into the release workflow. Next
prove a two-laptop test job; only then automate queue scheduling and add the UI.
Feedback/incident links can proceed alongside the worker trial using existing
telemetry. Deployment of the current product remains a separate delivery lane.

For each slice record implementation, test scope, merged state, deployment state,
owner and next action. Baseline and compare: human handoff count, time spent
reconstructing status, repeated test minutes, queue delay, deployment duration,
failed-change recovery time, duplicate effects and stale-status incidents.
Use representative repeated runs; retain slower results and setup cost. Remove
or simplify a mechanism if it adds more coordination than useful automation.

Done for the initial milestone: one real release can be inspected, independently
verified and resumed without rereading chat history or reuploading unchanged
code; both laptops contribute with inspectable receipts; current production and
remaining incidents are unambiguous. Later phases remain planned until tested.
