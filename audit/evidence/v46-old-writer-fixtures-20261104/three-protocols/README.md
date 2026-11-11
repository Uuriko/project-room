# Historical protocol controls under schema 46

Test-only source: `9c95524ac`. No archived source is changed or taught to support schema 46. The three original genuine protocol cases failed before this repair; all 12 tests in their files pass afterward.

The exact failures are in recovery-invitation-protocol (protocol 15), recovery-report-protocol (18), and restore-postpublication-cleanup (16). The initial assignment named the first two differently; the failing log identifies these files.

Cold schema-45 constructors now explicitly reject the newer schema. The old invitation prepared credential writer explicitly lacks project_room_writer_v46. Independent current-schema prepared writers still reach and refuse the restore seal/control mutation. Existing warm old-protocol checks, zero guard drops, unchanged durable state, compatible continuation, cleanup rollback/cold/exact retry and corruption tests remain.

Qualification uses only temporary copies of Root's three restore modules, hashed in qualification.json; those modules are neither committed nor included in this evidence. Node evidence is not Native Worker qualification.

Commands:
```sh
/Users/johnpotter/.local/bin/node --test --test-concurrency=1 --test-name-pattern='genuine' tests/recovery-invitation-protocol.test.mjs tests/recovery-report-protocol.test.mjs tests/restore-postpublication-cleanup.test.mjs
/Users/johnpotter/.local/bin/node --test --test-concurrency=1 tests/recovery-invitation-protocol.test.mjs tests/recovery-report-protocol.test.mjs tests/restore-postpublication-cleanup.test.mjs
/Users/johnpotter/.local/bin/node node_modules/eslint/bin/eslint.js tests/recovery-invitation-protocol.test.mjs tests/recovery-report-protocol.test.mjs tests/restore-postpublication-cleanup.test.mjs
```

Lint and diff check pass. Before and after logs are compressed with raw-byte SHA-256 digests. No providers, credentials, production calls, runtime changes or performance claims.
