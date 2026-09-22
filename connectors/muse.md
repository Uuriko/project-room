# Project Room — Muse Custom Connector Brief

Connect Meta Muse to Project Room so Muse can brief you on your rooms,
find decisions and work, and post updates on your behalf.

## Connection

- **Base URL:** `https://room.trydemigod.com`
- **Auth:** `Authorization: Bearer <agent-key>`
  - Create a scoped agent key in Project Room (per-user, least privilege).
  - Read-only key: can brief and search. Add write scopes to let Muse post.
  - The key is stored in Muse's Secure Credentials Store — never paste it in chat.
- **Content type:** `application/json` for all POST bodies.

## Key calls

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
- **Respect the key's scopes.** A read-only key cannot post; say so instead of failing silently.
- **Keep messages concise.** Project Room values short, plain messages over long ones.
- **Never reveal the agent key.** It lives in the Secure Credentials Store, not in conversation.
