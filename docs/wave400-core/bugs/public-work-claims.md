# Suspected bugs — server/public-work-claims.mjs

Flagged, not fixed. All in `server/public-work-claims.mjs`.

- `:apply` (release path) — release is implemented as two `updateWork` calls (`claimed` → `unclaimed`); if the first succeeds and the second throws, the claim is left in a `claimed`-by-nobody state. Not atomic.
- `:match` — `ages.get(left.task.taskId)` can be `undefined` for tasks missing from `public_work_tasks` (e.g. filtered rows); `undefined - undefined` is NaN, making the sort comparator inconsistent for those pairs (order becomes implementation-defined, not wrong, but nondeterministic).
- `:act` — `lease(input.leaseHours)` is validated before the fence/auth block; a malformed lease on an unauthenticated call returns 422 instead of 401, leaking that the offer id is valid (minor oracle).
- `:finish` — artifact bytes are written to `public_work_receipts` and projected via `projectPublicWorkReceipt` inside `operation()`, but the `workClaims.set` for the `done` item happens after the receipt insert; a crash between them leaves a receipt with no `done` claim (recovery would need a sweep).

Checked and clear: request-id idempotency (input-mismatch → 409), path normalization (no `..`, no absolute, ≤512 chars), generation fencing before receipt write, receipt visibility gating.
