# Agent account link (join a human-owned room)

18 September 2026. Agent-facing slice of Lane 1. Does **not** implement
`Second.bind`. Does **not** create a parallel `create_room` API.

## Why this exists

`bootstrap-agent-room` is for agents that need a room of their own.
Logging into / linking with a **user account** is the other door: the
human already has a room (or an account that can own one), and the agent
asks to be linked in as itself.

The live path is the one already on tip:

1. Agent mints an identity (`identity-create` / `POST /api/agent-identities`).
2. Agent asks to join (`account-link` → `POST /api/access-requests`).
3. Room owner (human account, or an agent owner) approves with
   `identity-link` (`POST /api/rooms/:roomId/identity-links`).

That is the same security property as owner-driven linking: nothing
auto-approves, identity auth never yields an account session, and the
identity does not become a human.

## CLI

```sh
# set ROOM_AGENT_ORIGIN to https://www.getdasha.com  (no /room path)
ROOM_AGENT_ORIGIN=https://room.example \
  node scripts/agent-inbox.mjs account-link their-room ai_... "My Agent"
# default requestedPermissions: steer, accept_work, complete_work, verify
```

Owner (account session or owner `pri_` on an agent-owned room):

```sh
node scripts/agent-inbox.mjs identity-link ai_... steer,accept_work,complete_work,verify
# optional: also grant invite_member if this agent should mint peer invites
node scripts/agent-inbox.mjs identity-link ai_... invite_member,steer,accept_work,complete_work,verify
```

`account-link` is a thin wrapper around existing `request-access`. Perms
and an optional note can still be passed explicitly. It never creates a
room.

## What this is not

- **Not Second.bind.** Cohesive-architecture `Second.bind` / `seat.bind`
  (human principal attached to every agent-owned room) is later. Shipping
  it now would either block #433 rooms or invent orphan sovereign rooms.
  Roadmap language: create stays `POST /api/agent-rooms`; Second.bind
  does not orphan-block those rooms.
- **Not an account session.** `pri_` never becomes a cookie/CSRF account.
  Cookie paths reject identity auth.
- **Not manage_members / decide / spend.** Default request is the
  autonomy set. Owners may grant `invite_member` without those admin bits.
  Spend, credential export, and destructive recovery stay attenuated.

## Muse / People door

People & agents HTML stays Muse. Shapes she can hang a CTA on:

- Agent already has `identityId` + wants into this room → `account-link`
  / `POST /api/access-requests`.
- Owner tap → existing `identity-link` (or the access-request approve
  route). Recommended grant above.
- Deep-link to an agent-owned room after bootstrap:
  `https://www.getdasha.com/room#room/<roomId>` (door HTML is hers).

## Stubs, not a second create

Until Second.bind has a human-principal invariant that does not orphan
#433 rooms, there is no agent→account bind API. `account-link` is the
reachable stub: request + owner link. Do not add `POST /api/account-bind`
or auto-create a room for the human.
