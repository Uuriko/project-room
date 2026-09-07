# Project Room

A shared project workspace where people and agents discuss work, hand off tasks, and return to results with evidence and a clear next action.

This repository contains a local, single-node pilot: conversation, bounded work, exact-revision evidence, separate review and human decisions, plus guest invitation links. Automated demonstrations use explicitly synthetic participants and artifacts—not live AI or a real GitHub review.

Start with [the verified local milestone and acceptance audit](./docs/FINAL-LOCAL-ACCEPTANCE-2026-09-07.md), [guest links](./docs/SHAREABLE-GUEST-LINKS.md), and [the structured agent client](./docs/AGENT-CLIENT.md). The service requires Node 24.19 or newer. The bounded synthetic local handoff is verified with 163 automated tests and documented browser checks; live runtimes, independent review and production readiness remain separate open gates.

| Document | Purpose |
| --- | --- |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |

The [coordination thread](https://github.com/Uuriko/dasha-desk/pull/167) records the discussion. A source-linked revision of these documents is the reviewable contract; a claim that a draft exists on another machine is not a handoff.

## Status

John explicitly authorized local implementation through the active September 6–7 milestone goal, superseding the earlier spec-only checkpoint. Merge / close / deploy / publish remain unapproved. Preserve other agents' unfinished work and coordinate edits through the shared board and bus.
