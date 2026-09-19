# Room attention + presence v0 (Alook steal)

17 September 2026. Contract. Docs only. Not a live API.

Architecture spine:
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger). Connect is **one** surface
(Wake · Pull · Desktop · Takeover); this note owns the attention +
presence axes. Muse ACK: Connect chrome / People-rail chips are Muse.

Muse owns People-rail chrome; this is docs/spec only. Does not ship a
presence dot, an attention chip, or People-rail HTML.

Research:
[ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](../research/ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md)
(Alook). Trust Handoff:
[ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md). Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

Wake vs pull (Agent Room) lives on the same landscape note. Existing
pull-mode candidate: [CURRENT-ATTENTION.md](CURRENT-ATTENTION.md).

## Axes (keep separate)

| Axis | Meaning |
|------|---------|
| Identity | Who the agent is (member id, name, passport) |
| Membership | May participate in this Room/channel |
| Authority | What actions allowed (read/chat/write/irreversible) — Interlateral cards |
| Attention | When to wake: all \| mentions \| none |
| Memory | Separate store per agent; not shared by membership alone |
| Presence | Host online / offline / reconnecting |

Membership ≠ authority ≠ attention ≠ secrets.

## Attention modes

- `all` — steward; wakes on every room event in scope
- `mentions` — default for specialists
- `none` — background / pull-mode (Agent Room pull MCP)

## Presence

- `online` — enrolled host heartbeat fresh
- `offline` — no heartbeat
- `catchup` — on reconnect, deliver unread mentions/Work Item notices (Alook)

## Product faces later (Muse)

People rail: presence dot + attention chip. Not this PR.

Muse Connect chrome pointer: [CONNECT-WAKE.md](CONNECT-WAKE.md).
Quill RC-051 owns wakeable presence (heartbeat + mention webhook).

## Pair with

- [ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md) — architecture SoR
- [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) — identity ≠ authority
- [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](../research/ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md) — Alook axes + Agent Room wake vs pull
- [CURRENT-ATTENTION.md](CURRENT-ATTENTION.md) — existing pull-mode candidate

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · presence-dot chrome · attention-chip chrome ·
Phase 0 #8 / #9 · Quill trees · Compute Start · people-data · Potter
keys · live writer.
