# Remote restore continuation driver

Source tool `72dff46ff306204a2f31ff71d00aa39822ddc180`, base `a2fb0c7cb9f8d77d5b594cf9880319ef5a3ffe14`. Existing script gains an explicit continuation-only branch; it never uploads backup data or starts a restore. Frozen backend cleanup contract e4fb was inspected, not modified.

Actual CLI over local synthetic HTTP:11pass/0fail/0skip. Includes persist-before-send assertions, interrupted coverage ACK, both first/last cleanup ACK loss, SIGKILL after send, two simultaneous restart refusals under the existing lock, manual lock-only reconciliation then exact pending-byte retry, >500 progressing receipts, origin/header confinement, redirects, binding/CAS/no-progress and false-zero refusal. A final test-only let→const cleanup freshly passes the SIGKILL/restart case. Lint0errors/0warnings; secret scan1848files/0findings.

The initial automatic stale-lock removal had a valid review blocker: simultaneous restart could unlink a newly live lock. The accepted cure removes ALL automatic lock-stealing. Atomicwx acquisition refuses anyexistinglock. After stopping other drivers and reconciling the old owner, an operator may explicitly remove only the lock, preserving the checkpoint. An interrupted lock write can leave an empty lock; it still failsclosed. Independent pairing review found no remaining material blocker, without claiming another independent test run.

Both local restore fixture failures in the69-test neighbor run (67pass/2fail) reproduce with the ORIGINAL base script in a targeted2-test run. The local restore main body from sourceParam through endmain is byte-identical; current-schema/operational-table fixture expectations are retained as inherited reds, not fixed or waved.

Credentials only come from ROOM_RESTORE_TOKEN. Requests use the fixed operator path at the explicit validated origin, never response URLs. Private atomic/fsynced checkpoints hold original receipt binding, exact pending bytes and current acknowledged receipt. Data verification does not finish cleanup: only remaining=verifiedGuardCount=0 pluscleanupComplete true ends successfully. Keep the same initialreceipt+checkpoint acrossrestarts; checkpointloss aftermultipleACKs cannot be repaired with immutable publicationrev0 alone and safely409s.

No production calls/deployment, no runtimecleanup edits, and no actualNative composed driver/backend qualification claim. Full test commands and log hashes are in qualification.json; operator usage and the official Cloudflare30-day SQLitePITR correction are in docs/BACKUP-DR.md.
