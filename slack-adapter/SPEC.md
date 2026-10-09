# Slack adapter prototype — SPEC

Standalone prototype (WAVE-2000 guild 31). Maps Project Room room events to
Slack-style messages and Slack Events API input back to room commands.
Runs **locally against fakes only** — no real Slack workspace, no real
tokens, no network I/O anywhere in this directory.

## 1. Direction: room → Slack

`roomEventToSlack(event, ctx)` is a total function over the room event log
shape `{ id, sequence, type, actorId, at, data }`. Every payload carries a
non-empty `text` fallback (Slack requires it) plus Block Kit `blocks`, and
`_meta` provenance `{ roomEventId, roomEventType, roomSequence, mappedAs }`.
`_meta` is adapter-internal and is **not** sent to Slack.

### Mapping table

| Room event type | Slack rendering |
|---|---|
| `message.posted`, `message.edited` | Section block: `*author*` + body (mrkdwn-escaped); context line with event id + timestamp; work-item tag when `data.workItemId` |
| `thread_reply` | Same as message + `:speech_balloon:` context header; posted with `thread_ts` resolved from `data.replyToId` via the bot's thread map (parent room event id → Slack ts) |
| `dm.posted` | `:lock:` prefixed card naming sender → recipient; context line marks it a DM |
| `member.access_changed`, `member.joined` | Compact `:busts_in_silhouette:` line: who acted on whom |
| `bond.proposed` / `bond.accept` / `bond_decline` / `bond_revoked` | Header + section card with status emoji and amount when present |
| `work.claimed`, `work_update`, `work_claim_conflict`, `work_review_rejected` | Status card with state emoji, task id, owner, inline `` `file` `` chips |
| `verification.pass` / `verification.fail` | PASS/FAIL line naming the check and verifier |
| `owner.decision`, `owner_required` | Crown header + decision text |
| *(anything else)* | Compact fallback card: `` `event.type` `` + event id + "unmapped type". **Never threaded** — threading a guess would misplace replies. |

### Escaping

`escapeMrkdwn` replaces `&`, `<`, `>` with `&amp;`, `&lt;`, `&gt;` before
inserting any room text into mrkdwn, so room content can never inject
mentions, links, or formatting. Bodies are clipped to 2800 chars, titles to
120, ids to 12–40 chars depending on field.

### Threading

The bot keeps `threadMap: Map<roomEventId, slackTs>`. When a room event
carries `data.replyToId`, the mapper looks up the parent's Slack ts and sets
`thread_ts`, so room threads become Slack threads. If the parent was never
posted (e.g. bot started mid-stream), the message posts top-level — it is
never dropped.

### Dedup

The bot dedupes on `event.id` (a `Set`). Re-delivery of the same room event
never produces a second Slack message. Stats counters: `roomEvents`,
`posted`, `fallbacks`, `skipped`, `inbound`, `inboundIgnored`.

## 2. Direction: Slack → room

`slackEventToRoom(envelope, ctx)` maps Events API payloads to room commands:

| Slack event | Room command |
|---|---|
| `app_mention` | `{ type: 'message.posted', data: { messageId, body, authorId, channel: 'room', via: 'slack-adapter', slackTs, slackChannel } }` — leading `<@BOT>` mention stripped |
| `message` (plain, no subtype) | Same command shape |
| anything else | `null` (ignored, not an error) |

Suppression rules (echo prevention): events with `bot_id`, events from the
bot's own user id, `subtype` of `bot_message` / `message_changed` /
`message_deleted`, mentions with empty text after stripping, and messages
with empty text are all ignored.

`verifySlackSignature({ signingSecret, timestamp, rawBody, signature })`
implements Slack's `v0` request-signing scheme (HMAC-SHA256 over
`v0:{timestamp}:{body}`, timing-safe compare). Requests older than 5 minutes
are rejected. In fake mode the shared secret is `FAKE_SIGNING_SECRET`; a
live deployment would inject the real signing secret here and mount the
verifier in front of the events endpoint. No live endpoint is included in
this prototype.

## 3. The fake

`FakeSlack` (see `fake-slack.mjs`) implements an in-memory subset of the
Slack Web API: `auth.test`, `conversations.list`, `chat.postMessage`,
`chat.update`, `chat.delete`, `reactions.add`, `users.list`, plus an inbound
event sink (`emitSlackEvent` / `onInbound`). It:

- accepts **only** `FAKE_TOKEN` (`xoxb-fake-slack-adapter-do-not-use`); any
  other token → `invalid_auth` on every method, so the fake can never be
  confused with a live client;
- mirrors real Slack error names (`channel_not_found`, `message_not_found`,
  `no_text`) for the subset it covers;
- generates monotonic Slack-shaped timestamps (`1728000000.0001xx`);
- performs **zero network I/O** — no `fetch`, no sockets, no `https`.

## 4. What a real deployment would still need

Documented here so the prototype's boundary is explicit — none of it is in
this directory: a real bot token + signing secret (stored in a secret
manager, never in code), a public HTTPS events endpoint behind signature
verification, channel/identity directory provisioning, retry + rate-limit
handling for `chat.postMessage` (Slack `ratelimited` + `Retry-After`),
and an operator runbook. The prototype proves the mapping layer; the
transport layer is deliberately out of scope.

## 5. File map

- `fake-slack.mjs` — the in-memory fake
- `event-map.mjs` — room → Slack payload mapping (pure)
- `inbound-map.mjs` — Slack → room command mapping + signature verify
- `bot.mjs` — runtime wiring (dedupe, thread map, stats)
- `example.mjs` — runnable demo against the fake
- `slack-adapter.test.mjs` — test suite (`node --test slack-adapter/`)
- `app-manifest.json` — scopes a real app would request (documentation only)
