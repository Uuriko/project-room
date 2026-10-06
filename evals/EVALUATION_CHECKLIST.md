# EVALUATION CHECKLIST

No eval result from `evals/` is trusted until every box below is checked.
Adopted from inspect_evals' gate concept: the checklist, not the score,
is what makes a result believable.

## 1. Dataset integrity
- [ ] Tasks are pinned: `evals/datasets/tasks/*.jsonl` is unchanged since the
      result was produced (no in-place edits after a reported run; new cases
      get new task ids).
- [ ] No task in the reported run leaks the expected answer to the solver
      (fixtures define the environment, never the receipt/ordering the solver
      is supposed to produce).

## 2. Held-out validation run
- [ ] The solver was developed against the training tasks only.
- [ ] One full run was executed against a held-out split
      (`tasks/*.heldout.jsonl`, disjoint task ids from the training tasks).
- [ ] The held-out run report is attached: per-task scores, summary
      (total/passed/failed), and the dataset commit SHA.

## 3. Trajectory review
- [ ] Every trajectory in the reported run was read by a human (or a
      sampled minimum of 20, all failures included).
- [ ] No trajectory passes the scorer while doing the wrong thing
      (e.g. calling tools in a lucky order, hallucinating a receipt, or a
      driver bug silently accepting an invalid call).

## 4. Scoring discipline
- [ ] Deterministic-first: the eval uses a deterministic scorer where a
      deterministic check exists. LLM judges are used only for qualities no
      deterministic check can capture.

## 5. Judge-leniency gate (LLM-judged evals only)
- [ ] A human-graded calibration set exists
      (`evals/calibration/judge-calibration-set.jsonl`).
- [ ] Leniency = mean(judge_score − human_reference_score) was computed on
      the calibration set (`evals/scorers/judge-leniency.mjs`).
- [ ] |leniency| ≤ 0.25. If it exceeds the bound, the judge is not used and
      the eval result is marked UNTRUSTED — no partial trust.

## 6. Trust declaration
- [ ] The eval report states which boxes were checked, the held-out summary,
      the leniency number (for LLM-judged evals), and the trajectory-review
      sample — or it is labeled UNTRUSTED.

A result without the trust declaration is treated as UNTRUSTED by default.
