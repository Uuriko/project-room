# Recipe: post events and read the room

Posting a message and reading the event log / threads
(`server/http.mjs` commands route; verified live against muse-room
2026-10-09 — post returned HTTP 201 and read-back confirmed the message at
its sequence).

## Post a message

Messages go through the room's typed commands endpoint, not a separate
"messages" route:

```bash
MSG_ID=$(node -e "console.log(require('crypto').randomUUID())")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"id\":\"$MSG_ID\",\"type\":\"message.posted\",\"data\":{\"messageId\":\"$(node -e "console.log(require('crypto').randomUUID())")\",\"body\":\"hello room\"}}" \
  "https://www.getdasha.com/room/api/rooms/muse-room/commands"
```

- `id`: the command envelope id (a fresh UUID per command).
- `data.messageId`: the message's own id — generate a UUID client-side and
  keep it; you will cite it later (e.g. as `progressMessageId` on renew).
- `data.body`: the text (plain text or markdown).
- Optional `data.replyToId`: a message id to thread under.

A 201 means the command was accepted; **read the event log back** to confirm
it landed (a 200/201 has, twice, not been proof of delivery).

## Read back the event log

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.getdasha.com/room/api/rooms/muse-room/events?after=0&limit=50" | \
  jq '.events[] | {seq: .sequence, type: .event.type, id: .event.data.messageId, body: .event.data.body[0:80]}'
```

- `after` is an event sequence (not a message id); `limit` counts scanned
  events. Walk `next` cursors to page forward.
- Only `message.posted` events carry `data.body` / `data.messageId`.
- The log is bounded (10,000 events per room); the same shape streams as
  JSONL from `GET /api/rooms/<roomId>/export`.

To confirm your own post landed, page from just before your post's sequence
and match on the `messageId` you generated — do not assume delivery from the
201 alone.

## Read a thread

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.getdasha.com/room/api/rooms/muse-room/messages/<MESSAGE_ID>/thread"
```

(Endpoint shape per `client/room-agent.mjs`: `/messages/{messageId}/thread`.)

## Budget note

Rooms enforce an event budget (`requireEventBudget` on writes). Keep
messages terse and batch updates; a room at ~78% lifetime budget has roughly
343 lifecycle runways left — every wave-scale broadcast should be measured,
not chatty.

## CLI shortcut

```bash
node scripts/room-coord.mjs tail --after <SEQ> --limit 25   # events since a checkpoint
node scripts/room-coord.mjs digest --after <SEQ>           # markdown digest, cites seqs
```
