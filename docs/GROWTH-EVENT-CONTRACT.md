# Growth event contract

Track C (agent-managed Growth Engine), slice C1. Growth events are the analytics
vocabulary for the room: a small, curated set of workspace/product events derived
from room activity. They are **not** the room event stream (`src/events.js`); they
are a privacy-shaped projection of it for analytics, funnels, and growth loops.

## C1 envelope

`defineEvent(type, { actor, source, fields, occurredAt })` builds a frozen envelope:

- `type` — one of the registered growth event types below.
- `schemaVersion` — stamped from the registry; callers cannot set it.
- `occurredAt` — ISO-8601 timestamp, normalized to UTC.
- `actor` — `{ id, kind }` where `kind` is `human`, `agent`, or `system`.
- `source` — where the event was observed: `web`, `api`, `agent-inbox`,
  `telegram`, `email-inbound`, or `system`.
- `privacyClass` — stamped from the registry; callers cannot override it.
- `fields` — named, scalar-only fields. No objects, no arrays, no extras.

## C1 actor classification

Every event names its actor. `human` is a person acting through any client;
`agent` is an enrolled agent identity acting through the agent surface;
`system` is room automation (e.g. an archival sweep). The kind travels with the
event so analytics can separate human behavior from agent behavior.

## C1 privacy classes

- `public-in-room` — visible to room members already (counts, identifiers,
  aggregate buckets). Safe for room-scoped dashboards and growth loops.
- `account-private` — per-account facts (notification preferences, inbound
  arrival). Must never appear in room-scoped or cross-account analytics without
  aggregation that hides the account.
- `never-collect` — may not be registered at all. The registry constructor
  throws if an entry claims it, and `validateEvent` rejects any envelope that
  claims it.

## C1 default-deny rule

Growth events collect **only named fields**. Additionally, two deny layers run
on top of the allowlist:

1. Secret-bearing field names (`password`, `secret`, `token`, `apiKey`,
   `credential`, `auth`, `session`, `cookie`, …) are rejected everywhere.
2. Content-body field names (`body`, `text`, `content`, `message`, `email`,
   `html`, `payload`, `file`, `attachment`, `data`) are rejected everywhere.
   Identifier-style names (`messageId`, `threadId`) remain usable.

Field values must be scalars (`string`, `number`, `boolean`, `null`) so content
cannot be smuggled inside nested structures. Message bodies, email bodies,
tokens, and credentials are never collected — analytics works on identifiers
and aggregates (length buckets, attachment flags, counts) instead.

## C1 vocabulary (schema version 1.0)

| type | derived from room events | privacy class | collected fields |
|---|---|---|---|
| `room.created` | `room.created` | public-in-room | `roomId`, `roomKind` (personal\|organization) |
| `member.joined` | `member.added`, `member.joined_via_invitation` | public-in-room | `roomId`, `memberId`, `memberKind` (human\|agent), `via`? (invitation\|direct) |
| `invite.accepted` | `member.joined_via_invitation` | public-in-room | `roomId`, `invitationId`, `via`? (email\|link\|agent) |
| `message.sent` | `message.posted` | public-in-room | `roomId`, `messageId`, `threadId`?, `replyToMessageId`?, `hasAttachment`?, `lengthBucket`? (short\|medium\|long) |
| `agent.mentioned` | `message.posted` (@-mention of an agent member) | public-in-room | `roomId`, `messageId`, `mentionedAgentId`, `mentionCount`? |
| `reaction.added` | `message.reaction_set` | public-in-room | `roomId`, `messageId`, `reaction` |
| `message.pinned` | `message.pinned` | public-in-room | `roomId`, `messageId` |
| `work.proposed` | `work.proposed` | public-in-room | `roomId`, `workItemId` |
| `work.completed` | `work.completed` | public-in-room | `roomId`, `workItemId`, `verificationKind`? (independent_review\|owner_decision\|none) |
| `help.offer_opened` | `help.offer_opened` | public-in-room | `roomId`, `offerId` |
| `notification.preference_set` | `notifications.preferences_set` | account-private | `roomId`, `channel`? (mentions\|replies\|work_updates\|announcements), `level`? (all\|mentions_only\|none) |
| `inbound.received` | inbound email / Telegram arrival | account-private | `channel` (email\|telegram), `roomId`?, `hasAttachment`? |

## C1 schema versioning

Each registered type carries a `version`. `defineEvent` stamps the registry's
current version; `validateEvent` rejects any envelope whose `schemaVersion`
does not exactly match the registered version. Vocabulary changes land as new
registry versions — old producers fail closed rather than emitting
misunderstood events.

## C1 validation

`validateEvent(envelope)` fails closed on: unknown event types, version drift,
privacy-class mismatch, unknown envelope keys, unknown or sensitive fields,
missing required fields, non-scalar values, out-of-vocabulary enum values, bad
actor kinds, unknown sources, and unparseable timestamps. It returns a frozen,
normalized envelope on success.

## Executable evidence

Run `node --test tests/growth-events.test.js`. The test vectors cover envelope
construction and version stamping, full-vocabulary round-trips, content-body
rejection, secret rejection, unknown-field rejection, missing required fields,
actor/source/timestamp enforcement, privacy-class stamping and override
denial, scalar-only fields, enum enforcement, and unknown-type/version-drift
denial.
