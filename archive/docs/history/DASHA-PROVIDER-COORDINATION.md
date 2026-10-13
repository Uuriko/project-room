# Room endpoints Dasha Compute provider coordination could reuse (task #45)

Dasha Compute needs: providers to come online, prove it, get matched with
demand, and show proof of completed work. The room already has every
primitive for this; nothing new needs building for a v0.

## Mapping

| Dasha need | Room primitive | Endpoint |
|---|---|---|
| Provider shows up | Member with `kind: "agent"` | `POST /api/rooms/:id/commands` (MEMBER_ADDED) |
| Provider advertises capacity ("2x M4 Mac mini, 24GB") | Capability registry | `POST /api/rooms/:id/capabilities` |
| Provider is currently online | Presence roster | `GET /api/rooms/:id/presence` |
| Job offered to providers | Work item | `POST /api/rooms/:id/commands` (WORK_PROPOSED) |
| Provider takes a job, no double-booking | Session claim (atomic, 10-min heartbeat lease) | `POST /api/rooms/:id/work-sessions` |
| Provider proves completion | Return brief / work result | `POST /api/rooms/:id/return-brief`, `.../work-result` |
| Job stuck, needs reassigning | Claim expiry → re-claimable | automatic on heartbeat timeout |
| Disputes / audit | Event log + diagnostics | `GET /api/rooms/:id/events`, `/diagnostics` |

## Why this fits

- **Session claims are the double-spend protection.** Two providers racing
  for one job: the first claim wins, the second gets 409
  `session_claimed`. This is the exact semantics compute-job assignment
  needs, already tested (see `docs/LOAD-TEST-2026-09-12.md` — claim races
  under 50 concurrent agents resolve correctly).
- **Heartbeat leases handle provider dropout.** A Mac that goes offline
  stops heartbeating; after 10 minutes the job is claimable again. No
  manual cleanup.
- **Pilot bounds are known.** 100 members/room, 10k events/room. A provider
  coordination room holds ≤100 providers — fine for the pilot, and the
  bound is a feature (bounded blast radius).

## "Done chips" data model (task #46)

A "done chip" is the provider's proof-of-completion, shown in room
activity. Spec:

```json
{
  "workItemId": "job-123",
  "providerMemberId": "provider-acme",
  "completedAt": "2026-09-12T18:00:00.000Z",
  "evidenceKind": "room_text" | "receipt" | "url",
  "evidence": "human-readable summary or receipt id",
  "verifiedBy": "member id of verifier, or null"
}
```

- Stored as the work item's result (`work-result` route), rendered as a
  chip in the activity feed.
- `verifiedBy` null = self-reported; set = a second member (or an
  automated verifier agent) confirmed it. The room's `verify` permission
  gates who can set it.
- No new tables: reuse the work-result payload. The chip is a rendering
  convention, not a schema change.

## Open questions (for John)

1. Do providers join the room directly (agent members), or does a Dasha
   bridge agent represent them? Direct is simpler; bridge is more
   controlled.
2. Is the room the system of record for job assignment, or a coordination
   layer over Dasha's own scheduler? Recommend: room as coordination
   layer first; promote to system of record only after the pilot.
