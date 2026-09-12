# Online import safety checkpoint

Isolated identity-scope branch, parent `770c733`. No canonical/Grok edits,
production data access, restore, or deployment.

## Immediate boundary

The authenticated HTTP import route now returns `409 recovery_requires_maintenance`
without reading/parsing the replacement history or calling the legacy importer.
Anonymous requests still fail authentication. All normal room auth/write/CSRF
checks precede this refusal. Export remains available to authorized members.
The OpenAPI operation is deprecated and documents refusal rather than success.

The previous behavior could rewrite events while retaining authority in separate
tables. Invitation audit triggers also make invitation-bearing imports fail.
Disabling online replacement prevents that path; it does not fix recovery.

## Evidence

11 focused export/auth-contract tests pass. Coverage includes unchanged exports,
malformed data, duplicate events, a 1,500-message export, preserved cursors and
projection checkpoints, owner/member refusal, anonymous denial, and a stale export
captured before revocation. A sentinel verifies HTTP never invokes importEvents;
the revoked credential remains unusable and serialized room state is unchanged.
Existing online-success tests were updated because that operation was removed,
not skipped. `git diff --check` passed. `node scripts/check.mjs`: 1,165 passed,
zero failed/cancelled/skipped; test duration 41,961 ms.

## Recovery still required

`RoomStore.importEvents` remains an internal legacy helper, not an approved restore
tool. No current client/script/HTTP call site invokes it (source search performed).
Do not use it as a shortcut around the HTTP refusal.

A qualified replacement must restore into fresh isolated storage under maintenance;
retain source evidence; compare an external monotonic authority witness; reconcile
membership, accounts/sessions, credentials, invitations, identities/links, shares,
guest-agent links, provider bindings, cursors and checkpoints; invalidate or rotate
affected secrets; and require explicit operator approval before cutover. A room
event export alone cannot supply all of that evidence. Corrupt/old snapshots,
concurrent writers, rollback and post-restore denial must be independently tested.

Grok's G3 probe is a local review artifact using the isolated store. Its revocation
case exports after revocation, not before, so it cannot establish stale-snapshot
safety. The invitation case reproduces append-only failure; neither passing probe
counts as a successful operational restore.
