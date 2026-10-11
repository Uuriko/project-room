# Responsive shared conversation: Codex source comparison

Research checkpoint: 2026-10-11. Codex source inspected at
`8c0f7011674145da7e10627769fb221c74fbf7a0` in openai/codex.
This is a targeted reading of input, transcript, streaming, and protocol code,
not a claim to have reviewed every line or obtained the desktop app frontend.
No Codex source was copied. Its repository is Apache-2.0; preserve notices if
we later import implementation rather than independently apply these patterns.

## The human experience

A person writes in one familiar conversation. Their message appears immediately.
One Room agent is responsible for responding, even when many workers help.
Other humans can speak normally; a second human's comment is not automatically
a command to every agent. Direct agent mentions remain an optional override.

Use Slack/Discord's compact channel navigation, avatars, grouped messages,
hover/focus actions, drafts and predictable threads. Use Codex's stable transcript,
streamed answer, persistent composer and interruptible work lifecycle.
Keep operational claims, routing and workers behind Activity/Advanced.
There must not be an empty assistant card competing with the conversation.

Feedback must distinguish facts:

1. Local echo: next paint, target under 100 ms. No extra Sending chat message.
2. Server committed: original message becomes normal opacity. This is not agent acknowledgment.
3. Agent accepted: actual acceptance event permits an avatar/progress indicator.
4. Answer: stream one message in place; hide redundant progress while text arrives.
5. Result/blocker: finish the same response and notify the initiating human in that conversation.

Dots indicate actual typing/response activity, not a fabricated agent thought.
A short agent-written acknowledgment can explain the plan when useful; do not
inject a canned 'Got it' from every worker for every human message. If no host
accepts a request, show one honest, contextual unavailable/not-picked-up state.
No global Not connected banner when nobody has asked the assistant for anything.

## What the source actually does

- [ChatWidget](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/tui/src/chatwidget.rs): committed history plus an active cell, cached live transcript tail, derived busy state. Commentary suppresses the redundant status row while streaming. `on_committed_user_message` reconciles submission client IDs and skips duplicate receipts.
- [InputQueueState](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/tui/src/chatwidget/input_queue.rs): pending-start, queued input, pending steers and rejected steers are distinct. Keep the original draft/history record through delivery and recovery.
- [Input submission](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/tui/src/chatwidget/input_submission.rs): queue/recover around unavailable session, model limits and prepared images rather than treating every submission as immediately started.
- [Streaming controller](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/tui/src/streaming/controller.rs): immutable committed region and mutable tail; table/fence holdback prevents layout churn. We should reuse this separation, not port terminal rendering wholesale.
- [Protocol](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/app-server-protocol/src/protocol/common.rs): separate turn/started, item/agentMessage/delta and turn/completed events. [Official app-server guide](https://learn.chatgpt.com/docs/app-server) documents the integration lifecycle.
- [Slack threads](https://slack.com/intl/en-gb/help/articles/115000769927-Use-threads-to-organise-discussions): initiators, repliers and mentioned participants receive thread notifications. Room should not require a person to search general chat for an answer to their own request.
- [Discord message API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx): message IDs/references and nonce controls are relevant to reply placement and duplicate suppression. Keep Room's existing stable command/message IDs rather than introducing another identity system.

## Room already has useful foundations

`src/client.js`: receipt reconciliation, SSE refresh coalescing and session boundaries.
`src/app.js`: scoped drafts, stable message rows, local echoes (PR2674), threaded replies.
`src/human-experience.js`: explicit/shared invocation, queued/working/needs-input states,
streamed answer drafts, Stop, contributions, retry identities and deleted-source handling.
`server/room-assistant.mjs`: configured coordinator, durable runs and fenced attempts;
its answer publication writes `replyToId: run.sourceMessageId`.
`server/agent-heartbeats.mjs`: durable mention/DM wakes; a wake is not proof of pickup.

The free-form review test bypassed the shared assistant: muse-room had no configured
Room coordinator, and Instinct-3 answered in general chat with no replyToId. It was
useful feedback, but manual cooperation rather than a reliable response contract.
Hiding the idle panel does not solve that routing gap.

## Implementation sequence

### Current bounded fixes

PR2674: immediate original-message preview; release ordinary composer on receipt;
actual avatar typing dots. PR2673: avoid room-cache eviction on unrelated writes.
PR2683: hide unconfigured idle assistant chrome, omit claim lines in threads,
preserve open message menus, cheap refresh for status/capability/lease events.
Follow-on in this branch: confirmed previews immediately lose pending opacity;
plain Ask Room dispatch no longer waits for the chat-history refresh before invocation.
The delayed-snapshot browser test proves a durable assistant run exists before
that blocked refresh returns. Attachments/contribution flows keep existing ordering.

### Next: make the response loop reliable

1. Connect an authorized coordinator and running host for the actual room. Validate
   readiness from the host, not a member name or configured ID. Resolve the existing
   owner/admin prerequisite through the room owner; do not silently bypass it.
2. Route human requests to the existing shared-run mechanism. In a solo room, default
   to Room. In multiplayer, room-directed asks and follow-ups to its active conversation
   target Room; human banter stays chat. Make the chosen audience clear in the composer.
3. Admit the message and invocation atomically, or durably queue the second operation
   by the same message ID. The present two-request browser path can lose invocation
   if the tab closes after the message commits. Do not call that end-to-end reliable yet.
4. Drive one compact response bubble from accepted/working/answer/failure events.
   Replace assistant polling on the visible path with a viewer-authorized run event
   subscription; retain bounded polling only as recovery. Reuse existing attempt IDs.
5. Supply a root message ID to every delegated worker and enforce publication through
   the coordinator's existing answer route. Deduplicate repeated/late results. Preserve
   intentional human broadcast and explicit direct-agent conversations.
6. Add one bounded pickup deadline and durable escalation to a configured fallback.
   Do not automatically start every room member or let all workers respond. If no
   fallback is configured, expose that fact and a single retry/connect action.
7. Decouple subsequent typing from receipt latency with a scoped outbox. Store each
   exact command, recover after restart, and keep failed items individually retryable.
   This needs race tests; simply removing the current busy lock would lose drafts.

### Visual refinement after the behavior works

One header, one transcript, one composer. Hide Everyone selector for normal public
chat; expose audience changes contextually. Compact assistant activity inline and
collapse completed work. Show message actions on hover and keyboard focus. Keep
search behind its existing shortcut until opened. Do not reset scroll, selection,
open menus or draft state on an incoming event. Use real avatars when the public
profile contract supports them; private account profile photos must not leak.

## Acceptance evidence required

Two human accounts and two agent hosts, desktop and 390px browser:
- local paint, server receipt, host acceptance and first answer timestamps measured separately;
- delayed/offline receipt, reconnect and replay produce one message and one invocation;
- tab close between commit/invoke resumes the same request;
- thread switch and room/account switch preserve drafts without leaking content;
- one coordinator accepts; delegated work yields one response in the originating thread;
- human chatter does not trigger a swarm; direct mentions still work;
- stop, expired host, late result, access revocation and no-host states remain truthful;
- streaming does not steal scroll/selection and reduced motion remains respected;
- human receives useful feedback without opening a board or understanding claim IDs.

Targets are product budgets, not measured production claims. The current live
application remains unchanged until exact-head hosted checks, serialized merge,
and deployment/smoke verification complete.
