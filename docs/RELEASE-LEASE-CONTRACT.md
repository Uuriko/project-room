# Release lease contract (proposal, no effect)

Status: proposal for review. This file changes no workflow, credential, branch
protection, roster or membership. Nothing here is release authority.

## Problem

`room/release-lease` is the only required status on `main`, and one seat's
local coordinator is the only thing that issues it. On 2026-10-21 the
cached-page startup fix #4490 was green, reviewed and ruled urgent at 02:06Z
(room seq 17395, 17396). It landed at 04:51Z (17456). Production carried a
blank-screen regression in the meantime, and no other seat could issue the
lease. A refusal was the correct outcome each time (17436, 17443, 17445). The
gap is that the gate has a single point of operation, not that it refused.

## Invariants any issuer must keep

An issuer, local or hosted, sets `room/release-lease`=success on a commit only
when all of the following hold at that moment:

1. **Exact binding.** The lease names one repo, one PR, the 40-character head
   SHA and the base SHA, and the PR's current head and base equal them.
2. **Live holder.** The Board claim `MERGE-SLOT` is live, unexpired, and held by
   the member requesting the lease, and its note names that head.
3. **Allowed target.** The repo and base branch are on an explicit allowlist
   (today `Uuriko/project-room`, `main`).
4. **Complete checks.** Every check run and commit status at the head is
   completed. None is failing, pending, stale or of unknown conclusion, and a
   truncated read counts as incomplete.
5. **No hold.** No explicit hold record names this PR or head.
6. **Serialization.** At most one live lease exists per base branch.
7. **Expiry and revocation.** A lease expires within a bounded time, and the
   issuer revokes it after the merge, after a head or base move, or after the
   slot is released.
8. **Receipt.** Issuing, merging and revoking each post a room receipt that
   names the PR, head, base and holder.

## Who may hold the slot

A roster file alone is not release authority. Any change that lets a second
seat obtain a lease, including any hosted workflow with write permission on
statuses, needs a recorded decision by the owner and the release seat in the
room. Silence or a review reply is not that decision.

## Questions for review

- Is a second issuer (a hosted workflow) wanted at all, or only a documented
  handover of the existing coordinator with a timeout?
- What lease lifetime and what unclaimed-slot timeout should apply to a
  ruled-urgent fix?
- Where do hold records live so that an issuer can read them as exact-head facts?
