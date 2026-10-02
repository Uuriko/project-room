# Goal: Grok Build keeps Project Room moving (29 September 2026)

Started from `docs/GROK-BUILD-CONTINUOUS.md` because John said: use that to start a long detailed goal, then do it. Completing one slice is not the end of this goal.

## Objective

Make Project Room faster, easier, and more powerful for Grok Build and other agents **without** a second work engine or busywork automation. Follow the standing loop every turn. Prefer `needs-me` / heartbeat / receipts / host cards.

Codex total backlog (read-only): `~/src/PROJECT-ROOM-MASTER-BACKLOG-2026-09-29.md`. This goal takes the Grok-owned slice of **B (join/return)** and **C (host reachability)** that does not steal Claude/jill/Codex files.

## Success (this goal)

1. A standing prompt exists and is the session rule (`GROK-BUILD-CONTINUOUS.md`).
2. #1211 is restacked onto current main (mergeable). Not merged unless John says merge.
3. Claude door bundles they name are on origin/#1212.
4. One peer message exists in a **shared** room (muse-room), with seq/messageId on the channel and no secret in the log.
5. `doctor` tells the truth about connection: membership, pull-only listener, execute off by default, rooms this identity can see. Tests call real `doctor()`.
6. Hosted MCP is configured on this Mac via env interpolation, never a committed `pri_`.
7. Live `doctor`/`pull` stay `ok` / `credential_accepted`.
8. Decision log still rejects always-on `--execute` and a second coordinator.

## Out of scope

Merge/deploy, `/llms.txt` GitHub-door ads, Stripe/mail, Desk, Dasha, DIE Track Room, Codex audit trees, `src/app.js` / `server/mcp-*.mjs`.

## Turn loop

Channel/board → `doctor`/`pull` → other agents → first unblocked queue item → next item same turn.

## Queue mapped to backlog

| This goal | Codex backlog | Status to drive |
|---|---|---|
| Restack #1211 | A02, C02 | merge origin/main; keep Grok files |
| Push Claude vN | A03, C02 | their bundle only |
| muse-room peer post | B05, C03 | evidence seq/messageId |
| doctor connection truth | B07, C01 (Grok seat only) | listening vs execute vs rooms |
| MCP env wiring | B06 (this host only) | config.toml + env, no secret in git |
| JOIN cards | B01/B08 | point at real doors |

## Stop

Only missing credentials, occupied files, live-deploy clash, or John says stop. Empty `needs-me` is not a stop.
