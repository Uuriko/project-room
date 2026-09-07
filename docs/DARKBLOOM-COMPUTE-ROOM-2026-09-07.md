# Darkbloom → Dasha Compute → Project Room

September 7, 2026. Read-only architectural research, not an implementation or a
security audit. Darkbloom snapshot: `0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0`.
Inspected selected routing, admission, settlement, transport, key UI and test
code, plus architecture/provider documentation. This is not a review of every
file. No Darkbloom code was installed, executed, copied into either product, or
used to run inference. Dasha's local public kit was inspected independently.

## Decision

Keep Project Room as the place people and agents agree on work, contribute,
review and decide. Keep Dasha Compute responsible for running inference jobs.
Connect them with one small, permissioned adapter. Develop Dasha in a dedicated
Room before depending on that adapter: coordinating development does not require
Project Room to execute the models itself.

The useful lesson is a set of explicit contracts, not Darkbloom's total feature
count. A request needs a known audience, route, budget, execution identity and
recoverable outcome. A person should see one compact work card; agents should
receive the same facts as structured data.

## Reuse boundary

Darkbloom is public source, **not permissively open-source software**. Its current
license restricts operating its software in other products, including competing
inference coordination and compute marketplaces, without written permission.
Do not transplant its coordinator, provider, configurations or UI into Dasha.
If direct reuse becomes desirable, obtain license review and permission first.
This brief proposes independently designed behavior, not a legal clearance for
derivative implementation. [License](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/LICENSE)

For reusable inference foundations, evaluate upstream MLX Swift and MLX Swift LM
separately: their current repositories carry MIT licenses. Pin the exact upstream
versions and review model-weight licenses independently; do not assume Darkbloom's
modified dependencies have identical rights or capabilities.
[MLX Swift](https://github.com/ml-explore/mlx-swift/blob/main/LICENSE),
[MLX Swift LM](https://github.com/ml-explore/mlx-swift-lm/blob/main/LICENSE)

## What to learn, and where it belongs

| Source pattern | Dasha Compute application | Project Room application |
| --- | --- | --- |
| Explicit owned-only versus owned-preferred routing | Separate strictly local/owned execution from permission to use other capacity | Show the permitted route before starting; never silently widen the audience or allow paid fallback |
| One shared eligibility decision | Model discovery and dispatch agree about usable capacity and explain rejection | Available tools reflect actual permissions/capabilities, not optimistic buttons |
| Reserve before dispatch; settle afterward | Distinguish a spending limit, a reservation, reported usage and final cost | Compact cost summary; expandable provenance; unknown cost is not zero |
| Cancellation has its own lifecycle | A request to stop is separate from confirmed stop and late completion | Keep “Stopping” until acknowledgment; retain a late result without falsely claiming cancellation succeeded |
| Alias separated from exact model build | Record requested model and actual build/hash | Receipt identifies what really ran, even when the friendly name stays unchanged |
| Typed, bounded operational telemetry | Capacity and health without prompt logging | Show progress and freshness, not a flood of traces or private reasoning |
| Source-bound acceptance evidence | Same model/input/runtime when comparing runs | Pin artifact and completion versions; review cannot silently migrate to a later result |

Darkbloom's self-route policy is derived from authenticated identity. A key can
enforce owned-only execution even when a request asks to prefer owned capacity.
The latter permits paid fleet fallback; it is not synonymous with free-only.
This distinction is particularly useful for user-controlled agent budgets.
[Policy code](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/coordinator/api/self_route.go),
[operator contract](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/docs/provider/self-route.md)

Its shared routing gate returns named reasons instead of allowing discovery,
warming and dispatch to invent incompatible definitions of availability. Borrow
that maintainability principle, not its exact trust architecture. Start Dasha
with a small capability vocabulary and one authoritative eligibility function.
[Eligibility source](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/coordinator/registry/routing_eligibility.go)

Admission checks reserve funds before work; terminal settlement handles late
provider reports after a consumer disconnect. For our bridge, durable
reconciliation is more important than copying timing constants. A disconnected
browser cannot tell us that work stopped or cost disappeared.
[Admission](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/coordinator/api/inference_admission.go),
[settlement](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/coordinator/api/settlement.go)

Control messages have a priority transport lane, although they cannot interrupt
a write already in progress. Our equivalent requirement is that stop and status
requests remain responsive under output load, with honest acknowledgment—not a
claim of instantaneous cancellation.
[Transport source](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/coordinator/registry/provider_writer.go)

Model manifests distinguish an alias from exact verified bytes. Diagnostics
distinguish continuing heartbeats from fresh measurements. Both ideas protect
Room receipts from saying “same model” or “still progressing” without evidence.
[Model registry](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/docs/architecture/model-registry.md),
[telemetry](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/docs/architecture/telemetry.md)

## What exists in our projects

Project Room already has assignment, scoped member credentials, explicit
accept/start/complete transitions, version-bound review, owner decisions, a
structured HTTP client, durable events and a return brief. It does **not** yet
have a Dasha execution adapter, MCP transport, an unattended agent runner or
per-tool spending grants. The existing [bridge](BRIDGE-COMPUTE.md) is a proposal.

Dasha's public kit is `/Users/johnpotter/src/dasha-desk/compute/`. Its README
already states that it was independently written without copying Darkbloom.
Its local coordinator really routes requests to polling providers, which invoke
Ollama and return complete or streamed output. However, that coordinator keeps
jobs in memory, generates a new job ID per submission and removes a job after
responding. The inspected route table has no consumer job lookup/cancel endpoint
or submission-idempotency contract. Room correlation fields are not retained.
Sources: `compute/coordinator/server.mjs:88`, `:94`, `:113`, `:195`.

The hosted Dasha Worker is explicitly absent from this source tree. Documentation
describes a durable hosted queue and account-bound keys, but those are not verified
live findings from this review. Do not conclude that hosted Dasha lacks a feature
because its local demo lacks it. Obtain the current hosted API contract and
source/evidence from its owner before writing the adapter. Sources:
`dasha-desk/README.md:9`, `docs/ROUTES.md:3`, `compute/README.md:20`.

The kit's threat model says coordinator and provider operators can inspect
prompts; billing and hardware attestation are absent. Cancellation may suppress
a nonstream result only after inference finishes. Do not turn a provider report
into proof of stopped execution, independent quality verification or settled
payment. Sources: `compute/THREAT_MODEL.md:15`, `provider/agent.py:105`, `:261`.

Darkbloom's own detailed encryption documentation also shows transient plaintext
inside its coordinator and inference process. Its architecture is not evidence
that Dasha inherits equivalent protection. Encryption, hardware posture, output
correctness and the user's permission to share context are different questions.
[Darkbloom privacy boundaries](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/docs/architecture/security/encryption.md)

## The smallest useful bridge — proposed, not shipped

1. A Room owner enables Dasha for one task type. A server-held, restricted Compute
   credential is separate from Room membership and never enters messages.
2. The worker chooses a small context package: selected messages/files, not the
   entire room. The grant records audience, route, model, maximum output, deadline,
   any spending ceiling, and who authorized it. Changes invalidate authorization.
3. Persist an outbound attempt before submission, with room/work/revision,
   context digest, command ID and correlation ID. A retry must recover the same
   Compute job. If the API cannot establish this, leave the outcome unknown and
   stop automatic resubmission.
4. Compute remains authoritative for execution state. Read progress and reconcile
   terminal state by job ID. Record received events idempotently; replaying the
   Room's history must never initiate another inference request.
5. Return a receipt containing actual model/build, output version, provider class,
   source of usage measurements, timestamps and reported cost status. Missing
   values stay unknown. Tool output is untrusted evidence, not instructions or
   permission to take the next external action.
6. A different reviewer evaluates the result. The owner decides when required.
   A successful Compute job alone does not mark the entire work item accepted.

Use one domain implementation behind HTTP first; a later MCP adapter should expose
that same contract. Proposed actions are discover, estimate, submit, status and
cancel—not a second workflow database. No endpoints or MCP tools with these names
are claimed to exist yet.

In the interface, keep this inside the existing work flow. Before a run: task,
selected context and a short route/cost confirmation. During it: a status line and
Stop. Afterward: result and Review. Put model versions, usage, full permissions
and diagnostics under Details. Avoid a permanent compute dashboard inside Room.

## A Dasha development Room can come first

Use a dedicated room for a source-linked development brief, an assigned agent,
an independently produced patch or design artifact, a separate reviewer and an
owner decision. Attach exact repository commits, issue/PR references, commands
run, test outcomes and unresolved assumptions. Git remains the source of code;
maintainer acceptance remains distinct from a Room review. Do not ingest private
Dasha operations files, account secrets or wallet material.

First useful tasks: verify the hosted job contract; define an idempotent bridge;
build a loopback fake-Compute adapter test; check cancellation and duplicate
delivery; then evaluate one explicitly authorized, non-sensitive inference run.
This ordering gives real agent collaboration immediately without representing
the unbuilt Compute integration as live.

## Testing implications

Darkbloom has source/model/runtime-bound tests, guards against empty/skipped test
success, and tests preserving original capability requests. We should retain
the candidate fingerprint and original inputs, distinguish scripted providers
from actual agents, and preserve failed as well as passing evidence. This is a
method to adapt, not a claim that their tests pass here.
[Test guide](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/docs/developer/test.md),
[capability scope test](https://github.com/Layr-Labs/d-inference/blob/0b46b1618d43cae3ae3d8e0fde1a9cc6d974e9d0/e2e/release_capabilities_scope_test.go)

Next: follow [the testing system](USER-TESTING-SYSTEM-2026-09-07.md): simulated
human journeys plus actual orchestrator-started agents using the Room client.
No paid inference, provider installation, Dasha modification or deployment is
authorized merely by this research brief.
