# Member capabilities

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

**Member capabilities** steal Discord *roles as capability bits* — named grants
on a Member — not Slack app marketplace, not Slack-with-bots chrome, and not a
plugin catalog. A bit is a yes/no on one Member. Display names, message
prefixes, and a 👍 reaction do not confer a bit.

Steal only this from Discord roles:

- Named bits: `act`, `emit_receipt`, `invite_member`.
- Owners hold every bit.
- Other humans and agents may be granted a subset.

Do not steal Slack app marketplace, Workflow Builder BPM, an agent-OS pane, or
people-data roles.

Existing v26 `permissions` (`steer`, `decide`, `manage_members`, …) stay the
live store authority. This contract names a parallel Discord-style layer. The
stub does not add bits to `PERMISSIONS` or rewrite `member.added`. A later fold
may treat `decide` as satisfying `act`, `complete_work` as satisfying
`emit_receipt`, and `manage_members` as satisfying `invite_member`.

## Bits

| Bit | Job | Default |
| --- | --- | --- |
| `read` | Read Room-shared material and participate in conversation. | **On** for every Member. |
| `act` | Record an Act on an Event (Approve / Reject / Acknowledge). | Off, except the owner. |
| `emit_receipt` | Emit a Receipt on a Work Item. | Off, except the owner. |
| `invite_member` | Invite a human or mint a guest-agent Member. | Off, except the owner. |

No other gated bit appears in this slice. Conversation is not a separate bit;
it rides with `read`. Chat reactions are not capabilities.

### Who holds what

| Member | Grants |
| --- | --- |
| Room owner (`role: "owner"`, `isOwner`, or `id` equals the Room `ownerId`) | All bits. |
| Human or agent, no overlay | `read` only. Guest-agent mint today is this shape (`permissions: []`). |
| Human or agent, granted a subset | `read` plus each granted gated bit. |
| Inactive Member (`active: false`) | `read` only. Gated bits do not fire. |

Authenticate the Member first. Then project bits. A label that says “owner”
in chat is not a grant.

## Schema: additive optional fields, no writer bump

Schema stays **v26**. Do **not** add a persisted `member.capabilities` array
on `member.added` / `member.access_changed` — that would widen the command
shape and risk locked writer PRs ([WorkItemSession #76](https://github.com/Uuriko/project-room/pull/76)
already owns store / HTTP / applicator edits).

Follow the same additive-JSON pattern as Work Item Session fields
(`status`, `stop_requested_at`, `heartbeat_at`) and guest-agent mint
(reuses `credentials` + `member.added`, no new table):

| Field on the Member projection | Meaning |
| --- | --- |
| `act` | Optional boolean. Missing = not granted. |
| `emit_receipt` | Optional boolean. Missing = not granted. |
| `invite_member` | Optional boolean. Missing = not granted. |

Alternatively, a nested `capabilityBits` object with the same keys. Missing
keys read as false. Legacy Members without the keys get **default grants**
(`read` only) unless they are the owner.

The isolated helper also accepts a viewer `capabilities` *list* so Act
components ([#77](https://github.com/Uuriko/project-room/pull/77)) can pass
`["act"]` without a store write. That list is a helper argument, not a v26
writer field.

## Intended call sites (document only)

This slice does **not** edit `server/http.mjs` or the store applicator. Later
live checks should call the helper at these sites:

| Site | Bit | Today (unchanged) | Intended gate |
| --- | --- | --- | --- |
| Act components Approve / Reject / Acknowledge | `act` | `#77` helper `canRecordAct` (owner or `act`) | Same. Open-in-Compute stays wider (any viewer who can see the Event). |
| `POST /api/rooms/:room/guest-agent-links` mint | `invite_member` | Owner-issued ([GUEST-AGENT-LINKS](./GUEST-AGENT-LINKS.md)) | Owner already has the bit. A later grant may let a non-owner mint. |
| Human invitation / share-link mint | `invite_member` | `manage_members` | Later fold may treat `manage_members` as `invite_member`. |
| Receipt write on a Work Item | `emit_receipt` | `complete_work` / accountable member | Later fold may treat `complete_work` as `emit_receipt`. |

Display names and packet chat do not pass these gates. Packet (no Member) has
no bits.

## Isolated stub

`member-capabilities/` is a pure helper, same isolation as `activity-inbox/`
([#75](https://github.com/Uuriko/project-room/pull/75)) and `act-components/`
([#77](https://github.com/Uuriko/project-room/pull/77)). It does not import
or rewrite those packages. No `server/` or `src/` imports.

```sh
cd member-capabilities && npm test
```

`memberCapabilities(member, { ownerId })` returns `{ bits, owner }`.
`canAct` / `canEmitReceipt` / `canInviteMember` are the gates. Fixture
cases: default grants, owner all-bits, deny `act` without the bit,
`invite_member` gate, `emit_receipt` gate.

## Fold, do not fork

- Schema stays **v26**. No writer bump. No new command type.
- Work states stay `proposed` / `accepted` / `working` / `blocked` /
  `completed` / `superseded`.
- Compute jobs stay on Compute. A capability is not a run lease.
- Agents remain Members. A bit is a Member grant, not a Slack app install.
- [CHAT-FIRST](./CHAT-FIRST.md) stays. Capabilities do not make chat the OS.

## Phases

| Phase | Ships | Does not ship |
| --- | --- | --- |
| **Docs + stub (now)** | This contract, isolated helper, fixture tests, one pointer each in README / AGENTS-WANT. | Schema, writer, UI, server applicator, Compute merge. |
| **Later checks** | Call the helper at Act / mint / invite / Receipt sites. | `member.capabilities` array on the writer; Slack marketplace. |
| **Later persist** | Optional additive booleans on the existing Member JSON. | Writer v27, new table, Phase 0 merge. |

## Non-goals

- Slack app marketplace. Slack-with-bots UI. Agent-OS pane. Workflow Builder.
- Merging Compute into Room, or Room into Compute Start.
- People-data. plugin.jup.ag. Potter keys. Designer. wrangler / hosted deploy.
- Phase 0 trees on #8 / #9. Contribution ledger #16–#18.
- Schema / writer bump. `server/http.mjs` or store applicator edits
  (avoids colliding with open WorkItemSession [#76](https://github.com/Uuriko/project-room/pull/76)
  and Act components [#77](https://github.com/Uuriko/project-room/pull/77)).

## Ask

Handoff on [#11](https://github.com/Uuriko/project-room/issues/11). Grok Bot
merges; Instinct owns publish.

- **Grok Bot:** merge this PR when ready. No wrangler.
- **Instinct:** publish only if a later live check is authorized. This slice
  does not ask for a Worker publish.
