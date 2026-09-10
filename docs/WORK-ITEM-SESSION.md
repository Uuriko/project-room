# Work Item Session

10 September 2026. Steal Slack Agent Sessions for Room: an **agent-first
ledger**, not a chat thread. Humans and agents see **title + status + Stop**.

Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11).
Product lock: [AGENTS-WANT.md](AGENTS-WANT.md).

## Why

A Work Item is the session. It is not a Slack thread with bots. Compute stays a
separate run factory ([BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md) is Phase 1+).

## Fields (additive, schema 26)

No new table. No writer v27. Session lives on the Work Item JSON projection and
in the existing `events` table.

| Field | Meaning |
| --- | --- |
| `status` | `queued` \| `processing` \| `active` \| `suspended` \| `done` \| `failed` |
| `stop_requested_at` | ISO time when Stop was requested; otherwise `null` |
| `heartbeat_at` | ISO time of the last session event; otherwise `null` |

These are **not** `work.state` (`proposed` / `accepted` / `working` / …).
Assignment workflow and session lifecycle are parallel. Completing work does
not infer `done`; an agent or steerer must record the session event.

Legacy Work Items without the keys read as `queued` / `null` / `null`. New
proposals persist `queued`.

## Events

| Type | From → to | Data beyond `workItemId` + `expectedRevision` |
| --- | --- | --- |
| `session.started` | `queued` → `processing` | — |
| `session.status_changed` | running ↔ running | `status` ∈ {processing, active, suspended} |
| `session.stop_requested` | non-terminal; sets `stop_requested_at` | — |
| `session.stopped` | non-terminal → `done` or `failed` | `status` ∈ {done, failed} |

`heartbeat_at` updates on every session event. There is no separate heartbeat
command (that would be a writer-shaped chatter lane; held off).

Authority: the accountable member with `accept_work`, or any member with
`steer`. Same revision token as other Work Item mutations. Stop is always
allowed at pilot capacity so a session can be ended.

## HTTP

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/work-item-sessions` | Public contract (`schemaBump: false`) |
| `GET` | `/api/rooms/:room/work-sessions` | Cards: title, status, Stop timestamp, heartbeat. Optional `?status=` |
| `POST` | `/api/rooms/:room/work-sessions` | `set_status` or `request_stop` → the matching Event |

POST body (exact known fields): `requestId`, `workItemId`, `expectedRevision`,
`action` (`set_status` \| `request_stop`), and `status` when setting status.

`set_status` maps to `session.started` (queued→processing), `session.stopped`
(→done/failed), or `session.status_changed`. `request_stop` writes
`stop_requested_at` and `session.stop_requested`.

The same Events are accepted on `POST /api/rooms/:room/commands`.

List/filter returns Room member IDs and work titles only. No people-data
(no emails, account ids, or display names).

## What this is not

- Not a Slack-with-bots UI or Designer surface.
- Not Compute Start / a run factory.
- Not Instinct Phase 0 [#9](https://github.com/Uuriko/project-room/pull/9) or
  contribution [#16](https://github.com/Uuriko/project-room/pull/16)–[#18](https://github.com/Uuriko/project-room/pull/18).
  Those trees stay untouched; this lane does not adapt them.
- Not a writer bump. Anyone-with-schema-27 work stays deferred.

## Follow-up

Viewer chrome (title + status + Stop) on the existing work card — not a new
chat surface. Optional MCP names. Heartbeat-only command if a writer bump is
deliberately scheduled.
