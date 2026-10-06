# Review parallelism: cheap-first, then judgment

Reviews are the serial choke alongside landing. The parallelization strategy
is two passes with a clean handoff between them:

1. **Cheap-first mechanical pass** — automatic, deterministic, no LLM.
   Runs on every PR via `.github/workflows/review-mechanical.yml`.
2. **Strong-model judgment pass** — a human or lane reviewer in clean
   context: they get ONLY the diff, the claim, and the mechanical report.

The merge gate is unchanged: merge only after a rev-reviewer's explicit
APPROVE on the exact head, never with an open CHANGES REQUESTED.

## 1. The mechanical pass

`review-mechanical` runs on `pull_request` (opened, synchronize, reopened,
edited). One check run does two stages, both written to the same job summary:

- **fast** (immediately): diff size + claim-scope match. `gh` + `node`
  only, no `npm install`, so the reviewer sees signal in ~1 minute.
- **full** (same run, after a bounded ~40 min wait): the job polls for the
  `test` workflow run on the PR head and appends the lint and test-suite
  conclusions. If the wait times out, the report says `timed-out` honestly
  instead of guessing.

A second trigger, `workflow_run` on the `test` workflow, re-emits the full
report event-driven with no polling — it activates once this workflow file
is merged to the default branch. It binds the report to
`workflow_run.head_sha` (the tested commit): if the PR head moved since the
test run, it skips instead of pairing a stale conclusion with a new head —
the `pull_request` job owns the current head. It reports:

| signal | source |
|---|---|
| diff size | files changed, lines added/deleted from the PR |
| claim-scope match | `scripts/review-scope-check.mjs`: does the diff touch only the files the claim declared? |
| lint | conclusion of the `test` workflow's lint job |
| test suite | conclusion of the `test` workflow run |

The result lands as a **machine-readable JSON block** in the check-run job
summary, marked with `<!-- review-mechanical-report -->`, plus a small
human table. The JSON shape (emitted by
`scripts/review-mechanical-report.mjs`) is the contract: `check`, `stage`,
`pr`, `head`, `lint`, `tests`, `files_changed`, `lines_added`,
`lines_deleted`, `scope: {verdict, drift, declared}`, `generated_at`.
Fetch it without opening a browser:

```bash
gh run list --workflow review-mechanical.yml --branch <branch> --limit 1
gh run view <run-id>  # job summaries carry the report
```

Scope drift (touched-but-undeclared files) is a **warning annotation**, not
a failure. Claims legitimately grow — lockfiles, generated files, a second
file the fix turned out to need. The reviewer acknowledges the drift in
their verdict; they do not re-run the check.

## 2. Declaring claim files in the PR body

The scope check reads one HTML comment from the PR body (invisible when
rendered):

```html
<!-- claim-files: server/a.mjs, tests/a.test.js -->
```

Comma- or newline-separated; several comments merge. A trailing `/` covers
a whole directory (`scripts/`). A bare name without the trailing slash is
exact-only (`scripts` does **not** cover `scripts2/x.mjs` — that is a
deliberate guard against prefix false-matches).

No comment → verdict `undeclared` → the reviewer checks scope by hand.
Always declare; it costs one line and buys the whole mechanical pass.

## 3. The judgment pass: clean-context protocol

The reviewer opens the PR with exactly three inputs and nothing else:

1. **The diff** — `gh pr diff <n>`, the exact head under review.
2. **The claim** — title, declared files, and note from the work-claims
   board. Not the room thread that produced it.
3. **The mechanical report** — the JSON block above.

What the reviewer does NOT read: the full room history, the lane's
working notes, other PRs' threads. Cognition's production pattern holds
here: clean-context reviewers catch ~2 bugs per PR because they read what
the code says, not what the author meant.

Reviewer checklist:

- [ ] Mechanical report read: lint/tests green, scope verdict noted.
- [ ] Diff read in full against the claim (not against the thread).
- [ ] Scope drift, if any, acknowledged or challenged.
- [ ] Verdict posted on the exact head: APPROVE or CHANGES REQUESTED with
      file:line specifics. No verdict, no merge.

## 4. Lane-pairing experiment

Pairing builder + reviewer from the **start** of a claim, on one crew,
to see whether early reviewer context cuts review rounds and time-to-merge.

Protocol:

- The reviewer is named in the claim's room post (ASK) before work starts.
- Builder shares the plan + mechanical report link as soon as the PR
  exists; reviewer does one early read and posts questions as PR comments.
- The formal exact-head review still happens; it is the merge gate.
- Measure per PR: **review rounds** (CHANGES REQUESTED → re-review cycles)
  and **time from PR open to merge**.

Baseline (recent merged PRs, measured 2026-10-05):

| PR | review rounds | open → merge |
|---|---|---|
| _fill from `gh pr view`_ | | |

Honesty rule: one paired PR is one sample. Report the numbers, do not
generalize. The experiment earns a second crew only if the numbers move.

## 6. Review-state surface + single-lane routing

Two lanes must never review the same PR, and no lane may trust a verdict
posted on a head that has since moved. The machine-readable surface is
`scripts/review-state.mjs` (unit-tested in `tests/review-state.test.js`):
run it against open PRs to get, per PR, the assigned reviewer, every
verdict's head SHA, and staleness flags.

Routing rules:

1. **One lane per PR.** Every non-draft PR that needs review routes to
   exactly one reviewer lane. No qualifying PR sits unreviewed.
2. **Assignment sticks across head moves.** When the author rebases or
   pushes a fix, the assigned lane re-reviews — a new lane is not assigned.
   This ends the re-review treadmill where each head move triggered a fresh,
   duplicated judgment pass.
3. **Author never reviews their own PR.** The deterministic slot skips the
   author's lane.
4. **A verdict covers one head.** Verdict provenance is
   `{ reviewer, verdict, headSha, at }` — who judged what on which exact
   commit, when. A verdict on a moved head is **stale** and does not gate a
   merge, consistent with the provenance model in #1614 (evidence frozen onto
   the version it describes; here the version is the PR head).
5. **No silent drops.** A PR with no eligible lane lands in `unrouted` in
   the state output; the coordinator re-routes from `unrouted` before merge.

Routing is deterministic (PR number → lane slot), so independent
coordinators compute the same assignment without negotiating. Persist the
assignment file (`--assign-file`) between runs to keep stickiness. Drafts are
never routed. The state surface reads GitHub PR reviews only; it changes no
merge gate.

## 7. What this does not change

- `npm run check` / `npm run lint` / the `test` workflow remain the quality
  gates. The mechanical pass aggregates and adds scope; it duplicates no
  test execution.
- Branch protection and the lander rule (APPROVE on the exact head) are
  untouched. This workflow is informational, never required.
- Money-adjacent code paths (bounties, $DASHA, payouts) keep their existing
  review bar regardless of what the mechanical pass says.

The shared `Uuriko` publisher login does not identify the authoring lane. Supply a trusted local `--author-lanes file.json` map of PR number to lane (from the coordination record) before routing those PRs; missing attribution leaves them explicitly unrouted. This report grants no approval or merge authority. A reviewer’s outstanding changes request remains blocking until that same reviewer replaces it, even if another reviewer approves.
