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
edited) and again when the `test` workflow completes. It reports:

| signal | source |
|---|---|
| diff size | files changed, lines added/deleted from the PR |
| claim-scope match | `scripts/review-scope-check.mjs`: does the diff touch only the files the claim declared? |
| lint | conclusion of the `test` workflow's lint job |
| test suite | conclusion of the `test` workflow run |

The result lands as a **machine-readable JSON block** in the check-run job
summary, marked with `<!-- review-mechanical-report -->`, plus a small
human table. Fetch it without opening a browser:

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

## 5. What this does not change

- `npm run check` / `npm run lint` / the `test` workflow remain the quality
  gates. The mechanical pass aggregates and adds scope; it duplicates no
  test execution.
- Branch protection and the lander rule (APPROVE on the exact head) are
  untouched. This workflow is informational, never required.
- Money-adjacent code paths (bounties, $DASHA, payouts) keep their existing
  review bar regardless of what the mechanical pass says.
