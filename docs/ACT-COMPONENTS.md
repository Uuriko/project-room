# Act components

Proposed contract, 10 September 2026. Docs plus an isolated helper stub.
Does not bump schema (stays v26), edit the writer, merge Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9), or touch
[#16](https://github.com/Uuriko/project-room/pull/16)–[#18](https://github.com/Uuriko/project-room/pull/18).
No `server/` or `src/` edits. Compute stays a separate run factory.

Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11).

## Product

Room is an **agent-native Work Item / Act / Event / Receipt ledger**. Agents
are Members. Humans are a thin viewer and steer. See
[AGENTS-WANT](./AGENTS-WANT.md).

**Act components** steal Discord / Slack *interaction components* — typed
buttons attached to a record — not Slack-as-home and not a bot pane. They are
actions a Member can take on an Event (and later a Work Item). Recording an
Act writes a ledger Event (or reuses an existing command). It is not a chat
reaction.

Steal only this from Discord / Slack components:

- Approve / Reject as named actions on a proposal-class Event.
- Open-in-Compute as a **deep-link only** to
  [getdasha.com/compute](https://getdasha.com/compute).
- Optional Acknowledge when the Event still needs an ack.

Do not steal Slack-with-bots chrome, an agent-OS pane, Workflow Builder BPM, or
merging Compute into Room Start.

[Activity](./ACTIVITY-INBOX.md) lists Events that need a look. Act components
are the buttons on those Events. Activity is not the Act store.

## v0 kinds

| Kind | Job | Who sees it |
| --- | --- | --- |
| `approve` | Accept this proposal / result. | Members with `act`, or the Room owner. |
| `reject` | Refuse this proposal / result. | Same as `approve`. |
| `open_compute` | Open Compute in the browser. Never starts a run in Room. | Wider: any viewer who can see the Event. |
| `ack` | Optional. Mark the Event acknowledged. | Same as `approve`. |

No other kind appears. Chat reactions (`message.reaction_set`, 👍 / ❤️) are
not Acts and never become the Act store.

### When a kind is offered

| Kind | Offered on |
| --- | --- |
| `approve`, `reject` | **Proposed-class** Events. v0 that set is `work.proposed`. Later proposal Events can join the set without a schema bump. |
| `open_compute` | An Event or Receipt that already carries a Compute bridge pointer (`computeJobId`, nested `compute`, or `bridge: "compute"`). See [BRIDGE-COMPUTE](./BRIDGE-COMPUTE.md). |
| `ack` | An Event marked `ackNeeded` (or a reply request that still needs an ack). |

Plain `message.posted` chatter offers nothing. A reaction Event offers
nothing. A Receipt without a Compute pointer does not mint Open-in-Compute.

### Component shape

| Field | Meaning |
| --- | --- |
| `kind` | One of the four kinds above. |
| `label` | Button copy: Approve, Reject, Open in Compute, Acknowledge. |
| `target` | Pointers the later view needs: `eventId`, optional `workItemId`, optional `receiptId`, optional `computeJobId`. |
| `records` | Intended command / Event payload if this Act writes. Omitted on `open_compute`. |
| `href` | Only on `open_compute`. A `https://getdasha.com/compute` URL, with optional `work_item` / `receipt` query when known. |

No `run`, `start`, `prompt`, or inference payload. Open-in-Compute does not
POST `compute/api` and does not embed a Compute UI in Room.

## Recording an Act

This slice does **not** add a writer, a command type, or schema 27. The
intended records reuse v26 commands where they already exist:

| Act | Intended Event / command | Notes |
| --- | --- | --- |
| `approve` | Existing `owner.decision_recorded` with `decision: "approved"`. | Approval does not merge, deploy, spend, or start Compute. |
| `reject` | Existing `owner.decision_recorded` with `decision: "rejected"`. | Same command family as today's decision form. |
| `ack` | Existing conversation ack / reply-request close, when one exists. | Do not add `act.acknowledged` in this slice. |
| `open_compute` | None. | Deep-link only. Room does not write a Compute job from this button. |

A later live writer may emit those existing commands. Do not introduce
`act.recorded` as a second store. Do not treat a chat reaction as the write.

Live Room still grants human decisions with the v26 `decide` permission. This
contract names a dedicated **`act`** capability for Act-component Approve /
Reject / Acknowledge. The stub does not add `act` to `PERMISSIONS` or rewrite
`decide`. A later fold may treat `decide` as satisfying `act`. The Room owner
always qualifies.

## Open-in-Compute

Compute stays a separate run factory. [FOLD-COMPUTE-ROOM](./FOLD-COMPUTE-ROOM.md)
and [BRIDGE-COMPUTE](./BRIDGE-COMPUTE.md) stay in force.

- The href origin is `https://getdasha.com/compute` (the Compute door, not
  `/compute/api`).
- Optional query: `work_item` when the Event / Receipt has a Work Item id;
  `receipt` when a Receipt id is known.
- Room never starts, leases, or cancels a Compute job from this component.
- Room never embeds Ask / Provide / Pay / a token stream in the Room UI.

Example: `https://getdasha.com/compute?work_item=wi-job&receipt=rcpt-9`.

## Capability

| Action | Gate |
| --- | --- |
| Approve / Reject / Acknowledge | Viewer `capabilities` includes `act`, **or** the viewer is the Room owner (`role: "owner"` or `isOwner`). |
| Open-in-Compute | Wider. Any viewer who can see the source Event / Receipt. |

Display names, message prefixes, and a 👍 reaction do not confer `act`.
Authenticate the Member; then project buttons from that grant.

## Isolated stub

`act-components/` is a pure helper, same isolation as `activity-inbox/`
([#75](https://github.com/Uuriko/project-room/pull/75)) and
`contribution-rollup/` ([#17](https://github.com/Uuriko/project-room/pull/17)).
It does not import or rewrite those packages. No `server/` or `src/` imports.

```sh
cd act-components && npm test
```

`availableComponents({ event, viewer, receipt })` returns `{ components }`.
Fixture cases: approve/reject on `work.proposed`; Open-in-Compute when a
Receipt / Compute bridge pointer exists; no components for plain chatter;
capability gate.

## Fold, do not fork

- Schema stays **v26**. No writer bump. No new command type required for this
  stub. `receipt.recorded` in the helper is a conceptual Receipt Event for
  fixtures; it does not add a store command.
- Work states stay `proposed` / `accepted` / `working` / `blocked` /
  `completed` / `superseded`.
- Compute jobs stay on Compute. Room may deep-link; it does not run inference.
- Agents remain Members. An Act is a Member action, not a bot interaction
  token.
- [CHAT-FIRST](./CHAT-FIRST.md) stays. Act buttons attach to ledger Events,
  not to a Slack-with-bots composer.

## Phases

| Phase | Ships | Does not ship |
| --- | --- | --- |
| **Docs + stub (now)** | This contract, isolated helper, fixture tests, pointers in README / AGENTS-WANT / ACTIVITY-INBOX. | Schema, writer, UI, server applicator, Compute merge. |
| **Later view** | Buttons on Events (and later Work Items / Activity rows). | Embedded Compute, reaction-as-Act, Workflow Builder. |
| **Live write** | Existing `owner.decision_recorded` (and existing ack close) from those buttons. | New `act.recorded` store; `act` added to v26 `PERMISSIONS` in this slice. |

## Non-goals

- Slack-with-bots UI. Agent-OS pane. Workflow Builder BPM.
- Merging Compute into Room, or Room into Compute Start.
- Embedding inference UI in Room. Starting a Compute run from Room.
- Chat reactions as the Act store.
- People-data. plugin.jup.ag. Potter keys. Designer. wrangler / hosted deploy.
- Phase 0 trees on #8 / #9. Contribution ledger #16–#18.
- Schema / writer bump. `server/http.mjs` or store applicator edits
  (avoids colliding with a WorkItemSession writer if one is open).

## Ask

Handoff on [#11](https://github.com/Uuriko/project-room/issues/11). Grok Bot
merges; Instinct owns publish.

- **Grok Bot:** merge this PR when ready. No wrangler.
- **Instinct:** publish only if a later live view is authorized. This slice
  does not ask for a Worker publish.
