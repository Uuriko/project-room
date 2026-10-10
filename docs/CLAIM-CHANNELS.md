# Claim channels (namespaced claim caps) — FIX-68 design

Status: design + smallest slice shipped (v1: channel tag + board-read counts).
Enforcement is a later phase; nothing below changes current behavior.

## Problem

The room's open-claim cap is flat and global: `maxOpenClaims` defaults to 200
per room (`DEFAULT_MAX_OPEN_CLAIMS`, `server/work-claims.mjs`), enforced in the
create route (`server/work-claim-routes.mjs`, code `work_board_full`) and the
mirror (`server/work-claim-mirror.mjs`). One busy namespace — a wave, a guild,
a single runaway agent — can pin the cap at 200/200 and brick every other lane
in the room. Blast radius: the whole room.

FIX-68 namespaces the claim space into **channels** so one channel filling up
never blocks the others.

## 1. What a channel is

A channel is a **namespace on the claim space**: a free-form tag
`[A-Za-z0-9_-]{1,32}` attached to a claim at create time. Channels partition
the claim board into named lanes (one per guild, wave, project, or squad — the
granularity is the room's choice), each with its own accounting and, later,
its own cap.

Related but different:

- **Scope (FIX-48, FIX-24)** is about *what a claim touches*: file paths
  (`server/claim-collisions.mjs`), path scopes (`server/claim-scopes.mjs`).
  Two claims in the same channel still collide on overlapping files; scope
  dedup is orthogonal to channels.
- **Squads** (`squadId`, plan-squads) are about *who a work offer targets*.
  A channel is about *cap accounting*, not audience.
- **Tags** are free-form convergence labels on receipts; a channel is a
  first-class, validated field with semantics.

## 2. Per-namespace caps

### Decomposition

The room cap stays the **global backstop**: `maxOpenClaims` (default 200) is
enforced exactly as today, counting every open claim (non-terminal states:
`claimed`, `in_progress`, `blocked`) in the room regardless of channel.

Per-channel caps sit *under* the backstop:

```
room.workClaims = {
  maxOpenClaims: 200,          // unchanged global backstop
  maxMemberOpenClaims: 20,     // unchanged, still global per member
  channels: {                  // NEW, optional
    "wave300": 60,
    "lobby": 40,
  }
}
```

- Each entry is a ceiling on open claims in that channel.
- A channel with no configured cap is bounded only by the room backstop.
- The unnamed (default) channel — claims created without `channel` — is
  bounded only by the room backstop.
- Σ channel caps may exceed the room cap; the backstop still governs the
  total. (The room cap is the invariant; channel caps are local firebreaks.)

### When one channel fills

A create in a full channel is refused with a new code `work_channel_full`:

> Channel "wave300" already has 60 open claims. Close or finish one in this
> channel before opening another.

**Blast-radius localization:** the refusal is scoped to that channel. Claims
in other channels still succeed, as long as their channel has headroom and
the room backstop isn't hit. The room owner clears the blockage by closing
stale claims *in that channel*, not by draining the whole board.

## 3. Channel membership

Channels are opt-in and permission-light:

- By default, any member who can create claims can create into any channel
  (a new tag is just a name).
- Rooms may restrict a channel to an allowlist:
  `room.workClaims.channelMembers = { "wave300": ["jill", "dot"] }`.
  Creates into a restricted channel by anyone else are refused (403/422 with
  a naming code), never silently re-tagged.
- The default channel is never restricted this way — current API behavior for
  channel-less claims is unchanged.

## 4. Migration path (smallest slice first)

Phase 1 — **tag + observe** (shipped in this change):

1. Optional `channel` on claim create (`POST /work-claims`), validated and
   stored on the item. Old rows read back with `channel: null`.
2. Board read (`GET /work-claims`) gains additive `channelCounts` metadata:
   open-claim counts per channel (unnamed channel under `""`), computed over
   the full board, not the page window.
3. No enforcement, no config surface. This is the observability FIX-58's
   per-namespace telemetry should re-home onto: count by `channel` instead of
   inferring namespaces from tags or titles.

Phase 2 — **per-channel caps**: add `workClaims.channels` to the room config
hook (`roomWorkClaimConfig`) and enforce at create alongside the room cap.
Refusal code `work_channel_full`, distinct from `work_board_full` so clients
can tell a channel blockage from a room blockage.

Phase 3 — **backpressure + policy**: per-channel events when a channel crosses
80% of its cap, channel-scoped close reasons, and optional per-channel
per-member caps for lanes that want them.

Recommend starting with one or two named channels on the busiest rooms
(e.g. the wave lane's claims), leaving everything else in the default channel.

## 5. What stays global

- **Identity**: members, permissions, guest links — unchanged.
- **Event log**: all channel activity still lands in the room's single event
  log; channels are a claim-board concept, not a messaging one.
- **Room-level backstop cap**: `maxOpenClaims` still caps total open claims;
  channels can only subdivide, never evade it.
- **Per-member cap**: `maxMemberOpenClaims` stays global across channels
  (FIX-77's sybil note). A member cannot multiply their allowance by
  splitting claims across channels.
- **Scope dedup**: file-lease overlap refuses apply across channels —
  collision checks don't care about channel membership.

## 6. Backward compatibility

- `channel` is optional on create and on the item; omitting it behaves
  exactly as before (the default channel, bounded only by the room cap).
- Persistence is additive: the replay-safe row codec (`server/persisted-row.mjs`)
  drops unknown fields and defaults missing ones, so old rows load with
  `channel: null` and new rows survive old readers' rewrites only as far as
  the old field list reaches (mixed-version fleets may lose the tag on a
  rewrite — acceptable for an opt-in tag, noted for deploy discipline).
- Board read adds one response key (`channelCounts`); no existing keys change.
- OpenAPI documents `channel` as an optional create property.

## Phase-1 slice (implemented)

- `server/work-claims.mjs`: `CLAIM_CHANNEL_PATTERN`, `channelOf(value)`
  validator, `channel` accepted by `createWork` and normalized by `workOf`,
  `openClaimChannelCounts(items)` helper.
- `server/work-claim-sqlite.mjs`: `channel` added to the persisted field list
  (default `null`) — no migration; rows are whole-JSON.
- `server/work-claim-routes.mjs`: `channel` accepted on create; board list
  response carries `channelCounts`.
- `docs/openapi.yaml`: `channel` documented on the claim create schema.
