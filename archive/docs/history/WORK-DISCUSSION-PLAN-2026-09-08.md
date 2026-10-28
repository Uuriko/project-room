# Focused work discussion

September 8, 2026 · local implementation plan

Previous goal turn made progress: full agent lifecycle was implemented and tested.
The goal remains active. This slice addresses a concrete context gap: messages
and source replies do not change a work revision. An agent can repeatedly read
the assignment and still miss a newer clarification or another worker's draft.

## Product decision

One explicit read returns the selected source, explicitly work-linked messages
and their reply descendants. Do not broaden default selected-work reads or portable
exports. Keep the human UI unchanged; the browser already shows the conversation.
Expose the same contract through the authenticated API, direct client, CLI and
one MCP tool. No extra dashboard, new dependency, schema or persistence table.

## Research used

- [Slack thread reads](https://docs.slack.dev/reference/methods/conversations.replies/)
  retain message relationships and use explicit continuation rather than assuming
  a short page means completion. Apply that pattern with committed sequence order;
  Room's frozen-window guarantee is our own contract, not a Slack guarantee.
- [Linear agent context](https://linear.app/developers/agent-interaction) separates
  issue details, triggering conversation and attributed prior comments. Preserve
  those distinctions and keep current workflow separate from historical messages.
- [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  motivates targeted retrieval of sufficient relevant material rather than simply
  making context shorter. Do not silently clip the clarification an agent needs.

These are design inferences, not source-code reuse or compatibility claims.

## Contract

1. Authenticate each page in one read transaction. Membership is still room-wide;
   this selected view is convenience/data minimization, not task-private access.
2. Seed exact source plus messages explicitly linked to this work. Forward-include
   descendants only when unlinked or linked to this work. Another-work link stops
   inherited inclusion. Do not climb to ancestors, siblings or the whole root.
   Keep original links; label inclusion as source, linked or reply.
3. Return message/event IDs, post sequence, exact text, author, timestamp, recipient
   and reply/work references, plus existing draft proposal metadata. A recipient
   is room-visible attention, not a DM ACL. No authorship inference from a parent,
   packet ID or model name. Omit mutable reactions and unrelated participant data.
4. Freeze the room event horizon; order by message-post sequence, never timestamps.
   Map retained post metadata to the canonical projection; do not replay old
   authority events using today's reducer. Support older message IDs falling back
   to event IDs. No new indexed projection or schema for this bounded pilot.
5. Default20/max50 rows,64KiB serialized row budget, full text without truncation.
   Stop on count/bytes and advertise another matching row. An individually oversized
   legacy entry fails explicitly rather than causing an empty continuation loop.
6. Opaque, non-secret continuation binds room/work/viewer, original since/horizon,
   last returned sequence and the horizon event ID. It is not authorization or a
   signed snapshot. Reauthenticate; refuse mismatched scope, future horizon or a
   changed/missing anchor. No personal caught-up cursor read/write or coupling.
7. At exhaustion return the horizon as the discussion checkpoint. A later explicit
   read may use since=checkpoint; ancestry is still evaluated from full history.
   This numeric filter is unanchored, not recovery-safe history identity. After
   known or suspected restore/history replacement, discard it and read from zero.
   A continuation cannot be mixed with since. No automatic fetch-all or polling.
8. Return separately evaluated current work revision/state/next action. Clarifications
   remain untrusted content, not permission or formal work/approval changes.
   Reading all pages does not establish that no newer message exists; refresh.

## Implementation and verification

Root edits server projection/window helper and route, client read/response binding,
CLI/MCP adapters, exact runtime allowlist, executable docs and tests. Existing
write tools keep their exact receipt semantics. No automatic contribution adoption.

Test nested/shared source, explicit-link overlap, wrong-work branch, legacy IDs,
inactive authors, targeted recipients, two drafts with one packet, source-only and
empty work. Test more than100 messages, sparse events, equal timestamps, count/byte
limits, new arrivals/reactions, restart, cursor tampering/scope, since refresh,
revocation/session replacement and no state/cursor/reminder changes.

Use an actual agent to discover a newer source-reply clarification absent from the
original work read, then author its own useful answer and read its exact draft back
without a full-room snapshot. Root supplies no answer text. Inspect the resulting
human conversation in desktop/mobile/large text. Run core/browser/local Workers,
build/asset and exact-package checks, including the new query on real workerd.

## Next / out of scope

This enables the next room-native evidence and discussion-to-result design. Generic
human action-dialog reliability, native hosts, v9-compatible release recovery and
versioned charters remain prioritized. Isolated workspaces, Dasha, remote OAuth and
paid execution remain later independently authorized integrations. No live change,
push, deployment, outreach, account/provider changes or new recurring automation.
