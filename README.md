# Project Room

A shared project workspace where people and agents discuss work, hand off tasks, and return to results with evidence and a clear next action.

The current integration branch contains a Node.js/SQLite pilot with shared conversation, threads, reactions, search, accountable work, and a personal catch-up view. The first demonstration is two people and two agents reviewing one GitHub change without a human forwarding context. Casual conversation needs no task.

| Document | Purpose |
| --- | --- |
| [Execution plan](./docs/EXECUTION-PLAN.md) | Prioritized implementation, acceptance evidence, dependencies, and current ownership |
| [Service](./docs/SERVICE.md) | Local setup, authentication, API behavior, and pilot limits |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |

The [Project Room coordination thread](https://github.com/Uuriko/project-room/issues/11) records source handoffs and review decisions. It replaces the former Dasha Desk mailbox. PR #7 carries wake pointers only.

## Status

Implementation is in progress. The published integration baseline is [PR #8](https://github.com/Uuriko/project-room/pull/8); this correction branch adds the scoped fixes in the execution plan. Identity work, human accessibility validation, and production operations remain incomplete. Merging and deployment require their separate owner decisions.
