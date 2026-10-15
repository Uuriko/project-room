# Reviewed room result → private draft

Local implementation checkpoint for U06. This extends the account-owned Inbox/Rooms flow; it does not implement sending or complete the broad product goal.

## User journey

1. Open a private synthetic inbox message and deliberately share selected paragraphs with a room.
2. Room work references that shared message. The inbox shows related work in place, without a separate dashboard.
3. A native text result with an explicit independent passing review and current human approval offers **Use result**.
4. Preview the exact reviewed text. An expandable section shows the draft it will replace; the action clearly says nothing will be sent.
5. **Use as draft** copies the selected result into the account-owned private draft.
6. Editing retains its historical origin but labels the text **Edited since room review**. Saving an empty draft ends this lineage.

Ordinary conversation and direct private drafting do not require work, review or approval. This stricter gate applies only to the reviewed-result adoption path.

## Contract

The server, not a client-supplied body, chooses the adopted text. The selection digest pins the shared source revision, share request and room message, work revision, completion, evidence digest, independent verification and human decision. Unrelated room conversation does not stale the selection.

Adoption requires current account ownership, account-room authority, the exact prior source share, current source/draft revisions and the selected result version. Changed source, draft, result or review requires a fresh review. Rejected, superseded, externally linked, unreviewed or over-4,000-character results cannot be adopted through this path. Long results are not silently truncated.

The existing private command journal records the adopted body and provenance, including the room sequence. Exact retries recover the original receipt without overwriting a later draft. Browser uncertainty uses **Confirm save** with that same operation, not a second adoption. Pending draft operations remain in-tab; source-sharing recovery retains its existing session-scoped metadata behavior.

Browser previews and adoption receipts verify the text and selection digests. Account changes clear private views and invalidate in-flight responses. Private reads remain account-only and do not use agent transport.

Historical audits reconstruct the room at adoption time, use only preceding source shares, and verify the receipt and projected draft. This is consistency checking, not protection against an administrator rewriting the database and all evidence together.

## Storage and implementation

Schema 16 adds no tables. Its writer fence prevents older schema-15 writers from processing a journal containing the new adoption action. Both Node SQLite and local Workers cover upgrade, rollback, old-writer refusal and restart. Recovery fixtures now populate an adopted reply and preserve its exact retry and lineage in cold-package verification.

Core paths: server/inbox.mjs; server/store.mjs historical replay boundary; server/http.mjs account endpoint; src/inbox-client.js validation; src/inbox-ui.js contextual results and private adoption.

## Qualification

Candidate core suite: 709 passed. Inbox browser suite: 13 passed, including desktop/mobile adoption, edited provenance, stale review, unknown acknowledgement and mismatched preview content. Desktop and mobile screenshots were visually inspected. Candidate and exact-commit evidence are retained separately; consult test-results/reviewed-reply-* for final committed-version counts.

The initial expanded Workers fixture correctly refused a producer without accept_work; the fixture was corrected to grant only producer accept/complete and reviewer verify permissions. This was not a runtime permissions relaxation.

All sources and actors are synthetic/scripted. Tests do not establish real human usability, independent agent reasoning, retention or external provider compatibility.

## Remaining scope

- Synthetic send ledger and uncertain delivery reconciliation, before real email.
- Provider authorization, send identity, receipts and reconnect behavior.
- Opt-in sample journey for empty accounts and an account home independent of a selected room.
- Actual supported-agent connection and contribution qualification.
- Related-result pagination if real room volume warrants it; current results use existing room/journal bounds.
- Execution, payments, discovery, growth and other blueprint milestones.

No live deployment, external message, model execution or payment is part of this checkpoint.
