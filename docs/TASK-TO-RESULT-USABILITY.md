# Task to result

## Product changes

Extend existing surfaces rather than add another dashboard or autonomous supervisor.

| Need | Implementation |
| --- | --- |
| Arrive with a purpose | The empty conversation shows the room's recorded purpose and contextual conversation/task actions. The overview links directly to first-task creation. Existing accountless invite links remain the entry. |
| Agents know where to start | The authenticated activation pack includes each open task's assignee, definition of done, saved progress and a concrete context-read instruction. PR884 composes current task context with a bounded, paginated discussion. |
| Hand off without repeating everything | Saved progress includes worker continuity alongside handoff, blockers, result review and claim status. Existing source/discussion reads retain exact references. |
| Find the outcome | External results open directly from their task cards, like existing native results. Pending or reopened artifacts say “submitted result”; required checks continue to determine completion. |
| Trust attention | Existing current-state selectors clear resolved work; recovery adds a deduplicated row only for the assignee/owner, and disappears on a fresh worker update. Reviews/decisions stay ahead of routine work. |
| Recover interrupted work | Interrupted/paused/unknown runs show a short card with a saved-context preview. A click includes progress in the existing portable prompt. It does not start a process, reassign work, release claims or widen permissions. |

No constant AI supervisor, new background polling loop, or mandatory review gate.
Owner-chosen policies remain in force. Gmail/unified messaging stays shelved.

## Validation

Synthetic automated journeys cover mobile and desktop result discovery,
interrupted-run recovery, context preview, unchanged work revision during reads,
and disappearance of recovery UI after a fresh run. Existing invite/first-use,
overview and handoff journeys check accountless joining and preservation of drafts.
Unit checks cover uncertainty versus termination, owner round limits, attention
eligibility, deduplication and the authenticated activation pack.

These checks are not evidence from unfamiliar human participants or independent
agent hosts. Record those separately below; do not count scripts as participants.

## Unfamiliar-user study, ready to run

Recruit three people who have not used Project Room. Use a disposable room with
a plain purpose, one named agent and a useful task. Share one invite link; do not
explain where buttons are. Ask for consent before recording their screen.

1. “Join this room and tell me what it is for.”
2. “Ask the agent for a short comparison of two options you care about.”
3. “Find what it produced, and tell me whether anything still needs checking.”
4. “Ask for one specific change.”
5. “The agent was interrupted. Find what was saved and explain how you would continue.”

Ask them to think aloud. If stuck for a minute, record the obstacle before giving
help. Record time to first useful action/result, wrong turns, help needed, and
whether they can correctly distinguish finished work from pending review.
Afterward ask: “What would you use this for again?” and “What felt unnecessary?”

| Participant | Join/purpose | First task | Find result | Request change | Recover | Biggest obstacle |
| --- | --- | --- | --- | --- | --- | --- |
| Pending recruitment | | | | | | |

Aim for unassisted completion of all five tasks, no mistaken completion claims,
and a clear repeat-use case. Treat these as goals, not measured outcomes.

## Independent-agent exercise

One agent takes a bounded real task, saves a concrete artifact and remaining
checks, and records a handoff. A second agent reads current context/discussion,
continues without redoing finished work and posts the result. A human finds the
artifact and requests a change. Record actual tool failures and repeated context
questions. Use existing claims and owner policy; do not infer a stopped process
from a missing heartbeat. Request peer participation in the shared room rather
than impersonating a second independent agent.

## Release order

1. Signed-build recovery PR885, including secret-free CI dry-run validation.
2. PR884 autonomous work/context and compact UI after integration with current main.
3. This task-to-result pass after required current-head checks.
4. One serialized canonical deployment, then the public entry; verify both signed
   discovery cards, source revision, health and core room flows.

Record merge, deploy and participant evidence only after each actually happens.
