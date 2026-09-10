# Activity inbox

Proposed contract, 10 September 2026. Docs plus an isolated read-model stub.
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

**Activity** steals Slack Activity’s job, not Slack-as-home: a feed of things
that need a human, derived from the ledger. It is not chat. It is not Catch-up
auto-open. It is not the account Inbox (`/?account=1`). [Work Items](./SPEC-v0.md)
remain the post-first surface — you start work there. Activity is the optional
thin-viewer list you open when something already happened.

Steal only this from Slack Activity:

- A feed of mentions, exceptions, and other items that ask a person to look.
- A default notification tier quieter than “every new message.”
- Each row opens the source, not a second inbox thread.

Do not steal Slack-with-bots chrome, Workflow Builder, an agent-OS pane, or
message-volume ranking.

## Derived rows

Do not add a write-side `activity.recorded` Event. Replay existing Events and
Receipts. A later live projection may cache the same rows; it is not a second
store.

| Kind | Derived from | Opens |
| --- | --- | --- |
| `ack_needed` | An Event that still needs the viewer’s acknowledgment (reply request addressed to them, or an explicit `ackNeeded` on that Event). | Source Event; Work Item when present. |
| `failed_receipt` | A Receipt (or Receipt Event) whose status is `failed`, `cancelled`, or `expired`. Compute honesty stays on the [bridge Receipt](./BRIDGE-COMPUTE.md). | Source Receipt; its Event / Work Item when present. |
| `mention` | `message.posted` that addresses the viewer (`toMemberId` or `@DisplayName`). Same address rule as [mentions search](./MENTIONS-SEARCH.md). | Source Event. |
| `exception` | Verification FAIL, `work.blocked`, or an Event marked `exception`. | Source Event; Work Item when present. |

No other kind appears. Ordinary `message.posted` volume is not a row. Reactions
are not a row. Agent chatter that does not mention the human is not a row.

### Row shape

| Field | Meaning |
| --- | --- |
| `kind` | One of the four kinds above. |
| `at` | Source Event / Receipt time. Recency order only. |
| `room_id` | Event `roomId`. |
| `work_item_id` | Work Item on the source, when it has one. |
| `source_event_id` | Event id. Required. |
| `source_receipt_id` | Receipt id when the source is a Receipt. |
| `opens` | Pointers: `eventId`, optional `workItemId`, optional `receiptId`. The later view follows these; it does not open a chat thread as home. |
| `notify` | Whether this row dings under the **current** notification tier. |
| `actor_id` | Server-set Event `actorId` when present. Display labels are not authentication. |
| `summary` | Short factual line. Not a score. |

No `score`, `weight`, `rank`, or message-count field. Ranking by how many
messages an agent posted is a reject.

One source Event id yields at most one row. Duplicate id / same source + payload
does not add a second line.

## Notification tier

The Activity **list** (when a human opens it) can show all four kinds.

The default **notification** tier is **Mentions + exceptions**. Agent volume
must not drown humans. Failed Receipts notify as exception-class. `ack_needed`
stays on the list and does not ding at the default tier.

| Tier | Notifies | Use |
| --- | --- | --- |
| `mentions_and_exceptions` | `mention`, `exception`, `failed_receipt` | **Default.** |
| `all_actionable` | All four feed kinds | Opt-in. Still not “every message.” |
| `nothing` | None | Quiet. Opening Activity still lists feed rows. |

There is no “all new messages” tier. That would make Activity a chat inbox.

[Mentions search](./MENTIONS-SEARCH.md) stays a filter on the existing search
panel. Activity is a different job: ledger-derived actionable rows, including
failed Receipts and exceptions that are not chat.

## Fold, do not fork

- Schema stays **v26**. No writer bump. No new command type required for this
  stub. `receipt.recorded` in the helper is a conceptual Receipt Event for
  fixtures; it does not add a store command.
- Work states stay `proposed` / `accepted` / `working` / `blocked` /
  `completed` / `superseded`.
- Compute jobs stay on Compute. Room copies honesty onto a Receipt; it does
  not re-measure. See [BRIDGE-COMPUTE](./BRIDGE-COMPUTE.md).
- Agents remain Members. Activity does not start inference.
- [CHAT-FIRST](./CHAT-FIRST.md) correctly rejected Activity-as-landing. This
  contract keeps that reject. The later lock is: Work Items are post-first;
  Activity is the thin viewer, not chat home.

## Isolated stub

`activity-inbox/` is a pure helper, same isolation as `contribution-rollup/`
(that package lives on [#17](https://github.com/Uuriko/project-room/pull/17);
this stub does not import or rewrite it). No `server/` or `src/` imports.

```sh
cd activity-inbox && npm test
```

`projectActivity({ viewer, events, receipts })` returns `{ rows }`. Default
tier `mentions_and_exceptions`. Fixture cases: ack-needed, failed-receipt,
mention, exception, ignore plain message volume.

## Phases

| Phase | Ships | Does not ship |
| --- | --- | --- |
| **Docs + stub (now)** | This contract, isolated helper, fixture tests, one pointer each in README / AGENTS-WANT / DISCOVERY. | Schema, writer, UI, server applicator, Compute merge. |
| **Later view** | A human Activity list that opens source Event / Work Item / Receipt. | Chat-as-home, scoreboard, message-volume rank. |
| **Live projection** | Same rows from the v26 event log. | New write-side Activity Event as the store. |

## Non-goals

- Slack-with-bots UI. Agent-OS pane. Workflow Builder.
- Merging Compute into Room, or Room into Compute Start.
- People-data. plugin.jup.ag. Potter keys. Designer. wrangler / hosted deploy.
- Phase 0 trees on #8 / #9. Contribution ledger #16–#18.
- Account Inbox / mailbox. Catch-up auto-open.
- Scoreboard, badges-for-chatter, or “more messages = more attention.”
- Schema / writer bump. `server/http.mjs` or store applicator edits.

## Ask

Handoff on [#11](https://github.com/Uuriko/project-room/issues/11). Grok Bot
merges; Instinct owns publish.

- **Grok Bot:** merge this PR when ready. No wrangler.
- **Instinct:** publish only if a later live view is authorized. This slice
  does not ask for a Worker publish.
