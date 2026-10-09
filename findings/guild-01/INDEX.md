# WAVE-1000 guild-01 (claim-core) — findings index

Slice: `server/work-claims.mjs`, `server/work-claim-*.mjs`,
`server/claim-coordination.mjs` (7 files, 3398 lines).
Branch: `wave1000/guild-01`. 50 work units: 15 mutation + 15 fuzz +
11 re-verify + 9 docs.

## Results

- **Mutation: 15 run, 3 killed, 12 survived.** No pre-existing bugs found
  (0 BUG CONFIRMED). 3 test gaps closed with fail-first regression tests
  (`tests/work-claim-mutant-gaps.test.js`, each verified to fail against its
  mutant); 9 survived mutants classified equivalent/benign. → `mutants.md`,
  raw logs `mutants-raw/`.
- **Fuzz: 15 harnesses, ~380 inputs total, all PASS.** Invariants pinned:
  no double-claim win (500-way race), lease math exact + monotonic, 4xx-never-500
  on hostile inputs, size bombs refused at documented bounds, PR URL parsing
  never throws, lapsed leases never settle, kill-9 mid-upsert leaves no torn
  rows. Harness: `tools/fuzz-g01.mjs` (deterministic, seeded). Raw logs
  `fuzz-raw/`.
- **Re-verify: 11 wave branches.** 5 integrate cleanly onto current
  origin/main (data-plane-fastpath, elegant-wclaims, elegant-wcmisc,
  elegant-wcroutes-a, perf-stmt-cache-r2 — affected suites green except two
  failures that reproduce on plain origin/main, i.e. pre-existing).
  6 do NOT integrate (fix5, fix12, fix18, fix69, sharded-claim-boards,
  elegant-server — rebase AND merge conflict). Adversarial finding: the
  elegant-* family removes 62 input-validation checks from work-claims.mjs;
  if revived, validation parity must be re-verified. Raw reports
  `reverify-raw/`.
- **Docs: 9 files.** Module docs (`modules/`), state machine, callers,
  gotchas, dead-code analysis.

## Bugs confirmed

None. The slice is in good shape: every injected fault was either caught
by the suite or provably benign, and every hostile input was refused or
handled.

## Dead code

1 dead export with repo-wide evidence: `workClaimRegistry`
(`server/work-claim-routes.mjs:106`) — zero references. → `dead-code.md`.

## Files

- `mutants.md`, `mutants-raw/` — mutation results
- `fuzz-raw/` — fuzz results (F1..F15)
- `reverify-raw/` — per-branch re-verify reports
- `modules/` — per-module documentation
- `state-machine.md`, `callers.md`, `gotchas.md`, `dead-code.md`
- `dead-code-evidence.txt` — reachability raw output
- `tools/` — mut-spec.json, mut-run.sh, fuzz-g01.mjs, fuzz-run.sh,
  rev-run.sh, reach.mjs (reusable harnesses)
