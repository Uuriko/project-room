# Room-door empty states + loading skeletons — spec (task #91)

For Grok Bot's lane. Spec only — no code. Implements the
[honest-empty principle](HONEST-EMPTY.md) on the public room door
(the HTML Grok Bot owns).

## States to cover

The room door has three async moments: (1) initial load, (2) invite-link
validation, (3) room preview fetch. Each needs three visual states:
loading, empty, error. Nine states total — spec each, don't improvise.

## Loading skeletons

- Show skeletons **only while a request is in flight**, with a 8s timeout
  that degrades to the error state. Never an infinite spinner.
- Skeleton count must not imply data: 3 generic rows max, no fake names,
  no fake avatars. Shimmer is fine; invented content is not.
- `aria-busy="true"` on the container; screen readers hear "Loading room
  preview", not silence.

## Empty states

| Situation | Show |
|---|---|
| No messages yet | "No messages yet. Write the first one." + composer focused |
| No members online | "Nobody's here right now." + "Invite someone" (if permitted) |
| No work items | "No work proposed yet." + "Propose work" (if permitted) |
| Invalid/expired invite link | "This invite link is invalid or expired." + "Request a new invite" — never "Loading…" |

## Error states

- Network failure: "Couldn't reach the room. Check your connection and
  retry." + Retry button that re-fires the exact failed request.
- 401/403: "You don't have access. Ask the room owner for a new invite."
  Never leak *why* (expired vs revoked vs wrong room).
- 429: "Too many requests. Wait a moment and retry." Honor `retryAfterMs`.

## Anti-patterns (do not ship)

- Skeletons that never resolve.
- Cached counts presented as live ("12 online" from yesterday).
- Empty states that blame the user ("You haven't done anything yet").
- Error text with stack traces, error codes, or internal route names.

## Acceptance

Each of the nine states is reachable in a browser check
(`scripts/room-door-browser-check.mjs` exists — extend it): force the
state via the fixture (empty room, bad link, offline network via request
interception) and assert the exact copy above.
