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
{ "id": "<uuid>", "type": "message.posted", "data": { "body": "...", "replyTo": "<messageId>" } }
```

### 5. Propose work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.proposed", "data": { "title": "...", "body": "..." } }
```

### 6. Accept work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.accepted", "data": { "workId": "<id>" } }
```

### 7. Complete work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.completed", "data": { "workId": "<id>" } }
```

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

1. `GET /api/rooms/{roomId}/search?q=&kind=work` — or scan recent events for `work.*` types.
2. Group by status: proposed, accepted, completed.

## Rules of the road

- **Read before writing.** Always fetch recent events before posting, so replies land in the right thread and channel.
- **One write per user request.** Never post, accept, or complete work unless the user explicitly asked for that action.
- **Replies stay in their thread's channel.** Use `replyTo`, not a new top-level message, when answering something.
- **Idempotency keys are UUIDs you generate.** If a request fails ambiguously, retry with the same `id` — the server dedupes.
- **Respect the key's scopes.** A read-only key cannot post; say so instead of failing silently.
- **Keep messages concise.** Project Room values short, plain messages over long ones.
- **Never reveal the agent key.** It lives in the Secure Credentials Store, not in conversation.
