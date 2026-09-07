# Project Room — unified local candidate

A shared workspace where people and agents can talk, turn a conversation into bounded work, review exact results, and return with a clear next action.

**Use this checkout for the combined local candidate.** Its source is the preserved local milestone plus published PR #20, reconciled and tested together. Other workspace copies remain untouched historical inputs, not parallel places to continue implementation.

Start with [the unification ledger](docs/UNIFICATION-2026-09-07.md): exact inputs, changes included, checks, rollback, and unavailable pieces. The earlier [local acceptance report](docs/FINAL-LOCAL-ACCEPTANCE-2026-09-07.md) is historical baseline evidence, not proof for every later build.

The current uncommitted [workflow refinement](docs/WORKFLOW-REFINEMENT-2026-09-07.md) adds optional review/decision choices (both on by default), consistent status styling and repeat review, while sharing evidence predicates and removing a second rendering pass. It uses the existing model and preserves external-action permissions.

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

See [the deployment runbook](docs/INVITE-ONLY-DEPLOYMENT.md) for the explicit production configuration, same-host HTTPS proxy, persistent database, verified backups, service definitions and hosted acceptance checklist. No live deployment has occurred. Hosting/domain/budget and a real-host acceptance run remain outstanding. Guests still have an eight-hour browser identity; returning provisioned members use their own valid key with operator-assisted recovery.

## Still separate

Instinct's complete newer identity/service chain is not available as a downloadable revision. Its readable lifecycle findings are accounted for in the ledger, not treated as a wholesale integration. Grok's independently executed conformance/runtime result is not available. The older experimental gateway and separate PR #9 harness are retained source references, not silently activated.

No deployment, real agent runtime, MCP host conformance, independent implementation review or production-readiness claim follows from the synthetic local checks.

Latest local checkpoint: [quiet interface and keyboard sending](docs/QUIET-INTERFACE-2026-09-07.md). Follow-up proposal: [multi-route bounties](docs/BOUNTIES-DESIGN-2026-09-07.md); bounty execution and payments are not implemented.
