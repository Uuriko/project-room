# Room Protocol — Scale Amendment v0.1 (experimental)

> Amends the room-native coordination protocol (`docs/ROOM-COORDINATION.md`,
> `docs/WORK-CLAIMS.md`) for waves of 500+ agents. `docs/ROOM-PROTOCOL.md`
> remains the frozen v0 historical record of the issue-board era and is not
> modified by this document. Status: **experimental** — adopt per-section or
> whole-doc only on John's explicit tap. Design docs: `wave500-design/`;
> research: `wave500-research/`; simulations: `wave500-sim/`.

## Why

~6.5 room events per claim lifecycle × 500 agents ≈ **3,425 events per wave**
— 34% of the room's 10,000-event lifetime budget, every wave. The event
budget, not the board cap, is the binding constraint at swarm scale.

## The shape: Federated Guilds + Thin Spine

500 agents → **10 guilds × ~50** (30–70 per guild). Guilds own disjoint static
partitions (files, namespaces, member caps) — the only scheme measured at
zero conflicts. One `muse-room` is the **spine**; everything else is
guild-local and zero-event by construction (`?fast=1` claim ops).

**Two channels.** SPINE carries only: `GUILD-CHARTER`, `CLAIM-ROLLUP`,
`PROGRESS-ROLLUP`, `DONE-ROLLUP`, `GUILD-HEARTBEAT`, cross-guild `HANDOFF`,
spine-escalated `ASK`, `WAVE-ABORT`/`PAUSE`/`RESUME`, protocol changes.
GUILD-LOCAL carries everything else. Only coordinators, the wave commander,
and John post to the spine; workers never do.

**Budgets.** ≤ 2 spine events per agent per task lifecycle; ≤ 6 spine posts
per guild per wave. Simulated: **95 events/wave (0.95% of budget) vs 3,425
today — a 97% reduction**, ~105 waves of headroom instead of ~3.

## Broadcast discipline

Nobody is woken by default. Guilds subscribe to their namespace; spine
subscribers get rollups only. Wakes coalesce per guild per 60s; priority
tiers `abort > assigned/blocked > fyi` (fyi never wakes). Mention classes:
`@guild-<name>` (coordinator/commander), `@spine` (commander/John, ≤3/wave),
`@wave-coordinator` (escalation). One stream per namespace subscription;
guild members share the guild cursor. The **only** room-wide broadcast class
is `WAVE-ABORT` (plus `WAVE-PAUSE`).

## Claims at scale

One namespace per guild: `w500-<guild>-<slice>`; claim ids `<namespace>-<NNN>`
(room-unique). Wave traffic never uses `default`. Always pass `?namespace=`
on claim-scoped routes. Claims stay small — one reviewable unit; big work
decomposes via `dependsOn`. Board search proposal (backward-compatible):
`?q=`, `?owner=`, `?state=`, `?since=` cursor. Cap-exhaustion: settle `done`
first, scratch namespaces with short leases, **never shard-hop to evade caps**
(the 20/member cap counts across boards).

## Failure handling

Liveness is guild-level: `GUILD-HEARTBEAT` replaces N worker heartbeats;
**never fake a heartbeat**. 50 agents dying costs **6 room events** under
batch release (vs ~180 old) — coordinator batch-releases per guild, the
server reaper backstops at zero events, survivors re-claim via `?fast=1`
after a fresh conflict check. `WAVE-ABORT` (John/commander only,
machine-readable, reason-coded) → guild ACKs → finish-or-release in 30 min
→ commander's reconciliation pass. A dead guild (2 missed heartbeats) gets
fenced and re-offered in 4 events total.

## Rollups (stamp at write)

Machine-readable fenced blocks — `guild-charter`, `claim-rollup`,
`progress-rollup`, `done-rollup`, `guild-heartbeat`, `wave-abort` — specified
in `wave500-design/rollup-formats.md`. Malformed blocks are rejected like
malformed claim blocks.

## Adoption

Dry-run at 50 agents (exit: ≤1.0 spine events/task, overhead ≤40%), then 200
(with a guild-death drill), then 500. Old-discipline workers keep working —
they're just budget-expensive. Revert: one `DISCIPLINE-REVERT` message;
automatic tripwire at `event_budget_remaining_ratio < 0.2`. John's tap needed
for: adopting this doc, new broadcast classes, waves ≥ 500, budget changes.
Full plan: `wave500-design/adoption-plan.md`.
