# Dasha Compute bridge: six acceptance cases

September 7, 2026. Original analysis by the Room member `producer` for
`dasha-bridge-acceptance`, sourced from message `bridge-research-task`.

The next useful step is a durable, simulated submission adapter that proves
recovery before any real inference. The six cases below describe acceptance
requirements for a future bridge; they are not results of executing Compute.

## Current boundary

The assigned [research brief](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md#what-exists-in-our-projects)
reports that Room already supports assignment, scoped credentials, explicit
accept/start/complete transitions, version-bound review, durable events and owner
decisions. It reports no Dasha execution adapter, MCP transport, unattended runner
or per-tool spending grants.

That brief describes the inspected local Dasha kit as an in-memory coordinator
with new job IDs per submission and no consumer lookup/cancel or submission
idempotency contract. These are findings about that inspected local kit. The
hosted API and its capabilities remain unverified here. This analysis did not
inspect either implementation or execute inference.

## Proposed acceptance matrix

Every row is a proposed bridge requirement. References point to the assigned
brief's source sections, not independently verified live capabilities.

| Case and source | Trigger and expected behavior | Observable evidence required to pass |
| --- | --- | --- |
| **1. Selected context and permission** — [proposal steps 1–2](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md#the-smallest-useful-bridge--proposed-not-shipped) | Select two messages from a larger room. Authorize a named audience, route, model, output limit, deadline and spending ceiling. Submit only that selection. Changing any authorized field requires fresh authorization; Room membership or acceptance alone cannot authorize dispatch. | Compare the captured outbound package with the selected items and context digest. Record the authorizer and exact grant. Changing route or adding a message prevents submission until reauthorized. Credentials never appear in the package or receipt. |
| **2. Duplicate submission** — proposal steps 3–4 | Deliver the same submission twice and replay Room events. Both deliveries recover one attempt and one Compute job; replay initiates no inference. If the backend cannot guarantee this, automatic resubmission is unavailable. | Persisted attempt contains work revision, context digest, command and correlation IDs. A simulated backend dispatch counter remains one; both replies identify the same job. |
| **3. Unknown outcome** — proposal step 3 and [existing-kit limitations](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md#what-exists-in-our-projects) | Lose the reply after backend acceptance, then restart the adapter. Preserve “unknown” while reconciling the original attempt. A timeout cannot imply failure, success or permission to submit again. Without lookup or idempotency, stop automatic retries. | Durable attempt survives restart; status queries target its original identity. Injected response loss produces no second dispatch. A later authoritative reply resolves that same attempt, with uncertainty visible until then. |
| **4. Cancellation acknowledgment** — [cancellation and transport patterns](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md#what-to-learn-and-where-it-belongs) | Request Stop during output, delay acknowledgment and deliver a late result. Show “Stopping” until confirmed; preserve the late result. Distinguish reported cancellation from proof that execution stopped. | Timestamped stop request, backend acknowledgment and terminal result remain separately inspectable. Output load does not hide stop/status responses. No canceled state appears solely because the client disconnected. |
| **5. Exact output review** — proposal steps 5–6 | Complete with artifact A, then replace it with B. A different reviewer checks A's exact bytes/version; that finding cannot approve B. A successful job does not supply owner approval. | Receipt records actual model/build when known and output hash. Retrieved bytes match the reviewed hash and completion event. Replacement invalidates the current review; any required owner decision remains pending. |
| **6. Unknown usage/cost** — [reserve/settle pattern](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md#what-to-learn-and-where-it-belongs) and proposal step 5 | Omit usage and final settlement from a terminal response. Keep both unknown, distinguish ceiling/reservation from final cost, and reconcile later reports without silently enabling paid fallback. | Receipt shows measurement source and timestamps when supplied, explicit unknown fields otherwise, and separate authorized limit, reservation and reported final cost. No missing value renders as zero or settled. |

## One small next slice

Build a loopback fake-Compute adapter with a persisted outbound-attempt record
and injected lost-response/restart behavior. Exercise cases 2–3 first: one job
under duplicate delivery, recoverable uncertainty after response loss, and zero
dispatches from event replay. Keep live Compute disabled. Obtain the hosted API
contract from its owner before choosing production endpoints or claiming these
guarantees extend to Dasha.

## Producer record

Used only the write guide for Room client usage and the assigned research brief
for analysis. Accepted and started through the documented client. Six cases and
the proposed next slice were checked against the source. No Compute, billing,
deployment or human approval occurred. Independent review is pending at submission.

The guide was sufficient for Room discovery and commands. The operator supplied
the Node runtime, private producer configuration, local network permission and
fixture evidence-publication procedure. No mistaken command, failed action or
blocking documentation ambiguity occurred before artifact publication.
