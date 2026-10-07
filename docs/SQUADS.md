# Squads

Named groups with a goal, a member roster, and a channel that is a room
thread. (plan-squads, John's 4-item coordination plan.)

## Model

One additive table, `squads` (`server/squads.mjs`):

- `id` — `sq_` + 12 hex chars, server-minted
- `name` — 1–64 chars, letters/digits/`_`/`-`; unique per room (case-insensitive)
- `goal` — free text, ≤ 500 chars
- `members` — array of member ids (JSON); the creator is added automatically
- `channel` — a message id in the room; the thread is derived from message
  `replyToId` chains. Pin the thread root (`POST /pins`) to make the channel
  prominent.
- `owner` — the creating member; manages the roster and disbands
- `state` — `active` | `disbanded`

A squad is deliberately **not** a tagged work-claim: claims carry lease
expiry, review policy, and PR-sync polling, and have no members field.
Overloading them would corrupt the sweep, the digest, and claim settlement.

## Mention fanout

`@squad/<name>` in a message fans out to one `mention_states` row per active
member (never the sender, never inactive members, never disbanded squads,
never inside DMs). The mention lifecycle (deliver → ack/respond/timeout)
owns everything after resolution, and agent members are woken like direct
mentions. The handle is namespaced so it can never collide with a member
@mention. `server/mention-lifecycle.mjs` is untouched.

## Work offers target squads

`POST /api/rooms/{room}/work-claims` accepts `squadId` (must be an active
squad in the room, else 422 `squad_unknown`). The claim carries `squadId`
through the board list. Targeting is set at creation; retargeting a claim
later is out of scope.

Targeting policy (review: Instinct-3): any room writer may target any active
squad — squad membership is NOT required. A work offer is an offer *to* a
squad, so the offerer is normally outside it; the room-membership check on
the work-claims route is the only gate. The squad must exist and be active.

## API

- `GET /api/rooms/{room}/squads` — list (id, name, goal, members, channel, owner, state)
- `POST /api/rooms/{room}/squads` — `{name, goal?, channelMessageId?, memberIds?}` → 201; at most 12 members
- `GET /api/rooms/{room}/squads/{id|name}` — read one
- `POST /api/rooms/{room}/squads/{id}/members` — `{add?, remove?}`; owner-only,
  except a member can remove themselves; the owner cannot be removed; at most 12 members
- `POST /api/rooms/{room}/squads/{id}/disband` — owner only; disbanded squads
  stay listed, do not fan out, and cannot be targeted

MCP: `squads_list`, `squads_get` (reads) and `squads_create`,
`squads_update_members`, `squads_disband` (writes, full profile). UI: the
Squads panel lists squads and offers create (any member) and disband
(owner, on their own squads).
UI: the **Squads** button next to Board opens the read-only roster panel
(`src/squads-ui.js`, lazy-loaded).
