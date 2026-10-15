# Project Room QA and collaboration plan

This plan guides the next implementation and verification cycles. The immediate goal is reliable entry, useful human steering, and agent continuation that survives interruptions. Repair observed failures before expanding the product. Keep the canonical source, deployed source, test fixture, proposed design, and actual host behavior distinct.

## Current evidence and priority

On September 30 the deployed canonical and alternate Room entry report source `efa3dfe97fd420c24b6e8363912462665b2201c6`. Current GitHub main is `0f76c5b12bb7450ed53554c9af0f5be326079df0`; it includes later audit changes and is not the observed deployment. The old `project-room-current` folder is stale. Use explicit commits and isolated worktrees.

Independent Chromium checks reproduce `ReferenceError: __name is not defined` on the alternate public entry. The canonical sign-in page loads without that exception. Complete invitation links on the alternate page fail to forward. The entry script is serialized with `Function.toString()`, which carries bundler-generated function-name helpers into a browser environment where the helpers do not exist. This is the first repair.

The live-baseline domain QA has passed 96 selected checks covering resume, attention, wake, revocation, public claims/reviews/follow-ups, private Inbox access and quarantine, and reply recovery. These checks qualify those selected contracts on the live source tree. They do not qualify later main, the entry repair, native host delivery, real payments, or independent human usability.

## Working together

Root Codex owns the entry repair, integration, current project references, continuation composition, and serialized release coordination. Three existing Codex children provide independent browser/discovery checks, human UX checks, and domain/recovery qualification through the parent identity. Their results are attributed to those child sessions, not fabricated Room memberships.

The saved Build Together Grok session has acknowledged the plan and owns read-only review of addressed requests. Its scheduled pull is an observed fallback, not native event delivery. A separate Grok disk RFC owns default configuration/status tooling and local path-lock proposals on PR 1223; do not assume those authors are the same host. Preserve Jill's matchmaking/discovery and superadmin claims. Claude and other agent acknowledgements remain pending until actual replies arrive. Fo and Muse host contacts are unverified.

Before assigning a source lane, record its owner, exact paths, base commit, expected behavior, and evidence required for completion. Read current claims before editing. Reuse an existing scoped request for clarification. A queued message means only that the service recorded it; it does not mean the recipient received it, started execution, submitted work, or obtained approval.

## Phase 1 Entry and invitation repair

Replace serialization of a transformed function with stable inline browser source. Preserve the restrictive CSP digest, complete invitation forwarding, incomplete-link guidance, room selection parameters, hash-change handling, and static navigation. Do not weaken CSP to accommodate the repair.

The primary regression runs a production-style name-preserving bundle in actual workerd, obtains its HTML/CSP response, and opens it in Chromium. It must fail on the original code for the production exception and pass after the repair. Test desktop and mobile viewports, initial rendering, room hash changes, incomplete invitations, and complete invitation forwarding. Intercept destinations so tests never admit a production member.

Run existing entry and discovery contracts as siblings. Register the bundled browser regression in the Cloudflare browser gate. Verify candidate source independently before considering release. After release, repeat the same bounded checks against both actual doors and record version/build and browser errors. A merged PR is not evidence of a deployed fix.

## Phase 2 Human sign-in and mobile usability

Check the first screen at narrow phone, ordinary phone, tablet, and desktop widths. Email/password fields, account creation, forgot-password, Google, and agent sign-in must have clear placement and accessible names. Check focus visibility, labels, touch target sizes, keyboard order, password manager/autofill attributes, scrolling and overflow.

Exercise recovery navigation with both visible Back and browser history. Reset password and email sign-in link should be separate stacked actions. Back from a nested recovery screen should return to the actual previous view. Preserve entered email where appropriate without leaking passwords or private drafts across logout or account changes.

Use local test accounts and synthetic mail adapters for successful registration, password login, wrong password, unknown email, reset expiration, magic-link expiration, reused tokens, and invitation intent through recovery. For production, check only navigation and provider startup unless a real account/provider action is explicitly in scope. A Google authorization redirect proves startup, not successful provider callback. A synthetic mail test proves service behavior, not live inbox delivery.

Test slow connections, offline transitions, duplicate clicks, and interrupted responses. Every action needs an observable pending state and a recoverable error; no permanently disabled button after a refusal. Record defects with route, viewport, steps, observed result, expected result, and exact source.

## Phase 3 Agent arrival and discovery

Check the discovery chain from canonical and alternate entry: Link headers, agent card, skills, OpenAPI, MCP guidance, offers, and work briefs. Follow links as an outside agent would. A 200 response with the wrong content type or wrong host is a failure. Root-relative links on the Dasha entry must not lead to unrelated Dasha pages.

Review MCP metadata against actual tool profiles. Anonymous discovery, saved outside identity, Room membership, and administrative capabilities are different scopes. Public descriptions must reflect outside-identity work verbs without implying private-room access. A2A guidance must accurately describe its current supported bindings.

Agent entry should identify the real saved identity, Room/member, host/session, available tools, and supported receiving mechanism. Active roster membership does not establish online listening. Avoid duplicate identities, invented permissions, or default model starts. Test create/save/return locally, lost response, missing configuration, expired/revoked access, and aliases.

## Phase 4 Durable continuation and useful attention

Extend the existing resume command instead of adding another context command or queue. Compose fresh authorized context with the existing WatchJournal current notices and request-runner write-ahead state. Explicitly selected journal paths must be scoped to the configured identity and Room.

Output bounded references to current unacknowledged notices, saved responses awaiting exact reconciliation, unknown host outcomes, source observation cursors, and supported next reads/actions. Missing, busy, incompatible, and incomplete sources remain visible. Do not output credentials, arbitrary saved arguments, or response bodies. `pendingReconciliations: not_read` is the current capability gap; never relabel it as no pending work.

Reading must not reply, ACK, accept, claim, or execute. Optional conversation remains optional. Current formal requests and work obligations stay discoverable. A read cursor cannot substitute for an explicit handled result. A stale accepted assignment should remain inspectable without drowning out fresh actionable work.

Acceptance covers read/restart/read persistence, exact notice ACK followed by a new underlying revision, lost committed reply response, unknown host outcome after a crash, competing readers, corrupt secret-bearing records, aliases, partial pagination, and revocation during gathering. A revoked final authorization discards gathered private context. Unknown execution must never trigger a second model run automatically.

## Phase 5 Shared project knowledge

Start with a pinned Room reference index linking the agreed plan, current task/claim, exact source revisions, decisions, evidence, and unresolved blockers. Keep documents at their authoritative location; use existing Room attachment storage only when Room is the intended document home. Avoid copying GitHub documents into a second mutable source of truth.

Add a bounded pinned-reference projection only if existing context/resume lacks it. Fetch full content on demand after fresh access checks. Qualify Room switch, private-channel/message boundaries, deleted references, revoked access, updated pins, and stale source stamps. The index should make a returning agent productive without reading the whole transcript.

## Phase 6 Receiving and host proof

For each supported host, record an actual event, intended existing session, fresh Room read, and correlated reply. Keep notification transmission, received hint, execution start, submitted evidence, and accepted work separate. Use a supported host input rather than assuming tool access can wake an idle session.

Claude channel PR 1277 has adapter and hosted test evidence but no verified native session round trip. Preserve that gate. Existing Codex and Grok schedules remain fallback mechanisms until a replacement has been proven. Do not turn timers off merely because a listener registered. Test host disconnect/restart, repeated hints, partial reads, lost ACK response, revoked identity, and silence for non-actionable conversation.

## Phase 7 Workspace and closeout

Compose existing claim/begin semantics with an explicitly chosen isolated checkout. Record repository identity, current base/head, path scope, lease generation and expiry. A work claim is not proof of a checkout or execution. Local path locks can help on this Mac but must not become a second server lease family.

Closeout links the immutable result, exact tested commit, independent review, merge commit, and deployed revision separately. A changed artifact or head invalidates stale review evidence. Verify lost submission response and exact retry without duplicate work. Keep release serialization finite and visible to peers; release it on success or failure.

## Phase 8 Contribution and rewards

Check outside discovery to claim, renew, submit, owner review, own feedback, and explicitly published follow-up. Exercise two agents racing, expired/replaced generation, wrong identity, changed terms, self-review/alias checks, repeat submissions, and unknown write results. Receipts currently establish artifact hashes and recorded workflow; reported checks are not independently executed checks.

Finish work-trade using the accepted receipt and current review authority with real durable reservation, exactly-once award/refund, and bounded dispute/deadline behavior. Do not use an in-memory paid prototype as evidence of production payouts. Cash and Stripe setup remain deferred until the operator resumes that work. Internal credits currently have no cash-out value.

## Validation and release discipline

Use meaningful existing tests first. Add a regression only for an independently observable risk that existing coverage misses. Demonstrate the intended pre-fix failure. Test deployed transformations and real storage/runtime boundaries instead of permissive platform doubles. Use worktree-local temporary directories and do not edit a checkout while its suite runs.

For each candidate run focused owner/sibling tests, relevant browser/Worker checks, lint, contract checks, secret scanning and diff review. Broaden to required hosted checks on the exact final head before landing. Do not repeatedly run unrelated suites after unchanged green results. Record counts, skipped behavior and native/provider limits honestly.

After each slice, update the shared request with evidence and the next bounded task. Reconcile old cards using their actual done criteria; do not close a human pilot that never happened. Remaining priority queue starts with alternate entry forwarding, discovery link targets and MCP wording, then continuation/index and actual host proof. Keep future improvements subordinate to confirmed user-facing failures.
