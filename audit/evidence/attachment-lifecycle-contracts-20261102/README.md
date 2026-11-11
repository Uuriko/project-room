# Attachment quota and committed-delete contract reconciliation

Source `4c75f889e6720cd22693ce1e080c57d3c00b99a0`, isolated from `a2a4e31b4b4f911e541ca648ec418c1cd1fd52b2`. Test-only changes; no attachment/runtime/schema/permission modification. No deploy, real account mutation or production request.

The assigned baseline had 17 tests, 12 pass and five fail (exit 1). Each failure was raw SQL setup of a legacy fixture in a room now normalized by AgentRooms.create; the existing current writer guard correctly refused it. The three room-record quota fixtures and two initial committed-delete fixtures now use the existing explicit historical initializer. Every original test case and quota/private/missing-message assertion remains. The legacy expired-row test now advances an injected clock instead of rewriting expires_at, and still checks the exact 4,096 expired-row precondition before staging again. Existing legacy expire-on-list compatibility is preserved.

Current production contracts are added separately:

- Default AgentRooms.create normalized room: 32 real staged files enforce staged quota. A raw old UPDATE still refuses. After clock expiry, download returns unavailable without mutating staged bytes. A successful stage performs the existing guarded expiry, releases all 32 slots, and leaves the permit closed.
- Default normalized room: 4,096 actual stage/discard pairs followed by 4,096 actual stage/commit pairs. Terminal history does not use quota; live committed rows do hit room_files. Deleting one committed file permits another upload. No raw INSERT or opened permit creates these fixtures. This finite control took 26.47 seconds locally; it is a correctness test, not a Worker/production performance claim.
- Both legacy and code-owned normalized representations: two real uploaders commit 16 MiB, exactly filling room byte quota. Advancing beyond staging deadlines and explicit expiry preserves committed files. Another upload refuses room_bytes; uploader deletion is idempotent and reclaims capacity; owner deletion of a visible file reclaims bytes. Public nonowner deletion remains forbidden. Private file get/delete and terminal retry remain not-found for nonparty owners/observers.

Actual commands and results, `/Users/johnpotter/.local/bin/node` v24.22.1:

- `node --test tests/room-attachment-quota-ratchet.test.js tests/room-attachment-committed-delete.test.js`: **21/21 pass, zero skip, exit 0**, 27.04 seconds observed host elapsed.
- `node --test tests/room-mcp-files.test.js tests/current-attachment-lifecycle.test.mjs`: **19/19 pass, zero skip, exit 0**. Includes inherited current source proof-missing denial, since-join/all-history HTTP/MCP controls, interrupted-save rollback and guarded lifecycle/account erasure.
- ESLint on the two changed test files: exit 0. `git diff --check`: exit 0. `node scripts/secret-scan-diff.mjs --staged`: clean, exit 0 before source commit.

The intermediate new-test run had three fixture predicate failures because it expected camelCase quota names; actual source emits room_bytes/staged_files. Complete failed output is preserved and the final assertions check the existing exact names. No runtime behavior or assertion was weakened to address them.

Logs are complete gzip files with uncompressed hashes and actual exit codes in receipt.json. This receipt proves local Node behavior only; it does not extend earlier Native evidence or qualify an integrated/released head.
