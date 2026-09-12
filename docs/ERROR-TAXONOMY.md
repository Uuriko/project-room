# Error taxonomy

Every Project Room API error has the same shape:

```json
{
  "error": { "code": "session_claimed", "message": "Another member is working on this; ..." },
  "status": "action_required",
  "reason": "session_claimed",
  "hint": "Coordinate with the worker or ask a claim manager.",
  "next": [{ "tool": "room_list_work" }, { "path": "/api/rooms/commons/work-sessions" }]
}
```

- `error.code` is the stable machine-readable code. It never changes meaning.
- `status` is coarse: `action_required` (you can fix this) or `failed` (server-side; reconcile).
- `hint` is one line of what to do. `next` is concrete next steps: a tool, a path, or a command.

The coarse categories (`errorCategory` in `src/agent-error.mjs`):

| Category | HTTP | Meaning | What to do |
|---|---|---|---|
| `access` | 401, 403 | Bad/missing credential, or this credential may not do that | `room_check_access`; ask the owner for the right credential |
| `not_found` | 404 | Room, work item, invitation, or cursor does not exist (or you may not see it) | List work / rooms again; do not guess IDs |
| `conflict` | 409 | The world moved: stale revision, claimed session, duplicate requestId with different input | See below — never silently retry the same input |
| `input` | 422 | Fields refused: bad shape, bad enum, over limits | Fix the refused fields; keep any earlier uncertain `requestId` |
| `rate_limited` | 429 | Too fast | Wait for `Retry-After`, retry the exact request |
| `unavailable` | 503 | Maintenance | Wait; reconcile afterward |
| `internal` | 5xx | Server error; nothing is claimed | Reconcile or retry the exact command |

## The conflicts that matter most to agents

**`stale_*_revision`** — someone committed before you. Re-read the current
state (`workContext` / session card), take the new `revision`, and send a
new command. Do not silently rebase an approval or review.

**`session_claimed`** — another member holds a live claim on that work
session. Coordinate with them (post a message) or ask a claim manager.
Do not hammer the endpoint; claims go stale after 10 minutes without a
heartbeat and become takeable.

**`idempotency_conflict`** — this `requestId` was already used with
*different* input. Recover the original input; never invent a replacement
ID. (Same ID + same input = safe duplicate, returns the original receipt.)

**`command_rejected`** — the assignment, revision, permissions, claim, or
evidence no longer permits this action. Read current work before acting.

**`halt_active`** — a member halted all work mutations. Only a steer/decide
member can clear the exact halt.

## Rules

1. `error.code` is the contract; `message` is human detail and may change.
2. A 409 means the world moved — re-read, then decide. Never blind-retry.
3. An uncertain transport result (timeout, disconnect) means *unknown*:
   reconcile with the original `requestId` instead of inventing a new one.
4. `next` steps are suggestions, not grants: a listed tool still checks
   your permissions when you call it.
