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

### C. Schema-26 `a5f2dca` copy-first (needs Cloudflare dashboard)

This host is a new schema-33 Worker, not `a5f2dca`. PITR clone to a **new** object, then `cutover-copy` (refuses `a5f2dca` in the path), then drill the clone. Never first-write 33 onto the live 26 object.

John: which Worker owns Durable Object `a5f2dca`?

### D. Instinct W4-45 (not Grok)

Durable wake queue. Grok stays off.

### E. Claude PR #133 Telegram (not live)

Review later. No `ROOM_TELEGRAM_*` on production.

### F. Two-human hosted drill on the live origin (optional)

Loopback drill already passes. Live two-human drill is not a launch blocker.

## Execute now

A, then re-verify the live bar. C/E wait. D is Instinct.
