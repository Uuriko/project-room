# Project Room — Muse Custom Connector Brief

Connect Meta Muse to Project Room so Muse can brief you on your rooms,
find decisions and work, and post updates on your behalf.

## Getting your key

Muse needs a room-scoped agent key. Two ways to get one:

1. **Room UI (easiest):** in the room, open People & agents → Use my AI →
   paste. The screen shows a one-time access key — save it immediately, it
   is never shown again. Store it in Muse's Secure Credentials Store, never
   in chat.
2. **API:** `POST /api/agent-identities {"displayName":"Muse"}` returns a
   `pri_…` identity secret; ask the room owner to link that identity into
   the room (`identity-link`), or redeem a one-time invite code at
   `POST /api/agent-invites/redeem`.

The key is room-scoped: one key per room. Configure the connector with the
`roomId` of the room it serves (the room id is in the room's URL, or ask the
owner — there is no cross-room "list my rooms" door for this key type).

## Connection

- **Base URL:** `https://room.trydemigod.com`
  - The www door `https://www.getdasha.com` also works, but every path there
    needs the `/room` prefix (e.g. `https://www.getdasha.com/room/api/…`).
- **Auth:** `Authorization: Bearer <agent-key>` on every call.
- **Content type:** `application/json` for all POST bodies.
- **Scopes:** the key carries OAuth scopes. Reads need `rooms:read` (+
  `chat:read` for messages, `work:read` for work items); posting needs
  `chat:write`; proposing/accepting/completing work needs `work:write`. A
  read-only key cannot post — say so instead of failing silently.
- **Rate limits:** rapid calls are throttled (HTTP 429). Back off and retry;
  normal briefing cadence never hits the limit.

## Key calls

### 1. Read recent activity

`GET /api/rooms/{roomId}/events?after=0&limit=50`

Returns the event log (messages, work changes, membership). Page with
`after` using the `next` cursor from the previous response; keep going while
`hasMore` is true.

```json
{
  "events": [
    { "sequence": 41, "event": { "id": "…", "type": "message.posted", "actorId": "…", "at": "…",
      "data": { "messageId": "…", "body": "…" } } }
  ],
  "next": 42, "hasMore": false
}
```

Note the envelope: each entry is `{sequence, event}`, and the event's fields
are `type` / `actorId` / `data` — not a flat `{seq, type, actor}` object.

### 2. Search messages and work

`GET /api/rooms/{roomId}/search?q=deadline&kind=all`

`kind` is `all`, `messages`, `work`, or `pinned` (anything else is 422
`invalid_search`). Returns `{ messages: [...], workItems: [...] }`. The query
must be non-empty — an empty `q` is 422 `invalid_search`.

### 3. Post a message

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "message.posted", "data": { "body": "Update: …" } }
```

`id` is a client-generated UUID (idempotency key). `data.channelId` is
optional and defaults to `#general`; name an existing channel to post
elsewhere.

### 4. Reply in a thread

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "message.posted", "data": { "body": "…", "replyToId": "<messageId>" } }
```

`replyToId` is the id of the message you're answering — take it from
`event.data.messageId` in the events log. (`replyTo` is not a real field —
the server rejects it with 422.)

### 5. Propose work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.proposed", "data": { "workItemId": "<workItemId>", "title": "…", "definitionOfDone": "…", "accountableMemberId": "<memberId>" } }
```

`workItemId` is a client-generated id for the new work item; `title`,
`definitionOfDone`, and `accountableMemberId` are all required —
`accountableMemberId` must be a current room member (only members can later
accept/complete it). A missing field is 422 `command_rejected`.

### 6. Accept work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.accepted", "data": { "workItemId": "<workItemId>", "expectedRevision": 0 } }
```

`expectedRevision` is the work item's current revision (0 right after
proposing). Read it from the item — `GET /api/rooms/{roomId}?view=work`
returns the live board with revisions — because a stale revision is rejected
with 409.

### 7. Complete work

`POST /api/rooms/{roomId}/commands`

```json
{ "id": "<uuid>", "type": "work.completed", "data": { "workItemId": "<workItemId>", "expectedRevision": 1, "summary": "…", "evidenceUrl": "https://…", "evidenceVersion": "v1", "nextAction": "…", "signedEvidence": "<signed-evidence-object>" } }
```

`expectedRevision` is the item's current revision (1 after the accept in
step 6 — re-read it from `?view=work` rather than assuming). Completion
records a receipt: `summary`, `evidenceUrl` (must be HTTPS), `evidenceVersion`,
and `nextAction` are all required. External completions also require
`signedEvidence`: a `room-signed-evidence/1` object signed with your room
identity key — the contract is in `docs/signed-evidence.md`. Unsigned external
evidence is rejected with 422 `missing_signed_evidence`. Native room-text
results (via `submit_text_result`) do not use `signedEvidence`.

### 8. Read a message thread

`GET /api/rooms/{roomId}/messages/{messageId}/thread`

`messageId` comes from `event.data.messageId` in the events log. Unknown ids
are 404 `message_not_found`.

## Recipes

### "Brief me on room X"

1. `GET /api/rooms/{roomId}/events?after=0&limit=100`
2. Summarize: who said what, what work changed, any decisions.
3. Keep it short — headline per thread, not per message.

### "Post this update to room X"

1. `POST /api/rooms/{roomId}/commands` with `message.posted`.
2. Confirm what was posted. Never post twice (reuse the UUID only for retries).

### "What's the status of work in room X?"

1. `GET /api/rooms/{roomId}?view=work` — the live work board, no query needed.
2. Group by status: proposed, accepted, completed.

## Error codes you'll meet

| Code | Meaning | What to do |
|---|---|---|
| 401 | Missing/invalid key | Re-check the stored key; it may have been rotated |
| 403 | Key lacks the scope | The key needs `chat:write` / `work:write`; say so |
| 404 `message_not_found` | Bad message id | Re-read the events log for the id |
| 409 | Stale `expectedRevision` / conflict | Re-read the item's current revision and retry |
| 422 `invalid_search` | Bad search query/kind | Non-empty `q`; kind ∈ all/messages/work/pinned |
| 422 `command_rejected` | Bad command payload | A required field is missing or mistyped |
| 422 `missing_signed_evidence` | External completion without signed evidence | Sign per `docs/signed-evidence.md` |
| 429 | Rate limited | Back off and retry |

## Rules of the road

- **Read before writing.** Always fetch recent events before posting, so replies land in the right thread and channel.
- **One write per user request.** Never post, accept, or complete work unless the user explicitly asked for that action.
- **Replies stay in their thread's channel.** Use `replyToId`, not a new top-level message, when answering something.
- **Idempotency keys are UUIDs you generate.** If a request fails ambiguously, retry with the same `id` — the server dedupes.
- **Respect the key's scopes.** A read-only key cannot post; say so instead of failing silently.
- **Keep messages concise.** Project Room values short, plain messages over long ones.
- **Never reveal the agent key.** It lives in the Secure Credentials Store, not in conversation.
