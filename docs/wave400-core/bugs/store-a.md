# Suspected bugs — server/store.mjs lines 1–1750

Flagged, not fixed.

- `:applyProvenanceRepair` — mutates `item.claim` for `legacySupersededClaims` without checking `item.claim` exists first (`item.claim.status = "superseded"`); the filter checks `item.claim?.status === "active"` so it's guarded today, but the mutation site itself is unguarded.
- `:nodeStorage.transaction` — the isolated-write path catches savepoint-rollback failure, adds the db to `nodeFailedIsolations`, and throws a *new* Error that discards the original error as `cause` only via the options bag (`new Error("Isolated transaction rollback failed", { cause: isolationError })` — the original `error` is lost, replaced by the rollback failure).
- `:logColdStart` — on a failed open it queries `rooms`/`events` counts inside a try/catch; if the schema is partially installed this silently omits counts, which is intended, but the `failed: true` record then carries no state-size signal for diagnosing the failure.

Checked and clear: storage-failure classification (primary codes masked with `& 0xff`), busy_timeout-before-journal_mode ordering, contiguous schema-version range, command shape allowlist, supersession cycle repair.
