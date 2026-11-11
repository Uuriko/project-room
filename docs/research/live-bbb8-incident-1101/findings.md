# Production availability observation, 2026-11-02 00:30–00:31 UTC

The first concrete change in the finite observation was a readiness RPC **error in 42 ms**, followed approximately thirteen seconds later by cold initialization and successful room requests. The trace supports an exact-state recovery check; it does not justify erasing or restoring the database.

- At 00:30:36.679Z, deployed bbb8 Worker readiness emitted worker_wait_started / worker_rpc_started. The RPC emitted worker_rpc_settled:error and worker_response:error at 00:30:36.721Z; authorityObservation was absent.
- A POST envelope timestamped 00:30:49.587Z contains room.cold_start, room.do_initialized and room.do_request:200. Fourteen room.do_request:200 records are present through 00:31:03.222Z. These logs have no source stamps by design; parser null placeholders do not assert an unknown runtime version.
- 67 envelopes contain 23 HTTP503 and 42 HTTP200 responses, with two envelopes lacking a response status. Ten envelopes contain exceptions outside the original parser's fixed category inventory. No retained category identifies CPU, memory or storage limits. Raw messages were deliberately not saved.
- The single public urllib readiness request encountered the known perimeter403 and a non-JSON body. It is not a readiness result. There was no retry.

## Exact deployed source trace

bbb8 cloudflare/room.mjs:373–405 probeStorage logs do_entered, performs synchronous SELECT1, and logs sql_completed/do_completed. It does not depend on OAuth, room replay, job-health KV or the HTTP adapter. The constructor at178–280 does synchronous RoomStore/bootstrap before room.do_initialized; there is no blockConcurrencyWhile. A stall in ordinary OAuth handling alone therefore does not explain the separately reported probe RPC and SDK read timeouts.

readJobHealth at480–484 awaits heartbeat KV, counts public reports and awaits scheduler diagnostics. Those calls can add their own delay and are not the same readiness contract. The Worker wrappers for /api/ready and /api/health have independent shared in-flight probes and a2500ms response budget. Timeout returns do not prove cancellation or completion of the underlying RPC.

The old collector dropped room.readiness_probe entirely and ignored already-structured message objects. The replacement keeps only fixed, typed diagnostic values and statuses, with no URLs, queries, cookies or bodies. It replaced the existing tail lane; no parallel daemon was created. Its entire subprocess group was cleaned up after45.86seconds.

## Safest next action for the sole deployer

Use the existing exact-identity authenticated readback and a fresh readiness/job-health check once. Reconcile the original unknown MERGE-SLOT operation under its original request ID before any replacement write. If those checks succeed, continue observation through the existing release evidence workflow rather than forcing a restart.

If broad DO unavailability persists, preserve known committed storage, stable namespace/class/bindings, credentials, grants and unknown-operation IDs. A same-qualified-source code update can reset memory without deleting durable storage, but its admission and verification remain the sole deployer's decision; it is not a proven cure for this incident. A rollback requires existing exact writer/schema compatibility evidence. No destructive deleteAll, namespace replacement or credential regeneration is warranted.

Cloudflare documents that code-update resets affect in-memory state and preserve committed durable storage, and that overload/storage timeouts have explicit error classes. Neither condition has been proven by this sanitized trace.

Sources:
- https://developers.cloudflare.com/durable-objects/observability/troubleshooting/
- https://developers.cloudflare.com/durable-objects/api/state/

No deployment, reset, database edit, new identity, new grant or authenticated mutation was performed by this lane.
