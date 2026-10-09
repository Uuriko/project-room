# Suspected bugs — server/claim-coordination.mjs

Flagged, not fixed. All in `server/claim-coordination.mjs`.

- `:rollupClaimCi` — "neutral" is returned both when CI ran and everything was neutral/skipped AND when no signal exists at all; callers that treat neutral as pass will approve claims with no CI. (Probably intentional; needs an owner confirm on call sites.)
- `:settlePullRequest` — `current.outcome ?? outcome` on the merged path: if the stored link somehow carries `outcome: "closed"` while the batch outcome is `"merged"`, the record keeps `"closed"` on a `done` claim. Contradictory states are writable.
- `:rateLimitUntil` — `reset` values > 1e12 are treated as ms, else seconds; a reset in *microseconds* (unusual but seen from some proxies) would be read as far-future ms and hold polls far too long.
- `:fileLeaseConflictBody` — names only the first holder in the message; when several holders conflict, the others are in `conflicts[]` but the human-readable message hides them.

Checked and clear: PR URL parsing (strict host/protocol/path, no query/fragment/credentials); webhook reducer (only `closed` settles); backoff ladder bounds; `readyClaims` missing-dependency handling; ETag shape validation.
