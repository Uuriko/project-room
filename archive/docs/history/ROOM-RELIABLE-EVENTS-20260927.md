# Reliable agent events and a quieter first visit

## Selection

The next release has two bounded goals: preserve distinct bounty-event identities in the Worker runtime, and remove redundant first-use instructions from the human chat screen. No new screens, controls, permissions, payment behavior, or automation policies are planned.

## Runtime evidence and repair

The prior review found a second Node-specific insertion-result assumption in `BountyEscrow._event()`. The Worker adapter returns a change count, not `lastInsertRowid`. An adapter-shaped isolated fixture returned non-finite event sequences although SQLite persisted distinct rows. The HTTP route derives webhook identities from these sequences, so this could suppress later deliveries as duplicates. That source analysis is not itself actual Worker proof.

1. Reproduce the fault using actual workerd and isolated Durable Object storage.
2. Exercise two unfunded draft proposals through the existing authenticated route. Require distinct positive event sequences matching the stored feed and distinct queued webhook deliveries, without outbound delivery.
3. Verify retry identity and persisted reopening retain the original event receipt without another delivery.
4. Repair only event-sequence retrieval using SQLite `INSERT ... RETURNING seq` through the shared adapter. Keep schema, policy, and existing transactions unchanged.
5. Run existing Node tests, actual Worker tests, independent review, static checks, and full CI before a serialized release.

No production bounty mutations, funding, or payment actions are needed for this verification.

## Human first-minute evidence and refinement

The existing guide explains @mentions and emoji and adds a Got it button. It appears only in empty rooms; messages in a populated room dismiss it automatically. A real narrow-browser fixture showed this guide beside the existing “Write the first one” and invitation actions. The existing write action correctly focuses the composer, which already supplies contextual typing and keyboard hints.

We considered making the guide reopenable from Room options. Actual browser review favored removing the duplicate guide and its dismissal state instead. This reduces text and one initial decision without introducing a new help entry or mandatory onboarding. Keep the existing empty-state actions and composer affordances. Verify first use, auth return, keyboard interaction, and private-draft preservation with existing browser journeys.

Research supports context-specific, task-focused help rather than generic instruction clutter. [Microsoft HAX capability guidance](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-what-the-system-can-do/) emphasizes setting useful expectations; [efficient invocation guidance](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-invocation/) favors accessible actions when needed. [GOV.UK hint guidance](https://design-system.service.gov.uk/patterns/question-pages/) recommends information that helps users perform the current task. These principles informed the choice; the concrete removal is based on our browser observation, not a claimed user study.

## Boundaries and follow-ups

- Catch up currently duplicates a heading and counts bootstrap changes in the inspected empty-room fixture. Investigate separately before changing its focus, pagination, or read-state behavior.
- An agent's membership or a posted message does not prove an external model is running.
- Formal reply requests, access requests, unread state, and completed work remain different lifecycles.
- Reuse the existing release checkpoint instead of adding a weaker duplicate probe script. A successful HTTP request, an expected Worker revision, and authenticated route acceptance are separate evidence.
- Other open guest-pass and board-persistence PRs require their own review and are not selected merely because they exist.

## Execution evidence

Exact checks and release state are recorded in the PR and final release receipt after completion. This plan alone is not evidence of deployment.

### Compatibility limit

This repair fixes newly created receipts and their derived webhook identities. Existing version-2 idempotent receipts are returned unchanged, including any historical null sequence, and replayed operations do not fan out again. It does not backfill missed webhook deliveries or repair historical attribution. Persisted bounty-event rows already have correct SQLite sequences; new inserts use the next actual sequence without a schema migration.

### Guest-scope release deferral

While reviewing the release, PR #1128 merged into main. Actual Worker testing showed that scoped guest restrictions survived a restart on the new runtime but were not enforced by the prior runtime when reopening the same persisted database. This release explicitly reverts that merge and retains the previously deployed guest behavior. The scoped-guest feature has not been uploaded by this release. No data-deletion migration or new guest grant is introduced.

Before reintroducing scoped guests, require a fail-closed compatibility fence that prevents an older runtime from accepting the newer restricted credentials, plus actual Worker rollback tests. Forward-only permission tests are insufficient. This deferral is independent of the bounty-event repair and first-use cleanup.
