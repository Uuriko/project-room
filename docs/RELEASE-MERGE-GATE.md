# Required landing gate

GitHub currently reports `Uuriko/project-room` as a public **User-owned**
repository. Native GitHub merge queues are available for organization-owned
repositories, so this slice uses the existing durable `MERGE-SLOT` claim and a
required commit status instead of assuming a native queue or creating another
work engine. Availability: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue.

The additive branch restriction is `room/release-lease`. Until the landing
coordinator authorizes one exact head, ordinary UI/API/CLI merges fail GitHub's
required-status gate. Existing required checks, their GitHub App bindings,
strictness and all other branch protection settings stay unchanged. No new
credential, membership, GitHub token permission or deployment is needed.

## Install the restriction

Use the existing maintainer `gh` authentication. Inspect the concrete plan first;
`--apply` is the only mutating mode. Store journals outside the checkout.

```
node scripts/release-merge-gate.mjs install --state /absolute/private/install-plan.json
node scripts/release-merge-gate.mjs install --state /absolute/private/install-plan.json --apply
```

The script reads protection, preserves all existing required contexts and App
bindings, adds the new status, and verifies the result after PATCH. It changes
only required-status-check settings, never disables admin enforcement or adds a
bypass. An unexpected protection shape refuses installation.

## Native pause and exact grant

Reuse the work-claims UI/REST/MCP for both records; there is no new queue endpoint.
`RELEASE-PAUSE` is a durable coordination claim with no file ownership. While
claimed/in progress/blocked, its claim note is JSON:

```
{"kind":"room.release-pause.v1","directiveMessageId":"CURRENT_OWNER_PAUSE_MESSAGE_ID"}
```

Give this pause a non-expiring lease (`leaseHours:null`). Only the owning landing
lane releases it after the ruling's live-smoke condition is met. Missing,
malformed or terminal pause state fails closed; a released pause is `unclaimed`.
Existing prose rulings remain authoritative while this restriction is prepared.

Immediately before landing, claim `MERGE-SLOT` with the ordinary lease API and
an exact JSON note (full forty-character SHAs):

```
{"kind":"room.release-merge.v1","repo":"Uuriko/project-room","pr":123,"head":"FULL_PR_HEAD","base":"FULL_CURRENT_MAIN","purpose":"deploy-fix","directiveMessageId":"CURRENT_OWNER_PAUSE_MESSAGE_ID","workClaimId":"SOURCE_CLAIM","problemKeys":["release:landing"]}
```

The holder must match the existing Room connection used by the coordinator,
with at least two minutes left. During a native pause, only `deploy-fix` under
that pause's current directive passes; after release, `normal` is allowed.
`problemKeys` checks existing live claims and names any other holder. Resolve
conflicts or record supersession using the existing claim lifecycle before
retrying. This consumer supports the optional durable `problemKey` carrier;
it does not invent that field's persistence or silently infer keys from prose.

## Land one head

```
node scripts/release-merge-gate.mjs merge --pr 123 --head FULL_PR_HEAD --base FULL_CURRENT_MAIN --connection EXISTING_CONNECTION_FILE --state /absolute/private/merge-attempt.json
node scripts/release-merge-gate.mjs merge --pr 123 --head FULL_PR_HEAD --base FULL_CURRENT_MAIN --connection EXISTING_CONNECTION_FILE --state /absolute/private/merge-attempt.json --apply
```

Dry-run reads current PR/head/base, all actual required checks, pause, collision
claims and lease. Mutating mode rechecks, publishes success for **only that
head**, rechecks again, submits GitHub's SHA-matched merge, and revokes success in
`finally`, including after an uncertain status/merge response. The maintainer
still performs the required independent exact-head review before invoking this.
Another open head with a leftover success status refuses authorization. A changed
head, changed base, changed holder/generation, expired lease, draft, missing or
pending check, or unresolved problem collision stops the merge. Release the Room
slot with its current timestamp/history preconditions after recording the result.

## Recovery and limits

Every GitHub write's exact path/method/input is journaled before execution.
Reusing a mutation journal for a new operation is refused. After interruption,
read GitHub's actual PR/merge state, preserve the journal, and revoke that exact
head before doing anything else:

```
node scripts/release-merge-gate.mjs revoke --pr 123 --head FULL_PR_HEAD --base FULL_CURRENT_MAIN --state /absolute/private/merge-attempt.json --apply
```

This is a required **landing authorization** status, not a continuously evaluated
GitHub lease. A hard process kill between publishing success and revocation can
leave the selected head green until the coordinator reconciles it. GitHub statuses
do not automatically expire with Room leases. Do not call this complete
server-side lease fencing or retire owner pauses based solely on installation.
The guarded coordinator checks lease expiry immediately before its merge;
interrupted journals require recovery, and other stale authorizations block the
next landing. No heartbeat daemon or new write-capable Actions token is added.

Repo administrators with shared credentials can change protection or publish
statuses themselves. This restriction prevents accidental direct merges by
requiring an explicit landing authorization; it cannot distinguish seats sharing
one maintainer identity or prevent deliberate administrative bypass.

Do not remove the current pause or dispatch production as part of installing
this check. The production lane and its verified-smoke release condition remain
separate. The existing `merge-queue-worker` and unmounted in-memory queue are not
made authoritative by this slice.
