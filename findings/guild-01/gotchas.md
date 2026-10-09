# Gotchas — claim-core slice

Hard-won, non-obvious behaviors. Each is pinned by a test or a fuzz case
(2026-10-09).

1. **Route ids ≠ machine ids.** Routes enforce `[A-Za-z0-9_-]{1,128}`;
   the pure machine accepts any 1..256-char string, control characters
   included. Don't assume an id is URL-safe past the route layer.

2. **Two lease floors.** The pure machine allows any `leaseHours > 0`; the
   board route enforces `0.25..168`. A 0.24h lease is legal to the machine,
   refused at the board.

3. **Renew doesn't preserve the original lease.** `renewWork` without an
   explicit `leaseHours` uses the room default (24h), not the claim's
   original duration. Renewing a 1h claim with no args yields a 24h lease.

4. **`now` is trusted.** The machine never rejects a past `now` — renewing
   with `now` before the claim time yields an exactly-computed but earlier
   window (lease "monotonicity" holds only for forward time). Callers must
   pass sane clocks.

5. **Release wipes the round.** `updateWork`→`unclaimed`, `releaseExpired`,
   and PR-closed settlement all clear files, fileBlocks, attestations, and
   reviews. The next claimant — and any test asserting round isolation —
   must not expect them to survive.

6. **Attestations are per round+revision.** A repeat note on the same basis
   replaces in place with **no history stamp** (and no room event). Tests
   counting history entries must account for silent replaces.

7. **Blobs/tags are silently dropped off the done path.** `createWork`
   ignores `blobs`; `claimWork` ignores `tags`/`kind` and any undeclared
   param. No error — data just doesn't land. (Tags *are* accepted on create.)

8. **`closeWhenLive` needs EITHER match.** Revision **or** CI head sha equal
   to the live revision closes the claim (`&&` in the guard is "return null
   unless both differ").

9. **Stale PR outcomes tie-break on history.** An outcome stamped at the
   exact millisecond of `claimedAt` is stale only if the history shows a
   prior round (`pr_closed`/`pr_merged`/`state:unclaimed`/`lease_expired`
   or ≥2 `claimed` stamps) — otherwise the no-op wins. Millisecond ties are
   deliberately not ordered by timestamp alone.

10. **Coalescing is per store handle.** Two store objects for the same room
    don't share the 60s note-event coalescing (WeakMap keyed on the handle).

11. **A missing dependency is never "done".** `readyClaims` treats unknown
    ids as not-done; `delete` waives the id from dependents so nothing
    strands.

12. **`settlePullRequest` reads both link shapes.** `pullLinks` falls back
    to the legacy single `pullRequest` — batch and single-link items both
    settle.

13. **Bare 403 is not a rate limit.** `rateLimitUntil` only holds on 429 or
    403-with-exhausted-budget/message. Don't treat every 403 as a hold.

14. **Backoff advances on exact steps.** `nextPullBackoff` uses `step >
    current`, so polling at exactly a step boundary moves to the next step
    (no repeated same-step polls).

15. **Deploy claims need revisions.** `kind: "deploy"` without `revision`
    throws at create — and `closeWhenLive` ignores non-land/deploy kinds
    entirely (returns null).

16. **Workspace-disk fsync is ~160ms/upsert.** Durable-registry tests on
    worktree-local TMPDIR are correct but slow; tmpfs is ~50x faster.
    (Measured 2026-10-09 during kill-9 fuzzing.)
