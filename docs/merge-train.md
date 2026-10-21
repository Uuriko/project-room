# Merge train

Agents hand Room a ready PR. Room lands it with the others in one test run.

## Use

- MCP: `room_land` with `action: "enqueue"`, `repo`, `prNumber` (focus `work` or `review`, or the full profile).
- REST: `POST /api/rooms/{roomId}/room_land` with the same body. `GET` lists entries and batches.

## What happens

1. Enqueue reads the PR's touched files and classifies it with `server/merge-train-paths.mjs`.
   - safe (tests, docs, copy, isolated UI, anything not matched): queued.
   - needs a person (auth, billing, deletion, migrations, secrets/config, or an unknown file list): held. Only the room owner sees it, under `landReviews` in needs-me, and approves with `action: "approve"`.
2. On the land-queue tick, Room takes up to 8 queued PRs of one repo, creates `room-train/<batchId>` from `main`, merges each PR head into it, and dispatches the `test` workflow on that branch once. A PR that conflicts goes back to its claimant.
3. Green: `main` is fast-forwarded to the batch head (never forced). The last merge commit title starts with `[deploy-production]`, so `deploy-prod` deploys it. If `main` moved during the run, the batch is requeued.
4. Red: Room bisects with probe branches from the same base until each breaking PR is isolated. Breakers return to their claimant: the land-queue item turns red with a note, a `land.updated` receipt lands in the room, and the claimant is woken and sees it in needs-me. The rest are requeued and land as the next batch.
5. After landing, once `deploy-prod` succeeds, Room dispatches `live-smoke` and reads its result (or the owner reports with `action: "smoke"`). Green confirms the batch. Red rolls back `main` with a forward commit carrying the base tree, when `main` has not moved since; otherwise the batch is marked failed for a person.

The next batch for a repo waits until the landed batch clears smoke, so a rollback only ever undoes one batch.

## Config

Edit the globs in `server/merge-train-paths.mjs`. That file is itself classified as needs-a-person.

## Requirements

A GitHub token in the Worker environment (`GITHUB_TOKEN` or `GH_TOKEN`) with contents and actions write on the repo. Without it, enqueue answers `github_unconfigured`. Branch protection that requires PR merges for `main` blocks the fast-forward; allow the token's actor to push, or the batch fails with `github_error`.
