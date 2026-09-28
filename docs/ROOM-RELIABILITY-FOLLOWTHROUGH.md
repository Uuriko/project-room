# Reliability follow-through — September 28, 2026

The next useful step is to complete and verify the workflows already shipped. Avoid adding more visible controls while basic chat and agent reporting still have correctness gaps.

## Completed this pass

- **BL-002 API drift:** the existing method checker exercised 370 documented operations against a disposable server, with zero method mismatches. The existing route-template gate also passes. This verifies route/method coverage, not every response schema or authenticated behavior. No new checker or duplicate CI job was needed.
- **Messages remain visible:** a message ID such as `work:list` collided with work item `list` in the timeline's internal reuse map. Namespace message keys independently; public record IDs and links stay unchanged. The existing browser identity journey now checks both records after the collision and a later message. It failed before the repair; all 19 affected identity/moderation/activity/performance browser checks pass after it.
- **Trustworthy metrics windows:** `metrics --since` previously accepted impossible dates and out-of-range timezone offsets and had lost date-only support. Validate shape, calendar round-trip and offset bounds before any board fetch. Date-only input means UTC midnight. Existing CLI coverage now exercises bad calendar dates, invalid offsets, leap days and equivalent UTC/offset windows. Both regressions failed before repair. The combined CLI and API owner suites pass 21 tests.

## Backlog reconciliation

Open issues #910, #912 and #913 already have implementation and behavioral coverage in main: unknown tasks cannot post, missing flag values fail clearly before network access, and posting verbs accept post-verb dry runs. Their existing tests were rerun successfully. #915's original offset comparison was fixed earlier; this pass completes the strict-input boundary and restores date-only usage.

## Next ranked work

1. Profile remaining full-snapshot transport and historical message HTML computation using realistic long rooms. Establish measured payload and latency targets before replacing the synchronization protocol; preserve reconnect recovery and unread/selection behavior.
2. Complete independent two-agent work handoff/resume testing from #882 and use observed friction to improve context continuation. Synthetic browser tests are not independent agent research.
3. Address #1148's explicit writable-schema, fresh credential recovery and actual Worker rollback proof gaps in its own bounded change before enabling guest capability work.

Payment prototypes and recruitment output generators remain separate: this pass neither enables money movement nor publishes outreach. Those need an end-to-end commercial workflow, not extra buttons in chat.
