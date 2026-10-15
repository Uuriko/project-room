# Private inbox foundation

Blueprint U05, after the U04 design comparison. Local implementation only.
The wider product goal remains active.

## What is real

Account-owned synthetic sources, immutable source versions, saved private drafts,
and selected excerpts shared through the existing room message command. Sources
and drafts survive restart and backup. A room key, including an agent key, is
not an inbox credential. Another account cannot read the source even if both
accounts belong to the same room.

This is a service foundation, not a connected email product or a replacement
for the production interface. The separate U04 preview still uses downloadable
sample data and must not be mistaken for this account boundary.

## Contract

Every inbox operation requires the current account-session cookie and binding.
HTTP rejects bearer authorization. Writes also require the existing same-origin
and CSRF checks. Responses are non-cacheable and include account, authorization
epoch and session ownership for the future client's stale-response checks.

| Operation | Required intent |
| --- | --- |
| GET /api/inbox | List only this account's source summaries |
| GET /api/inbox/sources/:id | Read the current private source and draft |
| GET /api/inbox/sources/:id/share-context?roomId=… | Preview destination members and current audience version |
| POST /api/inbox/commands: source.save | Stable request ID, source ID, expected revision, synthetic content |
| POST /api/inbox/commands: draft.save | Stable request ID, exact source and draft revisions, text |
| POST /api/inbox/commands: source.share | Stable request ID, source revision, destination audience version, selected paragraph indexes |

Sharing checks source and audience again inside the same transaction that posts
the canonical room message and saves the private receipt. Nothing is selected
implicitly. Only selected text and a sample-excerpt label enter room history;
addresses, subject, private source ID and excluded paragraphs do not travel.
The source owner is the room-message author. No work item, agent execution,
external message, approval or payment is created.

The audience digest represents active member IDs and revisions at posting time.
It is a stale-preview guard, not a permanent audience lock: later members who
can read room history may see the shared excerpt. The integrated sharing UI must
make that consequence clear. Excerpts can themselves contain private information;
selection is an explicit disclosure, not automatic redaction.

All writes use exact-request idempotency. Changed content needs a new request ID.
An unchanged retry returns its original receipt without overwriting later source
or draft revisions. Current access is rechecked even for retries. Conflicting
drafts are rejected, not silently merged. Updating a source retains the old draft
and its original source revision. Saving blank text creates a new blank draft.

## Bounds and persistence

Synthetic adapter only; no provider credentials or provenance claims. At most
100 sources, 100 versions per source and 5,000 private commands per account.
Sources contain at most 20 paragraphs and 12,000 UTF-8 JSON bytes. Individual
paragraphs and drafts are limited to 4,000 JavaScript string characters.
Shared message text, including its label, also fits the existing 4,000-character
room limit. HTTP retains its 16 KB request limit and account write rate limit.
These are pilot bounds, not pricing or retention promises.

Schema 15 adds private sources, versions, drafts and command receipts. The writer
fence covers all 24 application tables. Migration is transactional and genuine
schema 8–14 runtimes provide upgrade fixtures. Existing writers are refused after
upgrade. Never downgrade a migrated database by merely replacing application code.

Startup and recovery verify schema definitions, replay private source/draft
receipts, compare exact retained versions and projections, and check shared
receipts against canonical room message content and authorship. This does not
reconstruct every historical authorization or audience decision. It is consistency
validation, not protection from an administrator who can rewrite the database.

Private content and historical drafts remain in the database and backups.
There is no deletion, retention policy, mailbox disconnect lifecycle or
field-level encryption added in this milestone. Do not connect real private
mailboxes until retention, backup access and operational controls are qualified.

## Qualification

- Account isolation, credential types, source/draft races and exact retries.
- Stale source/audience refusal and access revocation.
- Injected local receipt-write failure rolls back the room post as well.
- HTTP cookie/binding, CSRF and non-cacheable responses.
- Populated private source/draft/excerpt backup, read-only audit and restart.
- Genuine Node and local Workers schema upgrades, rollback and old-writer refusal.
- Existing desktop/mobile native-result and account-switch browser regressions.

Exact-commit counts and screenshots belong in the local evidence manifest.
All sources, users, messages and agent actors in these tests are synthetic.
Browser simulations do not establish human delight, retention or real delivery.

## Next: integrate one complete journey

1. Add an account-owned browser client with request receipts, stale-session
   suppression and draft conflict recovery. Never expose a private draft in
   room snapshots or the agent discovery API.
2. Connect the chosen list/detail desktop and focused mobile shell to a
   disposable synthetic inbox. Retain drafts and reading position; use compact
   contextual controls and explicit audience review.
3. Traverse source → selected canonical room excerpt → optional existing help,
   draft, exact result, independent review and human decision → private reply.
   Reuse existing work and review contracts rather than adding parallel models.
4. Prove direct replies and casual chat work without work machinery. A saved
   reply is not a sent reply. Provider identity, attachment support, uncertain
   sends, reconciliation and external authority require separate qualification.
5. Test real account switches and browser reloads throughout, capture and inspect
   screenshots, then review the whole journey for words and controls to remove.

No deployment, push, external provider, model call or money movement is part of
this checkpoint.
