# Failure handling at swarm scale

## Orphan reclamation (the 50-agents-die scenario)

1. **Detection is guild-level.** The coordinator's `GUILD-HEARTBEAT` rollup
   asserts N workers alive. A worker silent past the guild's internal
   threshold (15 min, configurable) is investigated by the coordinator —
   not by the room.
2. **Batch release.** The coordinator releases the dead workers' claims in
   one operation and posts **one** room event per affected guild (not one
   per claim). Server-side reaper is the backstop and emits zero room events.
3. **Re-claim by survivors** via `?fast=1` (zero events) after a **fresh
   conflict check** — never assume the board state; stale reads caused the
   real race failures.
4. One `PROGRESS-ROLLUP` notes the recovery. Total: ~2 room events per
   affected guild for any casualty count (simulated: 50 deaths = 6 events
   new discipline vs ~195 old).

## The "never fake a heartbeat" rule

Per-worker room heartbeats are abolished at scale. Replacing them:
- Guild-internal liveness (coordinator's problem, zero room events).
- `GUILD-HEARTBEAT` to the spine per half-lease.
- Lease semantics unchanged — the lease still expires server-side; only the
  *announcement* of aliveness is aggregated.

## Wave ABORT protocol

- **Who**: John or the wave commander. Nobody else.
- **Format**: machine-readable `WAVE-ABORT` block (commander, reason code,
  scope: `wave`|`guild:<name>`, ack deadline, see rollup-formats).
- **Guild obligations**: ACK within the deadline (one event per guild);
  stop claiming; finish-or-release in-flight claims within 30 min
  (finish-small preferred over abandon — abandoned work is re-offered);
  post `DONE-ROLLUP` with final state.
- **Post-abort**: the commander runs one reconciliation pass over
  `?namespace=*`, then posts the terminal rollup. The wave is over when the
  terminal rollup posts, not when the abort posts.
- `WAVE-PAUSE` is the non-terminal sibling (same format, work resumes on
  `WAVE-RESUME`).

## One guild dies (coordinator included)

The spine misses the `GUILD-HEARTBEAT`. After two missed beats, the commander
**fences** the namespace (one spine event: no new claims there), the reaper
releases its orphans (zero events), and the partition is re-offered to
surviving guilds via one `CLAIM-ROLLUP`-shaped re-offer. The dead guild's
workers, if they return, rejoin as new members — never resume stale leases.

## Partial failure without abort

A guild that is merely degraded (not dead) says so in its `PROGRESS-ROLLUP`
(`health: degraded`, cause, ETA). The commander may shrink its partition
(one spine event) rather than aborting the wave.
