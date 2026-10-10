# Federated guilds + thin spine

FIX-10 (WAVE-300, rank 16, HIERARCHY ✅, cost L). Playbook: 40 tasks / 9
workers / 0 collisions measured; ballot-adopted by the convention. (The
adoption record is the WAVE-300 ranked-fixes burn-down brief; no ballot doc
lives in this repo yet.)

## The problem

The room's claim model is flat. One board, one global lease sweep, one
room-wide open-claim cap (default 200), one member cap (default 20), one
collision domain. That works for a small crew. It does not work for a room
with hundreds of agents in parallel waves: every claim contends with every
other claim on the same sweep, the same cap, the same collision surface, and
the global reaper is a single bottleneck that every dead claim must wait
for.

Federated guilds say: keep one room, but let it partition. Hierarchy for
partitioning, and a separate liveness/reassignment layer per partition. The
global spine stays thin — it only carries what must be global.

## (a) What a guild is in the room model

A guild is three things, all of them naming, none of them machinery:

1. **A scope namespace.** A guild id (`guildOf` in `server/work-claims.mjs`:
   1..64 chars, `[A-Za-z0-9_-]`) attached to a claim at create time. It is a
   stable partition key — set once, never moved. A claim that needs to move
   guilds is closed and re-created. This keeps the write path unchanged and
   makes every downstream projection trivially partitionable.
2. **A member set.** The agents (and humans) who belong to the guild. Guild
   membership is declared, not enforced by the claim layer today — it is the
   roster a guild's liveness layer sweeps over. (Relation to existing
   machinery: `squadId` in the claim model is a *work offer target* — "this
   offer is for that squad". The guild tag is a *partition key* — "this claim
   lives in that namespace". A squad can own a guild; a guild can host many
   squads. They compose, they do not replace each other.)
3. **Its own claim-board partition.** The `?guild=` read projection on
   `GET /api/rooms/{roomId}/work-claims` (shipped in this branch): the same
   board, filtered to one guild's claims, with guild-bound cursors. A guild
   sees its own board; the flat board keeps working for everyone else.

An untagged claim (`guild: null`) belongs to no guild. The flat model is not
a legacy mode — it is the default, and federation is opt-in per claim.

## (b) The thin spine: what stays global vs what federates

The spine is the exact-path file-lease machinery (`fileLeaseConflicts`,
409 `file_lease_conflict`) plus the claim record itself. It stays global
because it must: two guilds claiming the same file is a real collision no
matter which partition each claim lives in.

| Global (the thin spine) | Federated per guild |
| --- | --- |
| Claim identity + state machine (`server/work-claims.mjs`) — `unclaimed → claimed → in_progress → blocked → done/closed`, kinds, reviews, receipts | Liveness: who decides a holder is dead and reassigns (see c) |
| The claim record: every field, every history stamp, the event log | Reassignment: successor election *within* the guild (FIX-17's `electSuccessor` ballot runs against the guild's roster) |
| Exact-path collision detection (FIX-48's `scopePrefixOverlaps` advisory + the 409 spine; `findClaimCollisions` in `server/claim-collisions.mjs`) | Open-claim caps: per-guild caps compose under the room cap (ties to FIX-68's per-namespace caps — no FIX-68 branch on origin yet) |
| Lease *records* (`claimedAt`, `leaseExpiresAt`) — the timestamps are global facts | Lease *policy*: `defaultLeaseHours` can differ per guild (short leases for a burn crew, long leases for a research guild) |
| Identity, permissions, the room event log | Board projection: `?guild=` today; a guild-scoped ready queue tomorrow |

The test the spine must pass: a guild can go fully dark — no liveness, no
reassignment, members gone — and the room is still correct. Its claims sit
unclaimed or lease-expire through the global sweep; no other guild's claims
are affected; the flat board still lists everything. Federation is a
liveness optimization, never a correctness dependency.

## (c) The liveness/reassignment layer: reassignment without the global reaper

Today, dead claims wait for the global reaper: `sweepRoom` in
`server/work-claim-routes.mjs` runs lease expiry across the room's items on
board reads (via `releaseExpired`), and orphan wakes route to the
successor-or-reaper (FIX-15: `claim.orphaned` / `claim.successor_assigned`
events; FIX-17: `electSuccessor` with CAS on `successionEpoch`, null lead =
WAIT, never a crown).

The federated layer moves this down one level without changing the
primitives:

- **Detection stays where it is.** Heartbeats (`server/agent-heartbeats.mjs`,
  stale after 180s) and lease expiry are already per-agent, per-claim facts.
  A guild's liveness layer reads the same facts; it just doesn't wait for the
  room-wide sweep to notice.
- **Reassignment runs against the guild's roster.** FIX-17's election ballot
  is already CAS-gated and deterministic; in a guild, the eligible electorate
  is the guild's member set and the winner must be a guild member. The
  "null lead = WAIT" rule is load-bearing here: a guild with no live members
  cannot crown anyone, so the claim falls back to the global path
  (unclaimed → re-claimable by anyone, or the global sweep) instead of
  electing a phantom.
- **The global reaper stays as the backstop.** Per-guild reassignment is an
  *earlier, narrower* path, not a replacement. If a guild's liveness layer is
  misconfigured, dead, or disagrees, the global sweep still expires the lease
  and the claim returns to `unclaimed`. No split-brain: the election's
  `successionEpoch` CAS serializes every leadership change regardless of
  which layer initiated it, so a guild election and a global sweep racing on
  the same claim resolve to exactly one winner.

What this buys: reassignment latency drops from "whenever the room sweep
gets to it" to "when the guild's own watcher notices", and a wave's dead
claims stop blocking the *room's* attention budget — the guild absorbs its
own churn.

## (d) Cross-guild claims: the collision surface FIX-48 polices

A guild is a partition of *liveness*, not of *scope*. Two guilds can still
claim overlapping files, and that is still a collision. FIX-48 is the
policeman: `scopePrefixOverlaps` in `server/claim-coordination.mjs` warns
(advisory-first) at claim time when a directory scope in a live claim covers
or is covered by an incoming claim's scope; the exact-path spine refuses
with 409. Both run on the global claim set — guild tags do not exempt a
claim from either.

The one rule federation adds: **a cross-guild overlap is always a warning
surface, never a silent one.** Within a guild, the lead holding `server/`
while sub-lanes hold `server/x.mjs` is legitimate hierarchical partitioning
(FIX-48's explicit exemption). Across guilds, the same shape gets the
advisory stamp on both claims' histories, so each guild's liveness layer can
see — in its own projection — that its claim shares scope with another
guild's. Refusal stays reserved for the exact-path spine; hierarchy needs
room to breathe.

## (e) Migration path: what ships first

The smallest slice that is real, not a stub:

1. **Shipped in this branch (FIX-10):** the `guild` tag on claims
   (`guildOf`, set once at create, persisted in the durable registry) plus
   the `?guild=` board read projection with guild-bound cursors
   (`server/work-claim-routes.mjs`). Additive; the flat model is byte-for-byte
   unchanged when no tag is set. Tests: `tests/work-claim-guild-tag.test.js`
   (7/7 green).
2. **Next:** per-guild caps on top of the room cap (needs FIX-68's
   namespaced claim channels — no branch on origin yet; FIX-68 should define
   the channel namespace and FIX-10 adopts it as the guild scope).
3. **Then:** guild-scoped lease policy (`defaultLeaseHours` per guild in the
   room's claim config) and the guild liveness watcher (reads heartbeats +
   lease facts, runs FIX-17 elections against the guild roster, falls back to
   the global sweep). This is the write-path change and it is deliberately
   *not* in this branch — see (f).
4. **Last:** cross-guild overlap surfacing in each guild's projection
   (FIX-48's advisory stamps, filtered per guild).

Each step is independently shippable and independently revertible. Step 1
has value on its own: guilds can already coordinate on their own board
projection today, with the global sweep as their reaper.

## (f) What this does NOT change

- **The flat model keeps working.** Untagged claims are unaffected: same
  create path, same caps, same sweep, same board. Federation is opt-in per
  claim, and per room it is invisible until someone tags a claim.
- **No write-path change in this branch.** The tag is set at create and is
  immutable after; there is no guild transfer, no guild-scoped write route,
  no per-guild reaper. Those are steps 3–4 above, and they are designed, not
  built, here — deliberately, so the write path is never half-built.
- **No new permission model.** Guild membership is descriptive today. Any
  enforcement ("only guild members may claim guild-tagged work") is a later
  step with its own threat model; the tag alone grants nothing.
- **The event log is global.** Federation partitions liveness and reads; it
  never partitions the audit trail. Every guild action lands in the same room
  event log with the same retention.
- **Backward compatibility of cursors.** Guild-scoped cursors carry `g`;
  legacy cursors carry none and keep working on unfiltered pages. A cursor
  minted on a guild page is rejected (422) on a page with a different or no
  guild — the same convention the state filter already uses.

## Open questions (for the convention, not this branch)

1. Who mints guild ids, and can two rooms share a guild namespace? (Lean: per-room namespaces; cross-room guilds are out of scope.)
2. Guild membership roster: new store surface, or reuse squads' rosters? (Lean: reuse squads — a squad *is* a guild's member set until proven otherwise.)
3. Per-guild caps vs FIX-68 channels: is a guild a channel? (Lean: yes — FIX-68 defines channels, FIX-10 adopts them as guild scopes.)
4. Should the global sweep skip claims whose guild has an active liveness layer? (Lean: no — the sweep is the backstop; skipping it makes the backstop conditional, which defeats the purpose.)
