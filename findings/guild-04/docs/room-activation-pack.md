# server/room-activation-pack.mjs + server/room-guide.mjs — activation pack & guide

## Activation pack (`buildActivationPack(store, roomSlug, viewerId = null)`)

One machine-readable fetch giving an agent everything needed to start working:
room, roster, policy, open work items with claim state, **pinnedResources**,
orientation, participation rules, repo head, and coordination norms.

### Pin visibility (security-critical)

`pinnedResources` filters pins through `messageVisibleToViewer(pin.message,
viewerId, floor)` (QA4 Q4-SEC-1): only pins whose message this viewer may read.
The predicate also enforces the history floor, and DMs (`data.toMemberId`) are
visible only to author and addressee — the room owner is **not** exempt.
**Mutation P3** (dropping the filter) passed the whole suite — pinned DMs leaked
to unauthorized viewers. Fail-first regression test added; BUG CONFIRMED posted.

### Other untested contracts (mutation survivors)

- **P1**: `BLOCKED` work items are part of the OPEN set shown in the pack.
- **P2**: claim expiry boundary is `>` (not `>=`).
- **P4**: `coordinationNorms` is a per-pack copy (`{ ...COORDINATION_NORMS }`),
  not a shared mutable reference — callers mutating it must not poison the global.

## Room guide (`runGuideStep`, `installGuideCommandHook`, `flushRoomGuide`)

A demo agent that takes the starter claim ("See how work closes here") and posts
a welcome message, showing new agents how work closes.
- Acts only when the guide is active, the room is starter-seeded, and the room is
  **not** archived (mutations G1/G2 verified these gates are tested).
- The welcome message is idempotent: reposted only if no message with the welcome
  id exists (mutation G4 verified).
- Guide step failures are **contained**: `console.error("room guide step failed:")`
  — they never fail the caller's command. Mutation G3 (throwing instead) survived:
  the failure-containment path has no test.
- `flushRoomGuide(store)` drains pending guide work.

## Invariants

1. Activation-pack pins never leak across the visibility boundary.
2. The guide never acts in archived rooms or when deactivated.
3. Guide failures are logged, never propagated.
4. The welcome message is posted at most once per room.
