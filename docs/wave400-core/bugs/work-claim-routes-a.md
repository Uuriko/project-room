# Suspected bugs — work-claim-routes.mjs lines 1–680

Read-only report; nothing fixed. Each item is a suspicion from code
archaeology, not a confirmed reproduction — owner should confirm before acting.

## Suspected

1. `server/work-claim-routes.mjs:592–603` — the REST `update` + `appendPullRequest`
   early-return sends the linked item raw via `helpers.json(res, 200, item)`
   **without** content-trust stamping. The read route stamps with
   `withContentTrust(stampClaim(item, caller))` (line 969), and the list pages
   stamp claims before projection (line 371). So the PR-append response is the
   one item response that does not mark member-authored fields untrusted — a
   client trusting its own read of `title`/`note` from this response could treat
   member-authored text as trusted. Also this path skips `enforceAutonomyTierForAction`
   for the actual mutation (the tier check in `handleWorkClaimsCore` line 691 runs
   only when the request reaches core; the early-return at 598 bypasses it) —
   though `linkWorkClaimPullRequest` does run its own `enforceAutonomyTierForAction`
   (line 556–557), so only the stamping asymmetry stands.

2. `server/work-claim-routes.mjs:609` — the `status` route's `?refresh=1`
   force check calls `maySweepWorkClaims` on `options.auth` (the auth snapshot
   from `http.mjs`), while `handleWorkClaimsCore` then reauthorizes
   (`reauthorize ? reauthorize() : options.auth`, line 647) and uses the fresh
   identity for everything else. If the reauthorized identity differs (e.g. a
   rotated session), the refresh-privilege decision is evaluated on the stale
   identity. In practice the two are the same member; still, the check and the
   rest of the request disagree on which identity matters.

3. `server/work-claim-routes.mjs:142` — `BOARD_QUERY` whitelists `auth`, but
   `buildWorkClaimPage` never reads it. Harmless (accepted and ignored), but it
   is a contract trap: any client that starts sending `?auth=` believing it
   does something gets silently ignored auth-scoping. Either wire it or drop
   it from the allowlist. (Also noted under "stale comments".)

## Checked and cleared (no bug)

- `memoizeList` (675): comment says "until a write invalidates it" — `set` and
  `delete` do call `cache.delete(roomId)`; the sweep → list-page flow sees
  fresh items. No staleness.
- `pageBoard` cursor continuation (302): for DESC-`updatedAt`/ASC-`id` sort, the
  resume predicate `updatedAt < cursor.u || (updatedAt === cursor.u && id > cursor.i)`
  is correct, including the state-bound `s` marker and legacy unbound cursors.
- `sweepRoom` (388): only items already lapsed (`leaseExpiresAt <= nowMs`) go
  through the state machine; compares pre/post state so only real lapses count
  as swept. Fine.
- `boardCursorOf` (281) accepting legacy `{u, i}` cursors while `buildWorkClaimPage`
  (366–367) rejects cross-state cursor reuse is deliberate (commented upgrade path).
- `claimIdOf` (118) returning after `invalidInput` — `invalidInput` throws, so
  the trailing `return id` is unreachable-but-harmless, not a bug.
- `retire` (491) error mapping: `work_not_owner`→403, `work_claim_terminal`→409,
  else 422 — matches the module's documented error contract.
- `linkWorkClaimPullRequest` (535) identity-changed check (514): the 403 fires
  only after the 401 for a missing member id, so the error precedence is right.
- Dead-code sweep: every function/const/export defined in 1–680 has at least
  one real caller (see `deadcode/work-claim-routes-a.md`).
