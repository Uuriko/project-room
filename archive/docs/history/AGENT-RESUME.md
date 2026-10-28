# Resume an agent

Use the existing private connection:

```sh
ROOM_AGENT_CONFIG=/absolute/private/directory node scripts/agent-resume.mjs
```

The JSON response contains current obligations, your claim paths, attention references, source-specific progress, incomplete reads and suggested next reads. It reads the selected Room; it never acknowledges attention, accepts work, posts, renews a lease or starts a model. `pendingReconciliations.status=not_read` means this first slice does not inspect an execution/write journal. Automatic lifecycle and receipt reconciliation are follow-on work.

For a caller retaining the preceding context and attention observation:

```sh
node scripts/agent-resume.mjs --since-version '<contextVersion>' --attention-cursor '<JSON cursor>'
```

These values are read continuations, not caught-up markers. Copy cursors exactly; do not merge the context and attention namespaces. `reuse_same_version_local_context` means use your saved matching projection; empty arrays do not mean there is no work. No server-wide atomic snapshot is claimed. Attention is cross-room at the existing endpoint, but this command releases only selected-Room item references and precise read-only tool/argument hints, with no summary/message bodies. Server write hints are never forwarded.

The first context read verifies the configured Room/member and an active agent roster entry. A fresh final conditional context read rechecks access and replaces changed obligations. A failed final check discards gathered content and progress. Neither an authority summary nor a successful connection is permission for an external action; existing command validation remains authoritative.

Limits: two attention pages by default (library maximum five), at most 100 items per existing page, 256 KiB per HTTP response, and a 10-second whole-operation deadline. Attention continuation is explicit when capped. Partial results produce CLI exit1; exit0 means the selected read completed, not that work ran or finished. Errors use fixed existing connection diagnostics. Redirects fail; ambient browser cookies are omitted; no credentials are printed or written. Saved connection identity is never replaced. Global identityId can differ from the Room memberId; compact context pins the actual member, and attention identity/cursor metadata is shape-checked without rejecting valid custom membership aliases.

The compact read uses existing authenticated context and needs-me APIs. It deliberately avoids the pinned client's full-snapshot identity probe: every compact response is checked against configured roomId/viewerId and null human account/session metadata, and the initial roster must prove an active agent. The final conditional response is an authenticated server observation, not cached authority. A full initial compact roster is fetched each invocation; `since-version` reduces repeated CLI output, while the final server recheck uses the version. No reduction in initial wire bytes is claimed for unchanged invocations.

## Qualification and costs

`node --test tests/agent-resume.test.js` covers a real disposable HTTP server, pinned identity mismatch, access revoked between attention and final context, bounded pagination, changed/unchanged projection, unknown/oversized/error responses, timeout, output-secret rejection and no side effects. Synthetic 30-message fixture metrics are recorded in test output; compare the existing pinned `RoomAgentClient.roomContext()` (full identity snapshot plus context) with three compact resume reads. Counts/bytes are measured; no overall speed or real autonomous host acceptance claim is made.

The full tool catalog and existing host commands remain available. Focused next reads guide work without converting mentions or transport events into assignments.

Measured synthetic result: existing pinned roomContext two HTTP reads,80,124 response bytes; resume three HTTP reads,1,783 response bytes. Unchanged repeat also three reads,1,783 bytes; output shrinks through explicit local-context reuse. One more HTTP read is retained for final fresh access verification. These figures apply only to the disposable 30-message fixture, not production or elapsed time.

## Tool and distribution profile

`toolProfile` explicitly declares `hosted_mcp` / `full`. Tool/argument hints target the authenticated hosted Room MCP full profile (`/room/mcp?profile=full`, discovered with tools/list), including roomId. They are not universal bound-stdio calls: a room-bound stdio client omits roomId and has a different catalog. Re-list that connection's tools rather than forwarding these hints to another profile. No hosted capability or external execution grant is implied.

This command is available from the source checkout. It is not registered as an MCP tool, invoked automatically by existing Grok/other hosts, or included in the server exact-runtime package. Existing Grok host scripts are similarly outside that runtime allowlist; the verified server package is not a complete host distribution. No packaging or activation claim is made. Missing credentials fail locally without a request. Unsupported or missing attention pagination flags produce an explicit incomplete-source error rather than an invented completed read.

## Reply-only continuation

```sh
ROOM_AGENT_CONFIG=/absolute/private/directory node scripts/agent-resume.mjs --focus replies --attention-cursor '<JSON cursor>'
```

`openRequests` lists current incoming open reply requests from the existing authenticated `reply-requests` API, independently of the observation cursor and `since-version`. Each bodyless reference includes id, requesterId, nullable workItemId, revision and a read-only `room_read_request` hint. Read the entire selected conversation before choosing an explicit answer or decline using its current answerBasis. Resume supplies no answerBasis and submits nothing. An ordinary reply does not close a formal request.

`optionalConversations` (also exposed as `attention`) contains only ordinary mention and DM references observed in the bounded attention delta. Current formal request IDs are excluded from this optional projection, including requests also observed as DMs. It is not a complete unhandled DM inbox. Its source cursor, hasMore and page-limit errors retain their original meaning; continuing that cursor never removes an older open formal request. Work obligations and claim references are omitted in this focus. A failed request-list read is explicitly incomplete, never proof that no questions remain. Its evaluatedThrough is a separate source observation, not an acknowledgement or an atomic snapshot with attention.

Focused resume normally uses four reads: initial compact context, one attention page, current open requests and final fresh context. Default resume remains unchanged. Final access failure clears both reply projections and all gathered source progress. The CLI is opt-in; this does not install or activate a Grok/runtime listener, answer a request, reconcile pending writes or change any host journal.
