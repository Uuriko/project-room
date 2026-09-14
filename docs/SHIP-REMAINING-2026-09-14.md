# Remaining ship — 2026-09-14 (updated)

Live origin is already production. This is what is left, what stays off, and who owns each slice.

## Live bar (must still hold after every change)

| Check | Required |
|---|---|
| `GET https://room.trydemigod.com/api/version` | `mode: cloudflare-production` |
| `GET /api/open` | `ship: false`, `persistence: none` |
| `GET /api/auth-config` | `provider: null` |
| `GET /api/ready` | 200 |
| Worker secrets | `ROOM_OPERATOR_ACCOUNT_ID` only |
| Occupancy | Do not edit `.gitignore`, `.wrangler/`, `docs/*RESEARCH*` |
| Instinct | Off W4-45 durable wake queue (`Uuriko/project-room#11`) |

## Done

- Clerk off the Worker and off the Room client SDK
- Local operator (Welcome member `c6a94a`)
- GitHub login; live status on #11
- Tag PR #3 read; sandbox not merged
- John confirmed invite works

## Do not ship

- `ship: true` / persist `oa1.`
- Gmail, Telegram, Twilio on the live Worker
- Clerk CLI / `clerk init`
- First schema-33 write onto `a5f2dca`
- Merge Tag `project-room-lab/` into Room source
- Instinct W4-45 wake queue

## Remaining slices

### A. Wording-only Join/invite help (Grok, this pass)

Tag 15 is a proposal catalog. Apply **only** live strings that already have controls:

- Drop “local pilot” from `#project-help-signin`
- Keep: key or invitation; never paste a human account key into an agent chat
- Do not dump the 60-string catalog

### B. Tag copy beyond that (blocked unless Tag names 2–3 more strings)

Sandbox stays draft. No merge.

### C. Schema-26 data on `project-room-staging` (do not in-place upgrade)

`a5f2dca32be0f3ba725608d3c89ce16c635b2c30` is a **git commit SHA** (schema 26), not a Cloudflare object hex. Staging still serves it:

| Host | Worker | `/api/version` |
|---|---|---|
| `https://project-room-staging.getdasha.workers.dev` | `project-room-staging` | `sourceRevision` a5f2dca…, `cloudflare-staging` |
| `https://www.getdasha.com/room` | same Worker (route) | same |
| `https://room.trydemigod.com` | `project-room` | schema-33 production (this tree) |

Cloudflare PITR restores the **same** Durable Object in place (last 30 days). It is **not** a clone-to-new-id API. Copying SQLite between objects is application export/import, not a platform button. Rollback restores **code**, not SQLite. One Worker version is pinned per object.

Do **not** `wrangler deploy` this tree to `project-room-staging`. That would be an in-place 26→33 write. Optional later: export from staging, import into a **new** object, drill, then consider cutover. Not a launch blocker.

### D. Instinct W4-45 (not Grok)

Durable wake queue. Grok stays off.

### E. Claude PR #133 Telegram (not live)

Review later. No `ROOM_TELEGRAM_*` on production.

### F. Two-human hosted drill on the live origin (optional)

Loopback drill already passes. Live two-human drill is not a launch blocker.

## How we actually ship (research, 2026-09-14)

Cloudflare: one Worker version per Durable Object; rollback restores **code** not SQLite; PITR rewinds the **same** object ~30 days and does not clone; new classes should use SQLite; staging and production bindings must not share a namespace. In-place `PRAGMA user_version` is the usual schema path **on one object**. A new object is for a new class or a one-time rewrite. MCP 2025-11-25: Origin 403 when present, allow missing Origin, no CORS `*`, unpublished HTTP servers **SHOULD** still require auth on mutating calls. `getByName("one-name")` is a singleton bottleneck (~200–1000 rps); fine for a pilot room, not a scale plan.

Implication: **https://room.trydemigod.com is the ship.** It is already a separate Worker/namespace from schema-26 staging. Do not in-place migrate `project-room-staging`. Do not wait on Tag merge, Telegram, Clerk, or Instinct W4-45. Optional later: application export from staging into a **new** production object. Observability is off on the production wrangler stub; enable only if we want logs, knowing it can restart objects.

## Execute now

A, then re-verify the live bar. C/E wait. D is Instinct.
