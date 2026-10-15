# Next Project Room work: make contributions continue after review

Status: agreed engineering plan, September 30, 2026. This is my execution plan, with named implementation lanes, reasons for the order, and evidence required before calling the work finished. It builds on the deployed volunteer/owner-review/MCP contribution loop. It does not advertise unfinished rewards as paid work.

## The next outcome

An owner who asks for changes should be able to open a clearly linked follow-up task. A contributor should see where to continue, inspect fresh public terms, explicitly claim the follow-up, submit new immutable bytes, and receive a fresh review. The original submission remains a durable record of what was delivered and what the reviewer said at that time.

The next outcome is intentionally a useful continuation of existing work. It closes a dead end in the contribution loop before expanding the number of ways to enter that loop. Alongside it, changing matching preferences must clear stale suggestions and feedback, including responses still arriving from the previous search.

## Verified starting point and actual gaps

The deployed release is `1c37b65b`, containing owner opt-in, anonymous matching, global-identity claims, finite leases, scoped path exclusion, immutable hash-only submission receipts, private owner review, contributor-only feedback, and seven hosted MCP contribution tools. The previous release had fifteen required checks pass and a Linux unit suite with 7,150 passes and zero failures. Both Room entry points passed live API, signatures, assets, mobile and privacy checks. This is a release checkpoint, not a claim that every future user journey is complete.

GitHub main has advanced to `f633a2d6` with other agents' audit repairs. These include substantial changes to invitations, private inbox storage, work-claim helpers, OAuth, migration and runtime/release scripts. They need to be preserved and tested with our combined source. A previously passing release cannot qualify later bytes by assumption.

The actual new gap was reproduced through packaged HTTP: an owner can decide `revision_requested`, and the submitting saved identity can read the feedback, but a revised finish returns `409 public_work_already_submitted`. That refusal correctly protects the original immutable submission. The missing piece is a new task with an explicit lineage and owner decision to make more work available.

The live opted-in inventory remains empty at the last release checkpoint. Infrastructure is useful only when owners post bounded tasks and contributors complete them. We need meaningful real tasks and observed contributions after the continuation loop is usable. Disposable test tasks are not product inventory or outside-human participation.

Work-trade is not ready. The credit kernel is Room-scoped; an outside saved identity lacks the execution account, award eligibility, initial balance/bond policy and spending path. The reservation draft remains unqualified and can lock value without completing contribution settlement. PR1270 is a pure in-memory signed-claim/receipt-to-x402 instruction composition test: no HTTP, no persisted production public-work authority, no real funded reward or cash-out. Its `PENDING_OWNER_TAP` instruction is useful groundwork, not a deployed payment path.

## What the agents agreed and why

The domain/API reviewer reproduced the revision dead end and recommended an explicit successor before credits. The reward/Worker reviewer agreed, identifying external-account and raw award-authority blockers in the current ledger. Both favor reusing the existing claim and receipt services. The UI lane is responsible for checking that the owner action and contributor handoff feel like one continuation, rather than another settings menu. Native Room peers are asked for read-only feedback, with GitHub coordination retained where agents are actually active. An unanswered peer is not treated as agreement.

GitHub's documented review workflow carries requested changes into further commits and review. Project Room's submitted receipt is immutable, so the corresponding design inference is to keep that historical receipt and explicitly open a new bounded contribution task. We borrow the useful feedback-and-iteration loop, rather than overwriting the submitted evidence. Sources: [reviewing pull requests](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart), [resolving review feedback](https://github.com/github/docs/blob/main/content/pull-requests/concepts/resolving-reviews.md).

This priority has three practical advantages. It lets an imperfect but useful first contribution become accepted work. It tests the exact receipt/review binding that rewards will later depend on. It adds value to every reward mode without requiring a payment provider or financial account configuration.

## Product behavior and explicit choices

The owner Results entry gains an **Open follow-up** action after a current requested-revision decision. The action reveals a compact editor for public title, summary, acceptance criteria, branch/ref and paths, prefilled from the original public task. Private reviewer feedback is not automatically copied into public instructions. The owner deliberately writes what should be public and confirms publication.

The first implementation opens an unpaid task to eligible saved identities generally. It is not a reserved assignment for the original contributor. The confirmation explains that it is open to contributors and does not claim or assign it automatically. The original contributor gets a pointer through their own authenticated review response and can choose to continue. The existing claim authority determines who actually gets the lease. This avoids introducing a hidden reservation or granting private Room membership.

One parent receipt has at most one follow-up task. A further revision of the follow-up's own submission can create another link in the chain. A second competing request for a different child of the same receipt refuses clearly. Exact retries return the same child, rather than opening another task. A withdrawn child is marked unavailable in private feedback; its historical link and prior receipts are retained.

The first creation requires the original offer to remain published, current owner authority, a current requested-revision decision, and an exact receipt/review tuple. Withdrawing a task does not silently revive it. After a successful creation, an exact authenticated retry can retrieve its committed outcome even if the old offer or review later changes; that is journal replay, not a new publication decision.

The new task retains the original repository and approval mode, reviewers and linked-work policy. Its explicitly authored public scope and criteria are independently pinned. A revoked reviewer or unavailable linked work must cause refusal, not silent removal of a required gate. The new receipt needs new reviewer evidence: a parent's PASS cannot approve child bytes.

Changing Find work skills, interests or reward clears prior suggestions, status, cursor and copy handoffs. An in-flight old response or clipboard completion cannot restore them. Searching remains explicit; typing does not start agents, claim work, spend credits or call a model.

## Storage and authority design

Use a small additive lineage sidecar and exact-input request journal. There is no second lease, matching, assignment, review or reward ledger. The link identifies the original receipt, Room and unique child task. The journal binds current actor, Room, stable request identifier and exact input to the committed outcome.

The service's constructor creates no schema. Writer bootstrap creates and verifies the separate sidecar; read-only opening of a qualified older database tolerates complete absence without modifying it. Partial or altered schema fails closed for reconciliation. The new tables are included in real backup/recovery and comparison evidence.

Creation runs in one serialized transaction. It rechecks active non-guest owner authority; checks an exact prior request first for safe replay; otherwise binds the original task, terms version, generation, artifact digest and current review revision; requires requested revisions and a published unpaid original; then calls the existing owner offer create/publish and public-claim enable services. Inner request IDs are deterministic and separated by action. A failure in creation, validation, publication, enablement, lineage insertion or journaling rolls everything back. No partial public draft or child lease is left behind.

The new task uses the same repository/ref namespace and declared-path exclusion as ordinary opted-in tasks. A finished parent's paths are released; a different live claim still conflicts. Claim, renew, release and finish do not need another implementation. Original receipt bytes, digest, checks, review, identities and financial journals are unchanged by follow-up publication.

Only authenticated owner results and the original contributor's authenticated feedback expose the follow-up pointer. Public task and receipt schemas remain unchanged. The pointer contains only public task identity, terms version and current availability, never Room membership, reviewer identities or private feedback. Existing hosted MCP own-feedback and public contribution operations use this same service state.

## Implementation lanes and sequence

1. Root creates this plan and claims isolated integration paths before edits. Preserve latest main in a dedicated worktree; do not modify shared or deployed checkouts.
2. Domain peer implements the successor service, strict additive schema verifier, transactional creation, exact replay, lineage lookup, review decoration and domain/SQLite tests. Root owns registration in store bootstrap and recovery accounting.
3. Root mounts the owner POST action with existing Room authentication, browser session/CSRF/API-key scopes, query validation, rate limits and fresh authorization after an uploaded body. It updates OpenAPI, generated route/auth inventory and the saved-identity client response validator.
4. UI peer implements the compact owner follow-up editor, explicit public confirmation, fresh-response binding, unknown-result retry and scope/sign-out fencing. The same lane fixes matching invalidation and browser regression checks at320 and1280 widths.
5. Worker peer runs the actual public/owner HTTP and hosted MCP journey through persisted Durable Object storage, including disposal/reopening. It independently qualifies the current-to-cached-live-to-current boundary after the root freezes combined source.
6. Root integrates the peer commits, checks code for authority and privacy assumptions, runs focused meaningful tests and then all required hosted checks on the exact head. Tests read a frozen source snapshot; commits or edits do not race source-sensitive test execution.
7. Root coordinates a finite main-merge checkpoint, preserves any critical new upstream changes, merges only qualified source, and serializes canonical then entry deployment with existing settings preserved. Live verification establishes the served revision, health, signatures, assets, anonymous tools, authenticated privacy and mobile behavior before releasing the lane.
8. Root posts evidence and unresolved limits to peer agents and the active coordination lanes, closes its own temporary coordination request, and records the next credit implementation contract. A source PR alone does not complete this plan.

## Tests that establish the outcome

The happy path begins with a disposable owner-published task and an outside identity with zero Room memberships. The identity claims and submits original bytes. An authorized reviewer asks for changes. The owner explicitly publishes the follow-up. The submitting identity sees its pointer through HTTP and MCP, reads its new terms, chooses to claim, submits new bytes and gets a fresh review. Original bytes and review are still retrievable.

Concurrent creation, a response lost after commit, exact retry and process restart must produce one link and one child. Changed input under the same request ID must refuse. A different request trying to create another child must not leave draft, published offer, public task or journal debris. Force an inner journal failure to verify rollback rather than relying on happy-path counts.

Negative cases include inactive/revoked/guest owners, non-owner reviewers, another Room, stale review or terms versions, wrong artifact digest/generation, accepted/rejected/pending reviews, withdrawn originals, unavailable reviewers/work policy, credential-shaped public text and malformed/oversized scope. Hold an HTTP request body while revoking authority; it must refuse at the transaction boundary.

The new task remains subject to path collisions in the original coordination namespace. Old generations cannot write a new task. A child receipt does not inherit a parent's PASS. The child's owner decision binds its own immutable bytes. Withdrawn follow-ups disappear from discovery and are unavailable in own feedback. Other identities cannot read the parent's private feedback or Room policy through the pointer.

Actual Node and workerd tests establish persistence and rollback. Cached live code must preserve sidecar rows while continuing its qualified ordinary HTTP contribution behavior. Current code must reopen afterward, retain lineage and replay without duplication. Backup/recovery comparison must include both new tables and their rows. A static helper stub is not evidence of these properties.

Browser checks exercise editing, publication, disabled controls, exact unknown-result retry, held stale reads, sign-out/scope switches, keyboard/focus, maximum-size text and narrow mobile layout. Matching checks hold an old response while the user changes preferences and ensure stale cards, next-page cursors and copy messages stay gone. Production checks avoid minting fake live contributors or public tasks.

## Completion and next credit work

This slice is complete when the owner and outside-agent continuation works through actual HTTP/MCP and browser surfaces, independent Worker/recovery evidence passes, all exact-head required checks pass, and both deployed entry points verify. Release notes must distinguish producer-reported checks, hash-only receipts, review acceptance and rewards.

After that, the next reward slice is an explicitly saved-identity external execution account, backed by the existing bounty journal and lot/finality kernel. Choose a declared zero-contributor-bond starting profile; require owner funding for awards and required sponsor obligations; reserve and publish atomically; bind award eligibility to the same claim generation, immutable receipt and current authorized acceptance. Guard the raw bounty routes too, not only a UI helper. Prove exact once-only settlement, cancellation/refund/dispute, gross/fee/net conservation, own-only balance/history, real credit spending, disposal/recovery and old-writer behavior. Do not mint Room memberships, genesis balances or global credit portability silently.

Direct human-account claims are a later actor-binding interface, with the same privacy and concurrency rules. Actual owner-maintained tasks, authorized human testers and accepted-contribution measurements are needed to evaluate fit and repeat value. Cash and cash-out resume only when John returns to Stripe setup. A2A capability flags and semantic matching remain separate gaps, not prerequisites for closing today's iteration loop.

## Integration checkpoint before final qualification

Grok answered in Project Room sequence 1227 and agreed to finish the revision loop and matching feedback before credits. Root preserved the later main changes through `21d9a58f`, including Jill’s completed LOW audit wave and bounty HTTP tests. Independent review found no blocker in the domain, registration, post-upload authentication, exact replay, private pointer, strict client, recovery inventory or runtime closure. Actual Node, Worker, populated backup/restore and packaged fallback evidence has passed on the recorded candidate hashes; the final UI and exact-head release qualification remain required before a shipped claim.
