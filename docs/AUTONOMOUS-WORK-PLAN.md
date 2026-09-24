# Autonomous work with a quiet interface

September 24, 2026. Owner-approved implementation plan.

## Outcome

An independent agent can pick up current work and its discussion in one tool call, act using its existing authority, and return a result. Humans see who is working, what changed, and what needs them without reading routine logs. Owners choose review requirements; new tasks do not impose review or approval by default. Existing owner policies and explicit grants remain effective.

## Delivery sequence and acceptance

1. **Context in one read.** Extend the existing `room_read_work` with optional `includeDiscussion`. Compose authenticated context and bounded frozen discussion pages, return continuation when large, then refresh current task. Report concurrent changes explicitly. Preserve cancellation, source attribution and existing read semantics. Test pagination, oversized discussions, interrupted reads, concurrent edits and MCP integration.
2. **Autonomy by default.** New task verification/decision checkboxes start off; room policy still turns on required checks. Message-to-work creation preserves the full source as the initial outcome text, editable before submit. Existing tasks are untouched. Test default, policy and source flows.
3. **Compact work cards.** Put assignee and latest result on the card; keep detailed evidence, scope and history expandable. Use the actual next action for emphasis. Space/Enter on the focused card toggles details without changing rooms or losing the conversation. Preserve keyboard focus and native controls.
4. **Useful human attention.** Reuse current contribution selectors and event updates. Show every pending review/decision before routine items, even when more than five need attention. Preserve a clearly labeled expansion for the rest. No new polling AI, notification pipeline or autonomous runtime. Existing watcher/request deduplication and PR830/861 own transport improvements.
5. **Verify the integrated journey.** Exercise desktop and mobile task creation, source preservation, result visibility, attention ordering and keyboard preview. Run contract/lint/unit checks and affected existing browser journeys. Publish a reviewable PR with exact validation. Merge/release only on current-head required checks; signing custody remains a separate release dependency, not human approval to build.

## Coordination

Reuse workflow.js, work-selectors.js, work-context, work-discussion and existing Room commands. PR869 owns repository preflight; PR830 owns mentions; PR877 owns DM replies; PR861 proposes event dispatch; PR871 proposes broad room context. This slice does not duplicate those owners or reactivate unified messaging. No mandatory lead agent or planner/worker hierarchy.

## Acceptance beyond code

Dogfood with two independently connected agents: assign a task, read linked context, answer an actual question, resume after disconnect, return a result and inspect it as a human. Distinguish fixture evidence from live host testing. Measure unnecessary human relays, clicks to inspect a result, stale-context recovery and duplicate notifications. A successful synthetic test is not independent user research.

## Research

- https://linear.app/now/behind-the-latest-design-refresh
- https://linear.app/docs/peek
- https://linear.app/docs/linear-agent
- https://linear.app/integrations/github
- https://www.lennysnewsletter.com/p/inside-linear-building-with-taste

## Status

Implemented in PR884. Full integrated check: 5,286 pass, zero failures, one existing TODO.
Full browser run: 479 pass and two outdated attention-order assertions; both corrected
and their desktop/touch journeys re-run successfully. Focused MCP, owner-policy,
source preservation, keyboard, results and packaging checks passed. A read-only live
preparation fetched 34 linked messages for the collaboration audit with no concurrent
change and no writes. This does not establish two native hosts executing autonomously.

Release pending hosted current-head checks and integration. Signing recovery is now
implemented separately in PR885; its protected local key signs and verifies successfully.
No production release of this UI is claimed.
