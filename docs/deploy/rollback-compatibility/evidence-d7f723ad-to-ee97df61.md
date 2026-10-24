# Rollback qualification evidence — freeze pair d7f723ad (forward) → ee97df61 (target)

Lane FREEZE-PREP, 2026-10-17. This is the pair that will be in force at
the next freeze: forward = main tip at evidence time,
`d7f723ada0ea808589dd0d123913055e40551c2e`; rollback target = production
at evidence time, `ee97df6132c37f8a41cc8925a00792b6bbd26e1d` (live read,
buildId `2026-10-17T23:49:02.420Z`, both doors). Raw boot output:
`boot-d7f723ad-to-ee97df61.json` (same directory).

## Status: evidence complete, receipt NOT YET ISSUABLE — one named gap

The compatibility substance below is complete and passing. A
format-valid receipt for this pair cannot be committed yet, for exactly
one reason:

- **GAP — `current.*.versionId` for the forward revision do not exist.**
  `d7f723ad` has never been deployed (production is still `ee97df61`;
  there is no deploy-prod run for `d7f723ad`). Cloudflare version ids for
  the forward Workers are created by that head's deploy-prod run, and
  `scripts/manual-rollback.mjs` requires the receipt's `current` to match
  the then-live allocations exactly. Inventing or placeholder ids would
  fail preflight and, worse, would look qualified.
- The target side is already known (it is the current production pair):
  prod versionId `2ae701ef-57d6-427a-95a1-5898d5b49d76`, entry versionId
  `da0edf74-e2ac-4e2b-a50f-ddde930d4cf2`, both at sourceRevision
  `ee97df6132c37f8a41cc8925a00792b6bbd26e1d` (provenance in
  `evidence-ee97df61-to-77df0e0b.md`).
- **Whose action closes the gap:** whoever runs the freeze deploy
  (John / authorized operator, per the deploy runbook). Immediately after
  that deploy-prod run, one command regenerates the receipt for the final
  frozen head — see `README.md` in this directory and
  `scripts/make-rollback-receipt.mjs`. The receipt must then be committed
  on `main` before `rollback-prod` can be dispatched for this pair
  (the receipt is read from `HEAD`).

If the landing runner names a different frozen head at settle, this
evidence does not transfer automatically: re-derive the static facts and
re-run the boot test for the named head (the delta is the qualification
subject, not the SHA pair alone).

## Static compatibility

- `STORE_SCHEMA_VERSION = 38` at both ends.
- `server/writer-fence.mjs` byte-identical: git blob
  `f2a7c40c8e4e31964c8d2fe5c01f66eaaab4df84` at both revisions.
- `cloudflare/wrangler.jsonc` byte-identical: git blob
  `ff761dfb04d4ef9f3c2c79c6856396d16e483106` at both revisions — retained
  runtime and bindings evidence (same `compatibility_date` `2026-07-30`,
  same Worker names, same `ROOM`/`ProjectRoom` Durable Object binding).
- Delta `ee97df61..d7f723ad`: 2 commits (merge #3719 restore-sanitize,
  merge #3935 dead-invite-link page), 10 files; no `server/store.mjs`, no
  wrangler, no writer-fence; zero DDL. Semantic change of note: the
  #3599 restore sanitize in `server/room-export.mjs` /
  `server/restore-ndjson.mjs` (forward exports/restores stop treating
  sha256 placeholders as live values).

## oldCodeNewData — boot test (target code on forward-written data)

Same CANDIDATE-FREEZE-QA Phase 1 pattern. Fixture built with `d7f723ad`
code (205 tables, money in flight, claimed+finished public-work task,
link-mode public room row, conservation 400 issued). Then `ee97df61`
code ran on it:

- R1 replay: target `replayNdjson` of the forward export returns
  `verified: true`, `contentVerification: "full"`, schemaVersion 38.
  (Fixture-scope only: the standing rule that production exports taken
  under a revision want that-revision-or-newer replay code is not
  lifted by a fixture pass. Rollback itself never replays an export.)
- R2 direct boot: ok; only the two known board bookkeeping rows differ
  (`work_item_board_backfill`, `work_item_board_divergence`, 0→1).
- R3 events hash bit-identical (`5c6c83eb91ff51c9250f710e2a4054eb772a1d593bb0b958ae7b1bc0073181eb`).
- R4 balances match the fixture exactly; conservation ok (400 issued;
  393 payable / 7 locked); public room join token reads back intact
  under target code; co_admin ceiling at target 6 of 9, zero
  `NEVER_GRANT` leaks.
- R5 target writes succeed (message, new bounty COMMONS-3 funded);
  conservation still exact after writes.

Verdict for this pair: `oldCodeNewData`, `retainedRuntime`, and
`workerBindings` all **passed** on the evidence above; only the forward
version ids (see GAP) stand between this file and a committed receipt.
