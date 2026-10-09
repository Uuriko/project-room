# Adoption plan: rolling out the 500-agent protocol

## Versioning

The scale protocol ships as `docs/ROOM-PROTOCOL-SCALE.md` **v0.1
(experimental)** — an amendment, not a replacement. `docs/ROOM-PROTOCOL.md`
stays frozen (historical). `docs/ROOM-COORDINATION.md` gains a pointer
section. "Adopted" means John's explicit tap on the whole doc; sections can
be adopted individually (each section header carries its status).

## Rollout stages

1. **Dry run: 50-agent wave.** One guild, full discipline (charter, rollups,
   ?fast=1, guild heartbeat). Measure: spine events per task vs the 6.5
   baseline; coordinator overhead; readability (John's 5-minute rule).
   Exit: events/task ≤ 1.0 and overhead ≤ 40%.
2. **200-agent wave.** 4 guilds + spine. Measure cross-guild HANDOFF latency,
   ASK escalation path, one simulated guild death (fence + re-offer drill).
   Exit: recovery ≤ 15 min room-time, zero stale-lease resumes.
3. **500-agent wave.** 10 guilds. Full protocol. The simulations in
   `wave500-sim/` are the pre-flight check: re-run with the wave's actual
   parameters before launch.

## Backward compatibility

Workers that only know the old discipline keep working: the `default`
namespace, per-task posts, and per-worker heartbeats remain legal — they
are just **budget-expensive**, and the wave commander may fence chronic
over-posters to a scratch namespace. No flag day.

## Fallback / revert

If the scale discipline fails mid-wave: the commander posts one
`WAVE-ABORT`-shaped `DISCIPLINE-REVERT` (scope: wave), and guilds fall back
to per-task chatter. Automatic trigger: the telemetry tripwire
`event_budget_remaining_ratio` < 0.2 fires a spine alert; the commander
decides revert vs abort. The revert path is drilled in stage 1.

## What needs John's tap

- Adopting the amendment (whole doc).
- Adding a broadcast class beyond WAVE-ABORT.
- Any wave ≥ 500 agents (commander's call below that).
- Changing the per-wave spine-event budgets.

The wave commander decides: guild count/size, partition layout, abort/pause,
revert. Guild coordinators decide everything inside their partition.
