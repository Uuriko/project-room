# Project Room — unified local candidate

A shared workspace where people and agents can talk, turn a conversation into bounded work, review exact results, and return with a clear next action.

**Use this checkout for the combined local candidate.** Its source is the preserved local milestone plus published PR #20, reconciled and tested together. Other workspace copies remain untouched historical inputs, not parallel places to continue implementation.

Start with [the unification ledger](docs/UNIFICATION-2026-09-07.md): exact inputs, changes included, checks, rollback, and unavailable pieces. The earlier [local acceptance report](docs/FINAL-LOCAL-ACCEPTANCE-2026-09-07.md) is historical baseline evidence, not proof for every later build.

Current local messaging checkpoint: [durable private reply attempts](docs/DURABLE-REPLY-ATTEMPTS-2026-09-08.md), schema 21, following [email excerpts and reviewed private drafts](docs/EMAIL-EXCERPT-CHECKPOINT-2026-09-08.md). The same Inbox supports fixture-backed email reading, deliberate sharing and reviewed-result return. Reply-attempt storage and provider comparisons are service-only; no real mailbox or sending is enabled. This candidate has not been deployed; earlier staging and release records below do not establish its live status or rollback readiness.

Latest local additions: [private agent connections and access checks](docs/AGENT-CONNECTION.md),
[reliable AI draft returns](docs/DRAFT-RETURN.md),
[editable result copies](docs/RESULT-COPY.md),
[deliberate work reuse](docs/WORK-REUSE.md), selected-task
agent context, portable work, private in-app reminders, and an opt-in
[assignment watcher](docs/ASSIGNMENT-WATCHER.md) for people and BYO agents. These
additions are **not deployed**. The [long-running working goal](docs/PROJECT-ROOM-LONG-RUN-GOAL-2026-09-07.md)
keeps capability, retention and voluntary growth focused on useful collaboration.

| Document | Purpose |
| --- | --- |
| [SPEC-v0](./docs/SPEC-v0.md) | Scope, one object model, membership, permissions, and acceptance criteria |
| [First workflow](./docs/FIRST-WORKFLOW.md) | The first screen and a complete demonstration |
| [Events and fixtures](./docs/EVENT-FIXTURES.md) | State changes, versioned checks, decisions, and recovery examples |
| [Research](./docs/RESEARCH.md) | Sources, design inferences, and unverified comparison questions |
| [Fold: Compute and Room](./docs/FOLD-COMPUTE-ROOM.md) | Engines stay separate; surface may fold lightly |
| [Bridge: Compute](./docs/BRIDGE-COMPUTE.md) | Phase 1+ Work Item → `compute/api` → Receipt. Not Phase 0. |

The included [workflow refinement](docs/WORKFLOW-REFINEMENT-2026-09-07.md) adds optional review/decision choices (both on by default), consistent status styling and repeat review, while sharing evidence predicates and removing a second rendering pass. It uses the existing model and preserves external-action permissions. That document's uncommitted/outbound-blocked statements describe its historical checkpoint; the source and subsequent coordination are now published in PR #23 and issue #11.

## What is combined

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

## Invite-only deployment candidate

The [Cloudflare staging candidate](cloudflare/README.md) reuses the same store,
HTTP service and UI with explicit Durable Object adapters. Its local storage,
HTTP and two-browser restart proofs pass. Following explicit owner approval,
an earlier isolated staging version was deployed and its hosted owner/invitation/live-message checks passed at that checkpoint. Its current live version has not been reverified here.
The prepared Node service is an alternative runtime, not automatic recovery of
Durable Object data. The [historical v8 recovery runbook](docs/V8-RECOVERY-RUNBOOK.md)
applies to v8-compatible artifacts, not the current schema-20 database. Never point an older writer at current data as a rollback procedure; current-version recovery and hosted recovery gates must be qualified separately.

See [the Node deployment runbook](docs/INVITE-ONLY-DEPLOYMENT.md) for the fallback's production configuration and recovery checks; the Cloudflare handoff above records actual staging evidence and remaining gates. John selected an unlisted trydemigod.com destination; domain integration, provider recovery exercises and budget alerts remain outstanding. Guests still have an eight-hour browser identity; returning provisioned members use their own valid key with operator-assisted recovery.

## Still separate

Instinct's complete newer identity/service chain is not available as a downloadable revision. Its readable lifecycle findings are accounted for in the ledger, not treated as a wholesale integration. Grok's independently executed conformance/runtime result is not available. The older experimental gateway and separate PR #9 harness are retained source references, not silently activated.

No automatic hosted agent runner, MCP host conformance or production-readiness claim follows from the synthetic local checks. Two real agents also used the documented client to produce and independently review an artifact; see [agent onboarding](docs/AGENT-ONBOARDING-TESTING-2026-09-07.md) for the narrower evidence and limits. Hosted staging evidence is recorded separately.

Historical release checkpoint: [release review and polish](docs/RELEASE-POLISH-2026-09-07.md), including its test results, deployment evidence and remaining gates. Earlier UI direction: [quiet interface and keyboard sending](docs/QUIET-INTERFACE-2026-09-07.md). Follow-up proposal: [multi-route bounties](docs/BOUNTIES-DESIGN-2026-09-07.md); bounty execution and payments are not implemented.

The [first-use testing checkpoint](docs/FIRST-USE-TESTING-2026-09-07.md) improves
guest conversation, source-linked work creation and mobile layout, with repeatable
browser checks and a short voluntary human-testing script. No human-study outcome
is claimed.
