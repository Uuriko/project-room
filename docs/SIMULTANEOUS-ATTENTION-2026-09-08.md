# Simultaneous attention: bounded review

## Plan

Test the existing compact next-step and expanded catch-up with multiple requests
from separate scripted MCP clients, six owner assignments and a new result handoff.
Use disposable desktop/touch fixtures, not real users or hosted model calls.

1. Start with several explicit requests. Focus the first suggested action.
2. Add a higher-priority result and unrelated current assignments. Confirm the
   focused action keeps its identity until the person leaves it.
3. Use More and Show all to discover every current need. Check stable ordering,
   exact links, keyboard activation, enlarged text and screenshot hierarchy.
4. Answer a selected request with entered text while more activity arrives. Only
   that request clears; other needs and decision gates stay pending.
5. Reopen/read from both agent clients. Each sees its own current requests and
   exact answer, without marking human history read or assuming work completion.
6. Inspect removal of a focused catch-up item. Keep a predictable remaining
   destination; never let a removed element strand keyboard focus on the body.
7. Run regressions and qualify runtime changes only if a demonstrated defect
   warrants them. Preserve existing packages and screenshots; document limits.

## Design references

[Linear Inbox](https://linear.app/docs/inbox) distinguishes actionable notifications,
read state and snoozing. Borrow the separation, not another inbox or automatic
read-on-open behavior: Room read markers must remain explicit.
[W3C keyboard guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
emphasizes persistent, predictable focus when elements change or disappear.
These are design inputs, not evidence of Room usability or conformance.

Previous goal turn: progress—runtime fixes, complete qualification and retained
evidence. Current work continues the broader goal; release/native-host/retention
gates remain open and this slice does not redefine completion.

## Results and implementation

The two new desktop/touch journeys run separate producer and reviewer MCP
processes. Three explicit questions, six owner assignments and one owner-decision
handoff make ten needs. The producer submits native text through the actual
protocol; the owner does not approve it. A focused question shortcut keeps its
identity when the higher-priority result arrives. More opens catch-up, and its
existing Show all control exposes all ten exact destinations without a new screen.

The initial tests failed when a requester cancelled the middle focused question:
`renderBriefList` sent focus to the first row, restarting the queue. It now keeps
the same record if present, then the next surviving old neighbor, then the
previous one. Only when no old neighbor survives does it use the first new item
or the existing safe section fallback. This applies to existing catch-up lists;
no new UI, tool, copy, event, authority, schema or storage contract was added.

Tests verify both next-neighbor and last-item/previous-neighbor recovery. The
human answers another question while unrelated activity arrives. Enter sends on
desktop; touch uses Send. The ordinary background update preserves entered text
and focus. Answering produces eight remaining needs, not room completion. A
separate explicit cancellation then leaves seven work needs. Both clients read
the exact current exchanges; these reads and opening the queue leave the complete
20-table audit unchanged. Human read markers stay zero and approval stays null.

One draft test incorrectly expected mobile Send to refocus the textarea. That
expectation was corrected: reopening the mobile keyboard is not required. Both
modes assert background activity preserves a focused composer; desktop also
asserts keyboard-send focus. No product behavior was changed for that test.

Six inspected viewport screenshots and two JSON journey records are retained in
`../project-room-runtime-packages-20260908/evidence-simultaneous-attention/`
relative to the repository. Screenshots show the expanded queue, neighboring
request destination and remaining needs with 200% root text. All needs are
reachable without horizontal document overflow. The opt-in expanded list is
necessarily longer; this is not evidence that users prefer its ordering.

## Qualification

Frozen runtime: `e1a3ae437a1b65874a27de9875d0c8db11dab364`.
Tree: `06baa3beb89e92e5666abc1815fea174370b919f`.
65 runtime files, 19 assets, schema/writer 12. Only `src/app.js` changes from
candidate `4ab081b`. Every source runtime file matches the retained candidate.
Manifest SHA256: `30e007a44b07f656b7f26c5c66170474fc1c99a2bc2daccf0180bc09add987a0`.
Package: `../project-room-runtime-packages-20260908/candidate-e1a3ae4`.
Fallback remains `4d22189ccdebc56db23397e6cc75b07eff0e3c2c`, schema 12.

579 core/API/package tests pass. Both new journeys pass, as do 14 local Workers
checks including browser/restart coverage and two exact-commit fallback browser
journeys. An initial package command rejected a relative destination before
creating files; the concurrently started Workers recovery test reported the
missing package. After using a verified absolute destination, all 14 Workers
checks passed. No partial package was reused or overwritten. The final frozen
full browser suite passed all 180 tests in 232.49 seconds, including both new
journeys and the prior catch-up, disclosure, focus, session and recovery cases.
The initial 34-test selection had one incorrect mobile test expectation described
above; its final corrected cases are included in the passing full suite.

## Now / next / later

- Now completed: frozen browser qualification and inspected evidence checkpoint.
  Keep the broader goal active; no publication or preview restart.
- Next: specify useful work discovery beyond current assignments. Source inspection
  confirms every work proposal requires an accountable member; only that member
  can accept/start/claim/complete. There is no generic unassigned-job pool. Existing
  `needs_me` includes assigned handoffs even when a permission is missing, while
  search's `eligibleWork` count means filter candidates, not capability fitness.
  Do not present a missing claim as permission to take another person's task.
  Compare an actionable-permitted view with an explicit offer-to-help workflow;
  retain visible permission gaps, owner assignment and current claim checks.
- Later/separately gated: capability profiles and standing roles, native-host
  acceptance, independent hosted recovery, consented human/retention measurement,
  optional bounty/provider integrations. Do not add metadata just to enable a
  recommendation or silently turn an offer into accepted work.

All human use here is simulated and both agents are scripted protocol clients,
not independently reasoning native models. No real-user retention, accessibility
conformance, provider recovery, deployment or production readiness is established.
