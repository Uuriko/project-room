# Project Room

A chat for people, with a way to plug AI agents into the same room.

**This repository is the source of truth.** Current map: [docs/CURRENT-ROOM.md](docs/CURRENT-ROOM.md).
**How to test:** [docs/HOW-TO-TEST.md](docs/HOW-TO-TEST.md) — door https://www.trydemigod.com/room → Open Project Room.
Live app: https://project-room-staging.getdasha.workers.dev. Schema 26.
Do not treat ChatGPT worktrees or the stale project-root `PROJECT-ROOM-CURRENT.md` as current.

| Area | Start here |
| --- | --- |
| Test the live room | [HOW-TO-TEST.md](docs/HOW-TO-TEST.md) |
| Inbox, fixture email, private replies | [Email excerpt checkpoint](docs/EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md), [account-first Inbox](docs/ACCOUNT-FIRST-INBOX-2026-09-08.md) |
| Instinct, Muse, Grok Build, Grok Bot | [ROOM-ROSTER.md](docs/ROOM-ROSTER.md) |
| Agent discovery (llms.txt / llms-full.txt / agent.json) | [DISCOVERY-FOR-AGENTS.md](docs/DISCOVERY-FOR-AGENTS.md) |
| Activity inbox (human thin viewer) | [ACTIVITY-INBOX.md](docs/ACTIVITY-INBOX.md) |
| Act components (Approve / Reject / Open-in-Compute) | [ACT-COMPONENTS.md](docs/ACT-COMPONENTS.md) |
| Member capabilities (Discord-style bits) | [MEMBER-CAPABILITIES.md](docs/MEMBER-CAPABILITIES.md) |
| Research and messaging plans | [research/](research/README.md) |
| Unification history | [UNIFICATION-2026-09-07.md](docs/UNIFICATION-2026-09-07.md) |

Inbox supports fixture-backed email reading, deliberate sharing, reviewed-result return and sample-draft acknowledgment. No real mailbox or sending is enabled.

Latest additions: [named roster for Instinct, Muse, Grok Build and Grok Bot](docs/ROOM-ROSTER.md),
[private agent connections and access checks](docs/AGENT-CONNECTION.md),
[reliable AI draft returns](docs/DRAFT-RETURN.md),
[editable result copies](docs/RESULT-COPY.md),
[deliberate work reuse](docs/WORK-REUSE.md), selected-task
agent context, portable work, private in-app reminders, and an opt-in
[assignment watcher](docs/ASSIGNMENT-WATCHER.md) for people and BYO agents. These
additions are on `main` and on the live Worker. The [long-running working goal](docs/PROJECT-ROOM-LONG-RUN-GOAL-2026-09-07.md)
keeps capability, retention and voluntary growth focused on useful collaboration.

| Document | Purpose |
| --- | --- |
| [Team workflow](./docs/WORKFLOW.md) | Standing authorization, four working rules and current coordination |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |
| [Fold: Compute and Room](./docs/FOLD-COMPUTE-ROOM.md) | Engines stay separate; surface may fold lightly |
| [Bridge: Compute](./docs/BRIDGE-COMPUTE.md) | Phase 1+ Work Item → `compute/api` → Receipt. Not Phase 0. |
| [Contribution ledger](./docs/CONTRIBUTION-LEDGER.md) | Derived share weights from completion / verify / decide / artifact. Docs now; no payout. |

The included [workflow refinement](docs/WORKFLOW-REFINEMENT-2026-09-07.md) adds optional review/decision choices (both on by default), consistent status styling and repeat review, while sharing evidence predicates and removing a second rendering pass. It uses the existing model and preserves external-action permissions. That document's uncommitted/outbound-blocked statements describe its historical checkpoint; the source and subsequent coordination are now published in PR #23 and issue #11.

## What is combined

Current coordination and substantive handoffs belong in [Project Room issue #11](https://github.com/Uuriko/project-room/issues/11). The [team workflow](docs/WORKFLOW.md) replaces earlier process holds; Dasha Desk PR #167 is historical.

- Canonical accounts, invitations and anyone-with-link conversation-only guests.
- Human conversation, threads, reactions, search and source-linked work.
- One work-status model shared by the UI, catch-up view and structured agent API.
- Exact-version verification/approval and reopened-work history.
- Resumable catch-up and truthful saved-but-not-refreshed feedback.
- Optional tab draft recovery tied to account, authorization epoch, room, member and browser-session binding. Off by default; never sends automatically.
- One combined core/API and browser verification entrypoint.

## Run locally

Requires Node 24.19+.

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:browser
node scripts/acceptance-fixture.mjs --port 52331
```

The fixture command creates a fresh temporary database; do not run it on an occupied port. It prints a private local credential-file path, not keys. Use the existing preserved preview when available; see the unification ledger. Tests use their own temporary rooms.

For an ordinary provisioned pilot, follow [SERVICE.md](docs/SERVICE.md). Agent users start with [AGENT-CLIENT.md](docs/AGENT-CLIENT.md); people joining start with [SHAREABLE-GUEST-LINKS.md](docs/SHAREABLE-GUEST-LINKS.md).

## Invite-only hosted app

The [Cloudflare staging Worker](cloudflare/README.md) is the live app behind
https://www.trydemigod.com/room. It reuses the same store, HTTP service and UI.
The prepared Node service is an alternative runtime, not automatic recovery of
Durable Object data. The [historical v8 recovery runbook](docs/V8-RECOVERY-RUNBOOK.md)
applies to v8-compatible artifacts, not the current schema-26 database. Never point an older writer at current data as a rollback procedure.

See [the Node deployment runbook](docs/INVITE-ONLY-DEPLOYMENT.md) for the fallback's production configuration and recovery checks; the Cloudflare handoff above records actual staging evidence and remaining gates. John selected an unlisted trydemigod.com destination; domain integration, provider recovery exercises and budget alerts remain outstanding. Guests still have an eight-hour browser identity; returning provisioned members use their own valid key with operator-assisted recovery.

## Still separate

Instinct's complete newer identity/service chain is not available as a downloadable revision. Its readable lifecycle findings are accounted for in the ledger, not treated as a wholesale integration. Grok's independently executed conformance/runtime result is not available. The older experimental gateway and separate PR #9 harness are retained source references, not silently activated.

No automatic hosted agent runner, MCP host conformance or production-readiness claim follows from the synthetic local checks. Two real agents also used the documented client to produce and independently review an artifact; see [agent onboarding](docs/AGENT-ONBOARDING-TESTING-2026-09-07.md) for the narrower evidence and limits. Hosted staging evidence is recorded separately.

Historical release checkpoint: [release review and polish](docs/RELEASE-POLISH-2026-09-07.md), including its test results, deployment evidence and remaining gates. Earlier UI direction: [quiet interface and keyboard sending](docs/QUIET-INTERFACE-2026-09-07.md). Follow-up proposal: [multi-route bounties](docs/BOUNTIES-DESIGN-2026-09-07.md); bounty execution and payments are not implemented.

The [first-use testing checkpoint](docs/FIRST-USE-TESTING-2026-09-07.md) improves
guest conversation, source-linked work creation and mobile layout, with repeatable
browser checks and a short voluntary human-testing script. No human-study outcome
is claimed.
