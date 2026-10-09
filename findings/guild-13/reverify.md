# Re-verify results (wave1000 guild-13, 2026-10-08)

10 wave/stale branches touching the slice were rebased (scratch copies only)
onto origin/main and their affected slice test files were run.

Runner: `findings/guild-13/tools/reverify.sh` (scratch worktree → rebase →
affected tests → diff review → worktree removed). No branch refs touched.

## Results

| Unit | Branch | Rebase | Slice diff after rebase | Suite | Verdict |
|---|---|---|---|---|---|
| R1 | upstream/guild-identity-sybil/bound-invite-codes | clean | server/agent-invites.mjs | PASS (agent-invites, mail-unconfigured) | **live branch, healthy** |
| R2 | upstream/guild-identity-sybil/identity-discipline | clean (at the time) | server/agent-invites.mjs | **FAIL** (agent-invites.test.js, mail-unconfigured) | **bit-rot — owner action needed** |
| R3 | origin/jill/funnel-agentcode-invite-20261007 | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R4 | origin/quill/login-github-oauth | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R5 | origin/hardwork-sec/referral-email-gate | clean | server/referral-invites.mjs | PASS | already upstream after rebase |
| R6 | origin/is-sec-1/guest-link-server-token-only | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R7 | origin/jill/self-serve-join-912 | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R8 | fork/jill/f01-rt-reuse-theft-detection | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R9 | fork/jill/f02-access-token-revoke-cascade | clean | empty (superseded) | PASS (nothing to run) | already upstream |
| R10 | origin/jill/912-secfix-replay | clean | empty (superseded) | PASS (nothing to run) | already upstream |

"Superseded" = the branch's slice changes are already on origin/main (the
rebase dropped the redundant commits; post-rebase slice diff empty). These
branches can be deleted.

## R1 adversarial review: bound-invite-codes (PASS)

Adds optional `boundIdentityId` to agent-invite mint; redeem enforces it with
403 `invite_identity_mismatch`, checked before revoked/expiry/used. Review:

- Binding validated for shape AND existence at mint — a typo can't mint a
  dead code. NULL = unbound (all existing rows/flows unaffected).
- The bound check requires the holder's identity secret; the holder's own
  retry still reaches the `duplicate:true` path. Correct.
- **Review note (not a bug):** the code comment claims "a bound code leaks
  no more state to non-holders than an unbound code does". Strictly, a
  non-holder probing a bound code gets 403 where an unbound valid code
  would 201 for them — a distinguishable signal that the code exists and is
  bound. Practical risk is nil (codes are 16-char unguessable; you can't
  discover bound codes by probing), but the comment overstates the property.
  Suggested: rephrase to "leaks only to a party that already holds the
  code".

## R2: identity-discipline — BIT-ROT (needs owner)

- Branch tip alone: slice suite passes.
- After a clean rebase onto the then-current origin/main:
  `tests/agent-invites.test.js` and
  `tests/agent-invites-mail-unconfigured.test.js` both FAIL.
- Fixture collision ruled out (both test files use per-run mkdtemp
  fixtures; acceptance fixture too).
- A later rebase attempt conflicted in `server/share-links.mjs`,
  `server/store.mjs`, `server/work-claim-routes.mjs` (outside this slice;
  left unresolved per lane rules — another lane's files).
- The branch's redeem change (route invite-redeem mints through the
  anonymous limiter + `noteActivated`) is security-relevant Sybil work; it
  needs a rebase and a test fix by its owner. No product bug → no
  BUG CONFIRMED post; reporting here for the parent to route.
