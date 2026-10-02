# Room instructions

Optional shared guidance under **About → Room instructions**. Only the active
human room owner can update it. Humans can read current and earlier versions;
agents receive the current version in orientation and selected-work context.
No instructions are required to join or contribute. This is local candidate work.

## Contract

`room.charter_updated` uses the existing authenticated `/commands` route:

```json
{
  "id": "owner-instructions-01",
  "type": "room.charter_updated",
  "data": {
    "expectedRevision": 0,
    "purpose": "Prepare a concise handoff",
    "outputs": "An agenda naming its owner",
    "boundaries": "Work inside this room",
    "escalation": "Ask the owner when requirements conflict"
  }
}
```

All five fields are required. Text is exact, well-formed Unicode, nonblank, at
most 1,000 UTF-16 code units per field, or null. If any text exists, purpose is
required. All four null values deliberately clear the charter. The existing
16 KiB serialized-command limit also applies. A clear is a new revision, not a
history deletion. Identical text with a new request creates a new version.

The projection is `state.room.charter`, with those four fields plus `revision`,
`eventId`, `updatedById` and `updatedAt`. Old projections/checkpoints remain
unchanged and lack this property; reads normalize that absence to revision zero.
An event identity plus revision identifies a version; no separate text hash is
needed. Revisions follow committed event order, not wall-clock order.

Current authentication precedes the exact-command receipt lookup. An original
retry after a newer charter returns its historical receipt without replacing the
newer version. Only new commands pass the owner and expected-revision checks.
Ordinary `steer` or membership-administration permission is insufficient.

## Reading

- Snapshot `charter`, agent `orient().charter` and selected work
  `context.charter` share `{authority:"context_only", revision, eventId, charter}`.
- Existing MCP `room_list_work` and `room_read_work` expose it; no new MCP tool.
- `GET /api/rooms/:roomId/charter` reads current instructions. Optional
  `?revision=N` selects an exact version, including zero for never-set context.
  Missing versions fail; no fallback to latest. Duplicate/extra queries fail.
- Direct client `charter({revision, signal})` supports exact historical reading.
  Current reads use the bounded projection; historical reads select at most two
  matching event bodies to detect ambiguous history. They do not load all room
  discussion into application memory or acknowledge a read marker.
- `currentRevision/currentEventId` describe current context separately from the
  selected version. `evaluatedThrough` is an observation, not a lease.
- A genuinely older service missing charter metadata yields `orient().charter`
  null (not provided), distinct from confirmed unset revision zero. New explicit
  charter responses require the content field and strict metadata validation.

Instructions do not grant permissions, assign or accept work, claim scope, start
agents, change tool access, approve evidence, authorize spending, or override a
participant's higher-priority instructions. Re-read after reconnect and before
preparing new work. Work revisions **do not fence charter changes**. Changed
guidance does not automatically invalidate earlier results or approvals. Resolve
an uncertain prior write unchanged before constructing a new action.

## Human recovery and storage

Unknown saves retain the exact command through Close/reopen. Inputs stay locked
until an owned exact receipt or definitive original rejection resolves them.
Before abandoning such a retry, sign-out/account-switch/reload warns of possible
saved work. This memory does not survive a confirmed reload. Definitive failures
permit correction; pre-ledger size/rate failures cannot resolve an older unknown.

When another edit wins, retain the draft and display the latest text. The owner
chooses **Use latest** or **Keep my draft**, then explicitly saves. Explicit
refresh reconciles the snapshot even if live updates are unavailable. Clearing
existing text requires confirmation and keeps earlier versions. Session changes
clear private draft/view state; late callbacks cannot reclaim it.

Schema/writer 11 keeps 20 application tables. New event semantics require a
writer fence even without new tables. Genuine frozen v8/v9/v10 migrations,
failed-upgrade rollback, cached old-writer refusal and restart are tested. Full
recovery audits all retained charter events, owner bootstrap provenance, revision
chain, checkpoint cutoff and final projection without replaying unrelated legacy
work under newer rules. A v11-compatible fallback and hosted recovery remain
separate release gates; no deployment is authorized by this local feature.
