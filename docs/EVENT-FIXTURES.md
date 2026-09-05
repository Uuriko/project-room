# Events and fixtures

Proposed v0 rules, 2026-09-05. The historical examples below adapt public coordination records; Project Room did not execute those events. The recovery cases are specified scenarios, not passing software tests.

## Work state and authority

Work states belong to one Work Item. Verification and human decisions are evidence about a particular result, not extra work states.

| Action | Work state before → after | Actor and required information |
| --- | --- | --- |
| Propose | New → proposed | Member with assignment capability; outcome, scope, completion requirements, and any required verifier or owner decision. |
| Accept | Proposed → accepted | Assigned accountable member; acceptance and a check for existing work. |
| Start or resume | Accepted or blocked → working | Accountable member or explicitly assigned executor; accepted attempt scope and, on resume, the resolved blocker. |
| Report existing result | Accepted → completed | Accountable member; exact result reference and claimed checks. No new attempt is required. |
| Report result | Working → completed | Accountable member; exact result reference and claimed checks. Another executor may supply the evidence. |
| Block | Accepted, working, or completed → blocked | Accountable member; reason and next responsible actor. A designated verifier may block completed work with a failed check. |
| Resolve without starting work | Blocked → accepted | Accountable member; blocker resolution, ready for a new attempt or an already-existing result. |
| Replace the outcome | Any non-superseded state → superseded | Member with assignment capability; replacement Work Item and reason. |

A completion report is allowed from an authorized accountable executor; it cannot create independent verification. Read-only work requires no write claim. If a Room-coordinated contested write is later supported, starting or continuing that write additionally requires a current resource claim. Claim expiry ends that write authority, not the member's ability to report a blocker or release its attempt.

## Checks and decisions

| Event | Required evidence | Effect on the current view |
| --- | --- | --- |
| Verification PASS | Designated verifier, distinct from the executor for an independent check; completion event, exact artifact version, check, and result. | Record PASS for that version and keep the work state unchanged. PASS alone cannot clear an unresolved blocker. |
| Verification FAIL | Designated verifier; exact completion/version, finding, and source evidence. | Current version becomes blocked; preserve its earlier completion and checks in history. A late result for an older version changes only that version's history. |
| Owner approved | Designated human decision-maker; work is completed, current completion/version, and all required checks satisfied. | Show approval of that result and proposed next action. An external action still needs its own authorization and execution evidence. |
| Owner requested changes or rejected | Designated human decision-maker; current result/version and reason. | Block remaining work or action; record the decision. New execution needs an accepted direction. |
| New result version | Accountable member; replacement artifact/version and a fresh completion report through the work-state rules. | Checks and decisions for older versions remain historical and do not apply to the replacement. |

Late evidence may be preserved for its original version but cannot clear a blocker or approve the current version. An ordinary discussion reply has no state effect by itself. An owner gate that was not required does not create a pending approval.

## Historical fixture A: an existing result

Source: the [#134 coordination fixture](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550301667), referring to [PR #134](https://github.com/Uuriko/dasha-desk/pull/134) at `70053cc6cf9d86f3a43220dcfbb0af05797380c0`.

| Recorded input | Room interpretation |
| --- | --- |
| Operator asks for the outcome. | Proposed Work Item with an owner merge decision required. |
| Codex finds the existing change. | Accepted responsibility; preserve the exact revision and avoid a replacement patch. |
| Codex returns that result. | Completion report; work is completed without a new write attempt or claim. |
| Instinct reports 28/28 checks and an invariant comparison at that revision. | Separate verification evidence for that version, as reported in the source. |
| The source says owner merge is pending. | Show the unresolved decision. Do not fabricate an approval or merge event. |

These are historical inputs, not a fresh assertion about the PR's live status.

## Historical fixture B: another executor satisfies the outcome

Source: the [faucet walkthrough](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550281808) and [failure-path discussion](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550315649).

Grok's external execution may satisfy the same outcome Codex was pursuing. Preserve the observed external result; the accountable member records its completion. The abandoned Codex attempt can be superseded without superseding the desired outcome. A separate verifier checks the exact external result.

The public walkthrough does not supply a fully resolvable deployment receipt or a real claim-expiry event. It illustrates the intended mapping; it cannot serve as proof that Room claims prevented a collision. A future fixture must identify the deployment and check evidence before claiming verified completion.

## Recovery cases to exercise in the first implementation

| Case | Expected result |
| --- | --- |
| A second person joins. | An authorized member sees the goal, owner, recorded result, checks, and next action without a pasted recap. A source outside the shared audience is not introduced into that conversation. |
| Worker becomes unavailable. | Preserve its last confirmed step and show availability. An unknown external action outcome remains unresolved; reconnecting does not blindly repeat it. |
| Application restarts. | Reconstruct the same view from stored events and source references; issue no external actions during replay. |
| The same receipt arrives twice. | Keep one logical receipt. Do not repeat a handoff or action. Reuse of the same source event ID with conflicting payload is rejected. |
| Two actors update the same revision. | One revision-checked mutation wins. The stale mutation records no misleading state-change event and must refresh before proceeding. |
| Artifact changes after PASS or approval. | Show that earlier evidence belongs to the old version. The current version needs its own completion, checks, and any required decision. |
| Independent verification fails. | Show the finding and next responsible member, preserve prior evidence, and block the current work. A later PASS alone cannot restart work or close an unresolved blocker. |
| A future coordinated write claim expires. | Stop authority to continue that write; require a new valid claim for another attempt. Preserve history. This case is outside the first read-only review loop. |

These cases define acceptance behavior. Claiming they pass requires execution evidence from an implementation.
