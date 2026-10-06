# `GET /api/rooms/{roomId}/work-claims-read` — route contract

Read-only projection of a room's canonical stored work claims. Ships with PR
#1468 ("feat: read canonical Board claims across MCP and SDK").

This is the read slice the hosted MCP `room_read_board` tool, the SDK
`board()`, and stdio use to fetch exactly one claim page (default 50, maximum
200) with `queue`/`state`/`limit`/`cursor` arguments, propagating
errors/cancellation. Older servers answer 404; the new callers have no
fallback, so a 404 means the server predates the route.

The key difference from the ordinary `GET /api/rooms/{roomId}/work-claims`
list: **this route performs no claim lifecycle housekeeping.** Expired leases
are not auto-released here, no claim/event/receipt/wake effects are emitted,
and the page is live — not a snapshot fenced by the room event sequence.

## Route row

| Field        | Value                                        |
| ------------ | -------------------------------------------- |
| Method       | `GET`                                        |
| Path         | `/api/rooms/{roomId}/work-claims-read`        |
| Auth         | `room`                                       |
| Scope        | `room`                                       |
| Capability   | none                                         |
| Path params  | `roomId` (required string)                   |
| Response     | JSON object                                  |
| Events       | none                                         |

## Auth

Same read guard as the other room routes:

- Bearer <redacted> credential or browser session. No credential → `401 unauthenticated`.
- A bearer <redacted> whose credential scope is not the room → `403 access_denied`.
- API keys need the `rooms:read` (or `rooms:*`) scope, else `403 insufficient_scope`.
- The caller must be an active member of the room, else `403 not_member`.

## Query parameters

Every key must be one of `queue`, `state`, `limit`, `cursor` (plus the
transport-level `auth` key), and each may appear at most once. Anything else
is `422 invalid_claim_input` (`"Expected a single queue, state, limit, or
cursor query parameter."`).

| Param    | Values                                                                 | Default |
| -------- | ---------------------------------------------------------------------- | ------- |
| `queue`  | `ready` only — unclaimed, ownerless claims with satisfied dependencies | —       |
| `state`  | `unclaimed`, `claimed`, `in_progress`, `blocked`, `done`               | —       |
| `limit`  | integer `1`–`200`                                                      | `50`    |
| `cursor` | opaque `nextCursor` from a prior page                                  | —       |

Validation failures are `422 invalid_claim_input` with an `"Expected …"`
message:

- `limit` outside `1..200` or not an integer → `"Expected limit as an integer 1..200."`
- `state` not one of the five states → `"Expected state one of unclaimed, claimed, in_progress, blocked, done."`
- `queue` anything but `ready` → `"Expected queue=ready."`
- `queue=ready` together with `state` → `"Expected either queue=ready or state, not both."`
- a cursor that is not the opaque `nextCursor` of a prior page → `"Expected cursor as the opaque nextCursor from a prior work-claims page."`
- a `queue=ready` cursor on a plain page (or vice versa) → `"Expected a cursor from a work-claims page."` / `"Expected a cursor from a queue=ready page."`
- a cursor issued under one `state` filter reused on another → `"Expected a cursor from a page with the same state filter."` (New cursors bind their state filter. Legacy pre-F12 cursors without a state marker keep their prior unbound continuation behavior.)

## Response (200)

```jsonc
{
  "roomId": "commons",
  "source": "work-claims",
  "evaluatedAt": "2026-10-05T21:00:00.000Z",
  "consistency": "live",
  "limit": 50,
  "historyLimit": 3,
  "historyScope": "recent_done_and_dependencies",
  "claims": [ /* board order: updatedAt desc, then id */ ],
  "hasMore": false,
  "nextCursor": null
}
```

- Page metadata: `roomId`, `source: "work-claims"`, `evaluatedAt` (ISO time
  the page was evaluated), `consistency: "live"`, the effective `limit`, and
  `historyLimit: 3`.
- Scope markers: the default page carries
  `historyScope: "recent_done_and_dependencies"`; `?queue=ready` adds
  `queue: "ready"` and `historyScope: "ready"`; `?state=X` adds `state: "X"`
  and `historyScope: "state"`.
- `claims` are the stored items in board order. Each claim's `history` is
  compacted to the newest three entries; the dropped remainder is counted in
  `historyOmitted`. Member-authored text is content-trust stamped for the
  viewer, exactly like the ordinary list.
- `hasMore` / `nextCursor`: follow `nextCursor` with the same filters for the
  next page. Cursors are opaque — pass them back unchanged.

## Default scope

Without `queue` or `state`, the page shows open claims plus done claims
updated within the last seven days, plus older done claims that are still
dependency exceptions for visible work. Older done claims beyond that are
counted in `olderDone` with `olderDoneQuery: "state=done"`; pass
`state=done` to list every done claim (still with compacted three-entry
history tails).

## Contract tests

`tests/work-claims-read.test.js` pins this contract: the route-table row and
its mount, dispatcher method handling, the auth guard, the response shape,
every validation case above, cursor pagination and state binding, the
seven-day done window, and the no-housekeeping read (an expired lease stays
`claimed`).
