# Incident: 2026-10-24 writer permit stuck at 42

One row in `room_writer_permit` was committed at version 42 ("write in
progress"). Every cold start of the room Durable Object threw, and every
room went down with it.

## Timeline

The down window is from PR #4878: roughly 9:45 PM to 11:35 PM PT on
2026-10-24. That pull request does not split detect, mitigate, and resolve
into separate clocks.

### Detect

Not recorded separately (PT). The site was down for about two hours before
the window closed, and `/api/health` stayed ok through it.

### Start

2026-10-24, about 9:45 PM PT.

### Mitigate

Not recorded separately (PT). The self-heal in PR #4878 reset the permit.
That patch, applied on `3b1370da`, is live in production as Worker version
`8552c7cb`. It is not on main.

### Resolve

2026-10-24, about 11:35 PM PT. Production has stayed up since the permit
was reset once.

## Cause

`room_writer_permit` is one row (`singleton = 1`). Version 0 means idle.
Version 42 means a write is in progress. 42 is `STORE_SCHEMA_VERSION` in
`server/writer-fence.mjs`.

An outermost transaction in `cloudflare/storage.mjs` calls `verifyPermit`
and requires the row to be 0. A row left at 42 fails that check with
`Database writer fence requires operator reconciliation`. The diagnostic
build recorded `permit value 42 want 0 v42`.

`RoomStore` opens that transaction from the Durable Object constructor, so
the throw happens on every cold start, before a request handler exists.
`cloudflare/room.mjs` routes every room with
`env.ROOM.getByName('invite-only-pilot')`. One stuck row blocks every room.
A `ROOM_SHARD` binding and a `RoomShard` class exist in
`cloudflare/wrangler.jsonc`. The fetch path does not use them.

Which write committed the permit at 42 is still open. PR #4878 says so.

## Why detection took this long

`GET /api/health` is answered by the Worker and does not open the Durable
Object (`cloudflare/room.mjs`). It kept returning `status: "ok"`.

`docs/INCIDENT-RUNBOOK.md` tells the first check to be `/api/health`, and
treats `status: "ok"` as the process being up. That reading was true of
the Worker and false of the room.

`cloudflare/external-probe.mjs` runs every 5 minutes
(`external-probe.wrangler.jsonc`) and requests `/api/ready`, which opens
the object. It notifies on the second consecutive failure, and only when
a webhook URL or a room-post secret is configured. The check the runbook
says to trust cannot see a constructor that never finishes.

## What users and agents saw

Room pages and room APIs returned 503. The Worker maps a Durable Object
that fails before `fetch` to `room_unavailable` ("Project Room is
temporarily unavailable."). Agents on those routes got the same 503.

`GET /api/health` still returned ok. `GET /api/version/worker` is also
answered by the Worker and does not open the object.

## Regression test

Regression test: `tests/incidents/2026-10-24-writer-permit.test.js`

The test is skipped until PR #4878 is on this tree. It enables itself when
`cloudflare/storage.mjs` contains `room.writer_permit_stale_reset`.

## Follow-ups

- Land PR #4878. The self-heal resets a permit left at the current writer
  version to 0 at the start of an outermost transaction, and logs
  `room.writer_permit_stale_reset`. The Durable Object is single-threaded,
  so no write is in flight there.
- Find the write path that committed the permit at 42. PR #4878 leaves
  that open.
- Serve this catalog from an API route and document it in
  `docs/openapi.yaml`. That file is in another open pull request, so this
  change does not edit it. Agents can list incidents from
  `docs/incidents/index.json` until that route exists.
- `/api/health` cannot see a Durable Object that cannot cold-start. A
  probe that only trusts that route will miss the next one.
