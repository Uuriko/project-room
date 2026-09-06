# Bridge: Room Work Item → Compute job → Receipt

Phase 1+ contract, 2026-09-06. Not a live integration and not a Phase 0 task.

Room stays a work OS. Compute stays a marketplace factory. The bridge is a thin tool call: a Work Item posts a job, follows that job, and records a Receipt Event. See the [product lock](./FOLD-COMPUTE-ROOM.md).

## Flow

```
Room Work Item
    → POST job to https://lobby.getdasha.com/compute/api
       (www.getdasha.com/compute/api is a forwarder; same API)
    → job lifecycle on Compute
    → Receipt Event on the same Work Item
```

Use the existing Compute surface. Preferred write is `POST /compute/api/v1/chat/completions` (or the stored-job path the gateway already documents). Then follow `GET /compute/api/jobs/:id` when Compute stored the job. Do not invent a second marketplace inside Room. Do not invent a second work OS inside Compute.

Room copy, if any, stays short. These lines are tone, not live measurements:

> Sent to Compute. Waiting on a Mac.
> Receipt in. model id · community · tok/s if measured · settled cents if paid.
> Mac offline. Still queued.
> Honesty UNKNOWN. No invented speed.

## Field map

Room sends correlation on the job. Compute remains source of truth for the run. Room copies honesty into a Receipt Event; it does not re-measure.

| Room field | Compute / Receipt use |
| --- | --- |
| `work_item_id` | Correlation. Required on the outbound job so a late result lands on the same Work Item. |
| `room_id` | Correlation. Required so a receipt cannot attach to the wrong Room. |
| Model preference | Prefer MLX when a Mac can. Do not invent kit flags. If Compute reports a different engine, record what ran. |
| Compute job id | Store on the Work Item / Event as the exact run reference. |
| Model id | Copy into the Receipt when Compute reports it. |
| tok/s | Copy only if Compute measured it (heartbeat / benchmark). Otherwise honesty `UNKNOWN`. |
| Provider class | Copy `hosted` or `community` when Compute reports it. Mixture or self-route: record the class Compute actually used. |
| Settled cents | Copy only if paid and Compute reports a settle. Pending or failed settle is not a guessed amount. |

Producer and provenance follow the [v0 object model](./SPEC-v0.md): record them when known, else mark unknown. A Compute job id is a source reference, not independent verification.

## Identity

- Humans reuse the getdasha session and X where possible. Room does not mint a second consumer login for the same person just to call Compute.
- Agent members authenticate with Room keys. A Room agent credential is not a Compute provider token and not a developer key unless an owner explicitly issues one.
- Never ask for Potter wallet secrets. Pay and provider payout stay on Compute. Room may link to Pay / Credits; it does not collect seed phrases, exported keys, or operator wallets.
- Source material still needs Room audience permission before it enters a prompt. Private Room context does not become a Community Mac prompt.

## Job lifecycle → Room events

Compute owns queued, leased, completed, failed, cancelled, and expired. Room does not invent extra work states for those. Existing work states stay `proposed` / `accepted` / `working` / `blocked` / `completed` / `superseded`.

| Compute signal | Room record |
| --- | --- |
| Job accepted / queued | Attempt Event. Work may move `accepted` → `working` when the accountable member started it. |
| Leased / running | Progress Event with the job id. Mid-run steer stays in the Room conversation and assignment; Compute cancellation is a separate job action. |
| Completed with stored usage | Completion or evidence Event plus a Receipt Event on that Work Item. Copy honesty fields. |
| Failed / cancelled / expired | Honest Event with the Compute reason. Do not mark completed. |
| Duplicate delivery of the same job id | One logical receipt. Same source, Room, event ID, and payload returns the existing Event. |

Replaying Room events never re-POSTs the job.

## Failure modes

Room records what happened. It never invents metrics, provider class, or cents.

| Failure | Honest Room Event |
| --- | --- |
| Mac offline / no community capacity | Queued or blocked with Compute's "No Mac online" (or equivalent). Offer Hosted only if the member chose that class. Do not boast Community. |
| Honesty UNKNOWN | Receipt still records the job id and whatever Compute did report. Missing tok/s, model id, class, or settle is `UNKNOWN`, not a guessed number. |
| Settle fail or still pending | Record pending or failed settle. Do not write settled cents. Do not treat unpaid or un-settled work as paid. |
| Unknown external outcome | Keep the uncertainty. Reconnect checks Compute for that job id before retry. A retry uses a new job unless Compute says the original is safe to reuse. |
| Auth / key / credits rejected | Record the rejection. Do not silently fall back to Potter's wallet, a shared operator key, or an invented free run. |

## Non-goals

- Room does not become a GPU marketplace. No Provide kit, Mac registration, payouts, Night Shift, or credits ledger inside Room.
- Compute does not become a multiplayer work OS. No Room membership, Work Items, verifier handoff, or owner decisions inside Start.
- This bridge does not ship in Phase 0. It does not move `instinct/integration-2026-09-06`, Quiet Focus, the adversarial harness, or production paths.
- No `/room` product page in this change. Reserve the path; publish it when Phase 0 actually ships.
- Never plugin.jup.ag. Never people-data. Never live volume, maps, or sparklines invented for a Room receipt.
