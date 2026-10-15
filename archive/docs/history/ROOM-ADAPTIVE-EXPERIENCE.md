# Room adapts to the work

Status: initial agent discovery implementation; human adaptation and inference below are design proposals. No production inference, automatic permission grants or new background jobs are enabled by this change.

## Product decision

Keep the conversation and navigation stable. Adapt the relevant context, tools, suggested next action and permitted automation to the selected task and participant. People should not have to configure a workflow before starting; agents should be able to inspect, override or expand recommendations.

Adapt to work, not guessed personality. A person may research in one conversation and review code in another. Keep those contexts independent. Membership, authorization and provider availability remain factual inputs, not model predictions.

## Three levels of adaptation

1. **Present:** highlight task-relevant context and tools within existing access. No confirmation for every harmless presentation change. Keep full discovery available.
2. **Clarify:** ask one short question when different interpretations materially change the result. Prefer an inline card at a natural pause; do not interrupt typing or rearrange the page. Include a free-text response and a way to defer an optional question.
3. **Authorize:** when an action exceeds established scope, show the concrete action, affected resource, duration and limit. An inferred intent or a suggested reply never grants authority. Existing authorization should not be requested again.

Changing presentation is not starting execution. Selecting an automation-oriented catalog does not create a schedule, register a webhook, wake a host or increase autonomy.

## Examples

| Current work | Human experience | Agent experience |
| --- | --- | --- |
| Investigating a bug | Relevant evidence and progress in the conversation | Task context, claims, discussion, blockers and result tools |
| Reviewing a result | Result, changes and one relevant decision | Exact result and evidence, clarification and verification tools |
| Planning a recurring review | A concrete proposed trigger and scope | Existing wake/heartbeat/webhook tools and current access checks |
| Ordinary conversation | Normal chat, no forced task creation | Conversation and request tools; broader tools remain discoverable |

Example clarification: “Should this produce a recommendation or an implemented change?” Choices: “Recommendation”, “Implemented change”, plus free text. Ask only if the conversation has not already answered it.

Example automation proposal: “When this task is ready for review, notify the assigned reviewer. Applies to this task until it closes.” Choices: “Enable for this task”, “Edit”, “Not now”. The concrete host and delivery support must be checked; the UI must not promise a model will start when only a notification can be delivered.

Do not turn “Always do this” into an unbounded grant. Offer a clearly scoped saved preference separately from a one-time decision. Users can inspect and revoke saved automation in one place.

## First implementation: focused agent tool discovery

Authenticated hosted MCP clients can select task-related catalogs through the existing `tools/list` operation. This is an explicit client selection: a reasoning agent or host can select a focus from its understanding of the task. The server does not infer intent from conversation or mutate the agent's configuration.

Focuses cover conversation, work, review and automation. Default clients retain their existing core catalog. Clients can request the full catalog when a focus does not cover their task. Existing capability filtering and call-time checks still apply. Selection is per request, not a saved room-wide mode, so different agents can use different focuses concurrently.

This is a Room extension to discovery, not a claim that all MCP hosts support dynamic tool-list refresh. Hosts that do not support it keep the existing catalog. Human popups and automatic focus selection are not implemented in this slice.

## Subsequent integration

- Use selected work state, explicit user requests and saved scoped preferences before inference.
- Keep agent overrides stable until the selected task changes or the agent changes the override. Do not flip modes after every message.
- Where semantic inference adds value, use a bounded proposal: a known focus or no-match, evidence reference and uncertainty. Never execute arbitrary model-generated configuration.
- Ask only when the missing answer changes the next useful action. Bundle related questions; avoid duplicate pending questions; remember dismissals for the same task/revision. Correcting a suggestion should be one action.
- Return the applied focus and reason to agents. Humans see a small contextual hint only when useful, with “Change” and access to all options. Explain a change rather than silently moving navigation.
- Save a successful repeated workflow only after explicit scoped opt-in. Starting one task is not consent to a recurring automation.

## TypeSafe / Jev candidate

The TypeSafe skill-suggestion cookbook selects a candidate and then independently checks applicability. Room could evaluate that pattern for proposing a focus or reusable workflow. Begin with observation-only suggestions over representative labeled Room tasks. Include mixed tasks, ambiguous requests, topic changes, explicit overrides and no-match cases. Confidence is not correctness or permission.

No model integration is needed for explicit focus selection. Compare an inferred suggestion with explicit task-state rules before adding latency, credentials or recurring inference cost. Do not send private room context to an inference provider merely because a connector exists.

## Evidence informing this design

- [Linear Agent skills and guidance](https://linear.app/docs/linear-agent): skills can be chosen explicitly or applied when context matches; guidance has workspace, team and personal scopes. Borrow reusable context, not a new navigation section for every capability.
- [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use): on-demand discovery avoids placing the entire catalog in context. This supports task-focused exposure, not fewer underlying capabilities.
- [Microsoft human–AI interaction guidelines](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/): predictable adaptation, understandable behavior and correction are central concerns. Avoid surprising mode changes.
- [TypeSafe skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) and [confidence routing](https://docs.typesafe.ai/patterns/confidence-routing): narrow typed judgments can propose applicability; application code owns policy and execution.

These are documented patterns, not evidence of improved Room outcomes yet. Room's prior audit found contradictory attention views and unnecessary reply prompts; adaptive presentation must not obscure those underlying facts.

## Acceptance

The first slice must preserve default and full discovery, return relevant existing tools for an explicit focus, reject invalid selections, respect capability filtering and produce no state mutation. Test the actual hosted RPC boundary.

For human integration, evaluate whether people complete representative tasks with fewer choices and interruptions while still finding advanced controls. For agent integration, compare completed-task quality, discovery bytes, unnecessary calls and missed obligations. A smaller catalog alone is not success. Never remove a required obligation because an inference ranked it poorly.
