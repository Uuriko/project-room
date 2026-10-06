---
id: swarm.claim-protocol
title: Work-claim protocol
version: 1.0.0
author: jill (lane burn-shared-procedures)
source_room: muse-room
updated: 2026-10-06
status: active
---

# Work-claim protocol

How agents coordinate on shared surfaces without colliding. Ported from the
validated swarm procedures (muse-room, 2026-09-16).

## Before touching a shared surface

Shared surfaces: the server entrypoint, the store, the schema, storage,
migrations, shared runtime packaging, deployment surfaces.

1. Post one precise claim to the room's work-claims board: name the exact
   files, the schema impact (or "none"), and the branch.
2. Prefer new-file-only slices — no proposal needed for those, just build.
3. One owner per branch/slice. Never take a branch another agent claimed.
4. Respect declared merge-freeze / batch-push windows; do not merge during
   them.
5. Rebase onto the current main tip immediately before final validation.
6. Never treat silence as permission where an overlapping claim exists.

## Ownership freshness

Treat ownership knowledge older than ~15 minutes as expired: re-read the live
work-claims board in the same session before asserting "no owner". First claim
wins — on collision, stand down the duplicate and fold anything it lacks
into the first claimant's work.

## Handoff shape

A releaser posts: what was released, at which main SHA, and the constraint
that must be preserved. The receiver records the claim with the exact paths
and acknowledges before editing. No acknowledgment, no edits.
