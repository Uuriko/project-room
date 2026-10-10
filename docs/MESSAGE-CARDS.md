# Rich message cards

A Discord-embed-style card that can ride on a `message.posted` event next to
the text body, for dashboards, alerts, and game UIs. Cards are purely
additive: messages without one render exactly as before, and every client
that reads the event stream already receives the card — rendering it is each
client's job, under the contract below.

## Where cards come from

Today cards enter the room through inbound channel webhooks
(`POST /api/rooms/{roomId}/inbound-webhooks/{webhookId}` with `{ text, card? }`).
`validateMessageCard` (`src/message-cards.js`) runs at write time — in the
deliver path and again in the `message.posted` reducer — so anything stored
on a message already passed the schema. Unknown fields are refused, never
silently dropped.

## The card JSON shape

```json
{
  "title": "Deploy",
  "description": "shipped **v2**",
  "url": "https://ci.example/runs/1",
  "color": "#00ff00",
  "image": "https://ci.example/badge.png",
  "thumbnail": "https://ci.example/avatar.png",
  "fields": [{ "name": "env", "value": "prod", "inline": true }],
  "footer": "ci-bot",
  "timestamp": "2026-10-06T22:00:00.000Z"
}
```

Limits: `title` 256 chars (required, non-empty); `description` 4096;
`url`/`image`/`thumbnail` 2000 chars; `color` a `#rrggbb` hex string;
`fields` at most 25 entries with `name` 256 / `value` 1024 (both required)
and optional boolean `inline`; `footer` 2048; `timestamp` an ISO-8601 string.
`url`, `image`, and `thumbnail` must be `https:` URLs whose hosts are not
private/reserved IP literals (`http:`, `javascript:`, `data:`, and friends
are refused).

## Cross-client render contract

Every client that renders a card — web, mobile, CLI, bot — follows these
rules. They are what make third-party card content safe to display:

1. **Escape every string.** Titles, descriptions, field names/values, and
   footers are untrusted third-party text. HTML-escape before inserting into
   markup; the web client also runs descriptions and field values through the
   same Discord-style markdown as message bodies *after* escaping (so
   `**bold**` renders but `<img onerror=…>` cannot).
2. **Never fetch card URLs server-side.** `url`, `image`, and `thumbnail`
   render client-side as ordinary links/images (`loading="lazy"` on the web).
   There is no server-side fetch to aim at internal infrastructure — keep it
   that way. Validate the `https:` scheme and the private-host refusal again
   at render time if your client re-parses the JSON (defense in depth; the
   write path already did).
3. **Links open out-of-band.** The web client renders the title link with
   `target="_blank" rel="noopener noreferrer"`. Other clients should open
   card URLs in the system browser / a new context, never inside the app's
   privileged webview without the same protections.
4. **Invalid cards render as nothing.** If a card fails validation at read
   time (a client on an older schema, a corrupt cache), render no card at
   all — never a broken half-card. The message body still renders.
5. **Text fallback.** Text-only surfaces (notification text, search excerpts,
   plain-text exports) should include the card's `title` and the field
   `name: value` pairs so the card's information is not silently dropped
   where rich rendering is unavailable.

## What each client does today

| Client | Card support |
| --- | --- |
| Web (`src/app.js` → `messageCardHtml`) | Full render: accent color, linked title, markdown description, fields grid, image/thumbnail, footer with timestamp |
| REST `/events`, `/stream` | Raw card JSON inside `message.posted` event `data.card` |
| MCP `room_list_events` | Same raw card JSON in the event data |
| MCP `room_post_message` | Not yet: posts `{ messageId, body, replyToId }` only |
| Web composer | Not yet: cards arrive via inbound webhooks |

A card that a client cannot render is data, not an error: keep the message,
skip the card, and follow rule 4.
