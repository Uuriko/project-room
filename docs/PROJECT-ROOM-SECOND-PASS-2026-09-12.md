# Project Room: second audit pass

- Date: 12 September 2026.
- Companion: [whole-product audit](PROJECT-ROOM-AUDIT-2026-09-12.md).
- Committed baseline: [ff7365e01e59398b29c05251164bf68947c7cd9f](https://github.com/Uuriko/project-room/tree/ff7365e01e59398b29c05251164bf68947c7cd9f). Remote main was checked again and remained at this commit.
- Local prototype baseline: Grok's uncommitted public MCP additions over local d963e4b. These are separate from committed main and were tested from a disposable copy.
- Scope: challenge the first audit's conclusions, inspect new work, and probe gaps between independently tested features. This pass did not modify implementation or publish anything.

## Result

The first audit's six release findings remain applicable to the unchanged committed baseline. The second pass adds four confirmed defects in committed code and two concerns in the uncommitted public MCP prototype. The common cause is that new entry points bypass policies that older paths already enforce.

The most useful next engineering investment is a common route boundary and a common work-action policy, backed by cross-feature tests. More individually passing feature tests will not catch these combinations by themselves.

| ID | Priority | Surface | Confirmed behavior |
| --- | --- | --- | --- |
| S1 | P1 | Committed thread API | Bypasses shared request limits and accepts an account-session token through the prohibited Bearer path. |
| S2 | P1 | Committed diagnostics | Unauthenticated requests to invented room IDs allocate an unlimited number of retained room buckets. |
| S3 | P1 | Committed work/session policy | An agent with halt-all recorded can start a session and become processing. |
| S4 | P1 | Committed recovery | A valid room with 10,001 events after permitted access cleanup exports successfully but cannot import its own export. |
| S5 | P1 before exposure | Local MCP prototype | Reports joined/live but has no successful join-to-briefing/listen path. |
| S6 | P1 before exposure | Local MCP prototype | Skips Origin/proxy/rate handling; ignores unsupported protocol headers and accepts invalid request IDs. |

P1 means a concrete release or readiness defect in this audit, not evidence of a production incident. S5–S6 describe unfinished local code owned by Grok, not deployed behavior.

## S1. Thread reads bypass the shared route boundary

The thread route returns at [server/http.mjs:484–490](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/http.mjs#L484-L490), before the shared credential-kind checks, decoded path handling, and request limits at lines 493–503. Its store method authenticates, so this is not anonymous access to a private room. The missing checks still matter.

Two loopback reproductions on a fresh in-memory room confirmed:

```json
{"threadRequest605":200,"normalRequest605":429}
{"accountCookieAsBearer":{"normal":401,"thread":200}}
```

The second probe created a legitimate account session in the fixture, then supplied its token in Authorization instead of the required account-cookie mode and binding. The normal room route rejected it; the thread route returned private thread content. This defeats the intended distinction between a room credential and a browser account session. It does not demonstrate access without possession of a valid credential.

The first probe made 605 thread reads followed by 605 ordinary reads with the same legitimate room credential. Thread reads did not consume the shared allowance. A large thread can therefore repeatedly trigger full projection reads and recursive response construction outside that throttle.

**Fix acceptance:** route every room read through the same credential-mode, session-binding, membership, path-decoding, and rate-limit middleware. Add a matrix for normal, thread, search, export, work, and SSE reads: room Bearer, account cookie, account token as Bearer, stale binding, revoked membership, encoded IDs, and exhausted allowance. Keep legitimate thread reads working.

## S2. The diagnostic log is not globally bounded

[server/diagnostics.mjs:5–16](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/diagnostics.mjs#L5-L16) bounds each list but never bounds the Map of room IDs. The HTTP error handler at lines 752–770 derives roomId from an untrusted failed request and records it even when authentication failed and that room does not exist. The usual read throttle runs only after successful authentication.

Reproduction results:

```json
{"diagnosticsCapacity":2,"retainedRoomBuckets":250}
{"anonymousErrorsAllocatedRoomBuckets":20}
```

The first probe inserted 250 distinct synthetic room IDs into a logger configured with capacity 2. All 250 buckets remained. The second instrumented the logger in the disposable service and made 20 unauthenticated requests to nonexistent rooms; each allocated a new bucket. No memory-exhaustion attack was attempted.

This creates memory and log-volume growth from unauthenticated traffic, particularly undesirable in the single shared Durable Object. It also corrects the first report's shorthand: diagnostics retain up to 200 records **per room**, not 200 globally.

**Fix acceptance:** impose a total record/byte budget and an LRU/TTL bound on room buckets. Keep unauthenticated failures in a bounded service-level channel without allocating arbitrary tenant buckets. Test many unique invalid IDs as well as many failures for one valid room. Preserve useful, sanitized support evidence.

## S3. Halt-all does not cover session starts

[server/store.mjs:1652–1655](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/store.mjs#L1652-L1655) uses a manually maintained HALT_GATED list. It includes work lifecycle and claim events but omits SESSION_STARTED and SESSION_STATUS_CHANGED.

The probe created an agent, assigned and started work, recorded a handoff with haltAll=true, then invoked mutateWorkSession with set_status=processing at the current revision:

```json
{"haltActive":true,"startSessionResult":"session.started","sessionStatus":"processing"}
```

No external process was started; the defect is in Room's own state and authority claims. The UI and agent presence can indicate a running session while the board still says that the member is halted. Existing handoff tests check blocked and completed work events, which correctly refuse, but do not cross into session actions.

**Fix acceptance:** classify actions centrally as starting/continuing work, reporting, or ending/releasing work. A halt must deny starts and continuation, including session takeover, while allowing necessary stop acknowledgments and safe release. Review CLAIM_RELEASED too: it is currently halt-gated even though it is an important cleanup action. Test the matrix through both the session endpoint and generic command endpoint, including exact retries and owner overrides.

## S4. Legal cleanup makes an export unrestorable

This is an independent extension of first-pass R2. [server/store.mjs:1660–1664](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/store.mjs#L1660-L1664) correctly permits selected cleanup events beyond 10,000 events. Import, however, rejects every input longer than 10,000 at lines 1382–1383.

The successful probe used real store commands to reach exactly 10,000 events with bounded synthetic status updates. It then deactivated an existing agent through the normal access-change command, exported the resulting history, and attempted an unchanged import:

```json
{"validHistoryBeforeCleanup":10000,"cleanupSequence":10001,"exported":10001,"restore":{"code":"invalid_import","message":"Import is 1 to 10000 event lines"}}
```

The history had no invitation records, so this failure is separate from the append-only invitation trigger found earlier. It also confirms a positive property: revocation remains possible at capacity. The mistake is treating 10,000 as both the admission threshold and the absolute maximum recoverable history.

**Fix acceptance:** keep cleanup available. Quarantine hosted import as already recommended, then qualify the offline recovery path against the actual maximum valid history, including all permitted cleanup events. Test an unchanged export/restore and reopening the resulting database. Account for the HTTP byte limit as well as line count; merely increasing one constant does not repair authority reconciliation.

## S5. Public walk-in currently leads to an endless join prompt

This is a review of Grok's captured local prototype, which explicitly says persistence is a later slice. The issue is the externally visible contract of that intermediate state.

- server/open-contract.mjs advertises status=live and mint=self_join.
- client/mcp-public.mjs reports joined_ephemeral with isError=false for a valid name and COMMONS code.
- The same implementation unconditionally returns join_required for briefing, work listing, and listen. It stores neither an ephemeral member nor a session that could make the next call succeed.
- The instructions say a reply without a tool call leaves the room and urge continued listening, although no membership or listening lifecycle exists.
- src/agent-join-notice.js repeats those directions. It was not imported into the browser app in the captured prototype.

All seven prototype tests pass. One test expressly accepts join success and then join_required, so the test suite currently verifies the stub's pieces without verifying the promised user journey.

**Fix acceptance:** while this is a scaffold, advertise unavailable/preview and give a finite stopping instruction. Once implemented, prove join → briefing → bounded listen → leave/removal, with the same identity, restart semantics, and rate limits. Quiet listening must have a defined backoff, expiry, and cancellation behavior; do not let tool descriptions direct an agent to consume compute indefinitely. Keep execution and spending subject to the user's actual authority.

Public room data also needs a publication boundary. The current bootstrap already uses the ID commons for an ordinary invite-only room. A future public route must not equate that ID with permission to expose its history. Use an explicitly provisioned public space or a reviewed public projection. This is a design gate, not a demonstrated leak in the current stub, which does not read the store.

## S6. The public MCP route needs transport and boundary validation

In the captured local server/http.mjs:213–220, /mcp returns before checkOrigin and proxy-address validation and never invokes rate(). The response permits every browser origin. A loopback request carrying Origin=https://untrusted.example and MCP-Protocol-Version=not-supported received HTTP 200 with Access-Control-Allow-Origin=*.

The handler also echoed an object-valued JSON-RPC ID and returned success. Its argument checks verify property names and required fields but generally do not validate their declared types, enums, or bounds. For example, a negative listen timeout reaches the tool instead of producing an invalid-arguments response.

The [MCP 2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires Origin validation and a 400 response for unsupported protocol-version headers. It allows a JSON-only POST response, a 405 for GET when no SSE stream is offered, and optional session IDs. Therefore, absence of SSE or a session header is not itself a protocol bug.

**Fix acceptance:** validate Origin using an explicit deployment policy, resolve trusted proxy identity, and apply bounded public admission limits before processing. Reject unsupported protocol versions; validate JSON-RPC IDs and complete tool argument schemas. Add conformance cases for notifications, unsupported versions, malformed IDs, unknown fields, wrong types, cancellations, and overload. Keep local and hosted origin policies explicit. Avoid importing the entire private stdio adapter just to obtain a protocol-version constant; a small shared protocol module removes unnecessary coupling.

These findings do not establish private-data exposure through the current MCP stub. They establish missing safeguards before that stub becomes stateful or public-facing.

## Product and architecture refinements

1. Keep conversation-first as the default human experience, while allowing compact agent APIs. These can share one domain model; they do not require competing product definitions.
2. Generate discovery from actual capabilities. A callable stub, passing catalog test, or protocol initialization is not proof that onboarding works. Report availability per operation and stop cleanly when the next step is unavailable.
3. Put shared policy before route dispatch. The thread and MCP findings are examples of early returns bypassing assumptions made elsewhere. Every new route should inherit a declared authentication, throttling, error, and data-visibility policy.
4. Treat halt, stop, stale heartbeat, work completion, and verification as separate but coordinated facts. One policy table should define which transitions each permits. The server and UI should use the same predicates.
5. Make safety cleanup part of capacity and recovery design. Test realistic valid histories, not only mocked sequence counters. A bounded pilot needs a safe exit even when it is full.
6. Archive isolated packages only after checking retained intent and other agents' plans. Zero runtime imports make a package a consolidation candidate, not automatic permission to delete it.

## What was rechecked and what remains qualified

| Area | Second-pass assessment |
| --- | --- |
| First-pass R1–R6 | Relevant code remains at the same immutable baseline; no fix landed on remote main during this pass. Core code paths were reread; the prior invitation/relink reproductions were not needlessly repeated. |
| Authentication | General routes retain strong checks. S1 is a specific exception, so the first report's broad praise must be read with that qualification. |
| Capacity cleanup | Confirmed that access revocation works past the event admission limit; do not remove that exemption. Recovery limits need alignment. |
| HTML rendering | Sampled escaping, HTTPS-only evidence links, and draft/session cleanup paths. No new injection or logout leak was demonstrated. This was source inspection, not a new exhaustive browser security test. |
| Tenant privacy | Whole-room visibility is an existing product boundary, not automatically an authorization bug. More granular access is a readiness/product decision; new public Commons access requires a separate explicit boundary. |
| MCP conformance | Checked against the version claimed by the prototype. JSON-only transport and GET=405 are permitted; the confirmed problems concern Origin, versions, IDs, and incomplete workflow semantics. |
| Enterprise checklist | SSO/SCIM, retention, audit, and recovery are important target requirements. The exact minimum for a limited design-partner trial depends on agreed users, data, and contractual scope; the first matrix is a target-readiness assessment, not a universal procurement rule. |

## Verification and handoff

- Committed baseline: six focused test files, **25 passed, zero failed**, approximately 4.31 seconds. Covered identities, diagnostics, threads, handoff/halt, work sessions, and export/import.
- Local prototype: **7 passed, zero failed** in a disposable copy.
- Additional probes confirmed S1–S6 using loopback services and in-memory synthetic rooms. No production traffic or credentials were used.
- The full 1,132-test result belongs to the first pass. It was not rerun or presented as a new result here.
- Two initial full-history fixture builds were stopped because replay repeatedly clones accumulated history. The completed capacity probe instead used 9,997 ordinary status commands after the three bootstrap/member events; it created a valid 10,000-event history without faking sequence counters. The slow attempts are diagnostic observations, not a production performance benchmark.
- No new desktop/mobile, assistive-technology, live-cloud, load-to-failure, or restore-qualification claim is made by this second pass.
- Grok's files remained unchanged by this audit. Their four captured hashes were checked before and after the probes and matched.

Captured local prototype SHA-256 values:

```text
client/mcp-public.mjs   9c20ba2e357d82a24e396db6ab297117b0381394025bbfd99f8e536eb01059a5
server/open-contract.mjs f91af091af77caecf07e7ff4f9d084e9811390b2baac913f1f65e29c81d16e47
server/http.mjs        6a3f96d36cfa23e33a0ec978f95141991c65ae4541534b21e322e5417a32caad
tests/mcp-http.test.js  1fc15bce4af058522ef0d86aba64c1a705b051ace110ff4251a8c5a6fa8250f4
```

Implementation order: preserve the first report's API/relink/import priorities; add S1–S3 to the same release-blocker tranche; include S4 in recovery redesign. Grok's public MCP work owns S5–S6 and should remain an explicitly incomplete preview until its user journey and boundary tests pass. Claim exact files on the bus and board before implementation. This document grants no branch, merge, or deployment ownership.
