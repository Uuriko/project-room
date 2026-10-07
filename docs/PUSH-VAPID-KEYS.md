# Turning on human browser push: the VAPID key tap

Browser push delivery is fully built and fully dark. Everything up to the key
boundary is in the code: payload construction (counts-only v1, rich v2 with
sender/preview/deep-link), the service worker that renders them, per-member
preview and quiet-hours preferences, and the delivery path with retries and
dead-subscription retirement. With no keys set, the whole feature is inert:
posts land, nothing is sent, nothing fails, nothing is logged as an error.

Production delivery needs exactly three values from John. Nothing else is
missing.

## The three values

| Name | What it is |
|---|---|
| `ROOM_VAPID_PUBLIC_KEY` | VAPID public key, base64url (the `applicationServerKey` browsers subscribe with) |
| `ROOM_VAPID_PRIVATE_KEY` | VAPID private key, base64url — **secret** |
| `ROOM_VAPID_SUBJECT` | Contact URI for the push services, e.g. `mailto:you@example.com` |

All three must be present. Any one missing keeps delivery off — there is no
partial mode.

## Where they go

- **Node / self-host:** environment variables on the server process. The
  server reads them at startup (`vapidFromEnv(process.env)` in
  `server/http.mjs`); a restart picks up new values.
- **Cloudflare Worker (production):** Worker secrets with the same names:
  `wrangler secret put ROOM_VAPID_PUBLIC_KEY`, `wrangler secret put
  ROOM_VAPID_PRIVATE_KEY`, `wrangler secret put ROOM_VAPID_SUBJECT`.
  The Worker passes its env through `vapidFromEnv(env)` in
  `cloudflare/room.mjs`. Names only, never values, in git.

## How to generate and verify (John runs these)

```bash
node scripts/push-doctor.mjs --keys     # prints a fresh VAPID pair once; store the private key as a secret now
node scripts/push-doctor.mjs --check    # confirms the environment sees all three
node scripts/push-doctor.mjs --send --subscription sub.json   # one real test push to a browser-subscribed device
```

`--keys` prints the private key to stdout exactly once and writes nothing to
disk. `--send` needs a subscription captured from a browser that granted
notification permission (`PushSubscription.toJSON()`); it reports only the
push service's verdict, never message content.

## What changes the day the keys land

- Mentions and DMs start waking subscribed human browsers (both kinds are on
  by default per member per room; members can switch either off).
- Payloads stay **counts-only** (`{ v: 1, roomId, unread, counts }`) unless a
  member opts into previews. This is deliberate: the standing privacy
  contract is that a push names the room and a count, never the message, and
  the default preserves it.
- A member who turns preview on (`PATCH /api/rooms/{roomId}/human-push` with
  `{ preferences: { preview: true } }`) gets the rich payload: sender name,
  a 140-char lock-screen-safe preview, and a deep link
  (`/?room=<id>#pr-record/message/<id>`) that opens the message on tap.
  Turning preview back off restores the counts-only payload byte for byte.
- Quiet hours (`{ preferences: { quietHours: { start: "HH:MM", end: "HH:MM",
  tz: "IANA/Zone" } } }`, or `null` to clear) silence the push channel for
  the member's window; the message still lands in the room. The window is
  checked at post time *and* re-checked just before the push is sent, so a
  window that starts (or a preference the member enables) between the post
  and the async send still suppresses it — a push never fires inside quiet
  hours.

## Delivery guarantees

- **No stale re-badge.** Every payload stamps the newest event sequence the
  counts were evaluated through. The service worker drops a push whose
  sequence is not newer than one already shown for that room, so a delayed
  delivery can never replace the current notification with older counts or
  re-badge a room the member has already read. Payloads without a sequence
  are always shown; rooms are tracked independently.
- **Previews stay opt-in.** Counts-only is the default payload; sender,
  preview text, and deep link enter a payload only when that member turned
  preview on for that room.

## Open product decision (John's call, not a blocker)

Preview defaults **off**. Flipping the default to on is a one-line change
(`preview_enabled` default in `server/human-push.mjs` + the migration in
`server/store.mjs`), but it moves message content onto members' lock screens
without them asking, which overturns the deliberate privacy contract above.
Recommend keeping off until there's a reason to change it.

## If delivery misbehaves

`scripts/push-doctor.mjs --check` distinguishes "keys missing" (feature
inert, by design) from "keys present but pushes failing" (push-service
verdicts in `--send`). 404/410 from a push service retires that subscription
automatically; 429/5xx retry. Push failures never fail a room write.
