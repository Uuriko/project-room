# Room

Draft 0.1.0. Normative words are RFC 2119. See [the draft index](../README.md).

A room is one shared project: a membership, a capability list on each member, and an ordered event log. Work items, claims, and messages are facts in that room. They are not a second room.

## Members

A member MUST have a kind of `human` or `agent`. Any other kind is rejected. Source: `src/events.js` (`member.added` requires `human` or `agent`).

An agent member MUST have an accountable human. When the add event omits `accountableHumanId`, the server stores the room owner's member id. A human member's accountable human is that member. Source: `src/events.js`.

The stored authority for what a member may do MUST be the member's `permissions` list, not a role name. The permission names are `steer`, `decide`, `manage_members`, `manage_claims`, `accept_work`, `complete_work`, `verify`, `write_external`, and `invite_member`. Source: `src/events.js` (`PERMISSIONS`).

Invitation role names (`moderator`, `member`, `guest`) MUST be presets that copy a fixed permission list onto the member at invite time. A later change to the preset MUST NOT rewrite members already stored. Source: `src/events.js` (`INVITATION_ROLE_POLICIES`).

Agent access profiles MUST map to fixed permission sets:

| Profile | Permissions |
| --- | --- |
| `chat` | none |
| `contribute` | `accept_work`, `complete_work` |
| `review` | `verify` |
| `collaborate` | `steer`, `accept_work`, `complete_work`, `verify` |

A request MUST NOT widen a profile by sending extra permission names. Source: `server/agent-connections.mjs` (`agentAccessProfiles`).

The room owner, or a member the owner grants, administers membership. An agent MUST NOT receive `manage_members` or `decide` except by an explicit owner grant, which the server marks `delegatedAdmin`. Source: `src/events.js`.

## Sponsor

A sponsored agent connection MUST record `sponsor_account_id` and `sponsor_member_id`. The sponsor row stays valid only while that sponsor is the human room owner, is active, still holds `manage_members`, and still matches the stored sponsor revision. Source: `server/agent-connections.mjs`.

The connection history MUST be retained. Disconnect is final. Source: `server/agent-connections.mjs` (the `agent_connections` triggers).

## Event log

Room facts that go through the command path MUST be appended as events. Each event has an id, a type, an actor, a timestamp, and data. The room MUST assign `sequence` as one more than the room's current sequence, and the pair `(room_id, sequence)` MUST be unique. Source: `server/store.mjs` (table `events`, insert on the command path).

A reader MUST ask for events strictly after a sequence. The query name is `after`. `afterSequence` is not a cursor. Source: `docs/openapi.yaml` (`/api/rooms/{roomId}/events`), `server/mcp-hosted-tools.mjs` (`room_list_events`).

A correction MUST be a later event. The command path does not update an earlier event body.

Event type names live in `src/events.js` (`EVENT_TYPES`). Board claim changes use `work_claim.updated`. Work-item scope reservations use `claim.acquired`, `claim.released`, and `claim.renewed`. Those are different facts. See [claim](claim.md).

## Room today

The room's own `kind` is `personal` or `organization` (`src/events.js`, `ROOM_KINDS`). That is the room type, not the member kind.

Share-link guests and guest-agent links are membership paths (`server/share-links.mjs`, `server/guest-agent-links.mjs`). They do not add a third member kind. A guest agent is still `kind: "agent"`.

Import of a room replaces that room's event rows as a whole (`server/store.mjs`, room import). That is a restore of a sequence, not an edit of one event.

`docs/SPEC-v0.md` describes work items and artifacts. This draft does not replace that product model. The event log above is the log both models share.
