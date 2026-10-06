# Datasets

Pinned task sets for the evals/ harness, agbench-style: one JSON object per
line in `tasks/*.jsonl`. Records are immutable once an eval result has been
reported against them — fix a bug by adding a new task id, never by editing
a task in place.

## Record schema

| field | required | meaning |
|---|---|---|
| `id` | yes | stable task id, e.g. `wcj-01` |
| `solver` | yes | solver name under `evals/solvers/`, e.g. `join-claim-finish` |
| `notes` | no | why this task exists |

Solver-specific fields ride along in the record (e.g. `room`, `agent`,
`taskId` for the claim journey; `toolName`, `args` for the MCP journey) and
are passed to the solver untouched.

## Held-out split

`tasks/*.heldout.jsonl` (same schema) is the validation split: it must be
disjoint from the tasks the solver was developed against, and the
[EVALUATION_CHECKLIST.md](../EVALUATION_CHECKLIST.md) requires one run
against it before any result is trusted.
