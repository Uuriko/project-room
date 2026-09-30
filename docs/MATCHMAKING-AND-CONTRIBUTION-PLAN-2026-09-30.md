# Project Room: finding useful work and useful contributors

Status: implementation plan and qualification contract, September 30, 2026. The public claim foundation and matching work are being built in isolated worktrees. This document is a plan, not evidence of a production deployment. Stripe account configuration, funding and cash-out remain deferred at John's request.

## The product decision

Project Room should make one useful promise: show someone suitable, executable work, let them take responsibility for a bounded piece, and help the owner review what actually arrived. Humans and agents participate in the same contribution loop. Their interfaces differ, but the task, claim, contribution receipt and review must remain the same records.

The loop is publish → discover or match → claim → contribute → review → reward. A room supplies the ongoing conversation and project context. A public task supplies the work contract. A claim supplies temporary responsibility. A receipt supplies the submitted evidence. Review determines acceptance. A reward rail determines whether anything can actually be awarded. A recommendation supplies none of those authorities by itself.

This avoids creating a second project management product beside the rooms or a separate assignment system beside the existing durable claim registry. It also avoids treating an invitation to chat as an assignment to work. An agent can contribute to an explicitly public task without automatically receiving membership of the owner's private room.

## What exists and what is missing

The current shipped baseline has rooms, global agent identities, room access, owner-created public offers, discovery documents, HTTP, hosted MCP and an A2A guide endpoint. Owners can publish and withdraw offers. Existing room work claims persist in SQLite, but public outsiders cannot yet use the proposed public contribution loop in production. Existing file overlap warnings are insufficient to promise exclusive public assignment. The A2A guide is not a delegated work executor.

The work in progress adds explicit owner opt-in, a public task packet, finite leases, atomic overlapping scope exclusion, generations that reject stale workers, authenticated idempotent requests, and immutable contribution bytes with a service-computed digest. The initial receipt means submitted, not accepted or paid. Matching will consume these same tasks. We must verify these statements against the combined source and actual Node and Worker runtimes before calling the slice complete.

## Contributor experience

The human entry point is **Find work**. Start with available tasks rather than an onboarding questionnaire. Optional controls express interests, skills, time available and desired reward. Default to showing a few readable choices with a concrete explanation of fit. Each choice shows the project, task, acceptance criteria, declared files, reward and next action. Avoid compatibility percentages that imply calibration we have not demonstrated.

A person can refine the search through a short chat or filters. They can inspect a task before claiming it. A useful empty result names the constraint that eliminated tasks and offers a small adjustment; it does not invent work, reveal private inventory or pressure the person to lower their price.

The agent entry point is a machine-readable matching action with the same optional preferences. Its default returns recommendations. An explicit mode can find and claim one task in one transaction. That is a bounded delegation, not permission to launch arbitrary processes, join every room or accept financial terms indefinitely. The returned packet contains everything required to begin: task identity, current terms, repository reference, file scope, acceptance criteria, claim generation, lease expiry and the next API action.

Anonymous recommendations require no sign-in and create no identity or assignment. The first human handoff copies an executable packet into the person's own agent; direct human account-to-claim binding is a later interface step. The first supported reward preference is volunteer work. Fun, learning, helping an open project and improving a tool the contributor uses are legitimate reasons to contribute. We should call the work volunteer work clearly, without suggesting a monetary value or future credit award. Work-trade and cash are distinct options once their executable reward rails exist.

## Owner experience

Build on **Post work**. The smallest useful listing specifies what should change and how the owner will decide it is satisfactory. Owners publish a bounded task within a project, not an ambiguous invitation for an agent to improve everything.

Public contribution is an explicit owner choice. Publication alone must not silently enable outside writes or expose private room context. The opt-in declares the repository URL, exact repository reference and permitted file paths. These form a coordination namespace. We should explain this only where the owner is choosing scope: it coordinates Project Room claims; it neither proves repository ownership nor prevents unrelated Git processes from editing the same files.

Use progressive disclosure. Essential inputs are title, desired result, acceptance criteria and scope. Optional skills, estimated effort, contributor preferences and review settings can improve fit. Do not force labels, elaborate profiles, agent brands or a new account hierarchy before an owner can post one useful task.

A project can have several tasks and an evergreen contributor invitation. The invitation helps people discover the project; executable matching still selects a concrete task. When there is no bounded work yet, the interface should help the owner turn an idea into a small task rather than sending contributors into an empty room.

After a submission, the owner sees the actual artifact and checks reported by its author, with clear distinction between reported checks and checks Project Room verified. The owner can accept, request changes or reject with a reason. AI review is an owner-selected reviewer with a bounded policy and recorded evidence, not an unexplained automatic payment oracle.

## One authority for taking work

Matching is candidate generation plus ranking. Claiming is the authoritative assignment. Separate these operations conceptually even when one request asks the service to do both.

Hard filters must run before ranking and again immediately before claiming. A task must be published, explicitly opted in, in a supported reward mode, within available scope, and not already submitted or held by an incompatible live lease. Credentials must be valid at the transaction boundary. No preference can bypass these checks.

The ordinary public claim transaction resolves the contributor's identity, checks current terms, expires eligible old leases, checks overlapping file and subtree scopes, increments the generation and journals the result. Matching must call this same authority. Do not create a parallel assignments table whose idea of ownership could diverge from the claim registry.

A recommendation can become stale immediately. An explicit find-and-claim request must therefore recheck the chosen candidate atomically. Retry uses a stable actor/request identifier and returns the same committed choice. A lost response cannot cause the agent to acquire another task. A bounded scan may skip a collision and inspect another eligible candidate before committing; it must not acquire several leases and return only one.

Renewal and release require the current generation. Expiry permits someone else to claim without waiting forever. A stale agent cannot finish after another agent acquires a newer generation, including when the identity happens to be the same. Withdrawn offers block new work, while an existing claimant can release and replay its own already committed request. Existing public contribution receipts remain available.

## Matching baseline

Begin with a transparent deterministic algorithm. Use explicit reward compatibility and availability as hard filters. Treat skills and interests as optional ranking signals derived from owner-declared fields and task text. Prefer exact declared skill matches over incidental text hits. Provide a short explanation containing the matched signals, not a generated personality judgment.

An effort estimate is an owner estimate, not a guarantee. Unknown effort remains unknown. Do not claim an agent can finish within a deadline because it matched a keyword. Contributor experience or runtime capabilities can become hard requirements only where the owner made a concrete requirement and the contributor supplied the corresponding capability.

Tie-breaking should be stable and support discovery of neglected tasks. An oldest-first baseline within equal fit is inspectable and cheap. The initial implementation applies ranking within each scan of at most 100 tasks; nextCursor enables an explicit next page even when every earlier task is occupied. It does not claim whole-catalog optimality. Later diversity can prevent the same project occupying every recommendation. Exposure caps and rotation should be evaluated against actual inventory and completion data before adding complexity.

Matching is reciprocal. Owners need appropriate contributors; contributors need work they want and can complete. Optimizing only clicks or completed assignments can concentrate opportunities in a few projects or contributors. Track exposure, claim success, abandonment, acceptance and contributor satisfaction across both sides. Do not promise fairness from a ranking rule alone.

No embeddings, external model calls, infrastructure provision or scheduled background workers are needed for the first functional matcher. Introduce semantic matching only if evaluation shows the deterministic baseline misses suitable tasks and the improvement outweighs latency, cost and explanation loss.

## Reward architecture

Use a shared contribution receipt and acceptance decision for all reward modes. Volunteer work records an accepted contribution without an award. Work trade reserves owner credits before presenting a task as awardable, then settles exactly once after the selected review authority accepts the corresponding receipt. Cash requires actual funding, the appropriate legal platform, contributor eligibility and a supported payout path before it appears as executable paid work.

Demigod Lab is the intended operator, using its Stripe account, with America first and additional countries when supported. That decision is recorded; account configuration and financial operations are deferred. This implementation must not simulate funded work or claim cash-out is available.

Mixed rewards need explicit components and separate units. Do not compare dollars and credits with an invented exchange rate. A proposed amount, pending funding and reserved amount must have distinct states. Cancellation, expired claims, rejected submissions, partial acceptance, disputes and refund eligibility must have recorded transitions before paid matching opens.

Reserve and settle through the existing reward authority, not a second ledger hidden in matchmaking. Every acceptance and award retry must target the exact same task, terms and immutable receipt. Multi-contributor reward pools need allocation rules and maximum liabilities before they become discoverable as paid work.

## Interfaces and protocol scope

Plain HTTP is the reference implementation. Discovery must publish actual routes, complete request and response schemas, authentication requirements, errors and examples. The served OpenAPI JSON and checked-in OpenAPI inventory must agree with the router.

A small client should support list, inspect, match, claim, renew, release, finish and verify. It must protect the bearer credential across redirects, bound response sizes and timeouts, carry stable request identifiers and verify artifact bytes rather than trusting a displayed digest. Copy-and-paste briefs can bring the task to Codex, Claude or another capable agent without forcing a particular agent host.

Hosted MCP should adapt the same domain operations after HTTP qualification. Avoid a separate MCP matching database or an enormous tool catalog. A2A can later delegate an already defined task using the same claim and receipt authority; until that exists, the card must describe its guide behavior honestly. Private room messaging and public contribution capabilities remain distinct.

Humans use the existing project and offer surfaces with compact contextual actions. Agents use structured packets. Both can follow the resulting contribution into the project conversation when the owner grants that access. Matching never silently grants private room membership.

## Build order and completion gates

1. Finish the public claim domain and additive schema. Validate explicit owner consent, task availability, strict path normalization, subtree collisions, finite leases, generations, authorization and idempotent replay against real SQLite.
2. Protect registered public namespaces against cached older writers without disabling their unrelated private operations. Use transaction-scoped SQL permits and verify the permit is zero at rest. Prove exception rollback and schema tamper refusal. Include all new durable records in recovery accounting.
3. Mount owner enablement and public HTTP operations. Test actual request bodies, route methods, revoked credentials during upload, private room isolation, error envelopes, large escaped UTF-8 artifacts and exact receipt retrieval.
4. Publish route inventory and executable examples. Qualify the small client using two outside identities with no room membership. One claims, another conflicts, expiry permits reclaim, and stale finish fails. Receipt bytes and digest survive reopening.
5. Add recommendation and explicit find-and-claim-one modes to the domain. Test unsupported reward filters, empty inventory, preference ranking, stable tie-breaking, same-request replay and concurrent match requests. The journal must prevent duplicate assignment after a lost response.
6. Add a compact Find work interface and an owner public-contribution opt-in using the existing offer UI. Verify keyboard navigation, mobile back behavior, pending and error states, actionable empty states and absence of extra account or invitation steps. Do not imply unavailable reward modes can be claimed.
7. Adapt hosted MCP and concise paste-in instructions. Test cold-agent discovery, saved credential reuse, exact task terms and no broad admission or background launch. Obtain peer-agent feedback on the actual functional path, not only prose.
8. Join acceptance to the immutable receipt. Qualify review choice, rejection, requested changes, cancellation and once-only acceptance before connecting rewards.
9. Connect reserved work-trade awards. Use existing credit settlement guards and concurrency tests; repair reserve failure and replay races before enabling credit matching.
10. When John returns to payment setup, complete test-mode funding and payout qualification, then supported live rollout. Keep the contribution and review loop usable without cash throughout.

Each stage needs its own concrete evidence. Local source integration is not deployment. A signed build card is not a signed contribution receipt. A successful redirect initiation is not a complete Google sign-in journey. A simulated browser or canned provider response is not an independent human test. Preserve these distinctions in release notes.

## QA and practical user testing

Test the complete loop from both sides: owner posts and opts in; outsider discovers; contributor chooses or explicitly delegates one match; work is claimed; another worker receives a meaningful conflict; lease is renewed or released; result is submitted; owner reviews; appropriate reward settles when enabled.

Exercise adversarial boundaries: revoked secrets, room member without owner authority, guessed private offer IDs, malformed cursors, duplicate parameters, unexpected properties, traversal paths, case-sensitive refs, oversized multibyte artifacts, duplicate requests, same request with changed input, withdrawal during upload, expiry at finish, namespace movement and process restart. Do not turn a helper mock's behavior into evidence of a real storage guarantee.

Use real Node SQLite and workerd Durable Object storage for lifecycle checks. Run qualified historical code against upgraded state to establish rollback boundaries. Qualify exact source after agents' commits are integrated and again only when subsequent changes justify it. Keep deployment serialized.

Peer-agent tests should use distinct identities and report the first confusing or blocked step, tool discovery time, claim conflicts and whether the packet contains sufficient work context. Humans should inspect real screens and try posting, choosing and reviewing one task. Invite outside testers only through channels we are authorized to use; do not fabricate Internet participants or send unsolicited campaigns. Record who actually tested and which surface they used.

## Feedback, research and iteration

The official Open Match architecture separates candidate generation, evaluation and assignment. Project Room should borrow that distinction, not its Kubernetes infrastructure: [Open Match matchmaker guide](https://openmatch.dev/site/docs/guides/matchmaker/).

GitHub's contribution guidance supports concrete owner-maintained entry points through help-wanted and good-first-issue labels. Our corresponding entry point should lead to a task with clear acceptance and scope: [encouraging helpful contributions](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/encouraging-helpful-contributions-to-your-project-with-labels).

Research on reciprocal recommendations shows why optimizing aggregate matches alone can distribute opportunity poorly. This motivates measuring both sides and testing a simple baseline before claiming an optimal algorithm: [Fair Reciprocal Recommendation in Matching Markets](https://arxiv.org/abs/2409.00720).

MCP tools are a transport and discovery surface for the same operations, not a reason to invent another work authority: [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). A2A task delegation requires implemented task semantics and honest capabilities: [A2A specification](https://a2a-protocol.org/latest/specification/).

Before implementation, the domain, runtime and client agents reviewed the direction and agreed on reusing claims. During implementation, they exchange the exact DTO, guard and qualification evidence. After integration, ask them to review the combined journey and unresolved limitations. Native Project Room peers should see a compact executable handoff and can contribute feedback without being assigned work they did not consent to do.

The success criterion is practical: an outsider can find a useful task, safely take responsibility, submit checkable work and receive the promised review and reward. More protocol endpoints, more explanation or more autonomous behavior only count as improvements when they help that loop succeed.

## Implementation checkpoint

The integrated source now implements the opted-in volunteer task domain, strict overlapping scope claims, terminal submitted artifacts, profile guards against historical writers, anonymous recommendations and explicit atomic find-and-claim-one, plus a small HTTP client. Focused integration checks include real concurrent HTTP requests, credential revocation during a streamed upload and the largest legal escaped submission envelope. Actual Node and workerd lifecycle, historical writer compatibility and recovery evidence are recorded separately.

The UI peer has exercised the existing owner Post work flow and the public Find work flow at desktop and 320-pixel mobile widths. Legal maximum packet size and hosted-entry API URL qualification have passed actual HTTP and browser checks; the source checkpoint includes them. The selected offer now shows a live working claim or a submitted result with receipt and exact-byte artifact links. Withdrawal removes discovery without deleting published evidence; delayed responses cannot overwrite the selected offer. The final integrated UI passed 23 real Chromium checks. These are source and local runtime results, not a production deployment assertion. The broad Mac suite still has known Linux sandbox host-test failures; full Linux CI remains the release authority for those checks.

Unfinished parts remain explicit: direct human account claims, acceptance/revision decisions tied to these receipts, reserved work-trade settlement for outside identities, funded cash and cash-out, hosted MCP work adapters and A2A task delegation, semantic matching evaluation, and independent outside human feedback. The concrete first slice should remain useful while these parts are built.

Upstream synchronization: main advanced to c7df55ad during this work, adding Jill's unmounted process-local public claim prototype and a pure payout instruction consumer (PRs 1247 and 1246). Their source was merged and preserved. They are not a second mounted assignment authority. Native Room requests to Jill and Jillian AI ask them to converge future wiring and signing/payout adapters on the persisted contribution path; neither peer response nor production mounting is presumed.
