# Provider reply drafts: research, decisions and implementation

September 8, 2026. Local fixture qualification only. Builds on `d852d5c` and the email excerpt checkpoint. This is not an enabled mailbox connection, a send service, a release certificate or permission to access an account.

## Decision

Finish one coherent journey before adding more channels: private email → deliberately shared excerpt → existing room work → reviewed result → private reply. The next missing boundary is what happens when that private reply becomes a provider-owned draft. Keep Inbox/Rooms as the product, not a new email automation dashboard.

The useful simplification is one canonical work lifecycle and one private reply, with explicit transitions. It is not collapsing every intermediate state into “Done.” Saving locally, creating a mailbox draft, approving its observed content and sending are different operations.

## Research that changes the implementation

### Draft creation is an external write

Graph's create-reply operation requires Mail.ReadWrite. Its JSON contract allows either a comment or a message body, not both, and distinguishes reply creation from later sending. Reply-To determines the reply destination when present. Consequently, a local Save must not silently create a remote mailbox item. [Create reply](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0).

Reply-all is a distinct operation with Mail.ReadWrite and its own recipient semantics. The response section documents 201, while its abbreviated JSON example shows 200. The reply documentation contains the same discrepancy. This fixture implementation conservatively recognizes 201 as created-but-unverified and leaves 200 unresolved; this is a qualification choice, not a claim that Microsoft never returns 200. An authorized test must resolve it. [Create reply-all](https://learn.microsoft.com/en-us/graph/api/message-createreplyall?view=graph-rest-1.0).

### Identity survives some moves, not every transformation

Graph immutable IDs are case-sensitive and require the preference header on each request. They remain stable across folders within a mailbox, with archive/export-and-reimport exceptions. Microsoft documents looking up a sent copy with the saved draft ID, but notes that it may not appear immediately. Keep opaque IDs and mailbox scope together; an empty lookup is not evidence permitting another create or send. [Immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

### Review must cover the provider's actual draft

Graph permits updating draft recipients, subject and body; omitted properties can remain or be recalculated. Our design therefore reads the provider's actual draft and compares it with the exact local intent. Provider-added quotes, a changed subject, extra recipients or uncertain attachments require review rather than silent correction. The inspected reference does not establish an atomic conditional-send guarantee. A changeKey or a last-second read alone must not be advertised as preventing concurrent mailbox edits. [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0).

### Accepted is not delivered

Sending an existing Graph draft requires Mail.Send and returns 202 with no response body. That is separate authority from mailbox-write permission. [Send draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0). Microsoft's process overview describes later transport processing and delivery outcomes. Project Room should display only the evidence it has, never turn HTTP acceptance into a delivery claim. [Send process](https://learn.microsoft.com/en-us/graph/outlook-things-to-know-about-send-mail).

## Implemented now

`server/graph-reply-draft.mjs` adds a small, private service-level qualification boundary. It uses existing account authentication, email normalization and recovery-compatible storage reads. No new database, schema version, network client, public endpoint or user-interface control was introduced.

1. **Prepare:** build a credential-free provider-shaped request from the current saved local reply. Bind account authority, connection profile, source identity/version, draft revision, reply mode and expected content. Fixture connections only; execution and sending are false.
2. **Revalidate:** rebuild from current authenticated storage and compare the whole plan. A digest is not authorization. Edited drafts, changed sources, disconnected accounts and tampered plans cannot silently reuse old intent.
3. **Observe creation:** classify a scoped response with an immutable provider ID as created-but-unverified. Missing responses and unsupported/malformed responses remain unconfirmed. No result authorizes repeating creation or sending.
4. **Inspect:** normalize a fully observed provider draft and compare its identity, draft state, thread, sender, from, separate recipient groups, subject, plain-text body and complete empty attachment inventory. CRLF/LF differences are equivalent; subject prefixes and quoted text are not silently erased. HTML is not rendered or returned as an actionable body.
5. **Version review:** tie the comparison to the complete observed source version, including provider revision. Identical visible text with a changed revision still produces a different review version.

The exact runtime allowlist includes the module. The disposable candidate-package builder now includes it too: the initial cold-package test exposed that omission, which is fixed. Candidate packaging is test evidence, not release provenance.

### Limits that must remain explicit

- These helpers are not a durable attempt journal. They cannot prevent duplicate writes across process crashes because they do not perform or persist writes.
- The provider draft ID supplied to inspection is not yet supplied by a persisted, authenticated creation receipt. Content equivalence is not proof of that association.
- All observations are invented fixtures, not recordings from a real account. No provider's actual behavior has been qualified.
- There is no OAuth/token storage, account consent UI, provider transport, remote draft patch, send endpoint or retry worker here.
- All outputs retain `canSend: false`; `content_matches` is deliberately not named `approved` or `ready_to_send`.
- This does not add HTML, attachments, shared-mailbox delegation or sovereign-cloud support. Unsupported variants need separate qualification.

## Product choices

**First provider candidate:** qualify Microsoft Graph next because the repository already has its import envelope and offline sync driver. This is a sequencing choice, not a permanent exclusivity decision or authorization to use an existing personal mailbox.

**Free core:** conversation, manually shared sources, local drafts and portable contribution remain useful without a paid model or connected email. Hosted help stays optional.

**Agent access:** room helpers work on the selected excerpt and existing work item. Do not give them the requester's entire mailbox or private reply merely because they contributed to a room.

**Interface:** one reply composer. Show account and recipients where they affect the action. Expand differences only when something changed. Preserve draft text through refresh, uncertainty and reconnect. Avoid a permanent “provider drafts” navigation destination.

**Action labels:** future draft creation must say it creates a mailbox draft; local save must remain local. After an uncertain external write, offer checking/reconciliation instead of a cheerful Retry that may duplicate it. These are proposed controls, not implemented UI.

**Breadth:** richer messaging, execution and rewards remain on the blueprint. They should reuse source, artifact, review and authority concepts once this journey proves them. Do not build three competing approval or status systems.

## Next implementation plan

### 1. Durable remote-draft attempt record

Reuse the account-owned private journal, but define a provider-specific operation contract rather than forcing opaque Graph IDs into the synthetic send schema. Before editing storage, map replay, migration and historical-writer checks.

Record the exact local intent, account epoch, connection revision, request identity, attempt identity and state. Reserve atomically, persist the uncertain/in-flight boundary before transport, then persist the correlated response and provider ID. An attempt record must survive the local source or draft changing afterward: later evidence still needs recording even when new execution is no longer allowed. Current helpers require current intent, so durable reconciliation will need a separate historical-attempt authority path.

Acceptance: duplicate reservations, restart before/after the outside call, lost responses, disconnect while in flight, edited source, edited draft, late evidence and old-writer recovery are all exercised without a network. No automatic re-create after an ambiguous outcome.

### 2. Exact provider review

Read only the ID bound to the creation attempt and connection. Persist the observed version and full recipient/body/attachment comparison privately. Require an explicit review of changed content. Do not guess identity by subject or approximate body matching. If a provider changes the draft again, invalidate the old review without deleting its history.

Acceptance: receipt/ID substitution fails; additional Bcc, changed sending identity, quoted private history and incomplete attachment observations cannot be called equivalent. Revocation prevents new work while retaining evidence of earlier effects.

### 3. Draft-only interface qualification

Mount the fixture driver behind an explicit local test capability. Use the existing composer and compact status area. Test a casual direct reply that creates no work item, plus the shared-excerpt collaboration route. Capture desktop/mobile screenshots and actual persisted state. Simulated users can expose friction but cannot establish retention or delight.

Acceptance: reload, switching rooms/accounts, competing tabs and uncertain outcomes preserve text and identity without adding navigation clutter. An agent's room credential cannot read the private attempt.

### 4. Dedicated authorized mailbox

Only after separate authorization: configure a dedicated test account, consent to the narrow initial capabilities and qualify read-only import before draft creation. Observe actual create status, response identity, reply quoting, signatures, threading, attachment completeness and delayed reads. Keep live sending disabled.

Acceptance: record real provider evidence privately with minimal data retention; update fixtures without copying credentials or personal content into the repository. Resolve the 200/201 documentation discrepancy and concurrent-edit behavior explicitly.

### 5. Separately authorized send trial

Only after the durable journal, identity binding, exact review and provider concurrency semantics are qualified. Use a recipient allowlist and bounded trial. Determine whether a suitable atomic provider condition is supported; if not, document and test the remaining race and choose an explicit restriction before exposing sending. Never label a simple read-then-send as race-free.

Acceptance: uncertainty is reconciled without blind resend, acceptance remains distinct from delivery, disconnect does not erase an in-flight outcome, and support can inspect the private attempt history. General mailbox support also needs operational recovery, consent, retention and credential lifecycle review.

## Verification

Verification on the edited local runtime:

- 18 focused reply-draft tests passed: account isolation, stale/tampered plans, missing outcomes, changed provider content, provider scope/identity and reopening the same saved reply through a cold allowlisted package.
- 815 full core tests passed with syntax checks. The preceding run passed 814/815 because the candidate package count still expected 79 files; the added module makes 80. Updated both candidate and exact-commit inventory expectations, then reran the entire suite successfully.
- 1 local Workers shared-store scenario passed, including preparation, process restart, exact plan revalidation and an unresolved creation outcome. This verifies the shared preparation code on Workers, not the entire provider-inspection matrix there.
- No UI code changed. Browser tests were not rerun and no new screenshot is claimed; the previous email excerpt UI evidence remains historical.

Logs are retained locally under `test-results/graph-reply-20260908/`, including initial failures rather than only successful reruns. The core command was `node scripts/check.mjs`; the focused command was `node --test tests/graph-reply-draft.test.js`; Workers used `node --test store.check.mjs` from `cloudflare/`. All used the bundled Node 24 runtime. No actual mailbox was accessed.

The ambitious product goal remains active and incomplete. Nothing in this checkpoint establishes a live mailbox, deployed revision or production-ready messaging service.
