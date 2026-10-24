# Rollback qualification evidence — declared-head pair 470d546a (forward) → ee97df61 (target)

Lane FREEZE-PREP-2-RESUME, 2026-10-18. Forward = the deploy head declared
on #3299 (comment 6247221103), `470d546a03411c38cb86c6752ed9737fd9409a21`
(main tip; two agreeing API reads). Rollback target = production at
evidence time, `ee97df6132c37f8a41cc8925a00792b6bbd26e1d` (live read,
buildId `2026-10-17T23:49:02.420Z`, prod door). Raw boot output:
`boot-470d546a-to-ee97df61.json` (same directory).

## Status: evidence complete, receipt NOT YET ISSUABLE — one named gap

The compatibility substance below is complete and passing. A
format-valid receipt for this pair cannot be committed yet, for exactly
one reason — the same structural gap as the prior freeze pair:

- **GAP — `current.*.versionId` for the forward revision do not exist.**
  `470d546a` has never been deployed (production is still `ee97df61`;
  the only successful deploy-prod run is the one that created `ee97df61`).
  The two Cloudflare version ids for the forward Workers — `current.prod.versionId`
  and `current.entry.versionId` — are created by that head's own
  deploy-prod run and are printed in its deploy job log
  (`Current Version ID: …`, canonical + entry) and cross-checked against
  its `pre-deploy-<sha>` artifact. Inventing or placeholder ids would
  fail `scripts/manual-rollback.mjs` preflight and, worse, would look
  qualified. They are never fabricated here.
- The target side is already known (it is the current production pair,
  two-read confirmed in FREEZE-PREP from deploy-prod run `39080407552`'s
  job log + pre-deploy artifact `12118124796`): prod versionId
  `2ae701ef-57d6-427a-95a1-5898d5b49d76`, entry versionId
  `da0edf74-e2ac-4e2b-a50f-ddde930d4cf2`, both at sourceRevision
  `ee97df6132c37f8a41cc8925a00792b6bbd26e1d`.
- **Completion (one command, post-deploy):** see
  `470d546a-to-ee97df61.GAP.md` in this directory — the exact generator
  invocation that produces `470d546a-to-ee97df61.json`, to be committed on
  `main` before any `rollback-prod` dispatch for this pair. Whose action:
  whoever runs the deploy (John / authorized operator) or the receipt
  lane immediately after that deploy-prod run completes.

## Static compatibility (re-derived against the declared head)

- `STORE_SCHEMA_VERSION = 38` at both ends (ee97: `server/writer-fence.mjs`
  line 7 in the extracted tree; head: same line read via the contents API
  at `470d546a`; no patch in the delta touches `STORE_SCHEMA_VERSION`).
- `cloudflare/wrangler.jsonc` byte-identical: git blob
  `ff761dfb04d4ef9f3c2c79c6856396d16e483106` at both revisions (two
  contents-API reads) — retained runtime and bindings evidence (same
  `compatibility_date` `2026-07-30`, same Worker names, same
  `ROOM`/`ProjectRoom` Durable Object binding).
- `server/writer-fence.mjs` **differs** — deliberately, and by exactly
  one line. ee97 blob `f2a7c40c8e4e31964c8d2fe5c01f66eaaab4df84` → head
  blob `5087ef2136fc4fd7ec359c7c918bf4a7bc2c462e`. The ee97 fence blob is
  identical to the interim tip cef1c096's, so the whole ee97..head fence
  delta is the cef1..head patch (+1/−1, PR #3988):
  `PATROL_ADDITIVE_TABLES` gains `"patrol_blocks"`. No fence DDL, no
  schema-version change. Per the fence's own comment, patrol tables are
  additive, created lazily by the patrol, and older writers have no code
  path to them.
- `server/store.mjs` **differs** — by exactly the cef1..head patch
  (+9/−1, PR #3988; ee97 store blob `b802a4ce2ad70ce6ca0b9a47edf6fedd5c2c2975`
  is identical to cef1's; head blob `2aab0fd4d9254e7bfd030ea55fd43c6f684e3e12`):
  a `patrolBlocks` import from `server/patrol.mjs`, a
  `RoomStore.patrolBlocks()` accessor, and a guarded
  `DELETE FROM patrol_blocks` when a room's log is replaced. No DDL in
  `store.mjs`.
- Full delta census `ee97df61..470d546a` (compare API): **57 commits,
  77 files**. In the head: #3723 (merge `85f51c09c`, EXP-5 receipt
  OG/JSON-LD: new `server/receipt-share.mjs`, receipts/proof/http wiring,
  runtime-package registration), #3987 (merge `d69238fd6`,
  `server/agent-connections.mjs` verifyHistory: a dissolved sponsor
  binding is excused only by a terminal fact — sponsor account
  deactivated or sponsor member inactive; repointed bindings and
  unexplained missing bindings still fail; logic only, no DDL), #3988
  (merge `5ad8010f7`, patrol park-and-continue, below), #3971 (the head's
  tip merge, deploy-lag measurement: workflow + `scripts/deploy-lag.mjs`
  + tests), #3953 front-door batch, #3719 (#3599 restore sanitize),
  #3945/#3946, plus perf/legal/misc landings. **Not** in this head:
  #3995 (so no `public_work_room_caps` table and no sponsor-cap schema
  surface), #3724, #3965, #3966, #3970, #3999, #3983.
- DDL scan of all 77 file patches: the **only** DDL in the entire delta
  is in `server/patrol.mjs` (#3988): `CREATE TABLE IF NOT EXISTS
  patrol_blocks` — patrol-owned, additive, created lazily on the first
  patrol tick (not at boot). No `ADD COLUMN`, no `ALTER`, no `DROP`, no
  other `CREATE TABLE` anywhere in the delta. No escrow/settlement file
  changes (`server/bounty-escrow.mjs` and the public-work settlement
  module are untouched).

## oldCodeNewData — boot test (target code on forward-written data)

Same CANDIDATE-FREEZE-QA Phase 1 pattern as prior pairs, run in an
in-memory variant (the sandbox blocks file writes from any process that
has read repo code, so the fixture store is a shared in-memory
`DatabaseSync` handed from the forward store to the target store, and
the R1 replay targets `':memory:'`; the R1 leg's final
`chmodSync(filename, 0o600)` — permission hygiene for on-disk restores —
is shimmed to a no-op for the `':memory:'` pseudo-file only, with the
pattern asserted to occur exactly once in the genuine ee97 source; no
verification logic is altered). The runner was validated by reproducing
the provisional cef1c096→ee97df61 pair first: R1–R5 outcomes identical
to the file-based provisional run on record. Forward code identity is
cryptographic, not by directory label: the eight delta files the boot
imports (`server/store.mjs`, `server/writer-fence.mjs`,
`server/patrol.mjs`, `server/agent-connections.mjs`, `server/http.mjs`,
`server/receipts-page.mjs`, `server/receipt-share.mjs`,
`server/proof-page.mjs`) were fetched at the declared head and their git
blob SHAs verified in-process against the head tree (store
`2aab0fd4…`, fence `5087ef21…`, patrol `b8a66a10…`, agent-connections
`f8646fd4…`, http `64caf55a…`, receipts-page `3cc788c4…`, receipt-share
`6069b3be…`, proof-page `610bff67…`) before execution; every other
imported file is cef1c096's, which the compare file list proves
byte-identical to head. Fixture built with forward code (205 tables,
money in flight, claimed+finished public-work task, link-mode public
room row, conservation 400 issued). Then `ee97df61` code ran on it:

- R1 replay: target `replayNdjson` of the forward export returns
  `verified: true`, `contentVerification: "full"`, schemaVersion 38.
  (Fixture-scope only, per the standing rule; rollback itself never
  replays an export. See the patrol variant below for the one replay
  limitation this delta introduces.)
- R2 direct boot: ok; only the two known board bookkeeping rows differ
  (`work_item_board_backfill`, `work_item_board_divergence`, 0→1).
- R3 events hash bit-identical (staged run:
  `77f7e8306cc1a6a6104b4d8bab420eb8b5718307aa5e1664a60aa2395d4d6bed`;
  fixture hashes are per-build because identity creation is randomized —
  the criterion is the within-pair match, as in prior pairs).
- R4 balances match the fixture exactly; conservation ok (400 issued;
  393 payable / 7 locked); public room join token reads back intact
  under target code; co_admin ceiling at target 6 of 9, zero
  `NEVER_GRANT` leaks.
- R5 target writes succeed (message, new bounty COMMONS-3 funded);
  conservation still exact after writes.

### Patrol variant (the #3988 table, tested explicitly)

Production will have run the forward patrol before any rollback, so the
fixture was also built with one forward patrol tick applied (210
tables: the four pre-existing patrol tables plus `patrol_blocks`).
Against that fixture, target code: **R2 direct boot ok, R2b/R3/R4/R5
all pass identically** (events hash within-pair match,
`444818311181d060ca9fd0fb4c37f42579dcec64462c38b49d581d51299bfc7b`) —
ee97 code serves a database containing `patrol_blocks` and never reads
the table. **R1 replay of the post-tick export fails** with
`Export names a table this store does not have`: ee97's
`replayNdjson` refuses any export containing `patrol_blocks`. That is
the restore-from-export path, not the rollback path (rollback-prod is a
Worker version swap over live data; it never replays an export), so it
does not block this pair's receipt — but it is a real, named limitation:
**a backup/export taken while production runs `470d546a` (after any
patrol tick) cannot be restored by ee97 code; restoring it requires
head-or-newer code.** This is the standing "exports want
that-revision-or-newer replay code" rule with a concrete table name now
attached.

Verdict for this pair: `oldCodeNewData`, `retainedRuntime`, and
`workerBindings` all **passed** on the evidence above; only the forward
version ids (see GAP) stand between this file and a committed receipt.
