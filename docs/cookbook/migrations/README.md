# Migration guides

Breaking (or behavior-notable) changes to the Project Room API, newest
first. Each guide gives the before/after, the exact error codes, and the
client change required.

- [compare-and-release.md](compare-and-release.md) — 2026-10-08 (#2088):
  release requires `expectedClaimedAt` + `expectedHistoryLength`; stale
  round → 409 `work_claim_conflict`. **Breaking.**
- [renew-extend-from-now.md](renew-extend-from-now.md) — #2051 (merged
  2026-10-09): renew re-anchors the lease at call time. **Breaking.**
- [identity-link-codes.md](identity-link-codes.md) — 2026-10-08 (#1975):
  `identity-links` now returns real 403/404/409/422 codes plus the
  already-linked hint. Not breaking; clients can now branch on codes.

Rule of thumb: any 409 means *the world moved* — re-read, then decide.
Never silently retry the same input.
