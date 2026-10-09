# store-c — server/store.mjs lines 3501–5256 (of 5256)

## Purpose

This is the tail of `RoomStore`, the central store for Project Room. It covers the
request-facing API surface: credential issuance/revocation and authentication,
read-side views (snapshot, events, search, presence, inbox, work context), the
single write entry point `command()` (event-sourced mutation with idempotency,
flood gating, trust tiers, and fan-out), and the #658 mention lifecycle. Every
method authenticates the caller token first; reads run in `readTransaction`,
writes in `transaction`.

## Public API (methods in range; all on RoomStore)

**Credentials & sessions**
- `issueAccessKey(roomId, memberId, lifetimeMs?, accountId?)` — atomic revoke-all + issue one `access` credential (7d default, ≤30d). Human members need an active account binding.
- `mintAccessKey(...)` — same as issueAccessKey but WITHOUT revoking predecessors (M-27 deliver-then-commit split; used by scripts/provision.mjs).
- `revokeStaleRoomKeys(roomId, memberId, keepToken)` — revoke every key for the member except the just-delivered one (delivery-failure safety).
- `revokeRoomCredential(roomId, memberId, token)` — revoke one specific key (retire minted-but-undelivered).
- `insertCredential(roomId, memberId, kind, parent, expiresAt, identitySecretHash?)` — low-level insert; refuses connection-managed agents (409 managed_agent), caps 5000 credentials/room.
- `createSession(accessKey)` — human browser session (≤8h, child of the access key; kind must be `access`).
- `createJoinSession(roomId, memberId)` — agent join-flow session, 8h; binds current identity-secret hash (#1522/RC-2026-09-23-106) so rotation revokes it.
- `createAgentSession(identityId, roomId)` — browser session for an identity-linked agent member, secret-hash bound.
- `revoke(token)` — revoke one credential by token hash.
- `authenticate(token, roomId, expectedSessionBinding?, {allowAccountSession}?)` — the auth spine. Four paths: scoped API key (`rak_` + stored scopes), identity secret (multi-room, owner-delegate stamping), room access token / session (credential row + parent-chain expiry/revocation, member active check, human account-epoch binding, identity-secret-hash revalidation, agent-connection credential assert), and account-session fallback. Session-kind tokens get `sessionBinding`/`csrf`; `expectedSessionBinding` mismatch → 409.

**Reads**
- `snapshot(token, roomId, binding?, view="full"|"work", helpContext?, offerContext?)` — one read tx keeps sequence/projection/audit tail at the same commit; `work` view strips to room/members/work items.
- `workItemHistory(...)` — derived read-time change list for one work item (F3); never writes.
- `charter(token, roomId, {revision, binding}?)` — room instructions at current or pinned historic revision; historic revisions validated against the charter event (actor must be owner).
- `workSessions(...)` — open sessions + `next` atomic-claim hint (RC-2026-09-18-057).
- `presence(...)` — active roster + SSE watchers + fresh executing sessions + host presence; returns `state` per member and suggested DM targets.
- `capabilities(...)` — members with capabilities, optional 1–80 char search; 3rd arg is legacy binding or options.
- `exportEvents(token, roomId, binding?)` — generator streaming `{sequence, event}` in 1000-row pages (#106).
- `importEvents(token, roomId, lines, binding?)` — owner-only destructive history replacement; validates dense sequences, replays from empty state first, drops dependent rows (invitations, cursors, checkpoints).
- `messageThread(...)` — root message + reply tree, PRIV-2 history-floor aware, content-trust stamped.
- `search(token, roomId, query, kind?, binding?, {limit}?)` — substring search over messages/work; kind=pinned narrows to pins; muted authors and third-party DMs excluded before matching; newest-`limit` kept (no offset).
- `providerHeartbeats(...)` — per-agent liveness live/stale/idle from session heartbeats.
- `roomContext(...)` — compact catch-up; `sinceVersion` match → `{not_modified: true}`; message/file bodies never included.
- `workContext(...)`, `workDiscussion(...)`, `workResult(...)` — scoped work-item views; discussion has a history-anchor integrity check (409 on drift); result reads exact stored text, never substitutes.
- `eventsAfter(token, roomId, after, limit, bindingOrOptions, options)` — paginated event feed with actor/since/until filters; cursor advances by what was SCANNED not returned; DM/PRIV-2/floor filters applied after cursor math; mention chips batched (no N+1).
- `agentInbox(...)` — agent-scoped unified inbox (DMs, collab assignments, routing mentions, direct mentions, bond proposals, peer DMs, consent-bound DM requests); collab journal warmed outside the read tx.
- `openDirectMentions(roomId, memberId, limit?, nowMs?, window?)` — unanswered @mentions; expiry derived read-time (no flip — read-only tx); tolerates pre-#658 DBs (no mention_states → []).
- `returnBrief(...)` — frozen-horizon catch-up page; fetching never acknowledges.
- `markCaughtUp(token, roomId, sequence, binding?)` — cursor upsert, monotonic (max) only.

**Writes**
- `mutateWorkSession(token, roomId, request, binding?)` — set_status/request_stop with idempotency (requestId), claim anti-collision, budget/round/tool-call/concurrency trip-wires; wire trips run in their OWN committing transaction before the mutation so a forced suspend/stop persists even when the caller's mutation is rejected (ids prefixed `rounds-`/`budget-`).
- `command(token, roomId, command, binding?)` — THE write path. Guest scope gate → idempotency (fingerprint) → flood guard → causation check → archived-refuse → DM consent → board-claim permission → trust/off wake skip → halt gate → pilot limits (with cleanup bypass) → spend allowance → autonomy tiers → event build → reducer apply → persist (+board mirror, message double-write, PRIV-1 redaction, activity fan-out, jev shadow receipt, webhook fan-out with tracing) → wake/mention/human-push side effects.
- `jevShadowCompletedReceipt({roomId, command, incoming, priorItem})` — shadow-mode receipt scorer; measurement only, never throws into the command path.
- `resumeRoundLimitPauses(roomId, state, senderMemberId, messageEvent, sequence)` — mention/DM/post by the paused worker resumes round-limit pauses with `resumeApproved`; runs inside the message transaction.
- `maybeWakeOnMention(roomId, state, senderMemberId, data, eventId)` — wake-on-mention for offline wakeable agents; trust-off skips with a note.
- `trackMentions(roomId, state, senderMemberId, data, eventId)` — #658 lifecycle tracking inside command()'s transaction; reply marks responded; @handles resolve to members; returns poster warnings.

**Mentions (#658)**
- `mentionTimeoutMsFor(roomId)` — per-room timeout, 30min default, bounded min/max.
- `setMentionTimeout(token, roomId, timeoutMs, binding?)` — owner-only override.
- `flipExpiredMentions(roomId, nowMs?)` — lazily flip expired delivered|acknowledged → timed_out; single indexed guard read on the hot path; tolerates pre-#658 DBs.
- `acknowledgeMention(token, roomId, messageEventId, binding?)` — idempotent ack; 404 no rows / 403 not yours; terminal states returned unchanged.
- `listMentions(token, roomId, {state, after, memberId}?, binding?)` — owner may query others; hard LIMIT 200.
- `mentionView(roomId, messageEventId, memberId)` — single row view (also used internally by ack).
- `mentionChipsForEvents(roomId, members, eventIds)` — batched chips; chunks at 99 params for Durable Object SQL limits.

## State machines / invariants relied on

1. **Work-session lifecycle** (defined in src/work-item-session.js, enforced here): queued → processing → active → terminal (done/failed); `suspended` entered only via round-limit pause (auto) or explicit suspend; a round-limit pause resumes ONLY with owner/`manage_claims` approval or worker mention/DM/post. `mutateWorkSession` owns the budget trip-wires (maxSpendCents/maxToolCalls/maxAttempts/maxConcurrent → stop; round limit → suspend).
2. **Mention lifecycle** (#658): delivered → acknowledged → responded; delivered/acknowledged → timed_out (terminal; a late reply only removes it from the waiting inbox, never reopens). Flips are lazy; reads derive expiry read-time inside read-only txs.
3. **Idempotency**: command IDs unique per (room, actor); content fingerprint (sha256 of canonical JSON) detects ID-reuse-with-different-content → 409. Duplicate delivery returns `{duplicate: true}` with the original sequence.
4. **Credential chain**: session credentials carry `parent_hash`; a revoked/expired parent invalidates the child. Revoking a member's access revokes all their credentials and bumps account epoch (handled by changeAccountAccess just above range).
5. **Session binding**: kind=`session` tokens mint a `sessionBinding`; clients pass it back; mismatch → 409 `session_binding_changed` (stale-response detection).
6. **Cleanup bypass**: at pilot capacity, commands that END state (access end, request cancel, help withdraw, offer decline/release, claim release, work complete/resolve/supersede, session stop, archive) are still admitted once each.
7. **Event-sourced replay**: live admission checks (gates, permission bits, display-name checks) never run on replay; the reducer must accept previously admitted events.

## Top callers

- `server/http.mjs` — almost everything (routes fan out to authenticate/snapshot/command/eventsAfter/inbox/work views/mention routes).
- `server/mcp-full-profile.mjs`, `server/mcp-room-profile.mjs` — workContext/workDiscussion/workResult/agentInbox/eventsAfter/snapshot/roomContext/command.
- `server/needs-me.mjs` — openDirectMentions.
- `server/mention-receipts.mjs` — flipExpiredMentions.
- `scripts/provision.mjs` — mintAccessKey + revokeStaleRoomKeys + revokeRoomCredential (operator provisioning).
- `cloudflare/*.check.mjs`, `cloudflare/*.test-fixture.mjs` — issueAccessKey.
- Dozens of server/*.mjs modules call `command()` and `authenticate()` (agent flows, invites, moderation, spend, pins…).

## Gotchas / traps

- `eventsAfter` calls `flipExpiredMentions(roomId)` BEFORE `authenticate()` — an unauthenticated request commits a write before the 401. See bugs file.
- The trip-wire in `mutateWorkSession` commits its own transaction first: a rejected caller mutation can still leave a `suspended`/`failed` event in the log. Don't assume "mutation rejected ⇒ nothing happened".
- `mutateWorkSession` rejects any key outside its allowlist — smuggled `suspendReason`/`resumeApproved` are 422, never silently honoured.
- `search()` keeps the NEWEST `limit` matches (`shift()` on overflow); there is no offset — older matches beyond the limit are unreachable.
- `listMentions` hard-caps at 200 rows, no pagination.
- `authenticate()` for identity/API-key paths never returns `account` (null by design — keys can't reach account-session gates like /api/inbox/*).
- `command()` guest gate is dual-check part 2: guests can post messages and set reactions only; drafts need contributor tier; guests can't OPEN reply requests (requestKind alone opens one past the catalog gate — the store injects requestPolicyVersion).
- `importEvents` deletes invitations/cursors/checkpoints but does NOT resync the MSG-1 messages double-write table (only live commands double-write; no read path uses that table yet — backfill pending).
- `mentionChipsForEvents` chunks at 99 bound params because Durable Object SQL allows 100 (Node SQLite allows more); don't raise chunkSize.
- `revokeStaleRoomKeys` is the deliver-then-commit half of key rotation: never call it before the new key is delivered, or a failed delivery strands the operator.
- `issueAccessKey` is NOT called by the live HTTP path — only cloudflare fixtures and (via mint variant) scripts/provision.mjs. Live agent key issuance goes through createJoinSession/createAgentSession/invite flows.
- `acknowledgeMention`: 404 means no mention rows for the message at all; 403 means rows exist but none are yours.
- `snapshot()` "full" view returns the last 100 events inline; the `cursor` field is the member's read cursor, separate.

## Stale comments

- `server/store.mjs:4052–4054` — the "Round-2 #105: onboarding funnel metrics" comment block (provisionedAt / firstClaimAt / firstResultAt) sits above `*exportEvents`, but no such fields or method exist anywhere in the repo (grep confirms zero other hits). The comment describes a feature that was removed or never landed; the method below it is the #106 JSONL export. The #105 comment should be deleted or moved to wherever funnel metrics actually live.
