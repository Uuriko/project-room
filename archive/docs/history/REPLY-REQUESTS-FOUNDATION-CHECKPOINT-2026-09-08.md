# Reply-request foundation checkpoint

September 8, 2026. Local partial implementation, not a completed feature or goal.

Runtime: `975f5e556af6dc764ab13659d7509d104525ce84` on
`codex/unified-local-20260907`. The user's follow-up asks for research and a broad
task roadmap; new runtime implementation is paused for that response.

## Implemented

- Explicit reply requests, clarification-aware response basis, answered/declined
  terminal states and attributable requester/owner cancellation. Ordinary messages
  remain ordinary; answering does not complete work or approve its result.
- Canonical current lists, bounded selected context and anchored immutable history.
  History retains transitions that happen between polls; current state is separate.
- Seven shared direct/CLI/MCP request operations with strict inputs, exact receipts,
  stable operation identity and conservative unknown-outcome handling.
- Schema/writer 12, historical reserved-field checks, replay/recovery auditing and
  genuine previous-version migration/old-writer qualification. No new SQL tables.

Default MCP exposes 24 tools; the existing optional attention configuration exposes
26. Existing observer journals remain v1/v2 and do not yet include request attention.
There are 20 application tables, 19 packaged public assets and 64 runtime files.

## Verification completed before the research response

| Gate | Result | Evidence boundary |
|---|---|---|
| Full core/API/package check | 510 passed; no failed/skipped/cancelled tests | Includes the final request changes and package checks |
| Full configured browser regressions | 159 passed; no failed/skipped/cancelled tests | Existing browser flows; not a new request UI acceptance claim |
| All nine Workers check files | 13 passed; no failed/skipped/cancelled tests | Local workerd, including genuine v7/v8/v9/v10/v11-to-v12 cases |
| Focused request tests | 21 passed, included in core total | Current/history/authority/recovery and scripted HTTP/CLI/MCP journeys |
| Exact runtime package | Created and verified | No deployment implied |

Tests cover changed clarification, wrong/stale identity, interrupted operations,
exact retries, historical anchors, projection auditing, inactive original requester
handling, capacity-ending operations and legacy payload compatibility. Independent
agents reviewed/tested bounded lanes; their scripted journeys are not labeled as
new semantic agent-authored work.

Exact package, relative to the project mirror:
`work/project-room-runtime-packages-20260908/candidate-975f5e5`.

- Source tree: `b8bfb72b02001c5e30f366befb3916d33afb8eb4`.
- Manifest SHA256: `e04e9f842db04edc45a6a27fe31b214e50b416ec887ca591d08ee0290f64416f`.

The test/package processes have exited. Review agents verified their runner
descendants were stopped; existing user previews were preserved. No new test
execution is claimed by the subsequent documentation-only research pass.

## Visual evidence inspected

Main inspected the generated `test-results/conversation-desktop.png` and
`test-results/recovery-resumed-mobile-large-text.png` during the research pass.
These are synthetic regression fixtures for the unchanged ordinary UI.

The desktop expanded work panel shows several competing secondary actions. The
enlarged-text mobile capture shows a tall identity/session header and a success
notice covering part of the lower content. These are layout observations and
candidate improvements, not measured human confusion. The limited mobile viewport
does not prove the complete scrolling journey or physical-device behavior.

## Remaining before feature completion

1. Human request composer/actions, exact draft ownership, stale-context refresh
   and immutable uncertain-send recovery.
2. Explicitly selected observer v3 for request attention, preserving v1/v2;
   include service-capability detection and sufficient current-condition capacity.
3. Actual agent-operated clarification/disconnect/resume exercise and complete
   simulated human journeys with fresh screenshots.
4. Full regression qualification of the complete slice; separate native-host
   acceptance, v12-compatible fallback and hosted restore/recovery release gates.

See [implementation plan](REPLY-REQUESTS-PLAN-2026-09-08.md) for the detailed
contracts and [whole-project research/backlog](WHOLE-PROJECT-RESEARCH-BACKLOG-2026-09-08.md)
for subsequent priorities. The overall goal remains active/incomplete.

Recorded live remains fb90a70 / Worker 901be347 / schema 7, untouched and unverified.
No push, deployment, provider connection, payment, paid compute, messaging outreach,
new recurring automation, personal inbox operation or other-product edits occurred.
