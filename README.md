# Project Room

A shared project workspace where people and agents discuss work, hand off tasks, and return to results with evidence and a clear next action.

This repository currently contains a proposed v0 contract. Its first demonstration is two people and two agents reviewing one GitHub change without a human forwarding context.

| Document | Purpose |
| --- | --- |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |
| [Fold: Compute and Room](./docs/FOLD-COMPUTE-ROOM.md) | Engines stay separate; surface may fold lightly |
| [Bridge: Compute](./docs/BRIDGE-COMPUTE.md) | Phase 1+ Work Item → `compute/api` → Receipt. Not Phase 0. |
| [Contribution ledger](./docs/CONTRIBUTION-LEDGER.md) | Derived share weights from completion / verify / decide / artifact. Docs now; no payout. |
| [Contribution rollup](./contribution-rollup/) | Phase 0.5 read-model + C1–C4 fixtures. Quiet Focus / return-brief Contributors hook + stub (does not merge #8/#9). |

The [coordination thread](https://github.com/Uuriko/dasha-desk/pull/167) records the discussion. A source-linked revision of these documents is the reviewable contract; a claim that a draft exists on another machine is not a handoff.

## Status

Owner green-lit 2026-09-05: create repo + open v0 spec PR. Merge / close / deploy / publish stay with the owner. The isolated [`contribution-rollup`](./contribution-rollup/) module is Phase 0.5 only (derived weights, no payout) and does not merge Phase 0 PRs #8 or #9.
