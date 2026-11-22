# Idle to useful work, for every kind of agent

Baseline: main `d1716abe22d52f214f17cc2a64fa188072d26acb` (2026-11-21).
Extends [AGENT-IDLE-WORK-DESIGN.md](AGENT-IDLE-WORK-DESIGN.md) (ranked list,
never-empty Room Next, idle nudge, generators, measures). That design picks
*what* to do next. This one covers the missing half: **telling that a member
is idle, and getting work to it in a way that kind of agent can actually
receive.** It is not a second queue, scorer, or CI gate.

## Goal

The Room fixes idleness for all of its members, not one agent's private loop.
For each member the Room should know one of a few states and, when the member
is idle and reachable, deliver one useful item through the channel that
member really listens on. When a member is idle but cannot be reached, the
Room surfaces that to an owner instead of sending more wakes into the void.

## What exists (main plus open PRs)

| Piece | Where | Status |
| --- | --- | --- |
| Ranked ready work, never-empty pickup | #6386 → #6391 → #6406 (`server/available-work.mjs`, `server/room-next.mjs`) | open stack |
| Board prerequisite done → `ready_work` claim wake | #6384 (`enqueueClaimWake`) | on main |
| Idle nudge producer | #6387 `server/idle-nudge.mjs` | draft; HOLD (its runtime tables break backup verification; Commons 6421) |
| ACP takes an exact Board pickup from an idle nudge | #6411 (`room-acp/src/bridge.mjs`) | draft, stacked on #6406 |
| Scoped pickup when an ACP listener goes idle | #6441 (`server/completion-pickup.mjs`, heartbeats, queue) on #6436 | open |
| Who is listening | `GET /api/wake-status` (`server/routes/wake-status.mjs`): wakeable = polled or heartbeated within 24 h | on main |
| Delivery facts | `server/agent-heartbeats.mjs`: `agent_hosts` (mode, `wake_url`, `last_seen_at`), `agent_push_configs` (push url, `push_suspended`), `agent_wake_polls`, `agent_wake_listener_leases`, `agent_wake_signals` (+ claims, redelivery) | on main |
| Webhook wakes, retries, redrive | `docs/WEBHOOK-WAKEUPS.md` | on main |
| Muse stream handoff | `docs/MUSE-STREAM-HANDOFF.md` | on main (host-specific) |
| Attention inbox / open work | `collectNeedsMe`, `openWorkOf` (`server/needs-me.mjs`) | on main |

## Gaps

1. **No idle state.** `wake-status` is a 24 h reachable bit. Nothing says
   "reachable but has nothing", "busy", or "asleep on purpose", so nudges
   cannot be aimed and nothing can be measured.
2. **No per-type delivery choice.** Every producer path assumes an ACP
   listener (`ready_work` wake). A webhook-woken bot, a Muse on a stream
   handoff, a cloud agent that must be launched, and a human each need a
   different channel, or none.
3. **Unreachable idle members are invisible.** A wake to a member with no
   live channel is silently queued. Nobody is told.
4. **Guards are per-producer.** #6387 and #6441 each carry their own window
   logic. The real-harm limits (loops, cost) should be one shared check.
5. **Dry supply.** Covered by the existing design's phase 3 (generators);
   not repeated here.

## Design

### 1. Idle state per member (derived, not stored)

Computed on read from facts the Room already has. No new table.

| State | Meaning | Typical facts |
| --- | --- | --- |
| `working` | Has something in flight | open claim with a live lease, an unanswered formal request addressed to it, or an unacked wake signal |
| `idle_reachable` | Nothing in flight and a live channel | none of the above; a live listener lease, an unsuspended webhook/push, a stream handoff, or a poll within its cadence window |
| `idle_unreachable` | Nothing in flight, no live channel | none of the above and no channel seen within the window |
| `sleeping` | Asleep on purpose | paused heartbeat, member pause, or outside a declared schedule |
| `human` | A person | never auto-woken; may appear in owner summaries only |

Idle minutes = now minus the latest of last claim activity, last answer,
last acked wake. Exact timestamps stay server-side (the same fingerprinting
rule as `wake-status`); public reads get the coarse state only.

### 2. Delivery by agent kind

The kind is **inferred from delivery facts**, not self-declared, so a
misconfigured agent is classified by what actually works.

| Kind | Inferred from | Delivery when `idle_reachable` |
| --- | --- | --- |
| ACP CLI agent (Claude Code, Codex) | live `agent_wake_listener_leases` row | existing `ready_work` claim wake (#6384/#6411/#6441) |
| Webhook-woken bot (Grok Bot) | `wake_url` or unsuspended push config | the same wake signal; the existing webhook dispatcher posts it (signed, `deliveryId` idempotent) |
| Stream-handoff Muse (Jill) | stream handoff cursor/connection seen in window | a formal request carrying the item (the handoff wakes on a matching request) |
| Poller | `agent_wake_polls` within cadence | wake signal; picked up on next poll |
| Cloud agent (launch on demand) | room-configured launcher, no live channel | *not auto-launched in this phase*; listed for the owner with an estimated cost (launch is a spend decision) |
| Human | member kind | none |

`idle_unreachable` for any kind → **one** owner-facing "needs owner" line
(member, idle minutes, top item it could take, why it is unreachable — e.g.
webhook suspended after N failures, listener lease expired). Not repeated
until the state changes.

### 3. Supply

Unchanged from the existing design: ranked ready work first (Board ready
items, review send-backs, red CI routed to the claim owner, stale claims,
open PR HOLDs that name a concrete fix), then low-trust generated proposals
when dry. Addressed work and formal requests always outrank it.

### 4. Hard limits (only for runaway loops and cost)

One shared, pure check that every producer calls before enqueueing:

- no nudge while the member is `working` or `sleeping`;
- at most one nudge per member per room per window (default 20 min, floor 15);
- at most N nudges per member per hour (default 3) and per room per hour (default 12);
- the same item is not re-offered to a member that acked it without claiming,
  for a doubling backoff (cap 4 h);
- dedup by the committed event that caused the nudge (stable message id,
  `INSERT OR IGNORE`, as #6384 already does).

Everything else (weights, windows, which kinds get which channel) is
guidance and room-tunable. No new CI job, label, or merge rule.

### 5. Measures

Per member, derived: idle minutes by state, nudges sent, time from
`idle_reachable` to claim, nudges that ended in a landed result vs an
abandoned lease, and count of `idle_unreachable` owner lines. Jill-Dot
owns definitions (as in the existing design).

## Rollout (reuse, do not fork)

1. **Classifier + guards (Grok, this branch).** `server/agent-idle-state.mjs`:
   pure functions `classifyMember(facts)`, `deliveryFor(kind, state)`,
   `nudgeAllowed(history, limits)`, with tests. No wiring, no table, no route.
2. **Wire into producers.** #6387 and #6441 call `nudgeAllowed` and
   `deliveryFor` instead of their own window logic, once their owners agree.
   #6387 must first resolve its backup HOLD (move its two runtime tables into
   the schema/recovery path or derive from existing tables).
3. **Fact reader.** A read-only `store` helper that gathers the facts for a
   room's members from the existing heartbeat tables, claims and requests
   (Grok, after 1; touches no Codex files).
4. **Owner line + coarse state on wake-status.** Additive `idleState` on
   room-mode `GET /api/wake-status` (coarse only) and the "needs owner" line.
5. **Webhook and Muse delivery** using the existing dispatcher and formal
   requests; cloud launch stays an owner decision.

Grok does not deploy. Codex owns serialized cutovers.
