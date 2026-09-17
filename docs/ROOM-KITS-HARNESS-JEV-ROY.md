# Kits · Harness · Jev · Roy ladder

17 September 2026. Contract. Docs only. Not a live `/room/kits` door.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

Catalog: [ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) **Optional later**
rows for **Skillbox-shaped library** and **Harness bridge**.

First steal map: [#457](https://github.com/Uuriko/project-room/pull/457).
Cua desktop Connect card: [#454](https://github.com/Uuriko/project-room/pull/454)
(not on `main`).

## Skillbox-shaped kits

Steal the *shape* from [kitze/skillbox](https://github.com/kitze/skillbox)
(MIT). Prefer optional self-host beside Room. Do not fork Skillbox into
the Worker. Do not collapse into Compute.

- Immutable revisions + checksum
- Scoped client keys (Add agent)
- Agent-first install (“ask your agent”)
- Never execute uploaded skill code in Room

| Steal | Room mapping | Don’t |
| --- | --- | --- |
| Agent-first install copy | kits.txt / Connect: “paste packet into your agent” already — lean harder | Human marketplace shelf |
| Versioned immutable skill revisions | Room kit cards with checksum + restore | Silent overwrite of Connect packet |
| Scoped client keys + usage | Aligns with Add agent digest keys | Share one key across agents |
| Import scattered markdown → library | Port Grok / Muse skills into a Room skill door later | Fork Skillbox into Room Worker cold |

An optional kit lives **under Connect**. It never replaces the Join or
Connect CTAs and is not a marketplace shelf.

## Harness-bridge Connect shape (docs)

Steal the *shape* from
[0xSero/harness-bridge](https://github.com/0xSero/harness-bridge) (MIT).
Any harness (Claude Code, Codex, OpenCode, Pi, Grok…) → any compatible
OpenAI / Anthropic / Responses endpoint. Does **not** edit
`~/.claude.json` / `~/.codex`.

1. Provider URL + secret key
2. Live models list (honesty)
3. Harness picker; inert + reason if dialect missing

| Steal | Room mapping | Don’t |
| --- | --- | --- |
| Provider once · pick model · pick harness | Room Connect “bring your agent” panel: endpoint + model + harness | Force one vendor |
| Live model discovery | Honesty: list what the Room Mac / Compute endpoint actually serves | Invent Astra if offline |
| Inert harnesses when dialect missing | Show why a harness can’t run (visible reason) | Hide broken options |
| Keys never on argv / never logged | Matches Room import `connection.json` rules | Paste keys in chat |
| Local-first tray | Optional companion for enrolled agents on a laptop | Drive Potter laptop unrestricted |

This is the Connect *shape* in docs. It is not Connect door HTML.

## Jev

`recommend_kits(query) → [{ id, score }]` using an operator TypeSafe /
Vercel key. Optional.

Room “which kit?” instead of a 30-turn search. Do not require Jev SaaS.
When the key is absent, the recommend path is inert + reason — same
honesty as a missing harness dialect.

## Roy ladder

- **Default = fast** (dsv-class) when online
- Quality optional: Astra → GLM → dsv
- Honesty when a Community Mac only has `qwen3:4b`

Never rename a model to hide a limit. When Astra / Fable / a quality pin
is exhausted, fail-loud and offer the fast-default fallback
([ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md)).

Judge models on [ROOM-SCORER.md](ROOM-SCORER.md) prefer `fast-default`
so scoring stays inside the 3–5% token bound.

## Stay-outs

Live kit door · Connect door HTML · People rail · Done-chip chrome ·
Phase 0 #8 / #9 · Quill trees · Compute Start · people-data ·
auto-merge · Potter keys · hosting Skillbox / Warp Factories now.
