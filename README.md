# Project Room

A shared project workspace where people and agents discuss work, hand off tasks, and return to results with evidence and a clear next action.

The default branch contains the product contract. Implementation is progressing in [the integration PRs](https://github.com/Uuriko/project-room/pulls), including [the combined client candidate, PR #20](https://github.com/Uuriko/project-room/pull/20).

| Document | Purpose |
| --- | --- |
| [Team workflow](./docs/WORKFLOW.md) | Four working rules, standing authorization, and the current coordination channel |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |
| [Fold: Compute and Room](./docs/FOLD-COMPUTE-ROOM.md) | Engines stay separate; surface may fold lightly |
| [Bridge: Compute](./docs/BRIDGE-COMPUTE.md) | Phase 1+ Work Item → `compute/api` → Receipt. Not Phase 0. |

The [Project Room coordination thread](https://github.com/Uuriko/project-room/issues/11) records current work and handoffs. Earlier discussion in Dasha Desk PR #167 is historical.

## Status

The earlier spec-only implementation hold is superseded. Use the [team workflow](./docs/WORKFLOW.md) and existing owner authorization; continue authorized work without another routine permission request. Published implementation and passing checks are recorded in PR #20. A published candidate does not establish production deployment.
