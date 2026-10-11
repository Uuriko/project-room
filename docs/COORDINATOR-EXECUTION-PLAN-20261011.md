# Coordinator implementation plan and execution receipt

This plan turns the Notion/coordinator design into small reviewable changes. Preserve the current chat layout and existing run/attempt protocol. Do not add a second orchestration database or a compulsory Notion dependency.

## Batch 1: reliable server admission and discovery

### Atomic request admission

Add an optional `message` to `invoke` on the existing assistant endpoint. The server writes the normal message command and the assistant run within the same transaction. Validate normal message permissions, channel, body and reply rules through the existing command implementation. Retain the existing source-message invocation form for clients already posting separately.

Use stable request, run and source-message IDs. A successful retry returns the same receipt; changed input under the same operation ID is rejected. Derive the nested command ID from actor and request ID. No caller can supply another author or use this path for a private message. Rejection, including unavailable coordinator or run collision, must roll back message and run writes.

Implemented: `server/room-assistant.mjs`, `server/routes/room-assistant.mjs`.

### Persistent discovery

The existing opt-in `--watch` command runs oldest queued unclaimed work serially through the established shared runtime. Add a bounded read deadline and preserve cancellation. Never infer working state from discovery alone. Never claim another host's attempt. Stop on uncertain execution failure; explicit same-journal recovery remains required.

Implemented: `client/shared-assistant-watch.mjs`, existing CLI wiring from 957cd667.

### Acceptance

Test exact retry, altered retry, unavailable coordinator rollback, run-collision rollback, invalid channel/private payload, agent impersonation rejection, idle cancellation, stalled read, and atomic admission through actual discovery and fenced threaded publication. Existing shared runtime tests continue to own model-session, late-input, stop and publication recovery behavior.

New tests: `tests/assistant-admission.test.js`; extended `tests/shared-assistant-watch.test.js`. These use real Room HTTP/server/storage paths where relevant. The lifecycle test substitutes the model execution and therefore does not prove provider authentication or real model quality.

## Batch 2: use atomic admission in the composer

This remains required; the server change alone does not fix the browser's existing two-operation path.

1. Carry Ask Room intent with the exact persisted pending draft so reload and retries cannot downgrade an ask into ordinary chat.
2. Use the combined operation for plain public asks; preserve attachment ordering until their transaction boundary is explicitly handled.
3. Keep local echo keyed to the same source message ID. Distinguish stored/admitted from host pickup; no synthetic acceptance message.
4. Clear only the originating draft after an authoritative receipt. Preserve another room/thread's draft during navigation.
5. On a lost response retry the same operation. Do not fall back to separate message creation after an ambiguous result.
6. Integrate with PR2683's receipt-first UX rather than overwrite it. Qualify mixed-version deployment: API support must precede a client that depends on it, or the client must discover supported features safely.
7. Browser tests: lost response then reload/retry; double Enter; rejection; account/room switch during send; old server compatibility; attachments; visible exact-once message and run; no idle setup noise.

## Batch 3: make a live host genuinely available

1. Check current room coordinator, qualified host and ownership through live API. Last assistant read timed out; historical unconfigured state is not fresh proof.
2. Use one dedicated Room identity with the existing owner-controlled configuration endpoint; do not borrow another agent's credentials or silently change the user's account.
3. Qualify the dedicated runtime's provider authentication with a bounded real task, then run the watcher under a documented supervisor.
4. Add idle readiness independent of in-flight runs: scoped host session, heartbeat expiry, provider readiness and capacity.
5. Test a real human request, two-human contribution, streamed result and Stop before calling it connected.
6. On host loss show the request's retained state and useful recovery. Automatic restart must reconcile existing attempts and external outcomes before new execution.

## Batch 4: responsive multiplayer scheduling

Preserve one Room identity but separate conversation execution contexts. Build on current work claims for conflicting resources. Add a bounded pool and fair scheduling only after host capacity is explicit. A long build must not block another person's status question. Replies normally contribute to the current request; unrelated asks create separate requests; conflicts require an explicit resolution. Preserve requester attribution and visibility throughout.

Inspect open changes-feed PR2633 before adding another poll/feed design. Use cursor/reconnect semantics to reduce full projection reads. Record receipt, admission, pickup, first useful response and completion times separately.

## Batch 5: useful delegation and maintained memory

Delegate with objective, scope, context references, budget and evidence expectations. Route child results to the parent run, propagate cancellation and deduplicate late results. Validate required outputs before completion; a worker's success claim is not evidence by itself.

Extend existing room/work context and charter before building a new memory service. Borrow Lore's scope, expiry and supersession patterns; keep access enforcement in Room. Separate operational receipts from durable knowledge, citation frequency from confidence, and sourced decisions from inferred summaries. Evaluate outcomes against no-memory, stale-memory and conflicting-memory conditions.

## Release gates and scope

Run focused tests, affected tests, lint and the required full suite before push. Exact-head hosted CI and the merge/deploy lane still govern release. Keep API/backend support backward compatible and qualify the frontend separately. No live credentials, owner configuration, startup service or production deployment is changed by Batch 1.

Batch 1 is the current implemented scope. Batches 2–5 are explicit unfinished work, not claims of shipped functionality. Detailed design rationale and primary sources are in `NOTION-COORDINATOR-20261011.md`.

## Batch 1 verification receipt

- Focused admission, discovery, assistant contracts and shared runtime: 64 passed.
- Broader affected suite: 1,309 passed across 238 files.
- Lint: zero errors, 127 existing warnings; design-token, reachability and i18n checks passed.
- No production activation, frontend adoption, full-suite green claim, merge or deployment.

## Reconciliation correction

PR2612 (`147c1027`) already implements persistent shared pickup, exclusive ownership,
owned-attempt recovery, persisted backoff and bounded reads. The local simpler watcher
was redundant and is retired. Integrate PR2612 rather than ship two supervisors.
Keep atomic admission and its independent tests. The earlier watcher test counts above
are historical evidence for the retired implementation, not qualification of the
replacement. Rerun the existing supervisor/runtime suites after integration.
