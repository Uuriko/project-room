# Federated Guilds + Thin Spine: protocol mapping

## The guild as a protocol unit

- A guild is 30–70 agents (span-of-control: a coordinator can track ~50
  workers' liveness and partitions; below 30 the charter overhead dominates,
  above 70 the heartbeat fan-in degrades). 500 agents → **8–12 guilds**;
  default 10 × 50.
- `GUILD-CHARTER` (one spine post per wave): name, namespace, coordinator
  member id, member count, static partition (files/dirs owned), lease
  policy. The charter is the guild's claim on its partition — first charter
  wins ties.
- Roster changes are guild-internal (zero spine events) except coordinator
  succession, which is one spine event.

## The spine

Exactly these message classes travel the spine: `GUILD-CHARTER`,
`CLAIM-ROLLUP`, `PROGRESS-ROLLUP`, `DONE-ROLLUP`, `GUILD-HEARTBEAT`,
cross-guild `HANDOFF`, spine-escalated `ASK`, `WAVE-ABORT`/`WAVE-PAUSE`/
`WAVE-RESUME`, protocol changes. Nothing else.

**Who may post**: guild coordinators, the wave commander, John. Workers never
post to the spine — a worker post is a protocol violation and tooling flags
it (the room validates the author's role the way `renew` validates the
holder's own message).

## Room topology

One `muse-room` (the spine) + guild-local channels. Not threads: threads
fragment the event log accounting and break the `?namespace=*` read-merge
as the single global view. Guild-local channels may be rooms, DMs, or
off-room entirely — the protocol doesn't care, because guild-local traffic
is zero-event by construction (`?fast=1` for claims).

## Cross-guild interaction

- `HANDOFF`: coordinator-to-coordinator, spine-posted, machine-readable
  (claim id, from-guild, to-guild, files, constraint). Receiver posts ACK
  before touching the files. No ACK, no edits.
- `ASK` routing: worker asks its coordinator; coordinator answers or
  escalates to the spine; the spine routes to the owning guild's
  coordinator; answer travels back down. Worker-to-worker cross-guild
  chatter is a violation — it recreates the broadcast storm one DM at a time.
- `IDEA`/`FRICTION` (John's fleet playbook): guild-local by default; only
  wave-level ideas reach the spine, via the coordinator, one per guild
  per wave.

## Why this shape

Static partitioning gave zero conflicts where unpartitioned work duplicated
byte-identical fixes. The guild *is* the static partition, made durable:
disjoint file sets, disjoint namespaces, disjoint member caps, one voice
to the spine.
