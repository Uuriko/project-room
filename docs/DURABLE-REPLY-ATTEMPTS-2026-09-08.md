# Durable private reply attempts

Local checkpoint, September 8, 2026. Builds on a17f005 and [provider draft qualification](GRAPH-REPLY-DRAFT-QUALIFICATION-2026-09-08.md). Schema 21; no live mailbox, network transport, sending, deployment or money.

## What changed

Project Room now retains a mailbox-draft attempt in the existing private Inbox journal. It no longer has to reconstruct the original intent from whatever draft happens to be open today. This extends the existing email → selected room excerpt → reviewed result → private reply journey without adding another task model or navigation destination.

The new service operations are deliberately not public browser or agent commands. Ordinary Inbox writes refuse them, even for the owning account; the fixture driver uses a separate internal entry point. A room credential is not private mailbox authority.

### Lifecycle

- **Reserved:** the exact account, connection profile, source version, local draft revision, reply mode and expected content are retained. A second reservation for that source is refused while an attempt remains unresolved.
- **Creation unconfirmed:** the winning dispatch transition is persisted before any potential outside call. A caller must check that the transition is nonduplicate before acting. Replaying a request returns its original receipt, not fresh permission to dispatch.
- **Created, unverified:** a correlated fixture response supplies a valid immutable provider draft ID. It is retained with the original attempt. It does not authorize a send or approve content.
- **Cancelled:** available only before dispatch. It permits a deliberate new reservation. Cancellation cannot imply that an uncertain remote action was reversed.

A missing, unavailable or unsupported provider response leaves the existing uncertain state unchanged. Repeated uncertainty observations do not add journal rows. There is deliberately no “definitely not created” shortcut based on a failed search or 404.

## Original intent and current authority

Reservation and dispatch rebuild and validate current intent. A changed source, private draft, connection or account authority prevents dispatch. The complete historical source and draft sequence is also used during journal verification, together with the retained connection configuration.

Recording a late outcome is different: it uses the original attempt's plan. Editing the draft or disconnecting the mailbox must not cause Project Room to discard evidence that an earlier action occurred. The owning account still has to authenticate. A revoked account cannot submit observations; after explicit reactivation and reauthentication, its owner can retain an outcome for the old attempt. Background reconciliation while no owner can authenticate is not implemented.

Known provider IDs cannot be reassigned between attempts for the same mailbox within the account. The recorded-draft inspector obtains the expected provider ID from the durable receipt, not from a caller-selected replacement. It compares against the retained original intent and labels that basis explicitly. A matching historical draft is not approval of the current edited reply. All results retain sending disabled.

## Recovery and compatibility

No new application table or parallel persistence layer was added. Requests and exact receipts live in private_inbox_commands. The deterministic reply transition drives both mutation and full historical replay.

Schema 21 retires old writers that cannot understand the new journal actions. Genuine v20 data is exercised through its actual archived runtime, along with older supported versions. A pre-v21 database containing colliding reply actions or attempt fields is refused rather than silently reinterpreted. Migration failures roll back the catalog and version marker.

Admission respects the existing private-journal pilot limit. Cancelling a reserved attempt and recording its one terminal creation observation remain possible at capacity. An observation conflict cannot rewrite a previous provider identity.

Local backup and reopen retain the complete journal. These consistency checks are not a claim that a database administrator cannot rewrite evidence, that provider effects can be rolled back, or that current account authority survives restoring an old backup.

## Verification scope

Focused tests cover:

- Exact receipt retries, wrong credentials, another account and unchanged room/private-draft content.
- Restart after the dispatch marker, missing acknowledgements and no automatic re-dispatch.
- Draft/source/connection/account changes before dispatch.
- Late creation evidence after local edits and disconnection.
- Account revocation and restored-owner reconciliation.
- Journal-insert rollback and capacity cleanup.
- Conflicting provider identities and receipt-bound inspection.
- Two independent database connections racing to reserve and to dispatch.
- Historical receipt tampering and pre-v21 namespace collision refusal.
- Populated local backup and read-only recovery.

The Workers fixture also reserves and dispatches, restarts its storage runtime, retries the exact marker, retains an unknown response and records a provider-shaped creation result. This is synthetic local evidence, not a real Cloudflare deployment or mailbox test.

Implementation checks passed: 16 focused journal tests, 832 core tests, 22 local Workers checks and the 242-test browser suite. The browser run began before the final share-lock refinement, so it is broad regression evidence rather than an exact-version certificate. The refined delayed-refresh tests also pass independently. The standard recovery fixture now includes an uncertain reply attempt, so subsequent version-upgrade checks retain this state too. Final committed-version checks are recorded below when complete. No new reply-attempt UI is claimed.

Local logs and inspected desktop/mobile screenshots are retained in test-results/reply-journal-20260908, including the initial browser failure and controlled before/after navigation checks. They contain disposable synthetic data only. Existing source files under the project mirror's sources directory were not changed.

### Browser defect found and fixed

The first focused browser run passed 46/47 checks but timed out returning to an email on desktop. A standalone retry passed, so the timeout alone did not establish a cause. Code inspection found an asynchronous navigation race: successful sharing started a room refresh, then its late completion called revealMessage even if the user had already returned to Inbox.

A controlled test held that room response, navigated back to Inbox, then released it. Both desktop and mobile failed before the fix. The share callback now carries a navigation-ownership check, invalidated by a newer destination, reset or room detachment. Late completion can update room data but cannot steal the newer Inbox view or place a stale room error there. Both controlled tests pass after the fix. The tests also now exercise a second completed share before releasing the earlier room refresh: a confirmed share no longer leaves the next one locked behind that refresh, and an older callback cannot clear a newer share's busy state. Fresh screenshots were inspected; this changes behavior, not layout.

## Limits and next work

This is durable coordination infrastructure, not an executing email client. No code here calls a mailbox provider. A future driver must honor the single winning dispatch transition; no client request ID is assumed to deduplicate remote creation.

An unresolved attempt blocks another creation for the same source, including a known-but-unverified remote draft. Later review, explicit remote-draft disposal or send reconciliation must define how that block is released. Do not add a generic “reset attempt” that silently permits duplicates.

Provider comparison is currently a private read, not a durable approval record. Remote drafts can still change after inspection. Shared/delegated mailboxes, account-wide cross-connection ownership, HTML, attachments and provider-specific concurrency semantics need separate qualification.

Next implementation order:

1. Persist the exact observed draft/review version and invalidate it when the remote draft changes. Keep quality review separate from sending authority.
2. Add an opt-in, local fixture driver and compact status/review controls in the existing composer. Exercise both a direct reply with no work item and the room-assisted route. Avoid a new dashboard.
3. Verify concurrent tabs, late responses, restart and revocation through that interface; capture screenshots plus journal evidence.
4. Only after separate authorization, qualify a dedicated mailbox read-only, then draft-only. Resolve the documented create-response ambiguity and actual quoting/recipient behavior.
5. Qualify sending separately, including uncertain outcomes and the remaining concurrent-edit race. A pre-send read alone is not an atomicity guarantee.

The broader product goal remains active: actual authorized messaging, bounded execution, rewards, growth and release readiness are not completed by this checkpoint.
