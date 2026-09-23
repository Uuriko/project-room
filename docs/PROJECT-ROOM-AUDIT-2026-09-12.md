# Project Room whole-product audit

- **Audit cutoff:** 12 September 2026, 11:05 PDT
- **Committed source reviewed:** [origin/main at ff7365e01e59398b29c05251164bf68947c7cd9f](https://github.com/Uuriko/project-room/tree/ff7365e01e59398b29c05251164bf68947c7cd9f)
- **Runtime code baseline:** 1a24ad1392a9768d54625e1887a5fd5bc27d5fd4; the two later commits add only RELEASE-INVENTORY and FREE-PATH documentation.
- **Live Worker observed:** a5f2dca32be0f3ba725608d3c89ce16c635b2c30, build 2026-09-12T02:13:08.899Z
- **Scope:** product intent, information architecture, desktop/mobile UX, accessibility, agent experience, API contract, domain model, authorization, privacy, abuse, storage, recovery, operations, tests, CI/release, documentation, GitHub workflow, consumer readiness, and enterprise readiness.

> **Decision:** Project Room is a strong, unusually careful bounded pilot, but current main is not a safe release candidate. Do not deploy it or distribute its OpenAPI contract until the release blockers below are closed. The live Worker is healthy but 113 commits behind this audit snapshot, so it must not be used as evidence that current-main capabilities are live.

This is an engineering/product audit, not a penetration test, compliance opinion, legal review, production restore exercise, physical-device study, or human usability study.

## 1. Executive verdict

The right product is already stated in the repository's best documents: **conversation is home; work is optional structure; agents are visible members; reports, verification, approval, and external action are different facts.** Preserve that. The competing “agent-native ledger with a thin human viewer” framing should become historical because it drives duplicate status systems and too much operational machinery into the human experience.

Project Room's strongest differentiator is not “AI chat.” It is a durable shared record where humans and agents can coordinate without confusing speech, work ownership, evidence, review, and authorization. The current reducer, transaction boundaries, provenance model, recovery discipline, and failure copy are materially better than most prototypes.

The release problem is trust. Current main contains:

1. a public API document that instructs callers to leak a private key in a URL and does not match the server;
2. an online import path that fails for real invitation history and can desynchronize authority from the rewritten ledger;
3. an agent relink path that silently restores old broader permissions;
4. user-facing Online and Done labels that assert facts the product has not established;
5. release metadata that can label dirty, uncommitted bytes with a clean commit SHA; and
6. “hard budget” copy for controls that cannot stop an external runner or provider and include a currently unreachable attempt limit.

### Readiness decision

| Milestone | Verdict | Why |
| --- | --- | --- |
| Local, synthetic engineering pilot | **Strong** | Exact current-main core suite passes 1,132/1,132; domain, auth, migration, idempotency, and recovery coverage are unusually deep. |
| Invite-only staging pilot | **Keep isolated** | The deployed Worker is healthy, but it is an older revision. Current-main features are not live evidence, and deployment must wait for the release blockers. |
| Agent API developer preview | **Blocked** | OpenAPI authentication is unsafe and false; permanent agent identity lifecycle and relink scope need repair. |
| Public consumer/community beta | **Not ready** | Key-centric entry, limited room lifecycle, no moderation/private conversations/files/notification delivery, cramped mobile chat, and no real-person/physical-device evidence. |
| Enterprise design-partner pilot | **Not ready** | No tenant isolation, IdP/SSO/MFA/SCIM, retention/deletion, immutable external audit, production observability, or qualified restore. |
| Enterprise procurement/production | **Not close** | The production architecture and governance gates are explicitly still designs, not delivered controls. |

## 2. Snapshot truth

| Surface | Observed truth at cutoff |
| --- | --- |
| Public main | ff7365e; 491 commits total, with 114 commits in the preceding 24 hours. |
| Shared local checkout | d963e4b, 114 commits behind, with 13 modified tracked files and three untracked WIP files. This audit did not edit any of them. |
| Live Worker | Health and readiness returned 200. Version endpoint returned a5f2dca / build 2026-09-12T02:13:08.899Z, 113 commits behind the audited main. |
| Schema | Current writer is 27. README and CURRENT-ROOM still say 26; SERVICE also contains older 5/7 claims. |
| Live doors | trydemigod.com/room, getdasha.com/room, and lobby.getdasha.com/room returned 200. |
| Current-main CI | Runs for the two latest documentation commits were still in progress at cutoff. The preceding 1a24ad1 run was green across contract, browser, and Cloudflare jobs. |
| GitHub queue | Three open issues and seven open draft PRs. Several drafts are old stacked branches; issue 11 is a 737-comment mailbox; issue 6's 36-item checklist remains unchecked despite substantial implementation. |
| Repository scale | 664 tracked files; 225 tracked entries under docs, 148 date-named; about 19.5K runtime source lines and 35K test/script lines. |

The new [release inventory](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/docs/RELEASE-INVENTORY.md) is a useful start and correctly marks hosted state unknown. It cannot be the only source of truth while README, CURRENT-ROOM, SERVICE, and Cloudflare README make contradictory claims. Generate this record from code, CI, and the served version endpoint.

## 3. Architecture: keep the core, change the deployment boundary

| Layer | Current design | What is good | Readiness risk |
| --- | --- | --- | --- |
| Browser | Plain HTML/CSS/JS; one large application controller | Fast, inspectable, no framework dependency, careful focus/draft/scroll recovery | app.js is 2,829 lines; mobile has nested scrolling; full projection rendering scales poorly |
| Agent clients | HTTP client, CLI, local MCP stdio, portable packets | BYO-agent path, strict origin, redirect refusal, bounded operations, no implicit execution | Public OpenAPI is wrong; no remote OAuth MCP or managed runner; identity secrets lack lifecycle |
| HTTP/SSE | One route layer with origin/CSRF/cookie/bearer checks and one-second SSE polling | Strong default-deny boundary and consistent error envelope | 780-line router, in-memory throttles/diagnostics, 100 global streams, poll-per-stream |
| Domain | One event reducer for conversation, work, evidence, decisions, and access | Excellent separation of report, verification, decision, and authority | Two user-facing status vocabularies are emerging; tombstones are not erasure |
| Store | Transactional event log plus compact projection; writer fences | Atomic events/projection/idempotency receipts; robust migration checks | Online import is unsafe; 10K-event finite room lifetime; full projections and cold-start audits |
| Cloudflare | Shared Node-compatible runtime in one Durable Object | Reuses the tested core and SQLite transaction model | Every account and room maps to invite-only-pilot: one bottleneck and one blast radius |
| External AI/compute | Deliberately outside Room | Correct separation of coordination from execution and spending | Therefore Room budgets and Stop are ledger facts, not execution enforcement |

The production evolution should remain one product and one domain model, but split storage/routing by tenant and room. Do not create microservices for their own sake. Introduce a tenant directory, per-tenant/per-room durable partitions, explicit account/organization boundaries, and a separately enforced runner/tool gateway only when those paths can be tested end to end.

## 4. What must be preserved

- Conversation remains useful without a work item.
- Addressing or mentioning an agent never grants permission, spends money, or proves that a runtime listened.
- Human, agent, reporter, producer, verifier, and decision maker remain separate identities and facts.
- Completion evidence never silently becomes independent verification or owner approval.
- Commands derive actor and time at the service boundary and commit event, projection, and idempotency receipt atomically.
- Fixed Host/Origin, HTTPS enforcement, duplicate-cookie refusal, secure HttpOnly SameSite cookies, CSRF checks, session binding, account epoch checks, and older-writer fences.
- Agent administration cannot grant manage-members or decide to agents; non-owner administrators cannot delegate authority they do not hold.
- BYO/manual agent paths stay free and usable even if hosted execution never exists.
- Failures stay beside the affected draft, uncertain writes retain an exact retry payload, and live updates preserve focus, selection, disclosures, and scroll.
- Progressive disclosure, 44px primary targets, reduced-motion behavior, no horizontal overflow at 390px, and honest labeling of synthetic evidence.

## 5. Release blockers

These are current-main blockers, not evidence that the older live Worker has every defect. Each fix needs an exact current-head regression and the full contract/browser/Worker gates before any deployment decision.

### R1 — Public OpenAPI tells callers to expose private keys

**Evidence:** [docs/openapi.yaml:5-15](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/docs/openapi.yaml#L5-L15) and [501-511](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/docs/openapi.yaml#L501-L511) define a member private key in ?auth= or x-project-room-auth. [server/http.mjs:107-118](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/http.mjs#L107-L118) accepts credentials only in Authorization: Bearer; those other fields select cookie mode and only accept room or account.

Following the spec both fails authentication and can place a durable credential in URLs, browser history, access logs, analytics, and referrers. The global security declaration is also wrong for intentionally unauthenticated identity creation, current agent-invite routes are missing, and no route/auth/spec conformance test exists. ROUTE-AUTH-TABLE also mislabels invitation acceptance as unauthenticated even though the server requires account session, binding, and CSRF.

**Required closure:** remove query/header credential schemes; define Bearer as the agent credential; mark genuinely public operations with security: []; add every supported agent route; generate or validate route/auth parity in CI; add a test that the spec never recommends credentials in URLs.

### R2 — Online room import is broken for invitation-bearing rooms and unsafe as authority recovery

**Evidence:** [server/store.mjs:1396-1407](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/store.mjs#L1396-L1407) deletes membership invitation audit rows, while [128-146](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/store.mjs#L128-L146) installs an unconditional BEFORE DELETE abort. Existing [room-export tests](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/tests/room-export.test.js#L62-L138) never seed invitation history.

A disposable reproduction issued one human invitation, exported the room, and imported the unchanged export. It failed with ERR_SQLITE_ERROR: “invitation audit is append-only.”

The path also replaces room events/projection while retaining credentials, identities, identity links, share links, and other authority tables. It can therefore desynchronize active authority, resurrect older membership state, and rewrite the purported audit ledger under one online owner bearer.

**Required closure:** disable hosted HTTP import. Restore into fresh isolated storage under maintenance, preserve the source capture, compare an external monotonic authority witness, reconcile every credential/link/session/invitation, rotate affected secrets, and require explicit operator approval. Add full invitation, share-link, identity-link, credential, removal, and old-export tests.

### R3 — Agent relink silently restores old broader permissions

**Evidence:** [server/agent-identities.mjs:70-101](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/agent-identities.mjs#L70-L101) requires requested permissions but ignores them on relink, reactivating roomMember.permissions instead. The existing relink test requests the same scope, so it cannot detect narrowing failure.

A disposable reproduction linked an identity with accept-work plus complete-work, unlinked it, then relinked while requesting accept-work only. The response reported success and omitted effective scope; the member still had complete-work.

**Required closure:** apply the newly requested, currently authorized scope through the reducer; return the effective scope; add narrower, broader, stale-owner, compromised-secret, and concurrent relink tests. Add secret generation, rotation, global revoke, expiry, and per-room audience binding before calling identity lifecycle production-ready.

### R4 — The People rail fabricates Online and premature Done facts

**Evidence:** [src/conversation.js:78-127](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/src/conversation.js#L78-L127) labels a member Online when they merely own/wait on work or posted within 15 minutes. [src/app.js:798-808](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/src/app.js#L798-L808) renders that inference and never reads the real presence endpoint; the dot is aria-hidden. This directly violates PRODUCTION-PLAN's “No fabricated online status” rule and CONVERSATION's statement that transport status is not participant presence.

[src/conversation.js:147-155](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/src/conversation.js#L147-L155) gives an agent a Done chip for any completion receipt. The canonical work chip uses terminalWork and waits for required verification/decision. A direct reproduction returned Done while the work card correctly said Awaiting verification.

**Required closure:** remove the inferred dots or show exact facts such as Watching now, Working, or Posted 8m ago with timestamps and accessible text. Use real /presence semantics for live presence. Reuse terminalWork for Done, or rename the nonterminal chip Result posted. Test contradictions across both surfaces.

### R5 — Release identity can certify dirty bytes as a clean commit

**Evidence:** [scripts/stamp-version.mjs:1-22](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/scripts/stamp-version.mjs#L1-L22) stamps git rev-parse HEAD into a tracked source file without checking the worktree. [cloudflare/wrangler.jsonc:14](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/cloudflare/wrangler.jsonc#L14) runs it before builds while assets are copied from the working tree. release-evidence similarly accepts a TAP file without proving which source produced it.

The current shared checkout is dirty and contains a stamped version file. A deploy from such a tree could serve uncommitted code while /api/version names a clean SHA.

**Required closure:** build from an exact Git archive/worktree, refuse dirty candidates, write version metadata only into generated output, bind test receipts to the content manifest, and compare served asset hashes plus source SHA before asserting live. One generated status record should replace hand-maintained live/schema claims.

### R6 — Session budgets are reported ledger guardrails, not hard execution limits

**Evidence:** [docs/SESSION-BUDGETS.md:3-5](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/docs/SESSION-BUDGETS.md#L3-L5) calls the fields hard bounds enforced by Room. [src/work-item-session.js:56-73](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/src/work-item-session.js#L56-L73) lets the worker declare optional limits, permits 1,000 attempts and 30 days despite docs saying 25 and seven days, and relies on self-reported spend. [server/store.mjs:1228-1256](https://github.com/Uuriko/project-room/blob/ff7365e01e59398b29c05251164bf68947c7cd9f/server/store.mjs#L1228-L1256) checks runtime/spend only on a later Room mutation, suppresses a failed stop write, then still says the session was stopped.

maxAttempts is effectively dead because a start only exists for queued to processing and no terminal state returns to queued. Room cannot terminate an external process, model call, tool, egress, or provider spend.

**Required closure:** rename these fields reported budget/ledger guardrails now; align code and documentation; remove or implement retry lifecycle for maxAttempts; never claim stopped without a committed receipt. A future sponsor-signed budget must be enforced by the actual runner/tool gateway and reconciled against provider usage.

## 6. High-leverage readiness gaps

### Identity, scope, and abuse

- Unauthenticated agent identity creation persists rows at 30/minute/IP. Identity secrets never expire and have no generation, rotation, global revocation, or garbage collection.
- Anonymous account-session creation persists 30-day slots at 20/minute/IP. One source can exhaust the 10,000-slot database limit in about 8.3 hours; a distributed source is faster.
- Throttles are a resettable in-memory Map. They are not a durable global, tenant, IP, capability, or creation quota.
- One active member—including a conversation-only agent—can read the full room snapshot/history and export every event. Selected work views minimize response size, not authority.
- Agent invite codes use eight characters from a 31-symbol alphabet: about 39.63 nominal bits and about 38.63 bits of minimum entropy because byte modulo 31 is biased. Codes may last 30 days; issuance is not idempotent and retained rows are unbounded/unpaged.
- The current walk-in proposal is separately owned and was not edited by this audit. Its public self-join and unauthenticated work-list slices must not ship ahead of persistent abuse controls, moderation, bounded identity lifecycle, data-minimized public views, and an explicit owner decision about public Commons.

### Data lifecycle and enterprise privacy

- Message delete is a UI/projection tombstone. Original and edited bodies remain in event history and exports.
- Private Inbox/email journals intentionally prevent deletion; there is no end-to-end retention, erasure, legal-hold, or backup deletion contract.
- There are no tenant keys, residency controls, subprocessor/data-flow inventory, DSAR/admin deletion, or verified erasure after restore.
- DMs/private groups and task-level agent context ACLs do not exist. Addressed messages are correctly room-visible, but that means any agent credential compromise exposes all shared history.

### Availability, performance, and operations

- Every account and room uses the single Durable Object named invite-only-pilot. It is one throughput ceiling, one operational unit, and one blast radius.
- SSE polls storage every second per connection and caps at 100 streams globally/three per credential.
- A room is capped at 100 members, 500 work items, 10,000 events, and a 4 MiB projection. There is no archival/compaction lifecycle, so an active chat has a finite lifetime.
- The recorded 50-agent loopback test achieved about 177 ops/s with p95 about 353ms and p99 about 1.6s; 100-agent setup hit the member limit. This is useful pilot evidence, not an enterprise capacity claim.
- RoomStore performs migrations and broad integrity verification at startup. Full-history validation on a Durable Object cold start needs a maximum-capacity benchmark against the 50ms CPU limit.
- Cloudflare observability is disabled. Diagnostics are only a 200-entry in-memory ring and disappear on restart. Health/readiness do not prove backup freshness, storage capacity, queue health, or agent health.
- Restore evidence is local/same-disk and does not establish provider PITR, RPO/RTO, off-host encrypted backup, or a production rollback.

### Consumer UX and accessibility

- At 390×844, the exact-main page had no horizontal overflow, but the nested message viewport was only 219px high and the page was 1,292px tall. Header, connection, four section shortcuts, title, Catch-up, and always-visible search consume most of the first viewport.
- Mention suggestions expose one listbox, zero options, buttons with aria-selected, and no combobox expanded/active-descendant relationship.
- People rows are pointer-only clickable divs; keyboard users cannot activate them to address a member.
- Skip to content targets connection chrome instead of the current page heading/feed.
- The Room key / Account key selector declares a radiogroup but contains pressed buttons, not radios.
- The Add agent dialog combines one-off manual use, persistent connection, named vendor presets, permissions, route, expiry, and MCP setup. It is technically careful but too much before a first successful interaction.
- Search, pins, and artifacts are incomplete: literal search and source links exist; bookmarks/pins/files/previews do not.
- Notification preferences exist, but there is no push/email/OS delivery. Private conversations, image/file sharing, voice, and screen sharing do not exist.
- Automated Chromium tests are strong. Physical iPhone/Android, Safari/Firefox, VoiceOver/TalkBack/NVDA, dictation, rotation, background/foreground, and unaided real-person testing remain open.

### Engineering and governance

- app.js (2,829 lines), store.mjs (1,703), inbox-browser-check.mjs (1,036), events.js (879), http.mjs (780), styles.css (780), and room-agent.mjs (719) mix too many responsibilities.
- Browser render work includes a per-message scan over work items, making the current path O(messages × work-items). Browser performance has not been qualified at the server's own caps.
- Static asset lists, runtime package lists, MCP tool-count pins, and test enumerations are repeated in several files. Six commits exist solely to bump MCP count pins.
- Four isolated package workflows run on every pull request even though their tests are also discovered by the root test runner; pull-request path filters are missing.
- CI has no concurrency cancellation or job timeout. A passing core run emits hundreds of expected-negative diagnostic warnings.
- PR 123 merged before its full failing check finished, followed by four failing main pushes. The observed workflow therefore did not universally block an unqualified merge.
- Cloudflare's development/build lock currently contains two high and four moderate advisories through Wrangler/Miniflare: undici 7.28.0 (fixed at 7.29.0+) and sharp 0.35.2 (fixed at 0.35.4+). They are build-supply-chain, not application runtime, findings.
- The public repository has no LICENSE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CODEOWNERS, or Dependabot configuration. Decide the intended governance before soliciting outside contribution.

## 7. Consumer and enterprise acceptance matrix

Status meanings: **Qualified locally** means implemented on audited main with executable evidence, not live or production-qualified. **Partial** means a real subset exists. **Missing** means the acceptance outcome does not exist. **Unsafe** means a delivered path contradicts the acceptance goal.

### A. Entry and consumer simplicity

| Gate | Status | Current assessment |
| --- | --- | --- |
| A1 Hosted entry and identity | Missing | Ordinary onboarding still relies on provisioned Room/account keys; no maintained IdP or recovery. |
| A2 Real room lifecycle | Partial | Account room discovery/switching exists; self-service create, leave, archive, and lifecycle administration do not. |
| A3 Invitations explain destination | Partial | Human/account and share-link previews, expiry, revocation, and bounded joins exist; delivery and production identity are absent. |
| A4 Lightweight vs reviewed work | Qualified locally | Work is optional; review/decision requirements are explicit and enforced. The new duplicate session status vocabulary needs simplification. |
| A5 Draft recovery | Partial | Opt-in session-scoped draft recovery and exact uncertain retry exist; no cross-device recovery or organization policy. |
| A6 Welcoming first room | Partial | Sign-in/chat UI is restrained, but key-centric entry and agent jargon remain; no unaided second-human result. |

### B. Conversation people return to

| Gate | Status | Current assessment |
| --- | --- | --- |
| B1 Reliable mobile composer | Partial | Strong Chromium simulation and IME guards; cramped nested scroll and no physical-device evidence. |
| B2 Search, pins, artifacts | Partial | Search, message/thread/source links exist; pins/bookmarks/files and safe previews do not. |
| B3 Unread and catch-up | Qualified locally | Durable cursors and catch-up exist without peer read receipts; current mobile presentation needs reduction. |
| B4 Quiet notifications | Partial | Preference state exists; no delivery channel, push, expiry/revocation proof, or lock-screen policy. |
| B5 Private conversations | Missing | Addressed messages remain room-visible by design. |
| B6 Social media and voice | Missing | No file/image attachment, safe preview, voice, screen sharing, recording, or transcription. |

### C. Agents as useful participants

| Gate | Status | Current assessment |
| --- | --- | --- |
| C1 Real runtime connection | Partial | Real BYO HTTP/CLI/local-MCP clients exist; no hosted runner, remote OAuth MCP, or qualified live current-main connection. |
| C2 Inspectable context | Partial | Selected task/source reads are bounded and explicit, but membership still grants room-wide read authority. |
| C3 Visible cost controls | Unsafe | Budget cards exist, but self-declaration/reporting and no execution gateway make hard-limit claims false. |
| C4 Recovery and cancellation | Partial | Idempotency, session ledger, stop-request, and handoff records exist; no real external cancellation/reconciliation. |
| C5 Evidence and independent checking | Qualified locally | Producer, reporter, evidence version, verifier, decision, and reopened history are strongly separated. |
| C6 Pause and memory controls | Partial | Room unlink/disconnect exists; no global secret lifecycle, external-provider recall boundary, or inspectable memory controls. |

### D. Organization controls

| Gate | Status | Current assessment |
| --- | --- | --- |
| D1 Tenant isolation | Missing | One database/one Durable Object with logical room rows; no PostgreSQL/RLS or actual tenant boundary. |
| D2 Enterprise identity | Missing | No OIDC/SAML/MFA/passkeys, enforcement policy, recovery, or emergency admin. |
| D3 Provisioning/offboarding | Missing | No SCIM/directory sync, groups, session inventory, or lifecycle reconciliation. |
| D4 Guests/admin separation | Partial | Time-bounded guests and scoped manage-members exist; no separate org/billing/audit roles or access reviews. |
| D5 Exportable audit trail | Unsafe | Event/export and safe diagnostic metadata exist, but any member exports the full log and online import can rewrite/break it. |
| D6 Retention/deletion/holds | Missing | Tombstones and append-only journals are not erasure or policy. |

### E. Reliability, privacy, and community operations

| Gate | Status | Current assessment |
| --- | --- | --- |
| E1 Tested capacity | Partial | Useful loopback load data and explicit caps; no browser-at-cap, multi-region, or replacement architecture. |
| E2 Restore/rollback drill | Unsafe | Local drills exist, but representative invitation history breaks import and authority reconciliation is unproved. |
| E3 Durable operations | Partial | Writer fences, maintenance mode, health, and support export exist; observability, durable throttle, alerts, and redundancy do not. |
| E4 Moderation/abuse | Missing | No reporting, blocking, spam operations, appeals, or public-community readiness. |
| E5 Encryption/secrets/data location | Partial | HTTPS, hashed secrets, and strict local credential files are strong; no tenant keys, residency, or full data-flow policy. |
| E6 Accessibility/device evidence | Partial | Automated Chromium/reflow work is substantial; semantic defects and real AT/device/browser coverage remain. |

### F. Switching, support, and proof of value

| Gate | Status | Current assessment |
| --- | --- | --- |
| F1 Authority-safe import | Missing | No Slack/Discord/GitHub import; room JSONL import is unsafe and fixture email is not a provider integration. |
| F2 Portability and exit | Partial | Machine-readable event export exists; no complete human export, files, account/space closure, or policy-aware exit. |
| F3 Consumer activation | Missing | No two-person unaided join/chat/artifact/return study or retention evidence. |
| F4 Enterprise exercise | Missing | No two-org, guest, agent, offboarding, audit, and restore exercise. |
| F5 Sustainable packaging | Missing | FREE-PATH states a useful promise; measured cost, usage reporting, packaging, and pricing decisions do not exist. |
| F6 Support/trust evidence | Missing | No named support/incident/status process, security policy, privacy terms, subprocessor packet, or certification. |

## 8. Simplify before adding more surface

1. **One product contract.** Keep README/CHAT-FIRST/PRODUCTION-PLAN's conversation-first model. Replace the competing thin-human/agent-ledger lock with one page: talk first, optional accountable work, agents visible, execution separate.
2. **One visible work state.** Keep the six work states plus one next action. Put queued/processing/active/suspended/done/failed under operational agent-session details. Do not show both status strips on ordinary work cards.
3. **One release truth.** Generate source SHA, qualified SHA, live SHA/build, schema, asset manifest, test receipt, and timestamp. README links it; historical checkpoints never override it.
4. **One declarative manifest each.** Generate runtime assets, browser checks, Worker checks, MCP tools, and capability coverage from canonical lists; delete count-pin churn.
5. **Archive or integrate shadow packages.** act-components, activity-inbox, member-capabilities, and hosted-denial-conformance import nothing into the product. Integrate useful behavior or move them to a clearly historical experiments/archive area and stop running duplicate CI.
6. **Archive checkpoint archaeology.** Keep a small active set: Product, UX, Architecture/API, Security/Operations, Testing, Release. Put dated checkpoints behind one archive index and repair/remove broken evidence links.
7. **Split along stable domains, not a framework rewrite.** Extract auth/session, conversation, work, people/presence, and Inbox controllers from app.js; route modules from http.mjs; store modules by authority/domain. Preserve shared reducer predicates.
8. **Make mobile Chat and Work real sibling views.** Use most of the first viewport for messages plus composer, collapse connection/search, move People into a sheet, and remove nested page/feed scrolling.
9. **Reduce routine message chrome.** Show used reactions plus one Add reaction control on focus/selection; keep 44px targets. Replace four scroll shortcuts with actual mobile views or a compact section menu.
10. **Close stale coordination loops.** Issue 11 is not a durable 737-comment work database. Keep ephemeral claims on the bus/board; create small GitHub issues with owner, acceptance, exact baseline, and supersession links. Close/archive obsolete draft PRs only after an explicit retained-scope decision.

## 9. Ordered execution handoff

Every task below must be claimed on the shared bus and board before editing. This audit assigns no one else's branch or file and does not authorize push or deployment.

| Order | Task | Done when |
| --- | --- | --- |
| 1 | Correct OpenAPI/auth contract | No key-in-URL guidance; public vs Bearer operations exact; route/auth/spec conformance blocks drift. |
| 2 | Repair agent relink scope | Requested authorized scope becomes effective and is returned; narrow/broad/concurrent/compromised-secret tests pass. |
| 3 | Quarantine and redesign import | Hosted route disabled; representative restore occurs in isolated storage and reconciles every authority side table. |
| 4 | Remove false Online/Done claims | Real presence or precise activity labels; canonical terminal predicate; accessible text; contradiction tests. |
| 5 | Make release provenance exact | Clean immutable source package, generated version file, content-bound test receipt, served-hash verification, one release inventory. |
| 6 | Correct budget truth | Ledger wording now; effective maxAttempts semantics; no stopped claim without receipt; gateway enforcement design before hosted spend. |
| 7 | Harden public creation/abuse boundary | Persistent/global quotas, lifecycle/GC, longer unbiased invite secrets, idempotent issuance, body termination, alerts. |
| 8 | Accessibility + mobile chat pass | Correct mention semantics, keyboard People action, useful skip target/auth group, ≥60% first-view chat/composer target at 390×844, real AT/device checklist. |
| 9 | Scale/operations tranche | Tenant/room partition design, pagination/windowing, browser-at-cap test, cold-start benchmark, privacy-safe observability, off-host restore evidence. |
| 10 | Product/governance cleanup | One product contract, active-doc set, stub/CI disposition, PR/issue cleanup, license/security/contribution decisions. |

The separately owned AGENT-WALK-IN-IMPLEMENTATION-PLAN-2026-09-12.md was read but not edited. Its remote MCP work depends on R1, R3, and the identity lifecycle work. Its public Commons self-join depends additionally on moderation, persistent abuse controls, minimized public reads, and an explicit product decision. Do not merge those gates merely to reduce owner setup effort.

## 10. Verification receipts

- Exact ff7365e full core check: **1,132 tests passed, 0 failed, 0 skipped** in 23.0s after fetching required history.
- Node coverage reported by the engineering audit: **96.04% lines, 89.78% branches, 95.03% functions**. This excludes meaningful browser/UI behavior and is not whole-product coverage.
- Exact-main browser inspected with a fresh disposable synthetic room at desktop and 390×844. Signed-out live entry and all three public doors were also inspected read-only.
- UX targeted checks: 18/18 on exact origin; 20/20 on the preserved WIP. No physical device or assistive-technology session was performed.
- Dynamic disposable-store reproductions confirmed invitation-history import failure and narrow-relink scope restoration. A suspected invite privilege-drift path was also tested and correctly rejected by the reducer's scoped-administration check.
- Live Worker: /api/version, /api/health, /api/ready, discovery card, public doors, and security/cache headers checked without authenticating or mutating data.
- Live headers included no-store, strict CSP, no-referrer, nosniff, and noindex. HSTS/Permissions-Policy/COOP/CORP remain hardening decisions.
- Cloudflare dependency audit found two high and four moderate build-time advisories; the production application itself has no third-party runtime package dependency.
- Public-tree scan found no committed credential/private-key signatures or tracked database/env/key files.
- GitHub state and recent workflow results were read through the public API. No issue, PR, branch, deployment, room, user, or external account was changed.

## 11. Coordination and file safety

- The canonical shared checkout's pre-existing WIP was preserved exactly.
- This new audit file is the only repository file written by this work.
- Findings R1-R6 and the two dynamically reproduced authority/recovery defects were sent to the local coordination bus for the owning agents.
- No push, merge, deploy, Worker reset, provider call, external message, money action, or live-room mutation was performed.
- Audit subreviews were independent and read-only: UX/accessibility, security/architecture/privacy, and code/test/release.

## 12. GitHub triage snapshot

Open issues:

- [#6 — Consumer + enterprise readiness](https://github.com/Uuriko/project-room/issues/6): useful acceptance model, but all 36 boxes are stale relative to current implementation.
- [#11 — Swarm coordination mailbox](https://github.com/Uuriko/project-room/issues/11): active, 737 comments at cutoff; too large to be durable current truth.
- [#19 — Parallel swarm plan](https://github.com/Uuriko/project-room/issues/19): acknowledged as stale but still open.

Open draft PRs: [#7](https://github.com/Uuriko/project-room/pull/7), [#9](https://github.com/Uuriko/project-room/pull/9), [#16](https://github.com/Uuriko/project-room/pull/16), [#17](https://github.com/Uuriko/project-room/pull/17), [#18](https://github.com/Uuriko/project-room/pull/18), [#22](https://github.com/Uuriko/project-room/pull/22), and [#26](https://github.com/Uuriko/project-room/pull/26). Several target old or stacked branches; #26 was conflicted during the audit. Preserve intent, but do not merge or mechanically rebase any of them without a current-head scope review.

## 13. Final product call

Do not broaden the feature list yet. First make every visible and machine-readable claim true, make authority recovery safe, and establish one exact release record. Then improve the first five minutes: invitation-first entry, a full-height mobile conversation, two clear agent intents (“use once” versus “connect”), and one status/next action.

After those foundations, the next durable product investment is not more agent ceremony. It is real identity, room lifecycle, moderation, retention, notification delivery, tenant isolation, and measured operation—so the excellent human/agent provenance core can be trusted by people outside the development team.
