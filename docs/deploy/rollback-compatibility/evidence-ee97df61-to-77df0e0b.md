# Rollback qualification evidence — pair ee97df61 (current) → 77df0e0b (target)

Lane FREEZE-PREP, 2026-10-17. This file is the qualification evidence the
receipt `ee97df61-to-77df0e0b.json` (same directory) links for all three
checks required by `scripts/manual-rollback.mjs`: `oldCodeNewData`,
`retainedRuntime`, `workerBindings`. Raw boot output:
`boot-ee97df61-to-77df0e0b.json` (same directory, trimmed to
decision-relevant fields).

## The pair

- current (production at evidence time, read live from
  `https://room.trydemigod.com/api/version`, buildId
  `2026-10-17T23:49:02.420Z`, both doors agreeing):
  - prod: sourceRevision `ee97df6132c37f8a41cc8925a00792b6bbd26e1d`,
    versionId `2ae701ef-57d6-427a-95a1-5898d5b49d76`
  - entry: sourceRevision `ee97df6132c37f8a41cc8925a00792b6bbd26e1d`,
    versionId `da0edf74-e2ac-4e2b-a50f-ddde930d4cf2`
- targets (previous production revision):
  - prod: sourceRevision `77df0e0b7ce777ca0bdfe61bddd7320b0b352c60`,
    versionId `bf533d21-d4cc-4596-86db-4537e662e4e6`
  - entry: sourceRevision `77df0e0b7ce777ca0bdfe61bddd7320b0b352c60`,
    versionId `5e696acc-769d-44d7-8528-2f978c0f6c46`

Version-id provenance (no wrangler/operator seat was needed): deploy-prod
run `39080407552` (2026-10-17T23:48:18Z, success, head `ee97df613`) — its
deploy job log prints the pre-deploy snapshot (the same JSON uploaded as
artifact `pre-deploy-ee97df6132c37f8a41cc8925a00792b6bbd26e1d`, artifact id
12118124796), which records the target ids above as the then-live 100%
allocations, and prints `Current Version ID: 2ae701ef-…` (canonical) and
`Current Version ID: da0edf74-…` (entry) for the versions that run created.
That run's smoke verified both doors at `ee97df613`. No later successful
deploy-prod run exists and production still reported `ee97df613` when this
evidence was produced.

## Static compatibility (both pairs share these facts)

- `STORE_SCHEMA_VERSION = 38` at both ends.
- `server/writer-fence.mjs` byte-identical: git blob
  `f2a7c40c8e4e31964c8d2fe5c01f66eaaab4df84` at both revisions.
- `cloudflare/wrangler.jsonc` byte-identical: git blob
  `ff761dfb04d4ef9f3c2c79c6856396d16e483106` at both revisions — same
  `compatibility_date` (`2026-07-30`), same Worker names, same Durable
  Object binding (`ROOM` / `ProjectRoom`). This is the `retainedRuntime`
  and `workerBindings` evidence: the retained runtime configuration and
  the bindings are literally the same file at both ends of the pair.
- Delta `77df0e0b7..ee97df613`: 15 files, no `server/store.mjs`, no
  wrangler, no writer-fence; zero `ADD COLUMN` (no DDL).

## oldCodeNewData — boot test (target code on current-written data)

Pattern: CANDIDATE-FREEZE-QA Phase 1. Fixture built with `ee97df613` code
(205 tables; money in flight: bounty COMMONS-1 submitted with locked
award+bond, COMMONS-2 funded; a claimed+finished public-work task; a
link-mode public room row; conservation 400 issued). Then `77df0e0b7` code
ran on it:

- R1 replay: target `replayNdjson` of the current-code export returns
  `verified: true`, `contentVerification: "full"`, schemaVersion 38.
- R2 direct boot: ok. Only boot-attributable table deltas are the two
  known board bookkeeping rows (`work_item_board_backfill`,
  `work_item_board_divergence`, 0→1) — same as every prior qualified pair.
- R3 events hash bit-identical to the fixture trailer
  (`fe4bafec08b47d63590126357823c4f0593430136fe59a0ab3533cb15ef95550`).
- R4 balances match the fixture exactly; conservation ok (400 issued;
  393 payable / 7 locked). Bounty states preserved (submitted / funded).
  Public room reads back with its join token intact. co_admin ceiling at
  target: 6 of 9 permissions, zero `NEVER_GRANT` leaks.
- R5 target writes succeed (message posted, new bounty COMMONS-3 funded);
  conservation still exact after writes.

Verdict for this pair: all three checks **passed**. The receipt covers
Worker-code rollback over live data. Restore-from-export is a separate
path; for this pair the fixture replay leg also passed (R1), which is
fixture-scope evidence, not a production-export guarantee.
