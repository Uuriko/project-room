# Release and acceptance execution plan — 18 October 2026

This plan takes the existing architecture and continuity candidates through final
integration, migration/recovery qualification, coordinated release and an observed
product journey. John authorizes execution, publication and deployment. He has
explicitly selected simulated requester/reviewer roles for today's acceptance
run; actual human testing is deferred to another day. This does not turn simulated
success into a claim about human usability, model quality or productivity.

## 1. Target and completion criteria

The target is one coherent release of Project Room, not another feature branch.
The architecture candidate starts at PR #4114 `aa69cf95`; continuity starts at
PR #4118 `4a2bb31c`. Production was last observed at `14e4320b`, schema38.
Main has advanced to `f18cd508`. The release introduces schema42. Record full SHAs
and workflow run URLs in the execution record; short labels here are navigation.

Completion is a conjunction of independently observable outcomes:

1. The intended source changes and newer main changes are integrated without
   dropping either branch's contracts. Exact proposed heads pass required hosted
   checks, and the eventual main commit passes its own release gates.
2. An upgraded database preserves messages, archived history, work records,
   evidence, revisions and exact retries. Old writers cannot mutate new storage.
3. Backup and restore preserve the captured state and expose authority revoked
   after that capture. A database restore is never mistaken for permission to
   reopen service under stale grants.
4. Both production doors report the intended source revision. Health, readiness,
   signed agent cards and an authenticated synthetic-room journey work.
5. Separate requester, reviewer and agent roles complete the agreed task through
   changed requirements, interrupted execution, review and acceptance. Unsafe
   retries and stale acceptance are refused. The results are recorded honestly.
6. Discovered release-blocking defects are repaired and the affected boundaries
   are revalidated. Remaining non-blockers have explicit disposition and evidence.

No numerical server benchmark alone establishes this complete product outcome.
No passing test replaces a missing deployment receipt. No fabricated user result
is entered as an actual customer outcome or public success story.

## 2. Ownership, workspace and evidence

Use the existing isolated architecture and continuity worktrees. Inspect dirty
files before editing; leave other agents' working copies alone. Claim source work
on the shared board/bus and report milestones in muse-room. Inspect live
`MERGE-SLOT`, `ROLE-DEPLOYER` and `RELEASE-PAUSE` claims before their associated
operations. Coordinate with the current release holder rather than dispatching a
competing upload. The ordinary production workflow remains the deployment path.

Maintain an execution ledger with: input SHAs, output SHA, action, command or run
URL, observed result, relevant artifact path, and remaining gate. Keep synthetic
fixture outputs separate from production observations. Store raw local command
logs outside tracked source; commit compact, secret-free reports. Never print
connection tokens, signing keys, private operator packets or authenticated headers.

Use Node24.19 for local qualification, matching CI. Resolve code and generated
metadata before expensive runs. Run small boundary tests first; once the source
is stable, run one full suite and reuse it until a source change creates a reason
to retest. Subsequent repairs get focused validation plus relevant hosted gates.
Do not repeatedly rerun benchmarks or tests merely to obtain a favorable result.

## 3. Reconcile and freeze the release source

### Architecture branch

Fetch main and record its full SHA. Compare the exact change since the last
integrated main; currently that is the escrow epoch/heartbeat fix in four files.
Merge it into #4114 while retaining both histories. Review the escrow behavior and
heartbeat-health behavior against their tests. Do not change unrelated message
storage or work semantics to make a merge easier.

Run the epoch-keeper and job-heartbeat regressions, adjacent escrow tests when
selected, the architecture migration boundary tests, recovery policy tests and
package/manifest checks. Regenerate the candidate manifest only if its inputs
changed. Verify the generated manifest rather than choosing a conflict side.

### Continuity branch

Merge the resulting architecture head into #4118. Inspect package and runtime
allowlist unions, brief preparation, cache identity boundaries and runtime input
provenance. Preserve independent reviewer identity, explicit omissions and fresh
server-side revision/authority checks. Verify that new storage modules remain in
the deployable package and that the cheap preflight still rejects package drift.

The architecture and continuity PRs remain separately reviewable. Keep the stacked
base correct while #4114 is open. After #4114 lands, point #4118 at main and verify
its resulting diff contains only the intended continuity and qualification work.
Do not delete either remote branch before its dependent PR is safely retargeted.

### Freeze discipline

Ask the release coordinator for a bounded landing window. If main moves again,
inspect the delta before deciding whether another integration is necessary. A
fresh commit changes the release candidate; previous green checks remain evidence
for their own SHA, not a substitute for new-head validation. Never ship a green
ancestor while describing it as the current planned release.

## 4. Qualification ladder

First run preflight: declared dependencies, module coverage, runtime import
allowlist and candidate-manifest consistency. Then execute the focused boundary
suite, lint and applicable contract checks. Run affected selection against the
actual stacked base, not all historical changes against main when that would hide
the incremental scope. The full suite still covers the combined candidate.

For every failure, retain its test identity and cause. Compare Mac host-policy
failures against the recorded exact file/name baseline; do not disable sandbox
checks. Fix candidate regressions. For timing failures, observe the operation with
a bounded deadline instead of simply enlarging a sleep. A passing targeted repair
does not erase the original failed run from the report.

Inspect required hosted checks on the exact new head: Node unit shards, Worker
SQLite, browser journeys, schema consistency, package/contracts and required
policy/security gates. Read failure logs before making changes. Canceled obsolete
runs are not failures of the replacement run, but queued/running checks are never
counted as successful. Keep a compact status ledger rather than polling unchanged
jobs continuously.

Reuse the production-mode shared benchmark when the measured runtime paths are
byte-identical to an already qualified base, and state the exact provenance.
If a repair changes message writes, snapshots, reads, sync or replay, run
`npm run bench:room` with the appropriate pinned base, bodies-at-rest and retained
raw samples. Check fixture failures and measured-write success before interpreting
latency. Preserve slower and inconclusive metrics; do not claim universal gains.

## 5. Migration, backup and recovery rehearsal

Use disposable, synthetic data. Do not copy a production database into a public
artifact or mutate a live room to manufacture test evidence.

Create representative history using the deployed schema38 implementation where
possible: multiple members, old and recent messages, replies, substantial message
bodies, a chunked partially advanced replay snapshot, work proposals and accepted
work, and retained evidence. Record counts, sequence, content hashes, work revisions,
archive marker, replay anchor and certification anchor before upgrade.

Open that database with the candidate. Verify schema42 migration preserves chunk
markers and parts, derives the correct replay anchor, drops the old body-bearing
cursor column and installs writer fences. A connection opened under the older
writer must be refused after migration. Resume replay from its durable state,
finish certification, and compare complete message records rather than only counts.

Exercise canonical work acceptance and exact command retry. Archive a synthetic
history prefix through the guarded API only after parity is certified. Restart and
verify recent and archived reads, replies to old messages and work state. Delete a
message and verify its text does not survive in chunks, snapshots, projection,
event replay or retained auxiliary copies covered by the privacy contract.

Run `scripts/restore-rehearsal.mjs` and the recovery comparison tests. Capture a
backup with real canonical work rows and live authority, then revoke credentials,
links, memberships, delegation and agent connections on the live synthetic branch.
Restore the older capture read-only and prove the reconciliation report names the
resurrected authority. Confirm exact retry receipts and captured work state survive
restore. Keep service closed to writes until the required authority reconciliation
is applied; a matching event count alone is not sufficient.

Inject transaction failures where existing tests provide hooks. Verify snapshot
chunks/marker/cursor updates roll back together and no certification refers to
partial data. Verify corrupt/torn snapshots trigger safe recovery instead of
silently returning truncated history. Reuse the actual Worker SQLite tests for
value limits and persistence, since Node SQLite alone cannot establish that limit.

## 6. Recovery choice before deployment

The deployment crosses schema38 to schema42. The old schema38 Worker is not a
valid automatic rollback target once schema42 migration has happened. Do not
lower schema markers or bypass writer fences to make an old version start.

Use the existing deploy-recovery implementation to classify prior and candidate
source/schema, record version allocation before upload, and rehearse each outcome.
A code rollback requires independently known compatible schema and row semantics.
Otherwise retain the new schema and roll forward with a tested fix. Restoring a
backup is a separate data operation with its own watermark and authority hazards;
it is not a casual substitute for code rollback.

Before upload, verify the deploy workflow contains this protection, the candidate
package is reproducible, migration/recovery tests pass, and the prior deployment
metadata will be captured. If readiness fails after upload, inspect actual deployed
revision and storage status first, then follow the compatible recovery route.
Never report rollback success without source/version readback.

## 7. Landing and deployment sequence

Acquire the candidate-bound merge slot through the existing coordination contract.
Record exact head and base and inspect protected-branch requirements. Mark a draft
ready only once its intended source and validation are reviewable. Merge #4114
through ordinary GitHub gates; do not use admin bypass to make pending checks green.
Retarget/reconcile #4118 against the actual merged main, qualify that diff and merge
it next. Preserve branch ancestry or explicitly verify tree equivalence when GitHub
creates a merge commit.

Record the final main SHA. Wait for successful `test` and `schema-gate` push runs on
that SHA, not merely PR checks from a predecessor. If another landing changes main,
coordinate the release window and repeat the exact-head decision.

Acquire or receive the live deploy role. Dispatch `deploy-prod.yml` with the full
candidate SHA and a reason naming this release. Do not use an onboarding override
just to skip a real regression. Observe the workflow's predeployment artifact,
upload, smoke and recovery disposition. Production deploys are serialized and must
not be canceled once started merely because a newer source commit appears.

Verify canonical and public-entry `/api/version` and `/api/version/worker` match the
release. Check health/readiness, home/terms/privacy, and signed agent-card convergence
on both doors. Inspect public board/gallery freshness as the runbook requires; do
not fabricate receipts or reseed unrelated real tasks to make a dashboard green.
Record such a shelf issue accurately and repair only within a justified scope.

## 8. Simulated multi-role product acceptance

Use separate requester and reviewer browser contexts plus a separately authenticated
agent client. Give them distinct memberships and the minimum permissions required.
Do not share a privileged owner token across all roles. All role actions belong to
a clearly named synthetic test room or local fixture, never a real customer's task.

The task: produce a short release recommendation from supplied synthetic evidence,
with a linked result and explicit acceptance criteria. The requester asks for a
recommendation; the agent takes the task; the reviewer evaluates the supplied
artifact; the requester makes the final decision where policy requires it.

Run the normal path first: join/sign in, read the conversation, propose/accept work,
claim it, prepare scoped context, produce a versioned result, submit for review,
verify as the independent reviewer and accept as the authorized human-role actor.
Check UI labels and resulting server state agree. Verify the agent cannot attest
for the reviewer or bypass the required human decision.

Run the change path: amend requirements after preparation or while work is active.
The agent must observe a new brief/revision and cannot silently treat the old scope
as current. Submit an outdated result deliberately; acceptance must refuse or expose
the stale evidence. Correct the artifact, request review again, and accept the exact
new evidence version. Retain the earlier result as history without presenting it as
the accepted version.

Run the interruption path: interrupt an agent request after durable start, restart
its host/journal, reconcile the original attempt and retry the delivery. Check one
logical execution/publication, no blind replay of an uncertain external effect,
and a visible interrupted/unknown state when reconciliation cannot prove completion.
Exercise duplicate commands and reconnecting browser/client reads. Existing actual
model-turn trials may be reused only with explicit source/protocol provenance;
simulated interruption must not be labeled physical Mac sleep/wake.

Run the return path: close/reopen the role session, load the selected brief and
result, identify what changed and the next action without replaying all unrelated
history. Exercise draft recovery, a narrow/mobile viewport and keyboard access
through existing acceptance browser tests. Keep screenshots/assertions from decisive
states rather than a large unreviewable recording of every click.

Use the existing acceptance fixture, API handoff and browser scripts wherever they
already express these assertions. Add a regression only for a demonstrated uncovered
boundary. Automated identities are role simulations, not independent human study
participants. Today's run does not close the deferred real-human pilot.

## 9. Measurements and defect triage

For each scenario record completion/refusal, accepted evidence identity, duplicate
execution/publication count, role/authority correctness, data recovery outcome,
context bytes and elapsed automated-run time. Record corrections and agent/tool
calls when observable. Do not present automated runtime as human task time.

The later human pilot will measure accepted outcomes per human hour, elapsed time
to acceptance, seven-day rework and total cost per accepted outcome. Cost includes
model/tool spend and human time using explicit recorded assumptions. It needs real
participants, comparable tasks, a baseline workflow and honest uncertainty. Today
we prepare the protocol and test machinery, not invented participant results.

Block release for unauthorized actions, privacy leakage, data loss, stale acceptance,
duplicate effects, failed migration/restore or an essential broken journey. Fix the
smallest coherent cause, add a meaningful regression and retest the affected layer.
An optional polish issue gets a bounded follow-up instead of derailing the release.
If a purported improvement cannot justify its cost against this product journey,
remove it from the release scope.

## 10. Final receipt and handoff

Publish one final ledger: deployed SHA or explicit reason no deployment occurred,
merged PRs, checks, schema transition, backup/recovery evidence, simulated scenario
results, performance provenance, defects repaired and unresolved gates. Link the
raw benchmark and qualification artifacts. State that real-human testing was
deferred by John and that physical sleep/wake remains unproved unless an actual
observed suspend/resume happened with a reliable wake plan.

Release only the source/merge/deploy claims acquired for this work, and verify the
release. Do not clear another owner's freeze. Leave source and qualification
reports reviewable even if an external runner, shared release lane or platform
capability prevents a later stage. A pending external gate is not completion.
