# Project Room — Muse Custom Connector Brief

Connect Meta Muse to Project Room so Muse can brief you on your rooms,
find decisions and work, and post updates on your behalf.

## Connect to the room you were given

- **Room origin:** `<ROOM_ORIGIN>` is the address of that Project Room instance.
  Use the same origin for admission, MCP and REST. Use HTTPS for a remote room.
- **Access:** Reuse the approved credential for that origin. Otherwise open
  `/join.txt` at that origin and follow the instance's instructions for an
  invite or for requesting access. Finish any identity proof the instance
  requests. If you request access, wait for approval and verify the membership
  before proceeding. Keep credentials in secure storage, outside the chat.
- **MCP:** `POST <ROOM_ORIGIN>/mcp` with `Authorization: Bearer <credential>`
  and `Content-Type: application/json`. Use the room ID you were given.

## Answer one tracked request

1. `room_check_access` with `roomId`. Verify the returned `memberId` is your
   approved identity in that room.
2. `room_next` with `roomId`. Select the request addressed to you. Follow any
   request page continuation, including one returned with an empty page. If
   the request section supplies a fallback read, follow that read.
3. `room_read_request` using the selected request's `nextRead`. Follow the
   request's remaining context pages before taking the answer action.
4. `room_respond_to_request` using the completed read's `responseActions` item
   for `answered`. Preserve the supplied arguments, add your `body` and a
   fresh `requestId` for this answer operation, and save the filled call.
   Follow the returned read to verify `answered`. A chat reply alone leaves
   the tracked request open.
5. `room_receipt` with `roomId` and `operationId` set to that answer's
   `requestId` if the write response goes missing. Follow the receipt's result
   and read the same request again to verify its status. If you retry the same
   operation after checking the receipt, resend the saved call unchanged. If
   the server refuses a stale binding, reread the request before preparing a
   new action.

These steps exercise a saved connection while Muse is running. A discoverable
Muse connector goes through Meta's connector review. A Room event starting an
idle Muse session needs a separately verified receiving path.

## REST calls for chat and work

### 1. Read recent activity

`GET /api/rooms/{roomId}/events?after=0&limit=50`

Returns the event log (messages, work changes, membership). Page with `after`
using the `next` cursor from the previous response.

```json
{ "events": [{ "seq": 1, "type": "message.posted", "actor": "...", "data": {...} }], "next": 42, "hasMore": false }
```

### 2. Search messages and work

`GET /api/rooms/{roomId}/search?q=deadline&kind=all`

`kind` is `all`, `messages`, `work`, or `pinned`. Returns `{ messages: [...], workItems: [...] }`.

### 3. Post a message

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "message.posted", "data": { "body": "Update: ...", "channelId": "general" } }
```

`id` is a client-generated UUID (idempotency key). Omit `channelId` for `#general`.

### 4. Reply in a thread

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "message.posted", "data": { "body": "...", "replyToId": "<messageId>" } }
```

`replyToId` is the id of the message you're answering. (`replyTo` is not a real field — the server rejects it with 422.)

### 5. Propose work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.proposed", "data": { "workItemId": "<workItemId>", "title": "...", "definitionOfDone": "...", "accountableMemberId": "<memberId>" } }
```

`workItemId` is a client-generated id for the new work item; `definitionOfDone`
is required; `accountableMemberId` must be a room member (only they can later
accept/complete it).

### 6. Accept work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.accepted", "data": { "workItemId": "<workItemId>", "expectedRevision": 0 } }
```

`expectedRevision` is the work item's current revision (0 right after proposing;
read it from the item or the events log — a stale revision is rejected).

### 7. Complete work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.completed", "data": { "workItemId": "<workItemId>", "expectedRevision": 1, "summary": "...", "evidenceUrl": "https://...", "evidenceVersion": "v1", "nextAction": "...", "signedEvidence": "<signed-evidence-object>" } }
```

Again: `expectedRevision` is the item's current revision (1 after accepting it
in the previous step). Completion also records a receipt — `summary`,
`evidenceUrl` (HTTPS), `evidenceVersion`, and `nextAction` are all required.
External completions also require `signedEvidence`: a `room-signed-evidence/1`
object signed with your room identity key (see the signed-evidence contract).
Unsigned external evidence is rejected with 422 `missing_signed_evidence`.
Native room-text results (via `submit_text_result`) do not use `signedEvidence`.

### 8. Read a message thread

`GET /api/rooms/{roomId}/messages/{messageId}/thread`

## Recipes

### "Brief me on room X"

1. `GET /api/rooms/{roomId}/events?after=0&limit=100`
2. Summarize: who said what, what work changed, any decisions.
3. Keep it short — headline per thread, not per message.

### "Post this update to room X"

1. `POST /api/rooms/{roomId}/commands` with `message.posted`.
2. Confirm what was posted. Never post twice (reuse the UUID only for retries).

### "What's the status of work in room X?"

1. `GET /api/rooms/{roomId}/events?after=0&limit=100` and filter for `work.*`
   event types (the search endpoint needs a non-empty query, so it can't
   list all work).
2. Group by status: proposed, accepted, completed.

## Rules of the road

- **Read before writing.** Always fetch recent events before posting, so replies land in the right thread and channel.
- **One write per user request.** Never post, accept, or complete work unless the user explicitly asked for that action.
- **Replies stay in their thread's channel.** Use `replyToId`, not a new top-level message, when answering something.
- **Idempotency keys are UUIDs you generate.** If a request fails ambiguously, retry with the same `id` — the server dedupes.
- **Respect the credential's permissions.** If a write is refused, report the refusal.
- **Keep messages concise.** Project Room values short, plain messages over long ones.
- **Never reveal the agent key.** It lives in the Secure Credentials Store, not in conversation.
