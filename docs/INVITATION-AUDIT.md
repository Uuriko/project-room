# Private invitation journal and recovery

6 September 2026. Extends invitation checkpoint `a88a0c7` on the canonical Project Room branch. The previous acceptance checkpoint remains a historical record; this document describes schema v5.

## Acceptance criteria

1. Reconstruct a new invitation's offer and final acceptance or revocation from a private append-only journal without consulting the invitation projection.
2. Commit the journal entry, relational invitation/audit changes, and any joined Room event, projection, and membership binding together. An uncertain acceptance retry adds no second journal entry.
3. Compare replay with stored authority and accepted-membership evidence; fail closed on inconsistency at startup and relevant access paths. Do not silently repair authority from a conflicting source.
4. Preserve v4 offer, audit, and Room-event bytes. Label the imported state as a migration baseline, retaining that qualification after later acceptance. Roll back a failed migration completely.
5. Provide a read-only operator audit, with no raw credentials, hashes, account IDs, or invitation contents in output. Keep private scope outside Room conversation/history.

## Storage and replay

`membership_invitation_journal` stores one initial entry and, when applicable, one terminal entry per invitation. Each body contains the complete invitation record and cumulative audit rows. Replay checks the exact schema, scope fingerprint, role policy, actor/scope relationships, transition order, audit prefix, sequence, and checksum chain. Full snapshots keep the first offer independently reconstructible; immutable-scope checks prevent later entries from widening it.

`server/invitation-journal.mjs` performs pure replay. It does not read the database, repair projections, or authorize a person. `RoomStore` then compares replay against invitation and audit tables. For accepted membership it also checks the exact joined event payload, actor/time/Room, account binding, and membership origin. Normal later permission changes or suspension remain governed by the existing membership and account authorization checks.

The journal is private because offers contain target-account identities and secret hashes. It is neither browser-served nor included in Room snapshots, conversation events, exports, or agent context. Shared history receives only the existing accepted-member event. A journal checksum detects inconsistency but cannot defeat an actor able to rewrite the entire database and its checksums. File access controls, backups, and operational trust still matter.

## Migration and recovery

The v4-to-v5 step creates the journal and append-only triggers, validates and captures each existing invitation as `legacy-v4-baseline`, and advances the schema marker in one transaction. Existing invitation rows, old audit rows, Room events, memberships, and credentials are not rewritten. A baseline is a validated snapshot of pre-existing local records, not proof of what originally happened. The audit reports how many invitations retain baseline provenance, including after a pending baseline is accepted.

The service rejects inconsistent records; it does not choose a winning copy or reconstruct authorization silently. Investigate with trusted local administration and restore a consistent backup in an isolated location. After migration, older service binaries refuse the newer schema. To roll back the application, restore the matching pre-migration backup; do not delete the journal or edit `user_version` in a live database.

The tested backup scenario closes the sole writer, copies the checkpointed SQLite database into a separate temporary location, and verifies the restored copy read-only. This does not establish a live backup strategy, recovery time objective, off-site retention, or a complete production disaster-recovery drill.

## Operator audit

```sh
npm run audit:invitations -- --db /absolute/path/to/room.sqlite
```

The command uses SQLite read-only mode and requires an existing schema-v5 database. It does not create a database, run a migration, or repair authority. Successful output contains `consistent`, `invitations`, `legacyBaselines`, `journalEntries`, and `completeJournalHistory`. The last field means no invitation relies on a v4 migration baseline; it does not mean identity is externally verified or deployment is approved. Failure emits a generic reconciliation instruction and exits nonzero without disclosing private scope.

Reproduce the focused checks with `node --test tests/invitation-journal.test.js`. They cover new issuance/acceptance/revocation replay, no-write receipt replay, write rollback, append-only storage, migration of all three statuses, failure after a baseline insert, read-only auditing, damaged membership refusal, and an isolated restored copy.

Local candidate evidence on 6 September: the journal suite passes **11/11**, the complete core suite passes **129/129**, and the existing Chromium suite passes **24/24** against the final service implementation. The browser result covers the unchanged chat/invitation UI under the new service checks. No UI code changed in this slice. Independent review of this journal candidate is pending; these automated results are not an independent PASS or release approval.

## Still open

Revocation is still revision-safe but lacks an idempotent successful replay; callers must reconcile the outcome. The operator lacks authenticated invitation-list/revoke/recovery screens. Server-managed invitation secret generation, production identity, deletion/retention semantics for private authority history, load measurement, and independent review remain open. No public release or live agent connection is authorized by this journal or its audit result.
