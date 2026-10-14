# Actual agent exercise: deliberate work reuse

An existing independent review agent used the new client against a freshly seeded,
disposable local Room. It was not a fresh-context agent or a human participant.
The seed contained a completed fictional agenda; that completion was fixture
history, not actual prior agent execution.

The agent received a synthetic steering identity and configuration naming the
permitted worker, reviewer and human decision-maker. It read the selected definition,
adapted the next agenda using its judgment, created one ordinary proposal and
retried exactly once with the same command. No acceptance, claim, external write,
evidence fetching, compute, approval, payment or publication was permitted or done.

## Observed outcome

- Title: **Collaboration agenda for September14–20**
- Criteria: changes since the last agenda; unresolved items with one owner and
  a next check-in; decisions needing human input; three prioritized questions.
  Independent review and owner approval required; no external action authorized.
- Work ID: `weekly-agenda-3b6586ca-7559-42ce-a121-d509cefdf64d`
- Command ID: `4f2cd718-5340-42d2-9aff-1edefa14c384`
- Event ID: `e7e0cd66-262d-4791-a4a5-8656007a78f7`
- First receipt: sequence14, duplicate false.
- Exact retry: sequence14, duplicate true, same event.
- Fresh work: proposed, revision0, proposer repeat-planner.
- Explicit roles: producer / reviewer / human owner; mode read; both checks true.
- No copied source relationship, claim, receipt, verification, decision, blocker
  or history. Next action remains the accountable member's acceptance.

The agent compared source contents before/after and reported an unchanged digest.
Root independently read the resulting service snapshot: sequence14, cursor0,
three work items total, the exact new proposal and fresh state above, and original
repeat-source still completed/revision2. No human read acknowledgement occurred.

## Evidence and limits

Reproducer: `scripts/work-reuse-agent-fixture.mjs`. Root seeded the Room and was
the sole source editor; the separate agent's contribution was the API proposal.
Automated unit/HTTP/browser tests are distinct evidence, not additional real-agent
participants. This proves a narrow actual-agent reuse journey, not independent
production adoption, cross-vendor compatibility, human preference, retention lift
or referral activation.

The fixture listener was stopped after root verification, and its temporary
database and plaintext test-role configuration were removed. No credentials appear
in this record. Existing previews and historical fixtures were left untouched.
