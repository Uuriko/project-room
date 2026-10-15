# Capture reconciliation — operator tooling and next recovery plan

## Decision

Keep consistency, comparison and permission to reopen as three separate decisions.
The existing audit verifies one captured database. The new offline comparison
identifies differences between two audited captures. Neither proves that either
capture contains current authority, and neither repairs or reopens anything.

The concrete next release-preparation step is a usable read-only operator command,
not a restore button in the room UI. This leaves the product interface unchanged.

## Research checked September 8

[Cloudflare's SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
states that PITR restores the whole object's SQL and key-value contents, is not
supported in local development, and schedules restoration for restart. It returns
an undo bookmark. Therefore the tested local application switch is not PITR proof.
Our design inference: pause controls and trusted recovery evidence must remain
outside the restored object's history.

[SQLite's online backup documentation](https://www.sqlite.org/backup.html)
describes consistent snapshots and restart behavior when concurrent writers change
the source during copying. Our design inference: use the actual captured content
and provenance, not the time a shell command began, as the comparison horizon.

Neither source establishes Project Room's current permissions or external effects.
Those require independently retained evidence and an explicit operator decision.

## Implemented interface

From the canonical source checkout, with Node24:

```text
node scripts/compare-recovery.mjs --older OLDER_CAPTURE --reference REFERENCE_CAPTURE
```

Both paths are required. There is no environment fallback, implicit live database,
repair option, remote endpoint, public report upload or credential authentication.
The command rejects nonexistent files, the same file through an alias/hard link,
unsupported schemas and failed existing audits. Each input opens read-only and is
inspected within its own stable transaction. These are not two simultaneous reads
of one global clock: prefer closed, privately retained online-backup captures.

The report contains:

- Both full-data digests and counts, linking results to the inspected captures.
- Added/removed/changed row counts for every one of the20 application tables.
  Direction is older → reference; a removal means absent from the reference.
- Exact retained event-prefix comparison per room, aggregated as equal, extended,
  divergent, missing and added room counts. Sequence/time alone is insufficient.
- Membership authority changes inside room projections, plus an access-difference
  flag covering accounts, credential/session state, account bindings, invitations,
  share links and managed-agent lifecycles and their receipts.
- Required review of provenance, authority horizon, expiry, current work/approvals,
  retries, external effects, separate observer journals and in-flight operations.

No record identifiers, names, tokens, credential hashes, paths, messages, results
or row values are emitted. Treat even aggregate counts and digests as private
operational evidence; this is not an anonymization guarantee.

Exit codes:0 means a completed comparison with no stored differences;2 means a
completed comparison requiring difference/history review;1 means unavailable or
invalid input. **Every report has `reopenAllowed:false` and
`authorityFreshness:"unproven"`, including exit0.** No deployment/restore tooling
is wired to these codes. Never treat exit0 as service-reopening approval.

It is intentionally a source-checkout operator tool, excluded from the immutable
runtime package. Existing candidate c2dd593 and fallback4d22189 remain unchanged.

## What this proves and does not

Eleven local synthetic cases exercise equality, content and exact-retry deltas,
revoked sessions/invitations without new room events, account suspension, member
access changes, managed-agent disconnects, elapsed time without stored changes,
reversed/forked history, added/missing rooms, CLI input/exit behavior and schema
refusal. Successful comparisons preserve both input database files byte-for-byte;
schema refusal does not migrate either input. All547 core/API/package tests passed,
including these11 cases. All65 runtime files still match candidate c2dd593's
retained manifest. The prior170 browser,13 Workers runtime,one Workers browser and
two browser fallback checks were not rerun: no runtime/UI files changed. There are
no new screenshots for this command-line-only tool. Whitespace checks passed.

The tool reports conservative differences, not a safe merge or minimal revocation
set. It cannot establish source provenance, global storage identity, subsequent
changes, external jobs/payments/publication, expired authority, or a newer source
that was never preserved. Matching historical events do not establish a shared
trusted origin. Missing or divergent history must not be automatically replayed.
The implementation loads audited records in memory; it is offline pilot tooling,
not a streaming large-database service or real-time authorization fence.

## Next implementation and operational gates

1. **Now — comparison and review.** Use independent private captures to inventory
   differences while the selected service and agents remain stopped. This tool is
   complete locally; no real capture or live room has been selected or processed.
2. **Next — explicit recovery authority contract.** Define a trusted external
   source of current identity decisions, its ownership and failure behavior before
   implementing a mutation. If current authority cannot be established, remain
   closed; do not select whichever capture grants more access. Define handling of
   cross-room accounts, credentials, invitations and agent generations together.
3. **Next — reviewed recovery application.** Choose between preserving recoverable
   current state and invalidating uncertain credentials under an approved plan.
   Any future apply tool must target a fresh disposable copy first, pin both input
   digests, reject changed inputs, preserve original captures, journal decisions
   outside the restored store, avoid replaying external work, and prove restart,
   stop and exact-retry behavior. No automatic row-copy merge is planned.
4. **Approval gate — hosted PITR/undo.** Obtain current approval and use a disposable
   hosted object, exact namespace/class/binding identity and independently stored
   restore/undo evidence. Verify operation while normal storage startup is broken.
   Reconcile all access and effects before any real service reopening.
5. **Later — operator ergonomics.** Consider a private, deliberately requested
   record-level review artifact only if aggregate reports are insufficient. Never
   place credentials or room content in ordinary logs or public reports.

No product UI/runtime/schema changes, models, payments, push, deployment or provider
operations occurred. The quiet-attribution candidate remains the retained runtime;
this adds meaningful recovery preparation, not production recovery certification.
