## Fixtures / journeys / docs tooling

### Fixtures (all synthetic — headers uniformly stress "never production")

| Script | Purpose | Consumed by |
|---|---|---|
| acceptance-fixture.mjs | (no header) acceptance fixture | tests/acceptance-fixture.test.js |
| acceptance-handoff.mjs | Advance only the synthetic fixture through producer/reviewer API exchanges | acceptance tests |
| candidate-manifest.mjs | Frozen candidate manifest: pin runtime, assets, schema, package hashes | deploy/acceptance |
| candidate-runtime-fixture.mjs | Test-only packaging of allowlisted working files; never a release certificate | packaging tests |
| email-contract-fixture.mjs | Invented Microsoft Graph-shaped data; no real mailbox/people/tokens | email contract tests |
| frozen-runtime-fixture.mjs | Test-only fixture loader; never mutates a frozen package or its manifest | runtime tests |
| gmail-contract-fixture.mjs | Invented Gmail API shaped data (users.messages) | gmail contract tests |
| gmail-live-fixture.mjs | Stateful provider double; never contacts Google or sends real email | gmail live tests |
| inbox-result-fixture.mjs | Scripted participants, synthetic local data; never hosted execution | inbox tests |
| real-agent-fixture.mjs | Operator-started, loopback-only fixture for real agent participation | agent exercise tests |
| record-rails-fixture.mjs | Synthetic qualification helpers on the real event/durable rail authority | rails tests |
| recovery-fixture.mjs | Disposable synthetic data; never import from a production entrypoint | recovery tests |
| reply-review-fixture.mjs | Deliberately invented provider history; not a provider driver | reply tests |
| reply-update-fixture.mjs | Shared invented mailbox/update fixture; never contacts a provider | reply tests |
| request-host-fixture.mjs | Explicit synthetic native-host exercise; never opens an existing Room DB | host tests |
| result-copy-agent-fixture.mjs | Disposable read-only actual-agent exercise; never opens a caller's DB | result tests |
| results-fixture.mjs | Disposable fictional results; no provider reads/execution/publication | results tests |
| synthetic-mail-fixture.mjs | Local test double with own database; never imported by deployed entrypoint | mail tests |
| telegram-contract-fixture.mjs | Invented Telegram Bot API shaped data; no token/chat export/real people | telegram tests |
| work-lifecycle-agent-fixture.mjs | Synthetic same-room participation; never a hosted runner | lifecycle tests |
| work-reuse-agent-fixture.mjs | Disposable actual-agent exercise; no production paths | reuse tests |

### Journey checks

| Script | Purpose |
|---|---|
| contribution-journey-check.mjs | Full synthetic browser journey; no human research claims |
| first-result-journey-check.mjs | W4-50 L2 first-result onboarding: newcomer joins from invite link |
| inbox-collaboration-journey.mjs | Test-only staged human simulation; agent choices via MCP |
| public-work-mcp-journey-check.mjs | Synthetic outside-agent usability: hosted endpoint replayed to real MCP |
| unified-journey-check.mjs | Combined local UI/API journey; all synthetic participants |
| signin-browser-journey.mjs | Reach recovery through visible password-first entry, incl. invitation hosts |
| journey-coverage.mjs | Journey coverage map (M1): every claimed capability links to executable evidence; runs in scripts/check.mjs:28 |

### Route / docs gates

| Script | Purpose | CI gate |
|---|---|---|
| route-docs-check.mjs | Route documentation gate (re-audit 2026-09-14, M4) | via check.mjs |
| routes-inventory.mjs | Legacy route inventory (batch RT) | manual |
| route-acceptance.mjs | Prove a route is mounted before a receipt is accepted | manual |
| openapi-gen.mjs | OpenAPI gate (batch RT): regenerates/verifies docs/openapi.yaml | scripts/check.mjs:37 (`--check`) |
| openapi-method-accuracy.mjs | Method-level OpenAPI contract accuracy (TASKS.md task 16) | tests/openapi-method-accuracy.test.js |
| docs-link-check.mjs | Intra-repo markdown links in maintained docs (docs/history/ excluded) | scripts/check.mjs:64 |
| check-wiki.mjs | Wiki schema check: docs/ROOM-WIKI.md must be well-formed append-only log | scripts/check.mjs:59, trace-entry.yml |
| wiki-build.mjs | W009: build-time embed of wiki planes for the read API | scripts/check.mjs:62 (`--check`) |
| skills-sync.mjs | skills/ is the only source for Project Room skills; copies the tree | manual |
| skills-sync-check.mjs | Fails when plugins/project-room/skills/ is not an exact copy of skills/ | manual |
| sign-agent-card.mjs | Build-time signer for the room's A2A Agent Card (RC-2026-09-23-105) | build |
| build-agent-docs.mjs | Build static /docs/agents pages from docs/agents/*.md + connect table | build |

### Behavioral notes
- Fixture headers are uniformly explicit about never touching production — good hygiene; the one exception is acceptance-fixture.mjs with no header at all.
- `routes-inventory.mjs` is labeled "Legacy" in its own header — superseded by openapi-gen/route-docs-check but still in the tree.

### Stale flags
- None in this slice (headers match behavior).

### Suspected bugs
- None in this slice.

DONE: 40 scripts, 0 stale flags, 0 suspected bugs
