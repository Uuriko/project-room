# v8 recovery: operator contract

This is local release preparation, not authorization to change a hosted service.
Use the [plan and primary sources](V8-RECOVERY-PLAN-2026-09-07.md) and the
[checkpoint evidence](V8-RECOVERY-CHECKPOINT-2026-09-07.md) together.

## Three separate operations

| Operation | Preserves | Does not prove |
| --- | --- | --- |
| Compatible application switch | Current storage, with a tested same-schema runtime | Reversal of data changes; a bug-free fallback |
| Restore an older capture | The capture's recorded state | Latest revocations, used invitations, retry receipts or external effects |
| Pause the new runtime | Rejection of new requests before normal storage startup | Drained in-flight requests, stopped external agents or provider restoration |

Live is recorded as schema v7. The local candidate and preserved baseline use v8.
**Never point old v7 code at migrated v8 data.** The v8 Node verifier refuses a v7
capture; retain the matching v7 tooling and an untouched original pre-upgrade copy.
Do not migrate the only backup to make a verification command pass.

## Preserve and verify a runtime

`scripts/runtime-package.mjs` accepts a full 40-character commit, reads only its
allowlisted Git blobs, and creates a new private directory. It neither installs
dependencies nor reads working-tree runtime contents. Existing destinations are
refused. No tests, credentials, operator directories, data, logs or screenshots
belong in the package. A missing final manifest means incomplete output.

Local-only interface:

```text
node scripts/runtime-package.mjs create REPOSITORY EXACT_COMMIT NEW_ABSOLUTE_DIRECTORY
node scripts/runtime-package.mjs verify PACKAGE_DIRECTORY EXPECTED_COMMIT
```

The verifier itself is standalone and can be kept outside the package. It requires
no Git, source checkout or network. Preserve its trusted copy and the trusted
manifest SHA-256 separately. A matching claimed commit string is not proof of
provenance. Hashes check content consistency, not permission to publish or restored
authority. The literal-import scan is not a complete JavaScript dependency parser;
actual cold runtime tests and source review remain required.

The runtime-only package deliberately retains exact original manifests, whose test
scripts refer to excluded test files. **Do not treat `npm test` in this package as
a release gate.** Run the source checkout's actual suites. Supported packaged
operations are the Node service with explicit external `ROOM_DB`, backup/audit/
provision tools on explicitly selected data, agent read/watch tools with explicit
configuration, and the Cloudflare build inputs under separately authorized tooling.
Generate static assets outside the immutable package when verifying it; unexpected
generated files make package verification fail. No third-party production Node
dependency is required; Cloudflare tooling remains a separate locked development
environment.

## Node capture and disposable recovery

1. Select the existing source database and a private destination parent. Use
   `scripts/backup-room.mjs --db SOURCE --to DESTINATION_PARENT`. It uses SQLite's
   online backup API, never a raw copy of an active database/WAL.
2. Retain the new private capture and its audit result. Verification is read-only:
   schema/fences, SQLite/FKs, invitation/share-link integrity, projection equality
   from retained checkpoint plus tail (or full history), reminder receipt/row
   relationships, and all 18 application-table counts/digests. It performs no
   repair. A failed capture remains private for inspection; no source is replaced.
3. Rehearse on a separate disposable copy with the matching runtime. Exercise
   identities, denied access, exact retries, invitations, current work, reminders,
   read markers, a new write and a further restart. Preserve the original capture.
4. Record the capture's actual horizon and compare subsequent changes. Do not assume
   an online backup represents the moment its command began. A fingerprint is not
   proof that a missing or altered pre-capture record was historically correct.
5. Reconcile post-capture revocations, account epochs, used/cancelled invitations,
   command and reminder receipts, watcher journals and external effects before
   reopening access. Invalidate uncertain access under an approved recovery plan;
   do not silently restore old authority or replay lost operations.

The automated fixture creates real API-generated records in two rooms, including
one supported legacy checkpoint. Its deliberate operator-level damage tests are
isolated validation tests, not a repair interface or a general security proof.

## Pause and compatible application fallback

`ROOM_MAINTENANCE=1` on the new candidate returns an uncached 503 with Retry-After
before opening normal storage, running bootstrap or accessing the Worker object
binding. Only literal `0`/`1` are accepted; unset means normal mode. The configured
origin must remain valid. Ordinary users, room permissions and request parameters
cannot toggle it. No administration or restoration HTTP endpoint is added.

Pause configuration must live outside the database being restored. Drain admitted
requests and separately stop/reconcile external workers before touching data.
Readiness correctly becomes unavailable; do not route around pause to a writable
instance. Normal restart still validates real storage and refuses missing/corrupt
production data.

The exact frozen `7075c1d` v8 baseline **predates maintenance mode and ignores this
flag**. The local rehearsal pauses only the newer candidate, then deliberately
opens that older baseline on synthetic data. A real fallback to 7075 needs an
independent traffic block, or a separately preserved and tested pause-capable
runtime. Do not assume changing the flag can keep 7075 closed. Its compatibility
does not certify every possible feature or workload.

## Cloudflare gates still requiring separate approval

The local workerd rehearsal keeps the same object identity and persistence across
candidate → pause → baseline → candidate. All application rows, v8 marker and idle
write permit are checked, together with real HTTP writes/retries and explicit
store-level identity/invitation exercises. Synthetic fixture rows are injected
through a test-only wrapper; this is **not** a product Node↔Durable Object transfer
path. Never deploy any test entrypoint.

Provider PITR remains untested. Before a real migration require current explicit
approval, exact-source hosted CI, trusted fallback artifacts, a matching-version
pre-upgrade capture and a separately authorized disposable-object PITR→undo drill.
That drill must work even when normal application storage startup fails. Keep
restore/undo bookmarks privately outside the restored object; preserve namespace,
class, binding and object name. Resolve uncertain outcomes by inspection, not blind
repetition. Reconcile the whole workspace's authority and external effects before
reopening. Node availability is not Cloudflare data failover.

No current live deployment, recovery, account/provider change, payment or outreach
is implied by a passing local check.
