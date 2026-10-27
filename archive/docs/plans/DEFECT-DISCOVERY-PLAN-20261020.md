# Defect discovery and repair plan

Written before implementation on 2026-10-20. Status: execution starts with the bounded coordination campaign below. This does not replace the collaboration, release-closure, or workspace-simplification plans.

## Why green tests missed these problems

We know the mechanism for the four reproduced coordination findings; we do not yet know their complete historical age or every review that missed them. Avoid inventing a history of negligence. The 67 relevant tests pass while the new reproductions expose failures. That establishes a coverage gap, not that testing is useless.

The tests exercise delivered, acknowledged, expired, and responded states separately. Their combined meaning is underspecified: a current timeout state is incorrectly used as evidence that a past acknowledgment never happened. Receipt reads persist timeout transitions, but replies inspect stored state. Consequently, inserting a read changes a later outcome. Presence combines transport health and observed activity into one label. The local bus uses a convenient heuristic—any subsequent post—as evidence of an answer. Each component looks plausible in isolation; the user-visible claims disagree when composed.

Our own coordination also failed at the boundary: a local file path was sent to a remote agent, notes were mistaken for tracked requests, and a quiet local ledger was initially treated as the place to find active agents. The repaired audit must test the claim from the recipient's perspective, not merely the sender's successful write.

## Research and decisions

1. Generate action histories, not just input values. fast-check supports commands with preconditions, simplified models, reproducible seeds and shrinking. Its documentation explicitly cautions against copying the implementation into the model. Use existing fast-check when sequences become large; enumerate small finite spaces first. [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/).
2. Control clocks, scheduling and failures. FoundationDB combines deterministic simulation with live performance and hardware fault testing; simulation does not replace those other layers. Here, reuse the real RoomStore with its existing injectable clock and temporary database, then move selected failures to HTTP/browser/native boundaries. Do not attempt to rebuild FoundationDB's simulator. [FoundationDB testing](https://apple.github.io/foundationdb/testing.html).
3. Compare histories with an independent consistency contract. Jepsen models invocation/completion histories against declared guarantees. Borrow the discipline: specify which observations may change, which facts must persist, and what retries mean. Do not label a local synchronous test a distributed linearizability proof. [Jepsen consistency models](https://jepsen.io/consistency/models).
4. Exercise interactions economically. NIST describes interaction testing and formal expected results; pairwise alone is not a guarantee. Exhaustively cover small high-risk factors, then use pairwise/three-way combinations for the wider UI matrix. [NIST SP800-142](https://csrc.nist.gov/pubs/sp/800/142/final).
5. Test the tests. Mutation research recommends selective, incremental mutation rather than mutating every line on every run. Introduce one narrowly scoped receipt mutant to prove the new checker detects invented read evidence; expand only where it adds distinct coverage. Do not report a global mutation score from one mutant. [Practical Mutation Testing at Scale](https://arxiv.org/abs/2102.11378).

## The method

### 1. State the promises before writing cases

For each critical journey record actor, intended outcome, authority, durable facts, observable result and recovery route. The oracle is a plain-language promise implemented independently, not today's code behavior. Separate safety (nothing forbidden happens), liveness (allowed work can progress), honesty (UI/API labels match evidence), and usability (a person can discover and complete the task).

Initial coordination promises:
- An observed acknowledgment cannot become unobserved merely because a deadline passes.
- Adding a status read to the same action/time history cannot change the final classification of a reply.
- A receipt cannot invent a read before acknowledgment or a correlated response.
- Retrying the exact command does not create a second message or second effect.
- An unrelated message does not answer an earlier request.
- A third party cannot inspect sender-specific receipts.
- Restarting does not change already recorded facts.
- Recent activity, membership validity, listener health and immediate wake capability are distinct facts.

Do not automatically infer task completion from a reply, ACK, or model-generated interpretation. A delivery record means recorded delivery, not proof that an external model started processing it.

### 2. Establish a finite experiment before expanding scope

Build scripts/coordination-history-audit.mjs as an explicit diagnostic, outside npm test until its known failures are repaired. It must return nonzero on invariant violations, write a machine-readable report, and never silently treat known defects as passes. Use fictional local rooms and existing production APIs; no production seam or live fleet load.

Enumerate acknowledgment present/absent, deadline minus one/exact/plus one, restart absent/present, and receipt read before reply absent/present. For each base history compare the same history with the extra read. Check privacy, unrelated messages and command retries separately so the first temporal failure does not mask them. Record every trace and observed result, plus shortest failed traces. Use an explicit bounded matrix with counts, not the word exhaustive for the entire product.

Add one isolated source mutant of the receipt reader that reports every receipt read. The same checker must reject it. Keep mutant code in temporary storage and delete it; never alter the checkout or production. This checks the oracle's sensitivity, not whole-program fault coverage.

### 3. Turn discoveries into owner-boundary repairs

For each finding record symptom, severity, exact source, minimal trace, owning component, queued overlapping work and acceptance condition. Ask existing owners before duplicating a patch. Each repair should fix the source of truth, not adjust labels until tests pass. Promote the minimized scenario into the existing primary test file, and keep the broader generator if it covers distinct sequence risk.

Temporal receipt repair needs a small explicit design: acknowledgment/response facts must survive timeouts, while deadline status is computed consistently. Historical missing evidence must remain unknown. Any schema change needs forward migration and replay/benchmark evidence. Do not attach this to a visual-only change.

Bus correlation is a separate local-tool repair. Add explicit request linkage; do not replace it with semantic guesses. Presence needs truthful independent observations; changing display precedence must not silently change authorization, wake eligibility or lease ownership.

### 4. Expand by risk, not by file count

Next campaigns, each with a bounded artifact:
- Identity/invites: duplicate redemption, lost response, old/new credentials, scope, expired invitation and account restart. Pair each human flow with the agent API equivalent.
- Claims/work/results: two owners racing, lease expiry, stale revision, replay, approval against the wrong version, completion after cancellation and withdrawn text.
- Sync/storage: write committed but response lost, disconnected observer, repeated events, partial history and restart; compare canonical state and projections. Use bench:room for any storage/write/sync repair.
- UI continuity: chat draft, private audience, thread/back, preview resize, reload, changing viewport, stale asynchronous response and permission revocation. Check real DOM and persisted draft separately.
- Packaging/platforms: same asset/source revision on web/Mac; native WKWebView reload/reopen; mobile touch/keyboard. Browser emulation is not physical-device qualification.
- Release: correct head, asset manifests, configuration, both doors, readiness and independent post-deploy checks. Never equate a green build with deployed behavior.

For security boundaries, use real unauthorized attempts and ensure rejection comes from the intended guard. For UI, test task completion and focus/scroll behavior, not only screenshot similarity. Retain actual human sessions as a later gate; simulated people are useful systematic probes but do not establish comprehension or product demand.

### 5. Keep the feedback loop small

No new recurring automation or elaborate QA dashboard. On each relevant change: focused invariant tests, selected interaction histories, one end-to-end journey and required repo checks. Longer seeded exploration is manually invoked or added to existing CI only after cost and ownership are understood. A failure stores seed/trace/source/command; a rerun reproduces it rather than fishing for green.

Measure escaped defects by class, reopened fixes, invariant and transition coverage, minimized reproducibility, scoped mutant detection, unique defects per test-minute, flaky failures, and time to owner/repair. Raw test count and line coverage are supporting signals, not quality targets. An untested gate remains explicit.

## Execution ledger and retained work

- Completed before this plan: four audit reproductions; 67 coordination baseline checks pass; live sync with Grok/Fo/John's Tab and Codex peers. Cursor intentionally inactive.
- Execute now: finite coordination history audit, report, isolated mutant, assess new failure traces and notify existing owners. This is the first completed campaign, not a claim of total bug eradication.
- Existing work retained: narrow resizable right preview; removal of Results modal; exact-version recovery; private drafts and uncertain sends; desktop unread-divider regression; native reload/reopen harness; disposable production acceptance evidence and checklist reconciliation.
- Preview qualification still open: responsive check timing, complete browser pass, native rerun, manifest regeneration and final affected/full checks. No new source is claimed shipped.
- Broader campaigns above remain scheduled work in this ledger, not background automations and not silently completed. Finish one coherent repair at a time, preserve source-specific evidence, then proceed to the next highest-risk seam.

## Acceptance for this first campaign

A documented one-command run explores the stated finite matrix, reports failures with replayable histories, exits nonzero on real defects, passes independent controls, and rejects the deliberately corrupted receipt reader. The original four findings remain visible until repaired. The plan, traces and outstanding work are accessible to the user and collaborators. No promise to find all possible bugs, no weakened tests to manufacture a green result.

## First execution results

Implemented `scripts/coordination-history-audit.mjs` without a new dependency or production code change. The finite matrix includes 48 histories / 24 paired comparisons (acknowledgment × three deadline positions × restart × exact request retry × inserted read). 120 control assertions pass: receipt privacy, unrelated-post isolation, and retry uniqueness. The audit returns exit 1 with 32 violations across TWO invariant classes, not 32 distinct bugs. Both the exact deadline and +1ms are affected, with and without restart/retry.

A matched before-deadline control passes (2 histories, 4 controls). The identical case against an isolated always-read source mutant fails with two `no-invented-read` violations. This establishes detection of that one false-evidence mutant only. Targeted ESLint passes. The broader 67-test pre-existing coordination baseline also passes; the new histories expose its gap.

Run the diagnostic (the repaired source now passes):

```sh
node scripts/coordination-history-audit.mjs --out test-results/coordination-history-audit.json
```

Reproduce a boundary subset or exercise the oracle:

```sh
node scripts/coordination-history-audit.mjs --case 'ack=true,delay=60000,restart=true,retry=false'
node scripts/coordination-history-audit.mjs --case 'ack=false,delay=59999,restart=false,retry=false'
node scripts/coordination-history-audit.mjs --mutant --case 'ack=false,delay=59999,restart=false,retry=false'
```

Reports contain action traces and shortest observed failing traces, not a claim of globally minimal counterexamples. Source hashes bind the report to the tested coordination modules. Mutation code is temporary and removed in `finally`. Unknown arguments or an empty case selection fail rather than silently passing.

The repair phase remains OPEN. No coordination schema/behavior fix, commit, push, or deployment is claimed by this campaign. Shared owners have been notified with exact reproduction recipes. Next is the receipt lifecycle repair design, followed by the minimized regressions in the existing owning suite. Presence and local bus repairs remain separate tracked findings. Other product-wide campaigns remain open as above.

## Repair checkpoint

Implemented locally: a lifecycle-owned additive observation table preserves acknowledgment and first reply facts independently of deadline state. Legacy acknowledged/responded rows retain known facts without invented acknowledgment timestamps. A late reply records response evidence while preserving timeout; reading receipts before the reply no longer changes its classification. Explicit late ACK and retries preserve the first observed ACK time. The current source passes all 48 histories and 120 controls; focused lifecycle/presence regressions pass. Fresh successful agent commands now supersede stale offline observations as idle, without claiming an active listening transport.

The separate local bus candidate correlates replies by request ID. It remains unapplied to the pre-existing untracked shared script; peers have been notified. This is an outstanding adoption item, not a deployed fix.

The retained desktop unread-divider bug was reproduced before repair. Short conversations cannot emit scroll events; a downward wheel over their fully visible messages now advances the horizon. The regression test uses an actual wheel without synthetic scroll events. Desktop/mobile activity, preview/recovery/continuation and writer-fence checks pass: 58 tests on Node 24. The transport preview test now supplies an actual long document instead of interpolating a missing fixture field. Native WKWebView reload/reopen acceptance also passed earlier in this source campaign.

Full and affected suites are still in progress at this checkpoint. No commit, merge or deployment is claimed. The full same-run benchmark is preserved in the local qualification outputs as bench-room-1000.txt; every metric was inconclusive (~), so there is no supported speedup or slowdown claim. Wider campaigns, real human/provider/device qualification and public Mac notarization remain open or explicitly deferred as recorded above.

## Qualification follow-through

The affected suite passed 1,977 tests across 312 files. The full Node 24 run completed with 11,284 passing, 61 failing and 31 skipped tests. These failures were retained, then diagnosed: 57 bridge checks shared overlong macOS Unix-socket fixture paths; one purge-registry omission and three recovery/cold-start assertions exposed incomplete integration of the observation table. The cold-start failure was missing fixture data, not measured slowness.

Repairs add the room-scoped purge entry, include substantive observation data in recovery coverage, update explicit table counts, and shorten only bridge fixture directory prefixes within the existing worktree temporary directory. Follow-up: 56 checks passed in the mixed regression run; the remaining 50 bridge checks passed after correcting that suite's four directory prefixes. Thus all 106 targeted follow-up checks pass across the recorded runs. The full suite has not been rerun after these repairs; its original failures remain recorded rather than being relabeled a full green run. Lint previously passed with 0 errors and 289 warnings. No production deployment is claimed.
