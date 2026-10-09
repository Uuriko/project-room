# Message discipline at 500-agent scale

## The problem in one number

~6.5 room events per claim lifecycle × 500 agents ≈ **3,250 events per wave** —
a third of the room's 10,000-event lifetime budget, per wave. The event budget,
not the board cap, is the binding constraint. Discipline is not etiquette; it
is budget survival.

## Two channels

**SPINE** — `muse-room` itself. Human-scannable by John. Carries only:
- `GUILD-CHARTER` — one per guild per wave (identity, namespace, partition).
- `CLAIM-ROLLUP` — one per guild: the batch of task claims, machine-readable.
- `PROGRESS-ROLLUP` — one per guild per half-lease: counts + blocked items
  needing spine attention. Routine progress never touches the spine.
- `DONE-ROLLUP` — one per guild: completions with PR refs and evidence.
- `GUILD-HEARTBEAT` — coordinator asserts N workers alive (replaces N worker
  heartbeats with 1).
- Cross-guild `HANDOFF`, spine-escalated `ASK`, `WAVE-ABORT`/`WAVE-PAUSE`,
  protocol changes.

**GUILD-LOCAL** — everything else: per-task CLAIM/PROGRESS chatter, internal
reviews, worker dispatch, debates. Carried on `?fast=1` zero-event claim ops
or guild-local channels. Never the room log.

## Hard budgets (per wave)

- Per agent: **≤ 2 spine events** per task lifecycle (claim-rollup share +
  done-rollup share). Workers post **zero** direct spine messages.
- Per guild: ≤ 6 spine posts (charter, claim-rollup, 2 heartbeats,
  progress-rollup, done-rollup) + escalations.
- 10 guilds × 6 ≈ **60 spine events per 500-agent wave** (vs ~3,250 today).

## Rules

1. Only guild coordinators, the wave commander, and John post to the spine.
   A worker posting directly is a protocol violation (tooling flags it).
2. Routine status goes to the rollup, not the room. If it isn't
   cross-guild-actionable, it isn't spine traffic.
3. A guild that goes silent still heartbeats at guild level — silence is
   signal (missed heartbeat = investigate, per failure-handling).
4. ASKs are answered inside the guild first; only cross-guild ASKs escalate,
   and the spine routes them to the owning guild — never worker-to-worker
   across guilds.
5. John's readability rule: the spine must read in under 5 minutes at 500
   agents. If it doesn't, the discipline failed regardless of the budget math.
