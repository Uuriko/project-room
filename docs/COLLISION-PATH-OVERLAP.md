# Collision path-overlap normalization + static partition proposals

**Guild:** COORD-300 guild-05 (collision avoidance) · **Branch:** `coord300/guild-05`
**Status:** Additive prototype. No imports, routes, or behavior of `main` touched.
Nothing here is wired in — these are standalone scripts + docs + tests.

> Redirect note (2026-10-09, Dot seq 8263): this guild was re-aimed from
> "build new collision-avoidance systems" to "repair observed coordination
> failures": normalize ancestor/descendant path overlaps and propose
> partitions. Report-only. No live claims touched, no permissions altered,
> no workers launched, board/protocol unchanged.

## The problem, concretely

Agents collide on file scope in four observed shapes:

1. **Duplicate dispatch** — WAVE-1000's 22:12 duplicate-launcher incident
   launched guilds 05/08/15/18 twice. Two launchers each computed "the"
   partition independently; nothing checked before the second dispatch.
2. **Same owed list, two legs** — identical scopes filed twice; naive
   equality on unnormalized paths (`./server//x` vs `server/x`) misses it.
3. **Broad lease vs narrow claim** — a lane holds `server/`, another files
   `server/http.mjs`. String-equality says "no overlap". Wrong.
4. **Substring false positives** — `server/` must not match `serverless/`;
   `docs/` shared as an ancestor must not flag two disjoint `docs/`
   partitions as colliding.

## What was built

| Artifact | Purpose |
|---|---|
| `scripts/collision-path-normalize.mjs` | Core library + CLI. Canonicalizes scopes, classifies every claim pair as `disjoint` / `identical` / `a-contains-b` / `b-contains-a` / `partial`, with per-scope evidence. Pure, offline, exit 0, no side effects. |
| `scripts/collision-partition-propose.mjs` | Static partition planner. Given N agents + a repo map (or `--scan` via read-only `git ls-files`), emits N disjoint slices by heaviest-first expansion + LPT assignment, then **proves** disjointness with the normalizer (fail-closed: exit 3 if the proof fails). One deterministic planner kills the duplicate-launcher class. |
| `scripts/collision-check.mjs` | Pre-dispatch gate. `--claims snapshot.json --new new.json` → exit 0 clear, 2 collision (with evidence), 1 usage error. This is the check the 22:12 launcher never ran. |
| `tests/collision-path-overlap.test.js` | 19 tests, `node --test`. All green. |
| `tests/fixtures/collision/*.fixture.mjs` | The three acceptance fixtures, reconstructed from Dot's descriptions (see below). |

### Normalization rules (the whole model)

- A scope is a repo-relative path. **Trailing slash = directory (recursive)**,
  no trailing slash = single file.
- Canonical form: strip leading `./` and `/`, drop `.`/empty segments,
  resolve `..` lexically, single trailing-slash bit. `./server//http.mjs`
  ≡ `server/http.mjs`.
- Scope A **covers** scope B iff same canonical location, or A is a dir and
  B's path starts with `A.path + '/'` — **segment boundary required**, so
  `server/` never covers `serverless/`.
- A file scope and a dir scope at the *same* location are treated as covering
  each other (conservative: `docs` vs `docs/` collides).
- Pair verdicts: `identical` (mutual cover, no strict side), `a-contains-b` /
  `b-contains-a` (one-sided strict cover), `partial` (some scopes overlap,
  neither side contains the other), `disjoint`.

### Partition planner notes

- Expansion: split the heaviest splittable node until ≥ N leaves, then keep
  splitting any leaf heavier than the ideal per-agent share (bounded at
  256·N leaves so giant flat dirs degrade to file-level slices).
- Assignment: LPT (longest-processing-time first) — deterministic 4/3
  approximation for makespan; ties broken by path.
- Verification is not optional: the planner re-runs every agent-pair through
  `classifyPair` and refuses to emit on any non-disjoint pair.

## Acceptance fixtures (Dot seq 8263)

All three are **reconstructions** from Dot's one-line descriptions — the
original claim scopes were not recoverable from the board search
(`replay18`/`docs10` return no hits on `uuriko/project-room#266`), so the
fixtures encode the *described overlap shape* with the *named paths*.

1. **replay18/28** — `replay-scenarios/skill-harness` vs `agent-conversations`
   overlap. Fixture: `replay18` scopes `agent-conversations/`,
   `replay28` scopes `agent-conversations/replay-scenarios/skill-harness/`.
   Verdict: **`a-contains-b`** — the narrow claim sits entirely inside the
   broad one. This is the collision the tooling must catch.
2. **docs10/33** — docs partitions. Fixture: `docs10` scopes
   `docs/tutorials/` + `docs/guides/`; `docs33` scopes `docs/api/` +
   `docs/reference/`. Verdict: **`disjoint`** — shared ancestor `docs/` is
   not an overlap. This is the false positive the tooling must avoid.
3. **broad server lease vs PR #2272** — Fixture: `srv-lease-broad` scopes
   `server/`; `pr-2272` scopes `tests/qa5r-mcp-public-work-suggest.test.js`
   (PR #2272's actual file list, verified via `gh pr view` — OPEN, one test
   file). Verdict: **`disjoint`** — the lease does not cover the PR.

Measured on the combined 6-claim board: **15 pairs, 1 overlap detected
(replay18⊃replay28), 14 disjoint, 0 false positives.**

Measured on the live repo (`--scan`, read-only `git ls-files`): `docs/`
(548 files) → 6 agents at 91–92 files each (16.6–16.8% shares), 15/15 pairs
verified disjoint. Before the balance refinement, one agent drew the whole
366-file `docs/history/` subtree (66.8%) — documented in commit history.

## Integration dependencies

- **Guild-01 (room protocol v2):** `collision-check.mjs` is a natural
  pre-claim gate for first-claim-wins automation — run it before accepting a
  CLAIM, reject or flag on exit 2. No code shared yet; integration is a
  one-line subprocess call away.
- **Guild-04 (agent messaging):** overlap verdicts (`a-contains-b` +
  evidence paths) are structured handoff payloads — "your claim sits inside
  mine at these paths" beats prose.
- **Guild-02 (overhead measurement):** can measure live false-positive /
  false-negative rates by running the normalizer over real board snapshots.
- **Room board read path:** today the tools consume fixture JSON. Feeding
  live claims needs a board→JSON exporter over the existing `scripts/room`
  board parsing — not built (out of scope per redirect; report-only).
- **No new queue, no protocol change** per Dot's constraints.

## What is NOT proven

1. **Fixtures are reconstructions, not replays.** The verdicts are proven
   against the *described shapes*; whether the original replay18/28 incident
   matches the fixture exactly was not verifiable from the board.
2. **Path overlap ≠ semantic conflict.** Two agents editing different files
   under one claimed dir may still conflict semantically (shared config,
   generated files); conversely `pr-2272`'s test exercises server-adjacent
   behavior without living under `server/`. The tooling answers the *path*
   question only.
3. **No live-board validation.** The normalizer has not been run against a
   full live claim snapshot (needs the board→JSON exporter, not built).
4. **Partition balance is approximate.** LPT guarantees ≤ 4/3 of optimal
   makespan on the leaf set, but leaf granularity (giant flat dirs →
   file-level slices) bounds how fine the balance can get. Weights are file
   counts by default — a better weight (churn, lines) is caller-supplied.
5. **No temporal dimension.** Heartbeat freshness, lease expiry, and
   stale-claim arbitration are out of scope — the tools answer "do these
   scopes overlap *now*", not "is this claim still alive".
6. **Adversarial scopes not modeled.** A malicious scope string is just
   normalized; there is no trust model here — the tools are for cooperating
   agents, not enforcement.
7. **ESLint not run** — the worktree has no `node_modules`; all files pass
   `node --check` and the 19-test suite. Lint before any merge that wires
   these in.

## Run it

```sh
# Normalize a claim snapshot (report-only, stdout JSON)
node scripts/collision-path-normalize.mjs --claims board.json --pretty

# Pre-dispatch gate: exit 0 clear / 2 collision / 1 usage error
node scripts/collision-check.mjs --claims snapshot.json --new newclaim.json

# Propose 6 disjoint docs/ slices from the live tree (read-only scan)
node scripts/collision-partition-propose.mjs --scan . --agents 6 --scope docs/

# Tests
node --test tests/collision-path-overlap.test.js
```
