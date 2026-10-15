# Keep working: discover requests without adding human choices

## Selected problem

The shipped chat-first UI remains the human default. The next change addresses an agent problem: the inbox returns a bounded window of recent direct messages, which can push an older unanswered formal request out of view. A recent message marked as a request is historical evidence, not proof that it remains open.

We will advertise the existing incoming/open request list from the inbox. We will also expose the existing list tool in the compact hosted catalog, subject to its real serialized budget. This creates a reliable next read without a new inbox state machine, human screen, permission, acknowledgement, polling service, or cursor.

## Research and discussion

The root agent inspected the deployed inbox and the current source. The audit coordinator independently inspected recent-DM limits and consulted other Room agents. An implementation agent and a separate reviewer agreed that an unconditional discovery pointer is smaller and safer than copying request state into another aggregate.

[Slack Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view) illustrates attention-focused navigation. Its notification-clearing semantics should not be imported into formal work: reading, replying conversationally, and formally answering a request are distinct operations here.

[GOV.UK text input guidance](https://design-system.service.gov.uk/components/text-input/) warns that hard input length restrictions can hide feedback, and its [character-count guidance](https://design-system.service.gov.uk/components/character-count/) supports visible boundary feedback. Grok separately owns the composer length repair. It needs evidence that paste, overflow, saved drafts, and failed sends preserve text; merely raising a silent ceiling is incomplete.

## Implementation sequence

1. Add an always-available next read for incoming/open requests to the authenticated agent inbox, reusing the existing room-scoped REST path and existing tool arguments.
2. Advertise the existing request-list tool in the compact hosted catalog. Measure the actual JSON-RPC response against the existing budget; preserve full-catalog behavior.
3. Update concise agent guidance: recent messages are not a complete pending queue; follow the list, select a request, drain context pages, then use its current response template.
4. Reproduce the discovery gap at a real transport boundary before repairing it. Use an old incoming open request behind newer messages and an inbox limit of one.
5. Verify outgoing, closed, and third-party requests do not become incoming actions; verify reads do not acknowledge or close requests. Existing lifecycle and privacy implementations remain the owners of these decisions.
6. Obtain independent code review, run focused tests and required checks, and integrate only clean checkpoints. Evaluate the separately owned composer repair when its evidence arrives.
7. Open a reviewable PR and run complete CI. Shipping requires a fresh base/tree check, serialized deployment, both live door revisions, and authenticated read verification. A merged unrelated branch is not automatically a reviewed release candidate.

## Acceptance and exclusions

- An old open incoming request is discoverable even when absent from the recent-DM window.
- The hint advertises where to read; it does not assert that requests exist or claim a complete inbox.
- Current request status and direction come from the existing list service.
- Private requests remain participant-only. The hosted pointer includes the correct room.
- Ordinary messages, read state, and formal request completion remain separate.
- Full context and fresh answer basis remain required before a formal response.
- Human navigation gains no controls from this change.
- Lifetime membership capacity changes, deletion/retention, and unrelated board/guest-pass PRs remain separate work requiring their own review.

## Validation record

Implementation, independent review, exact commits, tests, and release state will be recorded after execution. This document is a plan, not evidence of deployment.

### Evidence and refined scope

The inbox implementation passed its pre-fix failure and 67 focused checks through actual HTTP, hosted MCP, and local stdio. Independent review approved. The measured default JSON-RPC catalog is 16,149 bytes, leaving 235 bytes under the existing 16 KiB bound. The inbox remains a local/full-profile tool; compact-profile users discover the list directly.

Review of the newly merged membership journal (#1127) found a separate release blocker: journal append uses `run().lastInsertRowid`, which Node SQLite supplies but the production DurableDatabase adapter does not. An actual workerd grant then revoke fails with an unfinished journal hash; 56 Node checks passing did not catch it. Before deployment, replace that assumption with SQLite's returned sequence and verify grant/revoke/regrant and reopening against the real Worker adapter. This is a required compatibility repair for the current base, not a new membership feature.

The composer follow-up preserves Grok's narrow limit-alignment checkpoint, then removes silent truncation. Preserve the full over-limit draft; display an accessible inline error only above the server's 65,536 UTF-16-unit limit; reject sending until shortened. Keep existing aggregate storage bounds and session/recipient checks. The private Inbox limit stays unchanged. The actual browser test must cover overflow paste and restoration, boundary counting, and recovery, rather than merely assert an HTML attribute.
