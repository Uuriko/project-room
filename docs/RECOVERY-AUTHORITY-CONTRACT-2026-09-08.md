# Recovery authority: the missing independent source

## Finding

Current accounts, access epochs, credential/session state, invitation journals,
agent lifecycle records and member permissions are inside the same Room database.
`compare-recovery.mjs` can compare two captures, but neither is an independently
trusted statement of current authority. Signing a new copy of old data would
authenticate the signer/copy, not establish that its permissions are current.

Therefore do not add a “safe restore” flag based on matching hashes or report
exit0. Keep hosted traffic paused until current authority and external effects
are reconciled. No journal backend, key service or provider is provisioned here.

## Relevant research

[OpenFGA's consistency documentation](https://openfga.dev/docs/interacting/consistency)
distinguishes cached reads from reads that bypass the cache, and notes that an
immediate cached check can miss a recent relationship change. Our inference:
freshness must be an explicit contract at sensitive transitions. This does not
recommend introducing OpenFGA merely for backup recovery; bypassing a cache also
cannot make a historically restored database current.

The [Cloudflare and SQLite research in the comparison plan](CAPTURE-RECONCILIATION-2026-09-08.md)
establishes the different boundaries of snapshots, local application switching and
provider PITR. Whole-object restoration cannot preserve later permissions stored
only within that object. The broad search for further sources failed with a522;
the OpenFGA primary page was read directly. No unavailable search result is cited.

## Proposed contract, not implemented authority

Before implementing a recovery mutation, choose and validate these requirements:

1. A separately operated durable witness records authority changes outside the
   object being restored. Bind records to exact deployment/storage identity,
   account/member scope, operation identity and monotonic authority generation.
   A room title, local path or self-asserted label is not that binding.
2. Cover all authority-bearing paths, not only room events: account suspension and
   reactivation, credential rotation/revocation, session logout/binding, membership
   changes, invitation use/cancellation, share joins and managed-agent generations.
   Keep sensitive material private; never journal raw bearer credentials.
3. Specify atomicity and failure behavior before coding a dual write. An outbox
   can deliver evidence, but until the witness boundary is confirmed it cannot
   promise zero lost revocations after an immediate restore. A proposed grant must
   not become usable merely because one of two stores committed. A revocation
   must not silently succeed while an acknowledged recovery boundary omits it.
4. Recovery must compare against an independently trusted witness horizon, not an
   arbitrary “latest” file. Stale, unavailable, mismatched or contradictory evidence
   keeps the recovered service closed. Read-only aggregate comparisons remain useful
   for review, but do not substitute for current authorization checks.
5. Retain an operator decision and exact input/output digests outside restored data.
   Apply only a reviewed plan to a fresh disposable copy first. Preserve original
   captures. Never automatically replay missing external work or elevate access.
6. Prove failure/restart behavior across every acknowledgement boundary before
   publication: process exit, unavailable witness, conflicting generations,
   multi-room accounts, in-flight sessions and agents, expired credentials, and
   restoration before/after the captured horizon. Hosted PITR/undo still needs a
   separately approved provider exercise.

This is a substantial authority-system decision, not a reason to add another
mock badge or silently introduce a new production dependency. For the invite-only
pilot, reviewed recovery while traffic remains paused may be the simpler operating
model; unresolved current authority means no reopening. Selection of a backend,
operators and recovery policy belongs in the deployment approval.

## Prioritization

Comparison tooling is complete locally; enforced current-authority recovery is
not. Keep the release gate explicit. Continue independent product work meanwhile,
starting with focused existing-work discovery, rather than repeatedly wrapping
the same captured evidence in new manifests. No service or schema changes result
from this design note and no production protection is claimed.
