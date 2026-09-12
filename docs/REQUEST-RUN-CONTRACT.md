# Chat-request execution

Status: executable policy implemented; **not wired into the service, agent tools or UI yet**. Existing local execution still requires a work item. This contract is the next integration slice, not a release claim.

## Product boundary

A message is conversation. An explicit reply request asks another participant for an answer. A request run records one recipient's bounded attempt to produce that answer. None requires a Work Item. A future automation selects requests and initiates these same runs rather than inventing a second execution path. Human and agent recipients use the same policy; a requester does not gain access to the recipient's machine, credentials or paid services by sending text.

The implemented pure policy is `src/request-run-policy.js`. It never creates work, answers a request, starts a process or grants external authority. The trusted executor must separately configure the permitted program and resource limits.

## Ownership and failure behavior

- Claim only an open request addressed to the authenticated participant. Pin its context event and room-instruction revision. Use expected run revision, a distinct run ID, runtime and output limits.
- Commit the claim in the existing command transaction before starting a process. A duplicate receipt confirms the old claim, not permission to launch another process.
- Only one running or stop-requested attempt may exist. Time passing makes execution disallowed but **never** frees ownership: a crashed supervisor can leave a live child.
- Requester, recipient or human room owner may request a stop. Only the executing recipient may report terminal status. Stop requested is not stopped. Remote claims cannot prove OS process termination.
- An executor must stop on cancellation, answer, context/instruction change, access loss, deadline or explicit stop. It cannot undo effects already performed. Success after these changes is refused; a failure/cancellation report remains possible.
- A new attempt requires a recorded terminal predecessor, fresh explicit authorization and a never-reused run ID. Retain all IDs; cap at three attempts per request. No automatic retry or timeout takeover.
- Process success is not an answer, work completion or approval. Answer posting still requires the original inspected context basis and exact idempotent retry.

## Integration gates, in order

1. Register claimed/stop-requested/finished events in the existing event reducer and strict command field allowlists. Derive actor and request from authenticated current state, never request-supplied identity. Retain bounded run state per request; write claim and receipt atomically. Competing processes must yield one first claim, with no execution on duplicate receipts.
2. Introduce schema v31 writer fencing before accepting these new events: old readers/writers cannot replay unknown event kinds safely. Add genuine v30-to-v31 Node and Worker migration tests, data preservation, pre-open old-writer rejection, rollback and recovery replay checks. Do not deploy or migrate production data.
3. Expose authenticated read/claim/stop/finish operations through the shared agent registry and CLI. Validate exact receipts. Account switching/revocation must invalidate reads and mutations. No public run data, raw program arguments, environment or credentials in discovery/events.
4. Reuse the local process supervisor with request ownership instead of manufacturing a work item. Private journal reservation remains before execution. Unknown claim never starts; unknown terminal write never restarts; retained answer retries never refresh context silently.
5. Add compact run status beside the request and a scoped Stop control. Both humans and agents can initiate authorized runs. Ordinary messages stay unaffected; no job picker before chat. Label expired ownership unconfirmed, not idle.
6. Acceptance: human-to-agent and agent-to-agent requests without work; competing authenticated executors; lost claim/finish/answer responses; cancellation after actual process start; stale context; restart after a crash; limits and revoked access; desktop/mobile status and stop. Use synthetic programs first, not paid model calls.

Shared recurring automation follows these gates and needs its own scoped trigger, owner, enabled/paused state, bounded dispatch, run history and loop prevention. It is not delivered by the pure policy.
