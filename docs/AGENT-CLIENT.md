# Local structured client contract

Version 1 · Single configured Room and service · Local pilot, not universal interoperability

## Use

An operator provisions an agent membership and access key through the existing local administration flow. This document does not authorize provisioning on a live service. Keep the key in the process environment or a secret manager, never in URLs, committed files, tool descriptions, or command arguments.

Set `ROOM_AGENT_ORIGIN`, `ROOM_AGENT_ROOM`, and `ROOM_AGENT_TOKEN` for a permitted local process, then run:

```sh
npm run agent:inbox -- orient
npm run agent:inbox -- brief
npm run agent:inbox -- changes 0
```

These operations only read. Output contains permitted Room data and should be treated as private. The command does not start an AI, accept work, acknowledge reading, or perform external actions.

For programmatic use, import `RoomAgentClient` from `client/room-agent.mjs` and instantiate it with `{ origin, roomId, token }`. All operations target that fixed origin and Room. HTTPS is required except for isolated loopback development. Redirects are rejected, browser cookies are omitted, and each request has a 15-second timeout.

## Operations

| Client method | Result and boundary |
| --- | --- |
| `orient()` | Contract version, authenticated member, Room scope/permissions, evaluated-through sequence, bounded-pilot work records and their next steps. It is a description, not permission to dispatch. |
| `snapshot()` | Current authorized Room projection, recent event tail and viewer ownership. Room membership currently grants Room-wide context; this is not task-level privacy. |
| `changes(after, limit)` | Durable event page, next cursor, and has-more flag. Page limit 1–100. Advance a processing checkpoint only after your application handles the page. |
| `returnBrief(options)` | Frozen-horizon change history and live work needing attention. Pass the returned continuation tuple unchanged for subsequent pages. Fetching does not mark anything read. |
| `command(command)` | Explicit write through the existing service command boundary; success includes persisted event/sequence and duplicate status. The client does not grant additional capabilities. |

Orientation work entries include IDs, definition of done, source-message reference, state/revision, current receipt, review, decision and blocker. `next` contains `action`, `label`, `memberId`, `role`, `needsAttention`, `workItemId`, `workRevision`, `completionEventId`, and `evidenceVersion`. The evaluation sequence shows when that description was true. Re-read current state before acting on stale work; the service validates revisions regardless of the client's description.

The current orientation scans the existing pilot's capped work collection; it is not a scalable or selectively paginated agent inbox. Context clipping, work-level grants, runtime identities, budgets and wake controls need a later reviewed runtime integration. Do not expose this local pilot as a public agent service.

## Explicit writes and recovery

A command has a caller-owned stable `id`, an allowed `type`, and `data`. The service attributes the actor from the credential. Mutations include the expected work revision; review and decisions identify the exact completion event and evidence version. See `server/store.mjs` command shapes and `src/events.js` transitions; the end-to-end example is `tests/agent-handoff.test.js`.

On a lost response or timeout, the write outcome is unknown. Reconcile from permitted current state/events or resend the exact same command object with the same ID. Do not automatically replace its ID or replay an external effect. A changed command needs a deliberate new ID and fresh revision. HTTP errors preserve the service status and code; stale revisions need refresh, revoked access needs operator intervention, and rate limits require backoff. The client does not automatically retry or override those decisions.

## Interoperability boundary

This pass implements and exercises HTTP access only. The browser, return brief and client share the next-step function and canonical service state. An MCP wrapper should reuse this domain contract and service authorization, not create separate work records. MCP transport, authentication, host compatibility, conformance and live-runtime tests remain unimplemented and must be verified before calling that integration complete.
