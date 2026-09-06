# First workflow: one project, people and agents working together

Proposed v0 build brief, 2026-09-05. This document describes the experience to build; it does not describe working software.

The first workflow is project coordination around a GitHub change. An owner asks once, an agent finds or produces the result, another agent checks it, and the owner returns to a clear decision. GitHub holds the code; the Room connects the conversation, responsibility, evidence, and decision.

The [Multiplayer AI Manifesto](https://multiplayer-ai.com/) argues for shared agent sessions, less human forwarding, and work that can resume later. Those are useful design goals. The choices below apply them to our [v0 contract](./SPEC-v0.md), with the [scope cuts](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550808959) proposed in review.

## What the first screen does

| Surface | What a member sees or does |
| --- | --- |
| Room header | Project goal, access scope, and human and agent members. |
| Conversation | Ask a named person or agent, discuss an artifact, or assign an outcome. Agent progress appears here beside the human discussion. |
| Work card | Outcome, accountable member, current result, evidence, and next action. Expand it for attempts and checks. |
| Return summary | What changed since the member last visited, what is blocked, and which decisions need them. Every claim opens its underlying event or artifact. |

Keep the transition table behind this view. People should be able to discuss a result without learning ledger terminology or turning every message into a task.

## The first complete demonstration

Use the recorded [#134 review fixture](./EVENT-FIXTURES.md) at commit `70053cc6cf9d86f3a43220dcfbb0af05797380c0`. Its recorded results are fixture inputs, not a new assertion about today's PR status.

1. Potter asks Codex to check whether the linked change is ready for his review. The work card records that outcome and its scope.
2. Codex reads the existing work and evidence. If the result already exists, it links that result and describes what still needs checking. It does not create a replacement patch just to show activity.
3. Instinct receives the same work card for verification and fetches the exact revision. Its check result is attached separately from the executor's completion claim. Potter forwards nothing between agents.
4. A second authorized person joins and asks, "What is waiting on us?" The selected agent answers from the shared work card and source evidence. Joining does not restart the task or require a transcript pasted into a new chat.
5. Potter returns to the result, checks, and remaining decision in one view. Recording approval records a decision; a GitHub merge is a separate external action with its own authorization and evidence.

If a check fails, the card shows the finding and next responsible member. If evidence cannot be fetched, it shows that gap instead of claiming verification.

## Collaboration rules that keep the room usable

- Address a named member when a response is needed. Ordinary updates do not wake every agent. Agent handoffs use the accepted assignment and send its evidence directly to the next responsible member; acknowledgments do not start further turns.
- Members may ask questions and propose changes. An action uses the authenticated actor's explicit permissions and the accepted task scope. A message does not grant a new capability. An agent acknowledges an accepted change of direction before using it in a later step.
- Start with sources explicitly shared with the Room. Every reader must be allowed to see that material; joining the Room cannot expose another member's private connector context. Handle a restricted source in a separate restricted context, including its derived summaries.
- A completion claim may come from its authorized executor. Independent verification, when required, is a separate check by another actor against the exact artifact version. Display labels such as `[Instinct]` are not authentication.

## What to persist, and what to leave out

Persist the Room's messages, work cards, source references, decisions, and events. Resume an agent with the relevant task state and source-backed context. A provider session ID or an ever-growing transcript must not be the only memory. Reopening a Room must never replay an external action.

Keep execution in the existing agent runtimes. Local and cloud workers can both contribute; an offline worker shows as unavailable and leaves its recorded context available. Reconnection does not promise recovery of unrecorded process state or automatically retry an action whose result is unknown. Begin with one working connection before generalizing adapters or automatic model selection.

Going offline does not transfer an existing write claim to another worker. Apply the [claim recovery rules](./EVENT-FIXTURES.md#recovery-cases-to-exercise-in-the-first-implementation). The first read-only review needs no claim.

Apply the [proposed cuts](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550808959): explicit permission checks before a general Policy engine; ordinary evidence events before signed-receipt infrastructure; write claims only for contested writes the system can actually coordinate. Read-only research needs no write lease. A Room claim cannot lock an external repository by itself.

Keep reusable corrections explicit and editable. Automatic skill creation, benchmarks, agent marketplaces, Slack bridges, calls, and community features can wait until this workflow demonstrates value. Briefings and hiring remain later candidates.

## Build and evaluate in this order

1. **Shared review:** two authenticated people can use the same durable conversation and work card, open evidence, and return after a restart.
2. **Agent handoff:** connect an executor and verifier, pass the task and evidence directly, and display their results without human forwarding.
3. **Ordinary recovery:** show a failed check, unavailable worker, duplicate delivery, and changed artifact revision honestly. Superseded evidence cannot verify a newer revision. Repeat delivery must not repeat the assignment or its action.

Run the first five suitable handoffs through the Room. Record manual context relays, duplicated work, and whether each person can identify the result, responsible member, evidence, and next action without asking for a recap. The proposed pass condition is zero required human relays and zero repeated actions in these controlled cases, with failures visible and recoverable.

Let people use their existing tools and record where they fall back. Remove the earlier five-day Slack/Discord ban: forced adoption cannot show that the Room is useful. Message volume and acknowledgment counts are not success measures.
