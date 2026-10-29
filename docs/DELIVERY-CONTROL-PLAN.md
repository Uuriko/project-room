# Delivery control: implementation plan

Updated 2026-10-29 UTC. This is the implementation plan for
Project Room owning its development and maintenance workflow. It complements
[the product architecture plan](ARCHITECTURE-EXECUTION-PLAN.md); it does not
replace that backlog or make its unfinished work complete.

Read the [latest recorded release](#verified-release-20261029-2023),
[active priorities](FOCUSED-DELIVERY-PLAN.md), or
[retained checkpoint history](#retained-checkpoint-history).
Use [Room coordination](ROOM-COORDINATION.md) for live ownership; dated assignments
in this document do not establish current claims.

## Outcome and current evidence

A person or agent can ask what is ready, what is running, what failed, and what
to do next without reconstructing chat history. A disconnected laptop resumes
useful work without duplicating a deployment. Each production change has an
inspectable chain from intent to tested source, artifact, deployment and outcome.

### Evidence checkpoint: 2026-10-29 UTC

<a id="verified-release-20261029-2023"></a>

### Verified release checkpoint — 2026-10-29, 20:23 UTC

Production is `eb2c12a1d777ff042fb446b840aacc82e4e98664` (PR #5316, including
#5314). [Deployment 40947450056](https://github.com/Uuriko/project-room/actions/runs/40947450056)
passed its first strict smoke, live smoke and runtime publication. No rollback,
second Worker upload or readiness retry was needed. Independent authenticated
checks at 20:22:47 UTC found the exact revision at all four version doors before
and after; both bootstrap and selected participant reads returned 200, with 182
participant requests and zero nonparticipant requests exposed. Prior mixed-version
observations remain retained failures of convergence, not successful auth probes.

The [verified runtime](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-eb2c12a)
contains 635 files, 3,345,449 bytes, SHA-256
`516388f3b08e118434a1ae475d524170ea68e41b98e9c2f229b1bb8fc31f9ed4`.
A separate latest-release read confirmed the tag after publication verification.
Matching Graphify publication and three REST plus three fresh MCP reads passed
with digest `549256f1fb45977c249be93a019a28e977cfd0c19a3579a434e33b525a472ee8`;
coverage remains server-only and truncated.

This ships claim-history guidance, honest receipt outcomes, designated dispute
decider disclosure, accessible action names, agent enrollment/setup ordering,
correct API-key recovery hints and separate deployment-phase reporting. The
patrol detail and `.test.mjs` lint fixes merged afterward are not in this release.
DM navigation and selected-run performance experiments remain separate candidates.
Real screen-reader use, physical sleep/wake and universal first-attempt Google
sign-in reliability remain unverified. The full deployment-record/signing project
is not completed by these narrower reporting improvements.

## Retained checkpoint history

The dated observations below are retained as evidence. Words such as “current,”
“pending,” and “owns” describe their recorded time, not today's release or live
ownership. They do not override the latest checkpoint or active priorities above.

### Verified release checkpoint — 2026-10-29, 20:04 UTC

Production is `0bd217f8a76527c2dce09bec435eb091c70858d0` (PR #5313,
including #5304 and #5309). [Deployment 40944657802](https://github.com/Uuriko/project-room/actions/runs/40944657802)
passed its first strict smoke, live smoke and runtime publication. Both Workers
were uploaded once. The new bounded readiness recheck was **not exercised** in
this successful run; its fixture evidence remains distinct from production proof.
Earlier independent observations recorded new Workers with the old room-service
revision; those observations were retained, not counted as successful auth checks.

At 20:04:24 UTC, an independent authenticated check found all four version doors
matching before and after: both bootstrap reads returned 200, each exposed 182
participant requests and zero nonparticipant requests, and selected participant
reads returned 200. This does not claim an exhaustive authorization audit.

The [runtime archive](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-0bd217f)
was downloaded/verified by the publication job: 635 files, 3,344,131 bytes,
SHA-256 `02425b1ce4c4e7a7c7c0f81e89e38a9d4681fd0b4890e8be22aa88f551fa036f`.
A separate latest-release read confirmed this tag. The matching Graphify server
map was published with compare-and-swap; three REST and three fresh MCP reads
matched revision and digest
`598f4f86875392a557ec775da71e2e42a1f913f18fc655eca04cfa9e29936e75`.
Coverage remains server-only and truncated, not a complete product map.

Shipped changes include explicit private-message composition, permission checks
for bounty work, actionable reply/name errors, keyboard retry recovery, startup
retry, wake-error classification and the corrected Google return runtime asset.
Real Google first-attempt reliability, real screen-reader use and the cause of
multi-minute Worker/room-service convergence remain open investigations. The next
claim-history/outcome/decider candidate is separate from this deployed source.

### Recovery release checkpoint — 2026-10-29, 19:32 UTC

[PR #5300](https://github.com/Uuriko/project-room/pull/5300) landed
`b2f7dadf49979d5ddbc44288ac2af4c84b3660d0`, composing Google session recovery,
account restoration during app download, bounded room return and join-page
focus/accessibility fixes. It retains the merged cancellation guard and handbook
navigation/procedures. Final affected browser/manifest checks passed (26), as did
repository contracts. Independent final Google startup delta checks passed (25).
These are separate focused observations, not a full-suite or real-Google claim.

[Deployment 40939808567](https://github.com/Uuriko/project-room/actions/runs/40939808567)
uploaded both Workers after its exact-source schema gate. Its smoke failed on a
one-second Durable Object readiness timeout; recovery held the candidate rather
than rolling it back. The original failed report is retained. Independent strict
and public live smoke passed at 19:32, with all four version endpoints matching
before and after. A separate saved-identity check accepted the credential and
returned both bootstraps and participant-selected requests successfully; each
bootstrap exposed zero nonparticipant requests for that viewer. No second Worker
upload was used. This does not establish global privacy or human sign-in success.

Runtime publication was skipped by the failed workflow. Local preparation then
found the new Google-return module missing from the runtime asset lists. Corrected
packaging tooling `455618ee` built the unchanged deployed source and passed local
preflight plus remote download verification. Release
[`runtime-2026-10-29-b2f7dad`](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-b2f7dad)
was created without promotion, verified, then promoted to latest. Its archive
SHA-256 is `121b581099d8909e51b09ac620afa7e0041f3a37bd5691ff9e35753a33ceeb34`.
No additional Worker upload was needed.

Graphify for the same source was published and matched on three REST and three
fresh MCP reads, digest
`ddd30527a4ebf6460b397b8a2fe2d4ed6c5c24f3940ea174bf9b6a26bf16e6db`.
It remains server-only and truncated, without authenticated source attestation.
Existing parity diagnostics still require operator access; no speculative data
repair was made. The earlier runtime/map checkpoint below describes the prior
release, not the newly deployed source.

### Verified release checkpoint — 2026-10-29, 18:26 UTC

[PR #5292](https://github.com/Uuriko/project-room/pull/5292) landed
`4fe3f5189b1dda9cdae0c917c8579129ea4a8338`.
[Deployment 40929536373](https://github.com/Uuriko/project-room/actions/runs/40929536373)
passed its exact-source schema gate, deployment smoke, live smoke and verified
runtime publication (`runtime-2026-10-29-4fe3f51`). Mixed Worker/room-service
versions during propagation converged without another upload or reset. An
independent saved-identity read verified all four version endpoints before and
after bootstrap/selected-request checks. Both bootstraps returned 179 participant
requests and no nonparticipant entries for that viewer; this is not a global
privacy proof or a completed human sign-in journey.

Graphify was published for the same release, digest
`df444a943e46478704a84ac5fb3fb446fe2c8542df96b916aab902a461e9cd1a`.
Three REST and three fresh MCP reads matched. It covers server code and remains
partial/truncated; source-revision provenance is not an authenticated source
attestation. Existing Board overlap hooks consume it.

All six canonical browser shards passed on the 209f5941 composition in
[run 40928737023](https://github.com/Uuriko/project-room/actions/runs/40928737023).
Later changes were test expectations, the exact entropy exception and generated
manifest pins. The broad local suite was stopped after 13 minutes with partial
failures retained; no full-suite green claim. Test-only [PR #5294](https://github.com/Uuriko/project-room/pull/5294)
subsequently merged as `52dcbfb0656e1834828a0d3666608c588cd4ab41`, fixing
the composer CSS parser and missing browser timing; 16 focused checks passed.
That follow-up required no Worker upload. Operator-only parity details
remain unavailable; no speculative data repair was attempted. A fresh connector
read confirmed the supposedly unconfirmed answer was recorded: the old long-lived
connector process lacked current answer-stamp support. Updating its configuration
alone had not restarted that session.

This checkpoint supersedes the preparation-only status below. It is a dated
release observation, not a live deployment dashboard. The handbook consolidation
uses the existing [index](INDEX.md); archived handbook material is not considered
fully migrated until its surviving content has been reconciled.

### Current release execution — 2026-10-29, after 18:00 UTC

John authorized completion of the qualified release, final-source Graphify
activation, a real development-loop exercise, and bounded laptop handoff work.
The frozen 2457 candidate remains unchanged for evidence comparison. The isolated
`codex/release-final-1029` composes it with #5286, #5287, #5288, #5290, #5291 and
this plan. Merge and deployment are still distinct outcomes until recorded below.

The complete two-Mac browser run returned 743 passes, four failures and one skip.
Two journey failures are fixed by #5288; #5287 enables the initial-history test.
Canonical Linux run 40926149787 passed visual shard 4 including its negative
control, without baseline changes. Other canonical failures: journey shard 2
(the known fixture issue), manual lint missing base history (fixed by #5291),
and stale generated wiki data (regenerated in the final composition). Canonical
coverage/unit jobs were still running at this checkpoint. Passing visual tests
are not retained screenshot evidence for every surface.

#5290 provides explicit failure intake, fixed-source local reproduction and
work/request/evidence linkage; 23 tests pass including actual subprocess and
lost-acknowledgement paths. Actual frozen-source Chromium reproduced the known
journey failure. It was not submitted as duplicate live work after its fix.
A bounded native selected-request runner is separate work, not yet released.

Read-only stored logs identify parity failure in room `build-together-32f67587`
at 16:00:39 UTC with three outstanding failures. Exact mismatch details still
require existing operator access; no data repair is justified by the public
summary. Patrol's historical claim error is separate. Graphify remains hosted
at an older revision pending exact final-source publication and REST/MCP checks;
its server-only truncated map is not repository-wide coverage.

Earlier checkpoints below are historical, including their pending-results and
preparation-only statements. Preserve original receipts rather than rewriting
failed attempts as passes.

### Preparation candidate frozen — 2026-10-29, after 17:13 UTC

The fetchable preparation branch `codex/release-prepared-candidate-1029` is now
`2457a65e01f0849917cb174f4f41b7d11fbff145`, tree
`89ce10fa446c0dec4621b9236035836dd64139c1`. Main and production are unchanged.
It composes #5271, #5272, #5277, #5278, #5280, #5281, #5282, #5283,
#5284 and #5285 while preserving their ancestry. Earlier candidate packages below
are historical evidence and must not be called the final package.

- #5280 repairs agent discovery of work claim/update lifecycle operations; 39
  discovery and QA2 checks passed on composition.
- #5281 and #5283 contain the peer's creation recovery and contextual navigation
  fixture repairs. Peer reports 12 creation plus 62 related browser passes and
  32 draft-return/reuse/refine passes. These are focused results, not full coverage.
- #5282 closes outsider injection into private formal-request threads, including
  owner outsiders and public descendants. Participant replies and ordinary public
  conversation remain supported; 63 combined boundary/reply/work/result tests passed.
- #5284 repairs served-client affected-test dependencies and writes selected and
  omitted coverage into existing browser artifacts. 26 checks passed. An app-only
  affected probe accounts for all seven families: two selected and five explicitly
  omitted by budget; omitted checks are not passes.
- #5285 preserves #5231 dependency changes and aligns the Sharp workspace override.
  Frozen installs with pnpm 10 and 11, relay npm ci, registry integrity, 38 checks
  and both Worker dry runs passed. Three additional relay advisories (body-parser,
  zod and ip-address) require exposure assessment; this is not an all-clean audit.

Full browser qualification is dispatched using the existing six shards and all
142 scripts. This Mac runs shards 1/3/5; the peer is requested to run 2/4/6,
sequentially per host. Source is the full SHA above, run ID
`prep-2457a65e-20261029`, attempt 1, and `CI_BROWSER_SCOPE` is unset.
Expected plan hash:
`50f1dcd0d7380a78c1fdfc18d0eb260c47e7750282fcb2a852e02787f0100b82`.
Results remain pending. Keep each host's toolchain, selection, receipts, logs and
JUnit; do not overwrite visual baselines to conceal platform differences.

Local backup and restore rehearsals passed on the earlier addb03aa composition:
byte equality for nine events, two members, one work item and one file; stale
restore authority is identified while canonical work and retry receipts survive.
These scripted assertions are not a production restore rehearsal. Candidate and
serving source both declare schema 42 and matching writer definitions; current
provider allocation and full stored-data rollback compatibility remain unproven.

The 17:00 claim-prs tick recovered (zero checked/updated, three invalid skipped,
current failure count zero). Integrity still reports messages parity failures and
patrol separately reports a claim-legality transition. Public summaries do not
identify enough detail to justify a repair; obtain bounded operator diagnostics
before changing data or weakening checks. The old statement below about current
claim failure is superseded by this checkpoint; integrity is still unresolved.

The frozen candidate runtime package now verifies 632 source files and 134 assets,
schema 42, manifest `7fc27afde765301e78a9f5bd992c78c6cd06eddae368f5c820a2f56e87dd4f9f`.
The 633-file archive passes local publication preflight with the correct basename;
archive SHA-256 `230cec3b6a68ab61453a3a5c1f766dd8ad1a3409bf69c3778fb8f71b19d421f7`.
It has not been published. Additional relay advisory assessment found SDK test
paths only: Zod is reached by tests with local fixture responses; Express/body-parser
and express-rate-limit/ip-address are not imported by relay runtime/client paths.
Both Worker bundles exclude these packages. No live Worker exposure was demonstrated;
a separate dependency cleanup remains worthwhile.

### Qualification progress — 2026-10-29, 17:23 UTC

The peer accepted and started even browser shards (Room 23003/23006). Local shard
1 passed 23 tests; shard 3 passed 147, failed zero and skipped one. Shard 5 is
complete: 162 passed, zero failed. All three local receipts match the frozen
source/run/plan and report success: 332 passed, zero failed, one skipped,
542,467 ms sequential runtime. The skip is the old large-history DOM bound test in
`scripts/chat-performance-browser-check.mjs`, marked pending windowing since
October 7. Read-only source review confirms initial root windowing now exists;
the same test explicitly enabled on frozen source passed separately (27 initial
DOM items, 2,000 server-side historical messages retained). The original shard
result still contains one skip. This test does not prove permanent virtualization,
client full-history bounds, or total sign-in latency. A test-only follow-up removes
the obsolete opt-in. Original receipts, JUnit, selection and logs are retained.

The candidate Graphify server map was rebuilt at 2457a65e: 416 files, 7,912 nodes,
14,290 edges, zero model calls. Artifact size 1,479,235 bytes; SHA-256
`d78ed5dc09a80dd48579e89010e128e106c59b13f402a87b008392864fa0f8a6`.
Local callable lookup finds `workItemHistory` at server/store.mjs:4930. The result
reports server scope, partial semantics and truncation; this is not hosted
activation or repository-wide completeness.

Separate follow-up #5286 (`bb338ca57186356c5bc7dab99af9a534623f974f`) changes only
three relay lockfile records on #5285: body-parser 2.4.0, ip-address 10.7.5 and
zod 4.6.7. Fresh install, 21 relay tests and dry-run passed; that relay audit has
zero advisories. Upstream patches may contain non-security fixes. This follow-up
is not part of the frozen browser candidate; its bounded evidence is separate.

### Next release preparation — 16:55 UTC

Preparation only: no next release merge or deployment has started. The peer
laptop proposed the bounded scope in Room sequence 22961; this Mac acknowledged
the ownership and preparation boundary in 22964. Earlier sections below are
dated evidence, not the current queue.

**Current delivery:** production serves `6bda3388f6225eb4b468d4cd9ca522ebb926686f`
at both origins and both Worker/application version endpoints. Hosted
[run 40914289947](https://github.com/Uuriko/project-room/actions/runs/40914289947)
failed a one-second Durable Object readiness timeout; recovery held without a
second code transition. Subsequent independent deployment smoke and public live
smoke passed. This preserves the hosted failure; it does not prove sign-in,
installed Mac adoption, or a permanent readiness cure. Background-job health
still returns 503 with pre-release claim/integrity failures; no recovery is claimed.

The matching [runtime r2](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-6bda338-r2)
was downloaded and verified against all 633 exact-source package files before
promotion. Archive SHA-256:
`1dd1121f0c535219320c74014a602079cae5c30cc589a559edaf1ceda8081a23`.
The first immutable publication used the wrong asset basename and remains
non-latest; r2 corrects the name without changing source bytes. A narrow local
archive preflight is being added to the existing verifier and workflow to catch
this before publication. The deployment claim was released and read back unclaimed.

**Candidate inventory (refresh before composition):**

| Part | Exact inspected source | Remaining preparation |
| --- | --- | --- |
| Integrated documentation, evidence recorder and profile-lock safety | Main `63534b9244559a58b1029abbbba7b3a0b97d614e`; PRs #5273–#5275 | Retain 22 recorder and 31 Mac test results; these changes are not in the running 6bda runtime. |
| Selected work hydration | #5271 `c59e8112487e5d4e468b55d56fa08fce5d163d58` | Compose first; preserve selected corruption, authorization and offer-read behavior. |
| Selected result reads and browser fixture repairs | #5272 `d2f8cd3924f08b9e1ac5f8dc1bc85b96b8d234c0` | Depends on #5271; this is a product read-path change as well as test navigation repairs. |
| Creation navigation and failed-refresh recovery | Peer local `7efa12c036e894986ed469e2b938925de62be687`, tree `19c3c3eea37a281d839561ed4be2a438483607f2` | Peer publishes a fetchable head, then qualifies composition and remaining draft-return/refine/visual/reuse failures. |
| Graphify retention and callable lookup | #5277 `c6650ffcd271d7d9508c1b6fbc3bcac45325f5eb` | Compose four Graphify files; preserve partial-graph limits. Rebuild at final landed source before hosted CAS publication and REST/MCP readback. |
| Runtime publication preflight | #5278 `cd5a888c569f3dfcd1d4658c821257f4e4d246fc` | Six tests pass; corrected 633-file archive passes and original wrong basename fails. Qualify composition; verify downloaded bytes before latest promotion. |

The frozen browser baseline is **red**: peer source `09c466352572c95e805eea2856f0ad7817859979`
(same tree as local `9bec285d`) ran 736 tests: 649 passed, 75 failed,
11 cancelled, one skipped. Jill has the exact 86 failure/cancellation locations
for a selection-gap audit. Focused passes do not supersede this baseline.

The first preparation composition (`codex/release-prepared-candidate-1029`) is
`fb37bae66e458d379156c4a5702819fd6a862ce0`, tree
`45b0ea1a443cee21a69231b18e97ce23f98d72ec`: main plus #5271, #5272,
#5277 and #5278 merge locally without conflicts. Its 55 focused work/result/map/
publication tests passed with clean unchanged source before and after execution.
Runtime packaging verified 632 source files, 134 assets and schema 42, manifest
`86f64163e887b3a999dcdb713e33215b877bf6e4071da17cb8f797e8e6bca3b3`.
This is a preparation branch, not a main merge, final UI candidate, published
runtime or full-suite result. Rebuild after the outstanding UI composition.

**Work split and execution order:**

1. The peer laptop owns creation/UI repairs and their browser failure triage.
   This Mac owns isolated composition, package preparation, original evidence
   and this release plan. Grok diagnoses qa2-agent-eval/deploy-drift and job-health
   cadence read-only. Jill tests cold-agent/privacy behavior and omitted test
   selection. Each helper supplies exact source, outcome and unresolved limits.
2. Freeze an include/defer manifest after UI handoff. Compose dependency order
   on current main without merging the release. Reconcile duplicate component
   PRs by source behavior, not titles or ancestry alone. Keep #4900, #5276's
   delivery-only tool bundle, archived-index prototypes and unfinished rewrites out.
   Graphify's old manual-schema workflow portion remains deferred, not completed.
3. Run independent focused qualification concurrently on the two laptops; retain
   unchanged evidence with its original scope. Run the configured full browser
   selection once on the final combined tree and resolve or explicitly assess
   failures against changed behavior. Do not repeatedly restart unchanged suites
   or describe affected selection as the full suite.
4. Prebuild the exact candidate package, validate archive basename and contents,
   and prepare the Graphify extraction. Bind receipts to tree and commit. After
   eventual merges, confirm the resulting tree and rebuild source-stamped assets
   at the landed commit; do not relabel a different candidate SHA as deployed.
5. Before starting the next release, refresh current serving source, claims,
   schema evidence and incident disposition. One operator takes the existing
   deploy claim only for execution. Use the existing workflow and recovery tools;
   no new controller or speculative platform is required. A lost response means
   inspect the existing attempt, not dispatch another deployment.
6. Verify both origins, both version endpoints, signed cards and readiness;
   separately exercise sign-in, room switching, agent contribution, creation
   recovery and result review on the supported clients. Publish once with the
   expected asset name, verify downloaded bytes, then promote. Reconcile unknown
   outcomes before retrying; use a correction suffix for immutable mismatches.
7. Activate Graphify only against verified serving code and final source. Read
   the current hosted revision/digest, publish with both expected values, then
   verify REST and MCP identity, scope and an actual symbol lookup. Record what
   remains partial; a successful upload is not complete repository coverage.

Preparation is complete when the candidate, dispositions, executable commands,
evidence and recovery choices are ready for review. Starting the next release is
a separate step; preparation does not silently start it. Existing repository
protections apply, without inventing extra global approval or full-green rules.

### Reliability cycle follow-up

At that earlier checkpoint, production remained the independently verified `c47c3fc` release described below;
no new Worker deployment was performed for the following changes. The browser
navigation repair (#5252) passed 30 cases across eight scripts and remains a
test-only correction, with the mobile Search viewport issue still unresolved.
The machine command output-budget integration
([#5255](https://github.com/Uuriko/project-room/pull/5255)) merged at `5479e8d2`:
100 direct machine checks and 108 affected checks passed. One retained-byte budget
now covers stdout and stderr, including queued output after termination. This
machine source is outside the published runtime archive; neither an installed
agent upgrade nor remote descendant termination is established by that merge.

The proposed cold reply-context hydration change
([#5256](https://github.com/Uuriko/project-room/pull/5256)) passed 93 focused checks
and actual Workers corruption checks after independent review caught and repaired
a strict-JSON regression. That correctness evidence did not justify its performance
cost. The peer's explicit performance HOLD is supported by 144 raw samples, 12 per
case, whose medians were independently recomputed: at 5k messages, warm
baseline/candidate were 11.5156875/29.4373545 ms (about 2.56×), and cold were
22.4107085/29.8986045 ms. These are peer-host timings; “cold” only cleared the
projection cache. The benchmark source was inspected but not independently rerun.
Source commit `f082949795deba3242e6edef8b51890319c9cfbc` and raw SHA-256
`64b63af431c1f77b8ebe2f68a493e17c7eefa3254f798f67682fab3c6e10e6d0`
bind the retained `peer-reply-benchmark-source.mjs` and
`peer-reply-benchmark-raw.json` under `release-prep-20261029/`.
The peer's final acknowledgement (Room sequence 22803) confirms the revert and
that no production deployment occurred. The candidate was merged but never deployed; the allocation
benefit did not justify the reported slowdown. Revert
[#5257](https://github.com/Uuriko/project-room/pull/5257) restored the exact
qualified `5479e8d2` tree, `9506df174b998fc25a57f8c6d3c8f44e0c835ade`, at
`20e5fc33751e4e4dd92ca35423440e4f33971818`. Candidate source, negative controls
and qualification evidence remain preserved for investigation.

The performance HOLD at Room sequence 22791 was missed because a sent-message
sequence was used to advance the read cursor. A sent sequence does not prove that
intervening messages were consumed. Continuation must use the cursor returned by
the actual read; this is a coordination correctness fix, not a new permission or
approval requirement. No further optimization is implied by the revert.

Landing diagnostics
([#5258](https://github.com/Uuriko/project-room/pull/5258)) merged at
`a1de72cc6fea26dc2898c714a69386053a426c4a`. The local landing wrapper now uses
the qualified script. A live read-only control against draft PR #5231 returned
`candidate/pr_is_draft` with an actionable hint after two remote reads and zero
writes (`release-prep-20261029/merge-diagnostic-live-readonly.json`). This fixes
the ambiguous refusal that obscured #5250's draft state; it does not bypass
candidate identity or draft checks.

Final independent verification at 2026-10-29T11:01:52Z again verified stable
`c47c3fc` serving source. Authenticated orientation returned 123 work items, and
the deployment, merge and integration claims were read back as unclaimed.
Receipts are `release-prep-20261029/sustained-final-verification/verify-F5xtB3/receipt.json`
and `release-prep-20261029/sustained-final-auth.json`. This closes the cycle's
release/claim reconciliation, not the remaining performance and usability work.

A subsequent bounded cross-laptop observation recorded 18 successful readiness
responses on `c47c3fc`, alongside six matched canonical request traces. These
observations do not close incident #5177: the stored window still attributed
17,380 ms CPU to 50 reply-context calls. Shared history/projection work remains
an investigation target, and correlation alone does not establish the timeout's
cause. Deployment, active connector adoption and installed desktop execution
remain distinct from source/test qualification.

The coordinated integration
([#5249](https://github.com/Uuriko/project-room/pull/5249)) merged #5235, #5237
and #5238–#5248 at `c47c3fc79cc3af65db095f0b653d6dedb9e24454`, tree
`e01b537a7ff911e2b3f1cd1902d91157ee828305`. Deployment workflow
[40857688312](https://github.com/Uuriko/project-room/actions/runs/40857688312)
was deliberately **cancelled before runtime publication**, after the peer observed
an orientation HTTP 422 even though the default pilot's version endpoints had
converged. A later SDK orientation read passed with HTTP 200 and 123 work items;
source inspection confirmed the route exists. The peer later confirmed both
orientation reads returned HTTP 200 (Room sequence 22761). Staggered per-room propagation is
a hypothesis, not a proven routing defect. No speculative patch was applied.

Independent strict/live verification subsequently passed on stable `c47c3fc`
source before and after, with readiness 527/198 ms and live-smoke p95 200 ms.
Authenticated identity, Board and orientation reads passed. Manual publication
followed that verification: the downloaded
[runtime package](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-c47c3fc)
verified 632 archive files against 631 source files, with archive SHA-256
`3bf1f3f7fc0e9112800a75d0e7847429bcefd25695522bd620b7b34d12f5914e`;
the API confirmed it latest. The peer independently verified the 632-file
published runtime and a 200 orientation response in 112 ms (Room sequence 22769).
The deployment claim was released and read back as
unclaimed. This is an independently verified release and publication checkpoint,
**not a successful deployment-workflow run**. At this checkpoint,
[CI run 40857577869](https://github.com/Uuriko/project-room/actions/runs/40857577869)
reported 26 failures, all reproduced on baseline `8b19` in
[run 40838212637](https://github.com/Uuriko/project-room/actions/runs/40838212637).
They are inherited failures, not harmless results; CI is not green. The test-only
repair [#5250](https://github.com/Uuriko/project-room/pull/5250) merged at
`772ec49e868db65c36a7725593eaf5cf662889ee`, exact tree
`4ccc427f3bc66642b2b37cd63620d4a72d8068e9`. Its earlier landing refused
because the PR was still draft; after it was marked ready, the guarded merge
succeeded and the merge slot was released/read back as unclaimed. This test-only
repair was not redeployed and does not erase the original CI failures.

The inherited selected-work navigation assertions were subsequently corrected in
[test-only #5252](https://github.com/Uuriko/project-room/pull/5252), merged at
`ee846dc21f2576e9880b98d88ad2544b0c1288b8`. Thirty browser cases across eight
scripts passed. This repairs the tested navigation contract; it does not erase
original failures or imply a product deployment. A separate mobile usability
observation remains unresolved: Search results stay open above the selected
card, consuming the viewport (`offer-mobile-choices.png`, private screenshot).
Passing reachability checks does not establish that this layout is convenient;
no product fix is claimed for that observation.

Private receipts under `release-prep-20261029/` preserve these distinct outcomes:
`cohesive-verification/verify-8Osog2/receipt.json`, `cohesive-client-live.json`,
`cohesive-orientation-live.json`, `cohesive-peer-convergence.json`,
`cohesive-runtime-publication.json` and
`cohesive-release-claim.json`. The prior verified `0faa43b` release and earlier
readiness failures remain below; incident #5177 is not closed by this checkpoint.

On the initial `fc0725` composition, the peer reported 171 unit checks,
78 browser/workflow checks and two Worker checks; this Mac passed 149 unit and
65 browser checks. Integration review found a missing agent-orientation runtime
registration, an assistant run-ID overwrite, and a swallowed dispatch INSERT
failure. The repairs register the packaged dependency, preserve existing runs,
and commit a qualifying post and its derived run atomically before side effects.
A collision explicitly returns 409 and rolls the transaction back. Original
negative controls are retained; final package/assistant/first-result/unified
qualification passed 64 checks, with 54 focused assistant checks. Earlier
composition results are not presented as full qualification of the later repairs.
The exact merged runtime package verified 631 files, 134 assets and schema 42.
Private source-bound evidence is retained in
`release-prep-20261029/cohesive-integration-checkpoint.json`,
`cohesive-collision-before.log`, `cohesive-collision-atomic-before.log`,
`cohesive-release-final-tests.log` and `cohesive-runtime-final-create.json`.
These source and package checks alone do not establish deployed usability.

Previous integrated release
[40837088951](https://github.com/Uuriko/project-room/actions/runs/40837088951)
succeeded on `0faa43b83225ab59f4a7cbaba9fe294b22b40def`, tree
`cbecffa8755d4502375c65108bb545e20da656fc`. All four version endpoints,
authenticated identity and scoped Board reads passed. Independent strict and
live verification passed with stable source before and after: readiness was
62/68 ms and live-smoke p95 was 286 ms. The
[runtime package](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-0faa43b)
was independently downloaded and confirmed latest: 631 archive files against
630 source files, archive SHA-256
`39ebc423dc2661c54361dfdf9d4f7ba4a7cd684ad394082858ca357cb90d95d4`.
The deployment claim was released and read back as unclaimed at
2026-10-29T07:50:15.919Z. These receipts establish a verified release checkpoint,
not a permanent readiness cure or completion of the remaining architectural work.
Private evidence is retained under `release-prep-20261029/` in
`integrated-verification/verify-tIAQwA/receipt.json`,
`integrated-runtime-publication.json` and `integrated-release-claim.json`.

Previous release [40831070575](https://github.com/Uuriko/project-room/actions/runs/40831070575)
deployed `2b1d3ff2713d8091dbbe220b097fc47fff8b3a41`. Four version endpoints,
authenticated identity and scoped Board reads passed. Workflow readiness
passed at 56/35 ms; independent verification passed at 94/102 ms, with stable
source before and after. The downloaded [runtime package](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-2b1d3ff)
matched the qualified source and was confirmed latest at that checkpoint. The deployment claim
was released. These are point-in-time checks; [incident #5177 remains open](https://github.com/Uuriko/project-room/issues/5177#issuecomment-6490096702)
after the bounded follow-up comparison; this was not a rerun-until-green loop.
The completed 20-cycle observation returned 40/40 readiness responses with HTTP
200, with all observed versions still `2b1d3ff`. Canonical/entry elapsed-time
medians were 108/144 ms, p95 713/519 ms, and maxima 773/831 ms. This limited
observation does not establish a permanent readiness cure or close the incident.

Earlier release [40824263799](https://github.com/Uuriko/project-room/actions/runs/40824263799)
deployed `2d72bb7ffaf911ffa7801113de55e9130e208734`. Both entry points reported
that source in Worker and application responses; authenticated identity access
worked. The downloaded [runtime package](https://github.com/Uuriko/project-room/releases/tag/runtime-2026-10-29-2d72bb7)
matched all 630 exact-source files. Workflow smoke passed, but independent
readiness verification failed afterwards: [incident #5177 evidence](https://github.com/Uuriko/project-room/issues/5177#issuecomment-6489081310).
A publication receipt proves package identity, not current service health.

The verification CLI (#5199), release-record importer (#5202), portable archive
creator (#5203), existing-release integrity check (#5201), skipped-probe
publication fix (#5205), and pinned publication tooling/correction tags (#5211)
are merged. Records currently import public verification evidence; authenticated
journeys, deployment and publication remain separately inspected evidence.
Do not label their adapters implemented merely because the original receipts exist.

Cold work-only reads (#5213) now extract work-view fields and hydrate work
entities without loading unrelated conversation bodies. On its composed source,
57 checks passed. Reopened-store HTTP fixtures with 10 and 100 messages made
zero full-room hydration calls and returned 1,515/1,516 bytes; inline and
body-at-rest modes passed. Fresh authorization, work corruption refusal and
full-cache isolation remain checked. Selected-message mention resolution
(#5212) also uses fresh membership without hydrating room history. SQLite still
scans projection JSON; these changes do not complete A1, normalize all storage,
or prove a readiness cure. [Run 40827203823](https://github.com/Uuriko/project-room/actions/runs/40827203823)
deployed `eaa97768eb0c21f0ed22d47ed27d20286abeb6be`: all four version
endpoints converged and authenticated work reads succeeded. Both workflow and
independent verification failed the two readiness probes. Recovery held for
diagnosis; no rollback or runtime publication occurred, and the deployment
claim was released. That failed rollout did not replace the prior runtime package.
See [the preserved failure and recovery evidence](https://github.com/Uuriko/project-room/issues/5177#issuecomment-6489451932).

Archived history pagination (#5206) is included in the current verified release.
It seeks by sequence and message ID, preserves shared-sequence siblings across
count and byte boundaries, and stops after a page plus lookahead. The composed
source passed 47 checks, including cold-work and conversation regressions.
The five-result archive fixture previously loaded 266 bodies; it now loads at
most one 128-row batch. This bounds materialization, not every SQL row examined.

Reply-context duplicate traversal (#5219) reduced a local 20k-message fixture
from 245 to 166 SQL calls and approximately 210 to 60 ms. Metadata/body separation
(#5224) then removed 2,288,890 bytes of unrelated archive body materialization
and reduced SQL result bytes from 9,604,671 to 4,786,891. Its additional latency
effect was inconclusive. Canonical corruption checks, strict JSON validation,
private-message boundaries and page budgets remain covered. Both changes are
deployed; their local timings are not production CPU measurements.

The SDK Board read (#5221) now uses the shared authenticated Board service,
preserving legacy credentials, halts, session binding and read-only claims.
Runtime dependency completeness and service/HTTP/MCP parity were repaired in
#5225 before publication. The production Board read passed with the expected
viewer and revision. The SDK selected work-packet improvement
([#5232](https://github.com/Uuriko/project-room/pull/5232)) is now deployed in
`0faa43b`. The server selected work-context follow-up
([#5235](https://github.com/Uuriko/project-room/pull/5235)) is merged in #5249 and deployed in the independently verified `c47c3fc` release;
its earlier 85 passing tests were peer-reported qualification.
Default orientation still needs separate work.

Remaining read debt includes global reply-context metadata/event scans,
retained-message processing, default orientation call chains,
verified archive hydration and full projection scan cost. Preserve private
message, history-floor, index repair and corruption-recovery semantics while
reducing those reads. The 4 MiB projection cap remains unchanged.

Stored production logs show expensive reply-context calls alongside slow
readiness requests. Twelve reply-context invocations in one minute charged
18,694 ms CPU. A traced readiness failure included a storage RPC that completed
in 320 ms despite the caller exceeding its one-second deadline. These are
contention leads, not proof that one route explains every timeout. Keep the
readiness contract and investigate the shared-object work before changing it.

An independently inspected external telemetry bundle
([source commit](https://github.com/Uuriko/project-room/commit/d2b7bb138b975f0b0966e7beec02c20f409697cb))
preserves 400 requests in 40 complete cycles during 2026-10-29 06:00–06:22 UTC,
across the earlier `2d72`/`eaa` serving window. All nine manifest hashes matched;
the 205,165-byte dataset SHA-256 is
`ffbe429d0c612ec4d1987550c60798d73c2dc91b27a332d2b52c84643b673c0c`.
Independent counting found 32/80 readiness responses were HTTP 503, all reporting
a 1,000 ms DO timeout (17 canonical, 15 entry). Entry `/join` total latency p95
was 3,914 ms and maximum 7,941 ms; these are HTTP request measurements, not
browser rendering, sign-in or completed-join timings. Expected entry-home 302
responses were recorded without following their redirects.

The telemetry supports the historical incident evidence, not a current `c47`
health assessment or causal before/after speedup. Its `/api/version` control is
DO-backed, not the Worker-only endpoint. All curl records show one private
remote address and HTTP/1.1, while proxy configuration was not captured; the
reported wait phase includes unresolved network/proxy/server time and cannot
exclude network effects or isolate DO dispatch, constructor and handler costs.
Capture logs and the checkpoint referenced by the report were not included, so
their exit-status claims were not independently verified. Any future bounded
comparison should retain source, vantage/proxy metadata and a Worker-only
control, then correlate request identifiers with stored Cloudflare timings.
The bundle was inspected offline; no continuous probe was enabled.

The original manual two-laptop trial did not verify native execution. Both laptops ran the
same pinned-source native-host guard tests: 10 passed on each, but the peer ran
them manually and its native receiver was stopped. The manual run does not
populate the native request journal; the original request was answered with
the retained result and independently read back as closed, without rerunning.
The peer receiver was configured for legacy watch mode. Selected-request support
([#5226](https://github.com/Uuriko/project-room/pull/5226)), cancellation recovery
([#5227](https://github.com/Uuriko/project-room/pull/5227)), and native selection
([#5229](https://github.com/Uuriko/project-room/pull/5229)) are now merged through
`46321313bfff5de23ccfb87e4957ef109668494e`. Cancellation qualification passed
81 checks with one Linux-only skip; an independent cancellation/restart check
observed one delivery POST across restart. Swift acceptance passed 110 assertions
using a fake-node fixture, not a live model.

An actual native app was built from a clean checkout of that exact merged source,
with 52 runtime files; ad-hoc signing and deep strict signature verification
passed. The peer downloaded and verified the app but has not installed it.
A subsequent packaged-CLI trial on the exact `46321313` source used a writable
scratch workspace with the source export outside it. Node 24.19.0 ran the two
native-host test files: 10 passed, zero failed or skipped, in 206.913667 ms
(228.638791 ms command wall time); all 3,915 source-file hashes were unchanged.
An initial Python wrapper failed before tests; the actual Node command ran once.
The prior read-only run's five passes and five temporary-write failures remain
part of the evidence, not a successful test result.

After an injected post-commit acknowledgement loss (HTTP 201, Room sequence
22618), restart reconciled the same operation, attempt and response digest.
Local delivery changed from pending to delivered, exiting 0 at
2026-10-29T07:38:24.664Z. The completed model-turn count remained one and
`providerTaskStartedCount` was one. This demonstrates cross-laptop packaged-CLI
execution and saved-result recovery for the injected failure. It does not prove
installed desktop execution or every disconnect/cancellation case. The matching
local ten-test run took 269.583584 ms; receiver launch to answer took about
69 seconds, so no overall speedup is claimed. See the existing
[host guide](CODEX-ROOM-HOST.md#test-jobs-that-need-temporary-files) for the bounded
scratch configuration. Preserve selection and consent when installing the app;
do not replay the already-answered original manual trial. The original stopped
process's exit cause remains unknown.

The local MCP connector was also stale: its validator rejected the same
answered-request response that the qualified runtime accepted. A fresh stdio
process passed. The connector configuration now points to the verified runtime,
but the existing chat process has not reloaded, so active-tool adoption is not
yet proved. Identity files, journals and the native app were left intact.
Treat installed, configured and actively loaded revisions as separate evidence.

The stream-handover oracle correction
([#5214](https://github.com/Uuriko/project-room/pull/5214)) preserves the original
failure and verifies contiguous events, horizon and final content without
requiring an unnecessary snapshot GET. Its 18 checks include lost-event and
incorrect-content controls; this is an oracle correction, not a runtime fix.
The handoff and timeline test-debt fixes
([#5181](https://github.com/Uuriko/project-room/pull/5181),
[#5182](https://github.com/Uuriko/project-room/pull/5182)) are merged; duplicate
[#5230](https://github.com/Uuriko/project-room/pull/5230) was closed.

Private maintainer receipts retain the original failures and exact evidence:
`release-prep-20261029/execution-checkpoint.json`,
`readiness-bounded-2b1-summary.json`, `native-selected-build-receipt.json`,
`PR5229-SWIFT-REVIEW.json`, `native-corrected-job-evidence.json`, and
`stream-failing-grok-22418.json` (the latter five
under the same evidence directory). These are local evidence references, not
public download links; do not publish private logs or identity material.
Inventory reconciliation remains bounded: ten of 104 bundle dispositions have
been reviewed in the first pass. This checkpoint does not complete the remaining
94 decisions or establish incorporation of every historical requirement.

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

The numbered implementation proposal below is retained for its design and
acceptance criteria, not as a current queue. The verification-record adapter is
implemented; use [its current contract](RELEASE-RECORD.md). Broader merge,
deployment/publication adapters, controller and signing work remain incomplete.

## 1. Finish the current delivery without coupling it to this overhaul

1. Reconcile current PR heads and merged trees, including the peer's frozen
   conversation candidate #5188. Preserve its actual browser evidence.
2. Integrate #5199 and publication integrity independently of UI work. Reuse
   focused evidence where code is unchanged; test actual composition boundaries.
3. Deploy the selected qualified product revision once. Check both serving
   origins and Worker/application version endpoints, readiness and signed cards.
4. Run authenticated agent and essential human journeys separately from public
   smoke. Record scope honestly; public health is not sign-in verification.
5. Publish only the matching artifact. Keep #5177 open until evidence supports
   closure; retain the original stream failure alongside the qualified oracle
   correction without implying an unproved runtime repair.

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
