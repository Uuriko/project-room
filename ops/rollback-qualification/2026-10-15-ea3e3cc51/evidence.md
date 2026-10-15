# Rollback qualification evidence — candidate ea3e3cc51 → rollback target c0e5aefbf

**Run:** 2026-10-15, lane ROLLBACK-QUAL. Method: deploy packet §3
(`~/workspace/strategy-2026-10/deploy-packet-2026-10-15.md`), executed with
the repo's own test/store machinery in isolated local stores. No production
change of any kind.

**Pair (re-derived at run time):**

- Candidate: `ea3e3cc51c463afb63e870cdb85e990fb0b8786b` — current `main`.
  The packet was prepared against `87edba691…`; PR #3536 merged during this
  run (2026-10-15T21:21:29Z), so per the packet's own validity rule the pair
  was re-derived. The delta vs the packet candidate is exactly #3536
  (NDJSON trailer-v2 per-table digests, PR #3536, issue #3325).
- Rollback target: `c0e5aefbf89e6870b2fbec9f44df81363ed22a14` — production.
  Canonical version `3e990387-e6d9-4f52-92a1-9661b28e6b8b`, entry version
  `8272adc8-af05-462f-b0b1-770dfa16ee8e` (packet §1.1).
- Store schema: 38 on both sides; `server/writer-fence.mjs` blob
  `063f8c1bed981ed979805b91f20015808896ffef` is byte-identical at both
  revisions, and the full `c0e5aefbf…ea3e3cc51` diff (47 files) adds no DDL
  (`CREATE/ALTER/DROP/ADD COLUMN`/trigger/index scan: none).

## §3.2 Candidate-written fixture — PRODUCED

`build-fixture.mjs` (this directory) booted the candidate `RoomStore` on an
empty isolated store and exercised representative candidate writes through
candidate code paths (manifest: `fixture-manifest.json`, writes W0–W14):
room bootstrap; owner/agent access keys; member + message commands; account
creation; an auth-mail verify code (`account_magic_codes` — the persisted
state of the magic/reset paths #3538 touches); a live account session
(slot + method login); a GitHub OAuth pending state (#3533,
`oauth_pending_states`); the four anchored public-work starter seeds;
a full claim→finish lifecycle for each (identity-issued); the #3540
`reseedStarterPool()` replenishment (seeded 4 round-2 tasks); a room work
claim carrying a PR link (claim-prs source data); a deliberately malformed
`work_claims` row (production-residue shape); and a posted + funded bounty
(`BountyEscrow`, money/journal state).

Fixture identity (the export is the fixture):

- File: `fixture.ndjson` (this directory), **91,779 bytes**,
  sha256 `cd6744f71a8c74e0c411f0383d33fd03eedd62abeff83fb5dbb5687a7813cd52`.
- Trailer: version **2** (candidate exporter, #3536), events **5**,
  eventsHash `412d10bad5452e3d218aaf6e4e041dfc077910054a97c91a22e3583eb8e842cb`,
  per-table row counts + sha256 digests for every loadable table.
- 29 tables carry rows, including: accounts 2, account_session_slots 1,
  account_magic_codes 1, oauth_pending_states 1, public_work_tasks 8,
  public_work_receipts 4, public_receipts 4, work_claims 10,
  bounty_records 1, bounty_journal 4, events 5, messages 2.
  Full inventory: `fixture-manifest.json` (`fixture.perTableCounts`).

Authoring note: the malformed row's first cut edited only the
`{v, kind, data}` wrapper of `work_claims.item_json`, leaving the claim
valid; the old-code read-back exposed it, the fixture was rebuilt with the
malformation inside `data.repo`, and the builder now asserts the read-back.
Both runs are recorded in `old-code-run.json` history of this lane; only the
corrected fixture is committed.

## §3.3 oldCodeNewData — PASSED for live-store rollback, one named exception

Full machine record: `old-code-run.json` (script: `verify-old-code.mjs`).

**Restore leg.** The exact rollback source's replay
(`replayNdjson` at `c0e5aefbf`) **refuses the candidate-written export**:
`Export trailer is malformed`. Cause: the candidate exporter emits trailer
version 2 (#3536); the pre-#3536 replay only accepts the v1 trailer shape.
Per the documented fallback, the fixture was restored with the candidate
replay: `verified: true`, `contentVerification: "full"`, recovery audit
`ok: true` (schemaVersion 38, writerFence check true), `skippedTables: {}`.

> **Exception E-A (the one real incompatibility this run found):**
> pre-#3536 code cannot restore candidate-era backup exports. This does
> **not** affect a Worker rollback — the Durable Object store persists in
> place and no NDJSON replay occurs (proven directly below). It **does**
> mean: after the candidate deploys, any backup it writes is
> candidate-format; a disaster-recovery restore of such a backup must use
> candidate-or-newer replay code, not the rolled-back code. One-directional:
> candidate replay reads old (v1) exports and reports the weaker
> `events-only` level; old replay reads neither v2 exports nor, therefore,
> post-deploy backups.

**Boot.** Old-code `RoomStore` on the restored store: cold start clean
(integrity `eager`; schema/plugin/fence/verifies phases all completed;
rooms 1, sequences 5). Supplementary direct boot of old code on a copy of
the candidate-written SQLite file itself — the closest local analog of a
real DO rollback: also clean, room found.

**Fixture vs restored counts.** Identical for every table except
`work_item_board_backfill` 0 → 1 (a restore-time bookkeeping row written by
replay itself). The public-claim writer permit is present at rest with
`enabled: 0` — the #3324 closed-at-rest contract. No candidate row was lost
or mutated: the old code's own re-export of the restored store carries
trailer eventsHash `412d10ba…`, **bit-identical to the candidate fixture's
trailer eventsHash**.

**Old-code exercises on candidate data (all passed):**

| Step | Result |
|---|---|
| E1 room read | found, sequence 5 |
| E2 events/messages read | 5 events, 2 messages |
| E3 public board listing | 8 tasks, claimableCount 4 |
| E4 receipt read | candidate receipt `pwr_ed53…` rendered with full receipt shape |
| E5 account + sessions read | account active; candidate session listed |
| E6 session slot by token | candidate-issued slot resolves live under old code |
| E7 OAuth pending state | candidate-written `github` pending state read back |
| E8 claim-prs sync (stub fetch) | `skippedInvalid: 1` — the malformed row, error: `repo must be 1..200 characters of letters, numbers, or . _ / -`; the valid PR-linked claim produced no skip and the job did not fail |
| E9 claim lifecycle | round-2 task claimed and finished under old code; read-back state `submitted`; claimable 4 → 3 |
| E10 session write | new slot + method login under old code |
| E11 auth-mail state write | verify code issued under old code |
| E12 message write | message posted under old code |

**Before/after diff.** Exactly 12 per-table deltas, every one attributed to
a named old-code exercise (E9: public_work_requests +2, public_work_receipts
+1, public_receipts +1, agent_identities +1, agent_key_registry +1; E10:
account_session_slots +1, account_credentials +1; E11: account_magic_codes
+1; E12: events +1, messages +1, commands +1, credentials +1). Zero
unexplained loss, mutation, or unreadable candidate rows. Money state
(bounty_records 1, bounty_journal 4) unchanged by old-code reads and the
sync, as required.

## §3.4 retainedRuntime — PARTIAL (named exception E-B)

Produced: at **2026-10-15T21:32:53Z** all four live version endpoints
(`room.trydemigod.com` and `www.getdasha.com/room`, `/api/version` and
`/api/version/worker`) still serve sourceRevision `c0e5aefbf…` with the
packet's build IDs — the rollback target is the currently retained,
serving runtime, and its version IDs are those recorded in packet §1.1.

Not producible in this environment: the immutable-version module read
(`scripts/manual-rollback.mjs` `targetVersion`: fetch the version with
`include=modules`, parse the embedded `SOURCE_REVISION`/`STORE_SCHEMA_VERSION`
stamp, cross-check `schemaAt`) requires `CLOUDFLARE_API_TOKEN`, which is in
John's custody and absent here (no token env, no wrangler login). The
candidate-side versions do not exist until the deploy creates them, so
post-deploy retention of the target pair can only be confirmed in the
deploy window. The rollback workflow's no-execute preflight was therefore
not run; it remains a deploy-window step.

## §3.5 workerBindings — PARTIAL at source level (named exception E-C)

Produced (names and types only, no values): `cloudflare/wrangler.jsonc` and
`cloudflare/external-probe.wrangler.jsonc` are **byte-identical** at both
revisions (blobs `ff761dfb04…`, `ed7cf4389b…`), so the declared binding
inventories are identical by construction: Durable Object binding `ROOM`
(class `ProjectRoom`; the staging env's `ROOM` names the same class via
`script_name`), KV binding `ROOM_BACKUPS_KV`, assets binding `ASSETS`,
plus `vars`. The only `cloudflare/` code change in the pair is
`cloudflare/room.mjs` (+8 lines, #3533): it *optionally reads*
`GITHUB_OAUTH_*` env secrets and degrades to the designed 503 when absent.
The rollback target reads no binding the candidate adds, and nothing the
target needs was removed or retired — extra env present after a rollback
is inert to the old code.

Not producible here: the immutable versions' *actual* binding inventories
from the Cloudflare API (same custody gap as E-B; candidate version does
not exist yet). Deploy-window step, alongside the preflight.

## §3.6 Receipt and human review — STAGED (named exceptions E-D, E-E)

`receipt.draft.json` (this directory, committed after this file so its
evidence links can name this file's commit) is the format-1 receipt of
`scripts/manual-rollback.mjs` staged with: the exact target pair
(version IDs + source revision from packet §1.1), the candidate source
revision (its version IDs are `null` — they are created by the deploy),
and per-check results that are deliberately **not** gate-passing
(`passed-with-exceptions` / `pending`): the admission gate requires
exactly `passed`, so this draft cannot be used to roll back until a human
reads this evidence and finalizes it in the deploy window by (1) filling
the candidate canonical/entry version IDs from the deploy run's
`pre-deploy-<candidate-sha>` artifact, (2) completing the E-B/E-C
Cloudflare reads and upgrading the two checks, and (3) the dispatcher
setting the workflow's `compatibility_reviewed` acknowledgment — the human
compatibility review, which is John's (or the authorized dispatcher's)
and has **not** been performed.

## Reproduction

```sh
# candidate phase (checkout of ea3e3cc51…)
QUAL_CANDIDATE_SHA=ea3e3cc51c463afb63e870cdb85e990fb0b8786b \
QUAL_SCRATCH=<dir> QUAL_SECRETS=<scratch-sidecar> \
  node ops/rollback-qualification/2026-10-15-ea3e3cc51/build-fixture.mjs
# old-code phase (this checkout for the fixture; OLD_ROOT at c0e5aefbf…)
OLD_ROOT=<checkout of c0e5aefbf> CAND_ROOT=<checkout of ea3e3cc51> \
QUAL_BUILD_SCRATCH=<build scratch> QUAL_SCRATCH=<dir> QUAL_SECRETS=<sidecar> \
  node ops/rollback-qualification/2026-10-15-ea3e3cc51/verify-old-code.mjs
```

Secrets the run creates (identity secret, session slot token) live only in
the scratch sidecar (mode 0600), never in this directory.
