# re-verify R2: wave300/fix12-unprivileged-succession
started: 2026-10-09T09:47:42Z
HEAD is now at 143543319 FIX-12: declare x-room-permission on POST .../succeed (route-permission guard)
branch head: 143543319, merge-base with origin/main: b5c215f8
slice files changed: server/work-claim-routes.mjs 
rebase: CONFLICT — aborted, testing un-rebased head
running affected suite: tests/work-claim-qa-fixes.test.js tests/work-claim-guards.test.js tests/work-claims.test.js
suite: 3 passed, 0 failed
node --check on slice files:
done: 2026-10-09T09:48:22Z

## Adversarial review (2026-10-09)
Branch: origin/wave300/fix12-unprivileged-succession (7 files, +372/-3).
Rebase: CONFLICT — aborted, tested un-rebased head. Suite: 3 passed, 0 failed.
- Mount wiring present (server/http.mjs workClaimSucceedMatch), docs/WORK-CLAIMS.md + docs/openapi.yaml updated, tests/work-claim-succession.test.js added (184 lines). Coherent.
- R2-1 (advisory): holderLiveness resolves member->identity via store.bonds?.identityForMember rather than the identity_links table (the canonical mapping used by inbox-collab). If the bonds resolver doesn't cover all linked identities, succession fail-closes (safe) but may be unavailable for members without bonds. Verify the resolver choice.
- R2-2 (advisory): liveness read is not fenced with the heartbeat table write — a heartbeat landing between check and commit makes succession rest on slightly stale liveness. Benign given the 5-min threshold, but note the race window.
- Positive: guide choke + requireWriter + requireEventBudget all run before the succession body; per-member cap enforced (no cap evasion); deploy claims refused.
Verdict: no breakage. Rebase conflict must be resolved before merge (wave's problem).
