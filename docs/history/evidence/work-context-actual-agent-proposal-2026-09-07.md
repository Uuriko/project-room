# Proposed acceptance checklist: cancellation handoffs

Status: proposal for a future agent-run flow. None of the behavior below is claimed to be implemented or tested. This draft addresses task `cancellation-checklist` and its linked request. It separates cancellation delivery, execution state, final usage/cost, and approval.

## 1. The cancellation request times out

**Proposed case:** The operator sends cancellation request C1 for run R1. The response times out before Room receives an acknowledgement. No worker stop confirmation exists.

**Proposed Room display:** “Cancellation requested; acknowledgement unknown.” Show “Execution status unknown” or the last observed execution state with its timestamp. Show final usage and cost as unknown unless independently confirmed. Do not display “Stopped,” “Cancelled successfully,” or zero cost merely because the request timed out. If a later acknowledgement arrives, show “Request acknowledged; stop not confirmed.”

**Proposed human next action:** Refresh the same run’s status and inspect its latest evidence. Offer an explicit retry of the same cancellation request identity, C1, with duplicate handling; do not create a new run. If status remains unavailable, the operator follows up with the worker through an authorized channel. Uncertainty stays visible.

**Proposed observable acceptance evidence:** A controlled trace records R1, C1, send time, timeout, and any later acknowledgement separately. Captured Room states retain the unknown stop status. The retry trace retains C1 and demonstrates that duplicate delivery creates no additional cancellation intent or run. These are required future checks, not results of this drafting exercise.

## 2. The worker confirms it has stopped

**Proposed case:** After C1, the worker reports that execution of R1 has stopped at time T2. Its final usage report has not arrived.

**Proposed Room display:** “Worker confirmed stopped at T2,” linked to the confirmation. Separately show “Final usage/cost pending.” Label any available usage estimate as provisional, with its observation time. An acknowledgement that cancellation was received cannot satisfy the stop condition.

**Proposed human next action:** Inspect the stop evidence for the exact run and wait for, or request, the final accounting record. Escalate missing accounting under the operator’s policy. Do not infer a refund, zero charges, or spending approval from a stop confirmation.

**Proposed observable acceptance evidence:** A trace distinguishes the request acknowledgement from a worker-authored stop event identifying R1 and T2. A captured state shows stopped execution alongside pending accounting. A later final accounting record updates usage/cost with its provenance while preserving the stop event. Missing final values remain unknown.

## 3. A result arrives after cancellation was requested

**Proposed case:** An output for R1 arrives after C1 was sent, regardless of whether stopping has been confirmed.

**Proposed Room display:** “Result received after cancellation request; review required.” Show the exact artifact version, producer attribution, receipt time, and cancellation timeline. Preserve the separately supported execution and accounting states. Receipt alone does not mark the output verified, accepted, or human-approved.

**Proposed human next action:** Inspect provenance and route the exact artifact to the designated independent reviewer. Then the designated human decision maker decides whether to accept, reject, or request revision. No late output is automatically applied or published.

**Proposed observable acceptance evidence:** The request and receipt have correlated run IDs and ordered timestamps; the artifact has retrievable bytes and a matching hash. Review references that version. The decision remains pending until a distinct authorized human decision event exists.

Draft handoff: independent review first, then the designated human decision. This document supplies proposed criteria only; it authorizes no provider action, compute, payment, publication, or deployment.
