# Room Scorer — Warp-shaped LLM judge

17 September 2026. Contract + kit stub. Not a live door.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Personas:
[ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md).

Catalog row: **Scorer (LLM-judge)** on
[ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) — Optional later, not a
live `/room/kits` door.

First steal map (research):
[#457](https://github.com/Uuriko/project-room/pull/457). Cua / Fleet
receipts that scorers judge:
[ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md)
([#454](https://github.com/Uuriko/project-room/pull/454)).

## What

LLM-as-judge agents grade **past** Work Item sessions. One dimension per
scorer. Classifications + a pass threshold — not a vanity 1–10. Sampled.
Observer may open a PR on Room instructions / skills from failing
patterns. **Human merge only.**

Needs a full `room.receipt.v1` (tools + artifacts + human comments via
`traceRef`). **Scorers judge Done receipts, not Done chips.** Chip =
People-rail face; receipt = evidence. Do not invent scores without a
trace.

## File layout (factory-as-code steal)

`scorers/<slug>/scorer.md`:

```markdown
---
name: task-compliance
description: Did the agent complete the Work Item as asked?
agents: [implementation, review]
labels:
  - value: pass
    score: 1.0
  - value: partial
    score: 0.5
  - value: fail
    score: 0.0
passingScore: 1.0
samplingRate: 15
model: fast-default
selfImprovement: false
---
Judge only the receipt + trace for this Work Item. Return exactly one label.
```

Default stubs live under [examples/scorers/](examples/scorers/).

### Frontmatter

| Key | Rule |
| --- | --- |
| `name` | Slug. One dimension. Matches the directory name. |
| `description` | One line. What this judge measures. |
| `agents` | Personas whose Done receipts this scorer may sample. |
| `labels` | Closed set. Each has `value` + numeric `score`. Not a free-text grade. |
| `passingScore` | Inclusive threshold. `passed` iff `score >= passingScore`. |
| `samplingRate` | Integer percent of eligible Done receipts to sample (5–25 typical). |
| `model` | Judge model pin. Prefer Roy `fast-default` ([ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md)). |
| `selfImprovement` | If `true`, recurring fails may open a PR on Room instructions / skills. **Human merge only. Never auto-merge.** |

Body after the frontmatter is the rubric. The judge returns **exactly
one** label from `labels`.

## Default scorers

| slug | Dimension |
|------|-----------|
| [task-compliance](examples/scorers/task-compliance/scorer.md) | asked vs delivered |
| [efficiency](examples/scorers/efficiency/scorer.md) | unnecessary tool loops / stuck screenshots |
| [procedure-compliance](examples/scorers/procedure-compliance/scorer.md) | used right kits / Cua loop |
| [people-data-safe](examples/scorers/people-data-safe/scorer.md) | receipt artifacts contain no people-data |

One dimension per file. Do not collapse these into one mega-judge.

## Runtime

1. Work Item → Done + `room.receipt.v1` (the **Done receipt**; the
   Done chip is face only)
2. Sample by `samplingRate` (or on-demand re-score for kit testing)
3. Scorer persona grades offline
4. Classification + reasoning stored on `receipt.scores`
5. If `selfImprovement` is true: open a PR on Room instructions / skills
   — **human merge only**

Do not score every chat turn. Do not stuff this into Compute Start.

Failure click-through (product face later): open the scorer run beside
the original Work Item thread. No opaque “72% quality” badge.

## Cost

Target ≤3–5% of Room agent tokens. Prefer the Roy fast-default model
for judges. Sampling exists to keep that bound honest.

## Stay-outs

Live kit door · Connect HTML · People rail · Done-chip chrome ·
Phase 0 #8 / #9 · Quill trees · Compute Start · people-data in traces ·
auto-merge self-improve · Potter keys.
