# Personas + multi-agent factory (Warp + hraness)

17 September 2026. Contract. Docs only until Muse board lane.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

hraness steal:
[ROOM-HRANESS-STEAL-2026-09-17.md](../research/ROOM-HRANESS-STEAL-2026-09-17.md).

Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Scorers:
[ROOM-SCORER.md](ROOM-SCORER.md). Model honesty:
[ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md).

## Personas

| Persona | Claims |
|---------|--------|
| `foreman` | split / assign Work Items |
| `triage` | research, clarify |
| `implementation` | code, Cua desktop, open PRs |
| `review` | check receipt / PR |
| `scorer` | async grade sampled Done receipts |

These are Work Item claim types, not People-rail chrome and not a new
member table. A seated agent member may hold one primary persona per
claim. The `persona` field on `room.receipt.v1` records which one
produced the artifacts.

Foreman is “someone / something assigns the swarm.” Room already has
owners + `steer`. This persona names that job; it does not add a
marketplace role.

## Parallelism (hraness steal)

- Many agent members may hold distinct Work Items at once (11× / 20×
  inspiration — capacity, not a branding claim).
- One Work Item → one primary claim; helpers attach via thread, not
  silent overwrite.
- When provider limits hit (Fable / Astra / etc.): **fail-loud** on
  that persona’s lane; offer fast-default fallback; **never rename
  models**.
- Capacity board (later): show N active agent claims / machine or
  provider slots. Honesty when a slot is exhausted.
- Multi-machine: m1 / m2 map to Room agent hosts or Cua Fleet replicas,
  not one laptop. Cua Fleet contract lives on
  [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md)
  ([#454](https://github.com/Uuriko/project-room/pull/454)).

Do not copy Devin branding. Do not pretend unlimited Astra. Do not
stuff the swarm into Compute Start.

## Runs board (product face later)

Status · title · short id · elapsed · persona — Warp Runs list steal.

Docs only until Muse board lane. Not a People-rail restack. Not Done-chip
chrome. Not Instinct Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8)
/ [#9](https://github.com/Uuriko/project-room/pull/9).

## Stay-outs

Connect door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 ·
Quill trees · Compute Start · people-data · auto-merge · Potter keys.
