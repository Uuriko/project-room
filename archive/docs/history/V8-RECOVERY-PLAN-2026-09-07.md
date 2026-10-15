# v8 recovery and release preparation

## Decision and starting evidence

Start from clean local 7075c1ddfe5ced3ae970f817dbfd0fc3e88a13b6. The preceding
checkpoint passed 361 core/API, 76 browser and seven local Cloudflare checks.
Recorded live remains application fb90a70, Worker 901be347, schema v7; no hosted
state is inspected or changed here. This is a local preparation/rehearsal slice,
not release approval. Root is sole editor; three agents research/review read-only.

Existing tests prove v7→v8 migration atomicity, old-writer fencing and current-code
restart. Existing Node online backup proves message preservation, consistency and
invitation integrity. Neither proves a compatible app switch on populated v8 data,
all user records after backup recovery, or actual Cloudflare provider restoration.
The current Node backup verifier requires v8 and cannot certify a pre-upgrade v7
copy. It must not upgrade the only backup to make validation succeed.

## Research and boundaries

Primary documentation checked 2026-09-07:

- [SQLite online backup](https://www.sqlite.org/backup.html) and
  [backup API](https://www.sqlite.org/c3ref/backup_finish.html): use the database
  backup API rather than copying a live database file. Concurrent changes can
  restart an incremental copy; identify the completed copy's actual contents,
  not an assumed invocation-time horizon. Preserve source and earlier copies.
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html):
  the existing runtime exposes the online backup function used by this project.
  Keep Node 24.19+ and existing dependencies; do not introduce another engine.
- [Cloudflare versions](https://developers.cloudflare.com/workers/versions-and-deployments/)
  and [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/):
  code/config versions do not rewind storage. Old code can fail after an application
  SQL migration; class lifecycle constraints are a different migration mechanism.
- [Durable Object SQLite PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api):
  restoration covers the whole object's SQL and KV, with a 30-day window. Bookmarked
  restore is scheduled for restart and returns an undo bookmark. Local development
  does not support this provider history, so local tests cannot certify PITR.
- [Miniflare persistence](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/#persistence):
  explicit local persistence supports application restart/switch rehearsals, not
  provider recovery. Keep the namespace/class/binding/object name unchanged.

Inference from Room's one-workspace-per-object design: data rollback affects all
rooms, identities, revocations, invitation capacity, retry ledgers, reminders and
cursors together. Post-backup revocations may disappear and previously used links
or credentials may become usable again. Lost retry receipts can make an old command
appear new. Watcher journals and external side effects are not rewound. A verified
backup is therefore not proof of current authority or permission to reopen service.

## Deliverable 1: stronger Node backup and recovery evidence

Extend the existing verifier with a read-only recovery audit: current schema/fence,
SQLite/FKs, invitation/share-link integrity, event/checkpoint→projection equality,
private reminder record/receipt relationships, and all application-table counts/
digests. Reuse current reducers and schema contracts. Never repair or migrate a
backup during verification, and never emit raw rows, messages or credential values.
Return an explicit captured-copy digest/horizon description, not a latest-state claim.

Use a new synthetic fixture with two rooms and substantive data across the 18
application tables: work/evidence, current and revoked credentials, room/account
sessions, targeted and share invitations, joins, exact command receipts, explicit
read markers, and active/cancelled/resolved per-member reminders. Include a legacy
checkpoint only through an established supported fixture, not a fabricated shortcut.

Back up through the existing API into a new private destination. Open the copy
with matching code and compare every application row at its capture. Verify exact
identities/bindings, valid/invalid access, invitation replay/capacity, command and
reminder retries, privacy, new writes and a further restart. Add later source work
and access revocation to demonstrate that an older copy omits those later changes;
never report this as current authorization. Keep source and earlier copies intact.

## Deliverable 2: immutable compatible runtime package

Create a local-only packager/verifier using explicit committed runtime files and
the existing public asset allowlist. No network, credentials, fixture state,
operator folders, databases, logs, screenshots or arbitrary directory traversal.
Require an exact commit, a fresh private output directory and regular source files.
Package Node entrypoint/source plus Cloudflare adapter/config/build inputs; retain
exact package/lock metadata and an allowlisted source manifest. Record commit/tree,
schema, runtime requirement and file digests. Finish the manifest only after all
files are complete; interrupted output is not verified. Hashes prove consistency,
not trusted provenance or publication approval.

Verify from the package without relying on the original checkout or Git. Reject
missing, changed, extra or non-regular files. Test its actual imports, public assets
and Node recovery behavior from a fresh path. Keep verification tooling outside
the application entrypoint; no deployment command is run or generated as a side effect.

Preserve exact 7075c1d as the independently identified v8 baseline. Exercise a
distinct current candidate → preserved baseline → current candidate using real
workerd with the same persistence/origin/object identity. Compare all application
rows at each switch; retain schema marker 8 and idle permit 0. Check usable reads,
new work/reminder writes and exact retries under the baseline. It is a tested local
compatible fallback, not proof it is bug-free or deployed. No v7 downgrade or
Node↔Durable Object storage conversion is allowed.

## Deliverable 3: pause before normal storage startup

Add one explicit operator environment flag, disabled by default and strictly
validated, to reject ordinary traffic before constructing/migrating RoomStore.
Use the same small maintenance response in Node and Cloudflare; no cookie,
credential, room text or internal error is exposed. No request parameter/member
permission can enable/disable it. No restore, bookmark or administration endpoint
is added. Existing names, bindings, routes and migration configuration stay intact.

Test that pause works with missing/corrupt storage, neither opens nor migrates it,
does not call bootstrap or the object binding, rejects writes and reads, and sends
no-store/Retry-After with a truthful unavailable response. Returning to normal
must still validate the real schema. Pausing new requests is not evidence that
already-admitted requests or external agents stopped; drain and verify separately.
Keep pause configuration outside data that may be restored.

## Verification, handoff and hosted gates

Run focused tests, complete core/browser/local Cloudflare regressions, exact public
asset packaging and production bundling. Inspect current browser screenshots and
the paused response. Record actual commands/outcomes, hashes, process cleanup and
any failures honestly. Root checkpoints locally and releases the coordination lane;
the broader product goal stays active.

Before any real migration, require current user approval, exact-source hosted CI,
the actual compatible fallback artifact, matching-version pre-upgrade capture,
and a separately authorized hosted disposable-object PITR→undo rehearsal. That
future drill must work while normal app startup is unavailable, retain bookmarks
privately outside the restored object, preserve exact object identity and handle
unknown outcomes by inspection, not blind repetition. Reconcile lost history,
revocations, invitation capacity, retry journals and external effects before
reopening. Do not add a privileged recovery API merely to claim that gate is met.

No push/deploy/provider admin/live migration/DNS/account/payment/Dasha/Desk changes,
no new recurring automation, and no paid compute. After this local recovery slice,
continue the reusable-outcome/template product loop under the full active goal.
