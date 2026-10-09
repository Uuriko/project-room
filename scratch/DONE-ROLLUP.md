# DONE-ROLLUP — COORD-300 GUILD-05 (collision avoidance)

> Branch: `coord300/guild-05` · head `3eb5a49cff6b4086a0f7f74f48c69067a2bf2be3`
> (pushed to origin 2026-10-09 ~13:00 PDT; parent of `aa21ff2ec4d5491d55a067307e6a0fa7fce46c96`)
> Worktree: `~/workspace/pr-coord300-guild-05/` (kept; `.tmp/` TMPDIR inside)
> Charter: `scratch/GUILD-CHARTER.md` (file-based — no room post identity at depth 2)

## Redirect acknowledged (Dot seq 8263, 12:23 PDT)

Original 50-worker "build new" mission cancelled per Dot. Delivered the
redirected mission instead: **normalize ancestor/descendant path overlaps,
propose partitions — report-only**. No workers launched, no live claims
touched, no permissions altered, board/protocol unchanged, no new queue.

## Built (all additive, nothing wired into main)

- `scripts/collision-path-normalize.mjs` — scope canonicalizer + pairwise
  classifier (`disjoint`/`identical`/`a-contains-b`/`b-contains-a`/`partial`)
  with per-scope evidence. Segment-boundary cover check kills the
  `server/`-vs-`serverless/` false positive class.
- `scripts/collision-partition-propose.mjs` — deterministic static planner:
  heaviest-first expansion + LPT assignment, then a machine-checked
  disjointness proof over every agent pair (fail-closed, exit 3). One
  canonical planner is the structural fix for the WAVE-1000 22:12
  duplicate-launcher incident.
- `scripts/collision-check.mjs` — pre-dispatch gate: exit 0 clear /
  2 collision (evidence on stdout) / 1 usage error. The check the 22:12
  launcher never ran.
- `tests/collision-path-overlap.test.js` — **19/19 pass** (`node --test`).
- `tests/fixtures/collision/` — replay18-28, docs10-33, server-lease-pr2272
  fixtures (reconstructions from Dot's descriptions; originals not found on
  the #266 board — documented).
- `docs/COLLISION-PATH-OVERLAP.md` — design, measurements, integration deps,
  explicit "what is NOT proven" (§7 items).

## Measured results

- Combined 6-claim fixture board: **15 pairs → 1 overlap detected**
  (`replay18` contains `replay28`, evidence: `agent-conversations/` covers
  `agent-conversations/replay-scenarios/skill-harness/`), **14 disjoint,
  0 false positives**.
- Acceptance verdicts: replay18/28 → `a-contains-b` (collision caught);
  docs10/33 → `disjoint` (shared ancestor `docs/` correctly not flagged);
  broad `server/` lease vs PR #2272
  (`tests/qa5r-mcp-public-work-suggest.test.js`, verified via `gh pr view`) →
  `disjoint` (lease does not cover the PR).
- Live-repo scan (read-only `git ls-files`): `docs/` (548 files) → 6 agents
  at 91–92 files each (16.6–16.8%), **15/15 pairs verified disjoint**.
  (First cut gave one agent the whole 366-file `docs/history/` subtree at
  66.8% — fixed with balance-refinement expansion; history in commit.)
- Negative controls (all in-suite): `server/`≠`serverless/`, self-pair skip,
  `./`+`//` canonicalization, file-vs-dir same-location conservative flag,
  duplicate-scope `identical`, `partial` overlaps, CLI exit-code contract.

## Caveats / not proven

- Fixtures reconstruct Dot's one-line descriptions; original incident scopes
  unverified. Path overlap ≠ semantic conflict (see doc § "What is NOT
  proven", 7 items). No live-board validation (needs a board→JSON exporter,
  not built per redirect scope). ESLint unrunnable in worktree (no
  node_modules) — `node --check` clean + tests green instead.
- BUG CONFIRMED: none filed (no production bugs encountered; tooling is new).

## For the parent / launcher

- Relay option: if the parent holds a room posting identity, the charter
  (`scratch/GUILD-CHARTER.md`) and this rollup may be relayed to the room;
  this guild posted nothing itself (zero room events, per wave rule).
- Suggested follow-ups for other guilds: guild-01 can gate CLAIM acceptance
  on `collision-check.mjs` exit codes; guild-02 can measure live
  false-positive/negative rates once a board→JSON exporter exists;
  guild-04 can carry `a-contains-b` verdicts as structured handoff payloads.
