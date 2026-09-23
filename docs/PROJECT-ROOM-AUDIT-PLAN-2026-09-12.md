# Project Room: detailed plan for the third audit

Date: 12 September 2026. Status: **plan prepared; execution results are not implied by this document**.

This is the working plan for the next audit of Project Room's product, design, code, data, agent behavior, and operation. It builds on the [first audit](PROJECT-ROOM-AUDIT-2026-09-12.md) and [second pass](PROJECT-ROOM-SECOND-PASS-2026-09-12.md). Those remain records of the versions they inspected.

## 1. What we want to establish

The objective is to find consequential problems systematically and leave a reproducible account of what has and has not been checked. We cannot prove the absence of every possible defect. We can account for every reachable surface, test the important invariants across those surfaces, challenge the tests themselves, and make remaining gaps visible.

The third pass should answer five questions:

1. Does each person or agent see and change exactly what its current authority permits?
2. Does the durable record remain correct through concurrency, retries, interruption, capacity, migration, and recovery?
3. Do the interface and machine-readable contracts describe what actually happened?
4. Can an unfamiliar person complete the core journeys and recover from mistakes without understanding implementation details?
5. Can the product be packaged, operated, restored, and supported with evidence tied to the code that is actually running?

The central audit artifact will be a traceable chain:

**Product claim → entry points → policy/data dependencies → failure scenarios → expected result → evidence → finding or verified boundary.**

Test counts and line coverage are supporting information. They do not replace that chain. A test that expects a broken join loop to occur can pass while the product fails its purpose.

## 2. Starting facts and version discipline

At plan preparation, remote main still resolves to `ff7365e01e59398b29c05251164bf68947c7cd9f`. The shared checkout is `d963e4b9fdfaa85c1696d624c693cb62827e5321` and contains other agents' changes. The first two reports distinguish those baselines. The earlier live Worker observation was `a5f2dca`; it is historical evidence until queried again.

Grok has reported and source inspection now shows partial improvements to the local MCP prototype: preview/ship:false metadata, proxy-address resolution before dispatch, and 60 POST requests per minute per IP. These are **source-observed, not yet dynamically reverified by this third pass**. They must not be silently recorded as either unfixed or fully closed. The join/listen behavior, Origin policy, protocol handling, and data boundary still require separate checks.

Every result must carry:

- Repository and full commit SHA, or an explicit local-prototype label.
- For uncommitted code, a manifest of captured file paths and content hashes, including relevant dependencies.
- Runtime and package-manager versions, dependency lock identity, configuration mode, and schema version.
- Test/probe command, seed where relevant, observed outcome, timestamp, and artifact location.
- Whether the evidence came from static inspection, a local reproduction, a browser, CI, or the live service.

We will use one frozen committed snapshot for the main audit. Changes that land during the pass enter a delta queue. We finish a coherent result for the frozen snapshot, then retest affected findings against a newly captured version. We do not combine tests from several revisions into one green release claim.

## 3. Coordination and working arrangement

Codex owns this plan and the audit evidence it creates. Grok retains the public MCP/walk-in implementation lane recorded on the board. Other dirty files retain their existing owners. This plan does not assign another agent a task or transfer file ownership.

Before each work block, read the board, check the Codex bus inbox, inspect repository occupancy, and acknowledge relevant messages. Before writing any additional artifact or test file, claim its exact path. Append board updates; preserve other agents' rows. Use one writer per file.

All fault injection, load, restore, and malformed-input probes run in disposable copies with synthetic data. Use loopback listeners and bounded resource use. Browser checks run serially where they share ports or display state. Unrelated read-only inspections can run together, but a result cannot depend on an unawaited test or an actively changing source tree.

The current work is audit and planning. Live-service checks remain read-only. Publishing, deployment, account/provider changes, and destructive operations against shared data are outside this audit workflow. Findings are shared through the existing local bus; a message sent is not proof the recipient acted on it.

The default executor is the current Codex task. Proposed work packages below are separable if additional reviewers are explicitly assigned later; the plan does not automatically start other agents or new tasks.

## 4. Establish a complete surface inventory

Before writing more tests, enumerate what can actually run. Compare the inventory with docs, test discovery, build allowlists, and deployed assets.

| Inventory | What to record | How omissions will be found |
| --- | --- | --- |
| HTTP routes | Method, path, route branch, auth mode, origin/proxy checks, limits, validator, handler, response shape | Compare dispatch code, OpenAPI, route-auth table, clients, and route tests; inspect early returns separately. |
| Streaming paths | Open, resume, cursor, disconnect, cancellation, revocation, buffers | Compare SSE implementation, client reconnect code, Worker adapter, and stream tests. |
| Agent tools and CLI | Tool/command, inputs, permission, effects, retries, cancellation, public/private availability | Compare catalogs, dispatch tables, actual validators, help, discovery, and integration tests. |
| Events and mutations | Event type, actor, permission, target revision, halt/stop behavior, durable writes | Compare event constants, command allowlist, reducer handlers, wrappers, and projections. |
| Credentials | Type, issuer, storage, audience, binding, lifetime, rotation, revocation, recovery behavior | Follow every authenticate/resolve path and all token-producing operations. |
| Storage | Table, key, owner, writer, reader, retention, authority relevance, restore procedure | Read schemas, migrations, triggers, transaction boundaries, and backup/import code. |
| Browser surfaces | Entry, chat, work, People, invitations, accounts, Inbox, dialogs, recovery | Compare DOM controls, listeners, navigation, assets, and browser scenarios. |
| Background/local helpers | Watchers, journals, polling, timers, saved connection files | Inspect startup/stop paths, persistence, environment reads, and failure handling. |
| Build and runtime | Node, Worker, package manifests, static assets, optional modules | Compare import closure, build scripts, package verification, and actual startup. |
| Documentation claims | Current capability, availability, identity, privacy, completion, budget, deployment | Tie each externally visible claim to a tested implementation path. |
| Operational controls | Health, readiness, diagnostics, limits, backup, maintenance, release, rollback | Distinguish implemented controls, stubs, operator procedures, and designs. |
| Experiments and inactive packages | Runtime imports, CI participation, intended future integration, owner | Classify before recommending consolidation or removal. |

Each inventory item receives one disposition: reviewed, tested, excluded with reason, blocked with missing evidence, or not yet examined. An empty field is a gap, not a pass.

## 5. Define the independent rules before testing

An implementation cannot be its own only oracle. Derive expected behavior from the product principles, explicit authority rules, and protocol contracts. When documents conflict, record the conflict and test the narrower factual claim instead of silently choosing the most convenient wording.

The invariant register starts with these rules:

| ID | Invariant |
| --- | --- |
| I01 | No private data crosses a room/account/publication boundary without current authority. |
| I02 | Expired, revoked, or superseded credentials cannot regain access through another route or an exact retry. |
| I03 | The service determines actor, room, time, and allowed effects; client assertions do not create authority. |
| I04 | Accepted mutations commit their event, projection, authority changes, and retry receipt consistently. |
| I05 | An exact retry has the same logical effect once; changed content under the same request identity conflicts. |
| I06 | A failed operation preserves state, except for an explicitly documented and independently receipted safety action. |
| I07 | Concurrent stale writes cannot both become the winning revision. |
| I08 | Halt, stop, session ownership, and cleanup follow one policy across every entry point. |
| I09 | Conversation, work report, verification, approval, and external action remain distinct facts. |
| I10 | A displayed status is supported by an observable event or accurately labeled inference. |
| I11 | Untrusted text remains data; it does not become code, credentials, tool authority, or an agent instruction override. |
| I12 | Resource limits bound total retained state and work, not only a per-key list. |
| I13 | At capacity, authorized safety cleanup and a qualified recovery/exit path remain possible. |
| I14 | Restoration cannot silently resurrect revoked authority or rewrite provenance. |
| I15 | A source/version/test receipt identifies the bytes and configuration it actually covers. |
| I16 | A person can complete core journeys by keyboard and on a small screen with understandable errors and recoverable drafts. |
| I17 | Discovery advertises implemented, available operations and a finite next step. |
| I18 | Room coordinates external execution without claiming to enforce controls it cannot observe or apply. |

Architectural decisions need a separate register. For example, PRODUCTION-PLAN names PostgreSQL and an identity provider as the target; the first audit suggested tenant/room partitioning for the current Durable Object architecture. These are alternatives to evaluate against requirements, not two simultaneously approved migrations. The third audit should expose the decision and evidence needed, not quietly change project intent.

## 6. Test design: make combinations deliberate

### 6.1 Credential and authority matrix

For every protected entry point, exercise the credential classes that can reach it: none, malformed token, active room human key, active room agent key, room browser session, account browser session, account token incorrectly supplied as Bearer, global agent identity, managed/guest agent credential, and any implemented public identity.

Cross those with the critical states: right room, wrong room, inactive member, missing permission, expired/revoked token, changed parent key, changed account epoch, stale session binding, and relinked membership. Use only combinations that exist in the product, and mark inapplicable combinations explicitly.

For high-risk reads/writes, test the full relevant credential matrix. For secondary UX combinations, use pairwise coverage plus targeted three-way cases rather than an impractical Cartesian product. Always include successful controls alongside denials so an endpoint that rejects everything cannot appear correct.

### 6.2 Temporal matrix

For a state-changing operation, probe these moments where applicable:

1. Before validation.
2. After initial authentication but before commit.
3. After commit but before the response reaches the client.
4. During an exact retry.
5. After revocation, scope change, or room switch.
6. After process restart.
7. After backup restoration or migration.

Use deterministic barriers and a controlled clock for race/expiry tests. Sleep-based races are last resorts and must report timing uncertainty.

### 6.3 Input and resource matrix

Use absent, null, empty, wrong type, minimum, maximum, maximum-plus-one, Unicode, duplicate query/header fields, unknown fields, encoded IDs, malformed JSON, oversized bodies, and deeply nested structures where the entry point accepts them. Keep finite corpus sizes and time budgets.

Check both API replies and persisted effects. A 4xx response that still creates an invitation, identity, diagnostic bucket, session, or event is a finding unless that effect is part of the explicit contract.

### 6.4 Test the tests

For each critical invariant, introduce one small deliberate violation in an isolated copy: remove a binding check, bypass a rate counter, allow a forbidden state, or alter a receipt. The relevant test must fail for the intended reason. Restore the copy before the next mutant. Use this selectively on critical boundaries, not as a large new testing framework.

Passing tests should assert behavior and side effects, not literal tool counts, filenames, copied production predicates, or an already broken response. Preserve useful existing coverage and add small counterexample-driven regressions.

## 7. Workstream A — Authentication, authorization, and isolation

**Primary targets:** server/http.mjs, server/store.mjs, deployment/proxy handling, account/session clients, agent identities/connections, invitations, share links, and the public MCP route if included in the captured prototype.

Specific checks:

- Trace all dispatch branches before shared authentication, rate, CSRF, session-binding, and origin handling. Start with the confirmed thread exception and the new MCP exception.
- Verify credential audience: an account token must not become a room Bearer, a room token must not open another room, and a public identity must not resolve to an existing private member.
- Test owner, delegated administrator, member, guest, and agent permissions through wrappers and generic commands. Test partial administrator demotion between issuance and redemption.
- Verify that identity relink uses the requested effective scope, reports it, and does not reactivate old credentials unexpectedly.
- Test generic member changes against managed-agent and global-identity side tables. Ask whether one path can bypass another path's revoke/rotate semantics.
- Confirm existing SSE/watch connections stop receiving private events after access ends, including during reconnect and cursor replay.
- Test cookie duplication, conflicting auth selectors, missing/stale binding, origin mismatch, encoded path IDs, and trusted-proxy configuration.
- Verify public Commons uses explicit public data authority, not a familiar room ID or display name.

**Evidence:** a route/auth matrix, minimal failing probes, state-before/after comparisons, and a list of valid cases that still succeed.

**Completion:** every reachable private-data path has a documented auth policy and corresponding negative/positive evidence. Any exception is a named finding, not an assumed shared policy.

## 8. Workstream B — Work lifecycle, agent sessions, and authority to act

**Primary targets:** event reducer, workflow predicates, work-item sessions, halt/handoff, claims, help offers, verification, owner decisions, and client/MCP action adapters.

Specific checks:

- Build one transition table for work state and a separate table for session state, then test their permitted combinations. Identify impossible or misleading pairs.
- Extend the halt-all probe to session start, status continuation, takeover, claim acquisition/release, completion, and owner override. Preserve safe stopping and reporting.
- Test stale heartbeat takeover while the former worker is still sending heartbeats. Verify only one current owner can act.
- Cross budget expiry with retries, stale revisions, stop requests, failed stop writes, and owner intervention. Separate reported spend from enforced external spend.
- Verify an agent cannot independently verify its own claimed output or use external-reported authorship to satisfy an independent gate.
- Test completion replaced, reopened, superseded, or awaiting approval against every Done/result/list/search/People view.
- Test help withdrawal, offer selection, capacity, membership loss, and concurrent acceptance. A help invitation must not become an assignment automatically.
- Test room instructions changed after a work packet was read. Define whether the client must refresh, warn, or refuse; do not assume a work revision fences every dependency.
- Verify messages and mentions never start work or authorize a provider call merely by being addressed to an agent.

**Evidence:** transition/policy tables, selected model-based sequences, the shortest failing sequence for each inconsistency, and UI/API comparisons of the same state.

**Completion:** all high-risk cross-state cases have an explicit expected result. A central policy candidate is identified where duplicate predicates disagree.

## 9. Workstream C — Data integrity, concurrency, retries, and crash recovery

**Primary targets:** transactions, event/projection writes, command fingerprints, invitation journals, private Inbox journals, checkpoints, migrations, writer fences, and recovery scripts.

Specific checks:

- List every multi-table mutation and its transaction boundary. Verify authentication and mutable authority are rechecked inside the relevant boundary.
- Inject failure after each durable write in representative operations: message post, membership change, invite redemption, identity link, session stop, and Inbox reservation/acknowledgment.
- Check partial failure leaves no orphan row, stale projection, duplicate receipt, or false success.
- Simulate commit-success/response-loss. Retry the exact request before and after restart; then retry with changed content and with revoked authority.
- Race two clients on the same revision, the same invite, the same identity/member ID, and the same work claim. Record both outcomes and the final record.
- Compare event replay with stored projection and authority tables. Do not compare only against a second call to the same potentially faulty helper.
- Restore representative rooms: invitations issued/revoked/accepted, identity linked/unlinked, account suspended, sessions active/stopped, deleted/edited messages, and pending uncertain writes.
- Test cleanup histories beyond the 10,000 admission threshold. Confirm export, restore, reopen, and authorization reconciliation.
- Test interrupted migration, wrong writer version, read-only open, old runtime against new schema, and rollback from a qualified backup.
- Validate disk/storage failure through injected adapters or bounded fixtures; never fill the shared disk to manufacture a failure.

**Evidence:** transaction maps, crash-point outcomes, before/after database checks, restore receipts, and explicit authority-freshness results.

**Completion:** every high-risk mutation has a failure/retry scenario; recovery evidence covers realistic authority history. Import remains an open release issue until the independent authority problem is solved, even if a round-trip fixture passes.

## 10. Workstream D — API contracts, discovery, MCP, and agent usability

**Primary targets:** OpenAPI, route-auth documentation, discovery cards, tool schemas/descriptions, CLI help, public MCP, local stdio, and request validators.

Specific checks:

- Compare actual method/path/auth/body/response behavior with every advertised operation. Resolve unsafe key-in-URL documentation first.
- Exercise examples exactly as written with synthetic credentials. Redact secrets from captured commands and output.
- Compare tool input schemas with runtime validation for types, enums, ranges, required fields, unknown fields, and invalid identifiers.
- Check initialization, notifications, protocol negotiation, unsupported version headers, valid/invalid request IDs, cancellation, and error classification against the exact protocol version claimed.
- Distinguish tool execution errors from transport/protocol errors. Confirm retry guidance is finite and appropriate to the outcome.
- Test public preview discovery through join → briefing → listen. If unsupported, require an honest unavailable response and stopping instruction rather than a loop.
- Test an older client against newer server capabilities and vice versa. Unsupported behavior must not silently degrade into misleading success.
- Verify tool descriptions treat room text as untrusted context and avoid instructions that override the operator's task, approval, or compute budget.
- Verify connection-file permissions, symlink handling, cancellation cleanup, output bounds, and secrets in CLI errors.
- Check that public catalogs expose only intended public metadata and do not inherit private tools via shared module imports.

**Evidence:** contract-difference table, protocol conformance probes, and complete synthetic onboarding transcripts with secrets omitted.

**Completion:** every advertised high-value journey succeeds or reports an honest, finite unavailable state. Catalog count tests alone do not close a journey.

## 11. Workstream E — Abuse resistance, capacity, and performance

**Primary targets:** request limits, body handling, diagnostic storage, identity/session creation, SSE buffers/polling, thread/search/export paths, synchronous replay, and Worker partitioning.

Specific checks:

- Inventory every Map, queue, table, cache, retained journal, and stream. Record per-key and global count/byte/time bounds plus eviction behavior.
- Extend the diagnostic probe from one key to many nonexistent keys. Check logging cost as well as memory.
- Test many anonymous account slots, identities, invite attempts, and connections within controlled fixture limits. Verify cleanup/expiry and service-wide admission behavior.
- Check limits before expensive parsing or storage work, all route aliases, IP identity behind the proxy, and behavior after restart.
- Exercise slow readers, client disconnect during export, missed stream acknowledgments, and repeated reconnect. Measure buffered bytes and clean termination.
- Measure small, typical, near-capacity, and valid cleanup-at-capacity rooms. Use legal fixtures built through supported mutations wherever practical.
- Measure browser rendering and event-loop delay separately from HTTP response time. A fast health route does not establish a responsive application.
- Inspect deep reply chains and large search results for recursion, pagination, truncation, and response-size handling.
- Measure cold-start/replay behavior on the actual supported runtime configuration. Keep local measurements distinct from Worker CPU limits.
- Compare a small set of structural alternatives against requirements: current single object, partitioned durable storage, or the documented PostgreSQL target. Identify a decision, not a speculative rewrite.

**Evidence:** resource-bound inventory, workload definition, baseline measurements, tail latency, memory/buffer observations, and saturation/cleanup behavior.

**Completion:** all retained structures and expensive endpoints have an explicit bound or finding. No production load testing is required to establish a local defect.

## 12. Workstream F — Privacy, content handling, and data lifecycle

**Primary targets:** snapshots, events, search, exports, thread responses, private Inbox, drafts, diagnostics, saved credentials, and backup material.

Specific checks:

- Follow each data class from entry to projection, logs, events, browser storage, exports, and backup. Include original text after edit/delete.
- Compare full-room read authority with what onboarding and agent enrollment tell the user. Selected-work context is not a narrower permission unless every read path enforces it.
- Test cross-account browser changes while requests are delayed. Previous-room text must not appear in the new identity's UI or draft recovery.
- Inspect escaping and URL validation for message, name, title, source, evidence, imported email, error, and search text. Test content as data in DOM and agent packets.
- Check whether public titles, author labels, capabilities, or counts reveal private-room existence or membership.
- Verify diagnostic templates remove identifiers even when IDs happen to look like lowercase route words. Review support-export contents before describing them as sanitized.
- Distinguish hiding/tombstoning from deletion. Record what retention, erasure, export, disconnect, and account closure actually do today.
- Trace future deletion requirements across append-only journals and backups; identify policy decisions and architectural conflicts without claiming legal compliance.

**Evidence:** data-flow/retention table, redacted sample outputs, browser-storage observations, and gaps between privacy copy and implemented behavior.

**Completion:** every sensitive data class has an owner, visibility boundary, storage locations, and a stated lifecycle. Missing lifecycle controls remain explicit readiness gaps.

## 13. Workstream G — Human journeys, accessibility, and responsive design

**Primary targets:** signed-out entry, invitation preview, account/room switching, chat, threads, composer, People, work, Inbox, dialogs, and recovery states.

Review the following journeys end to end:

1. A new person understands the product, accepts an invitation, joins the intended room, and sends a first message.
2. A person returns to an active room, identifies what changed, finds a relevant thread, and replies without losing their place.
3. A person uses conversation without creating work or configuring an agent.
4. A person turns a message into work, chooses responsibility, sees a report, and understands whether review is still needed.
5. A person chooses between using an agent once and connecting an ongoing participant; the distinction and access are understandable.
6. A failed send, uncertain save, expired session, or lost connection preserves the right draft and offers an accurate recovery action.
7. A person switches rooms/accounts while dialogs, pending requests, and drafts exist; context stays with the correct identity.
8. A person finds and changes permissions, removes an agent, and understands the effect on existing activity.
9. A keyboard user completes the same tasks, including People actions and mentions, with visible focus and coherent reading order.
10. A phone user reads and writes a real conversation without fighting nested scrolling or a hidden composer.

For each journey, inspect empty, loading, success, denied, invalid-input, disconnected, retrying, and terminal states where they exist. Check whether the interface provides one understandable next action and preserves relevant context.

Use desktop and 390×844 as comparison fixtures, then additional narrow/reflow and zoom checks. Inspect long names, long messages, many rooms, duplicate names, localization expansion, reduced motion, touch targets, dialogs, focus restoration, and status announcements. Record accessibility behavior and usability separately: a role attribute alone does not prove a control works.

The earlier suggestion that chat/composer occupy at least 60% of the first phone viewport is a design hypothesis, not an accessibility standard. Evaluate it against actual use. Prefer task success, readable content, and stable keyboard/composer behavior over hitting an arbitrary pixel ratio.

Automated browser evidence can establish interactions and some accessibility properties. Real assistive-technology, physical-device, and unfamiliar-person studies remain separate evidence; do not label synthetic actors as human usability validation.

**Evidence:** annotated screenshots only where they explain a defect, journey observations, interaction checks, and concise usability findings tied to a task.

**Completion:** all ten core journeys have a disposition and recovery-state coverage. Missing human/device evidence is named rather than approximated as a pass.

## 14. Workstream H — Build, deployment, operations, and release truth

**Primary targets:** runtime packaging, source stamping, static assets, CI workflows, dependency locks, Node/Worker parity, health/readiness, diagnostics, maintenance, backups, and rollback instructions.

Specific checks:

- Build/package from the exact committed tree in isolation. Confirm the artifact identifies its content and does not silently include dirty shared files.
- Compare all static-asset lists and import closure. Test that missing optional-but-imported modules fail packaging, and that archived packages are not accidentally served.
- Verify required Node/browser/Worker versions and locked dependencies; read current primary advisories when assessing dependency exposure.
- Compare representative flows across Node and the local Worker harness, especially transaction adapters, URL/proxy behavior, clocks, streams, and asset loading.
- Inspect CI branch/PR events, required checks where accessible, failure behavior, cancellation, timeouts, and artifact retention. Distinguish observed merge behavior from inaccessible protection settings.
- Bind test receipts to source and configuration. A supplied TAP file plus the current SHA is not sufficient provenance.
- Check what health/readiness prove and omit: database accessibility, capacity, backup freshness, and ongoing operation are distinct signals.
- Inspect maintenance, backup verification, restore qualification, rollback, and operator error messages. Rehearse locally with synthetic data.
- Inventory security/support/contact/license and incident-response decisions. Identify an owner for missing governance rather than inventing terms or commitments.
- Verify live version and public metadata read-only when useful, then clearly separate deployed capabilities from repository capabilities.

**Evidence:** exact-source package receipt, parity results, CI/release map, operator procedure gaps, and fresh live-read timestamps where collected.

**Completion:** a reviewer can identify what was tested, what could be deployed, what is deployed, and what would be needed to recover. No deployment is part of this audit gate.

## 15. Workstream I — Simplification and maintainability

For each complexity candidate, ask what failure or user cost it causes before proposing deletion or a rewrite.

- Compare duplicate work/session/presence/status predicates and identify a canonical owner.
- Compare route tables, tool manifests, asset lists, test lists, and count pins; identify where generation would remove drift.
- Classify large modules by responsibility and shared state. Propose small extraction seams with behavioral tests rather than a framework migration.
- Classify inactive packages as intentionally separate, awaiting integration, obsolete, or unknown. Ask the lane owner only where intent changes the disposition.
- Review dated documents for contradictions, broken evidence links, and active references. Propose one current index and clear historical status.
- Review open issues/PRs against current implementation and existing audit IDs. Preserve retained scope before recommending closure/rebase.
- Identify duplicate CI work, noisy expected errors, fragile history fixtures, and tests that mirror implementation without checking outcomes.
- Include the cost of the audit machinery itself: prefer a few useful matrices and probes over another permanent layer of overlapping status documents.

**Evidence:** a ranked consolidation list with benefit, dependency, owner, risk, and smallest safe change.

**Completion:** recommendations explain a measurable reduction in drift, failure surface, or user effort. Nothing is deleted solely because it lacks imports today.

## 16. Cross-feature scenarios that must be attempted

These are the first targeted combinations, not the full inventory. Stable IDs make later results and fixes traceable.

| ID | Scenario | Expected boundary to test |
| --- | --- | --- |
| X01 | Account cookie token supplied as Bearer to every private read | Consistent credential-mode rejection. |
| X02 | Exhausted read limit followed by thread/search/export/alias reads | No alternate route bypass. |
| X03 | Many unauthenticated nonexistent room IDs | Total diagnostics and logging remain bounded. |
| X04 | Unlink broad identity, relink narrowly, retry old action | Requested current scope wins; old authority does not return. |
| X05 | Administrator loses one delegated permission before invite redemption | Current authority is checked at redemption. |
| X06 | Account switch while old response and stream events arrive | Old identity data cannot populate the new context. |
| X07 | Halt-all followed by session start/takeover/continuation | Starts refuse; authorized cleanup remains available. |
| X08 | Budget trip plus stale revision or failed stop write | No false stopped receipt; no hidden uncommitted effect. |
| X09 | Old worker resumes after stale-heartbeat takeover | Current ownership and revision win. |
| X10 | Completion awaits verification while People/results/search render | No premature Done or approved-result claim. |
| X11 | Completion replaced or reopened after a result link was copied | Historical and current result status remain distinguishable. |
| X12 | Room instructions change while a work packet is in use | Dependency freshness is explicit. |
| X13 | Commit succeeds, response is lost, client restarts and retries | One effect, stable request identity, accurate reconciliation. |
| X14 | Exact retry after member removal or credential rotation | Current authorization is still required. |
| X15 | Two clients redeem/link/claim the same target concurrently | One consistent winner or defined idempotent result. |
| X16 | Invite-bearing room exports and restores | Authority history reconciles; no append-only-trigger surprise. |
| X17 | Restore an older image after identity/account revocation | No resurrection of revoked authority. |
| X18 | Room reaches admission cap, then removes a member and exports | Cleanup and qualified recovery still work. |
| X19 | Large/deep thread with slow reader and disconnect | Bounded computation/output and cleanup. |
| X20 | Public Commons name collides with an existing private room ID | Public status does not imply access to private history. |
| X21 | Preview join followed by briefing/listen | Finite truthful outcome, no success-to-retry loop. |
| X22 | MCP malformed Origin/version/ID/arguments under load | Correct bounded transport/validation behavior. |
| X23 | Deleted/edited private text flows through search/export/agent packet | Visibility matches disclosed lifecycle and grants. |
| X24 | Dirty source build paired with an unrelated passing test receipt | Qualification refuses the mismatch. |
| X25 | Cold start at a near-capacity valid room | Startup remains measurable and failure does not corrupt data. |
| X26 | Stop or revoke arrives while a stream/export is pending | Future delivery follows a defined revocation policy. |
| X27 | Keyboard-only mention selection followed by rerender | Correct semantics, selection, focus, and draft preservation. |
| X28 | Phone keyboard, thread navigation, incoming message, failed send | Composer and place remain usable; recovery is clear. |

## 17. Evidence and finding format

Each finding should include:

1. Stable ID and short title describing the incorrect behavior.
2. Classification: confirmed defect, source-supported concern, design/readiness gap, documentation drift, or resolved concern.
3. Severity and confidence assessed independently.
4. Exact source baseline and reachable entry point.
5. Required actor, authority, data state, and trigger.
6. Expected behavior and the independent reason for expecting it.
7. Observed behavior, including durable effects and any sensitive-data exposure.
8. Minimal reproduction with synthetic data, plus a successful control.
9. Practical impact and limits of the evidence.
10. Smallest useful fix, regression criteria, dependencies, and lane owner if known.
11. Status: untested hypothesis, confirmed, assigned, source change observed, retest passed, or closed.

A source change observed is not a closed finding. Closure requires the original counterexample to fail safely, legitimate behavior to work, and affected cross-feature checks to pass on the fixed version. A new failure in a different layer is not a repair.

Use severity to prioritize impact and exposure: immediate credential/private-data/authority failures first; reachable corruption, unavailable safety controls, and public abuse paths next; then significant task/accessibility failures; then maintainability and copy. Do not call every missing enterprise capability an emergency vulnerability.

The execution ledger will record inventory ID, invariant IDs, scenario IDs, result, evidence, version, and limitation. It will also retain rejected hypotheses. Finding that a suspected bypass is correctly denied is useful evidence and prevents repeated investigation.

## 18. Execution order and checkpoints

| Wave | Work | Deliverable before moving on |
| --- | --- | --- |
| 0 | Coordination, frozen baseline, new-change queue | Source/environment manifest; no unowned write targets. |
| 1 | Inventory and claim/invariant map | Every reachable surface has a disposition and planned oracle. |
| 2 | Known findings and Grok's reported partial fixes | R1–R6/S1–S6 status against the captured versions; avoid rediscovering unchanged cases. |
| 3 | Auth/route boundaries and public MCP | Workstreams A/D plus X01–X06, X20–X22; urgent findings shared promptly. |
| 4 | Work policy, races, retries, crash/recovery | Workstreams B/C plus X07–X18; durable before/after evidence. |
| 5 | Privacy, global bounds, large/deep state | Workstreams E/F plus X19, X23, X25–X26; bounded resource observations. |
| 6 | Human journeys, accessibility, responsive behavior | Workstream G plus X27–X28; clear automation/manual evidence split. |
| 7 | Packaging, runtime parity, operations, simplification | Workstreams H/I plus X24; exact-source release and cleanup recommendations. |
| 8 | Challenge conclusions and reconcile deltas | Critical tests challenged, duplicates removed, limitations explicit, final prioritized report. |

Each wave is a reviewable checkpoint. Report new consequential findings as they are confirmed; do not wait for the whole document to be finished. A blocker on one wave does not stop independent local review. A known bug is recorded and handed off; repeated reproduction without new information is not progress.

For timing, use evidence-based work blocks rather than promising an arbitrary completion hour. Establish a bounded run for each expensive test. If a probe exceeds its resource budget, stop it, preserve the observation, and choose a smaller valid fixture or a better instrumented test. Do not quietly turn an aborted run into a pass.

## 19. Completion criteria for the third audit

The third audit is complete when:

- Every inventory item has a disposition, and every excluded/blocked item says why.
- Every critical invariant has relevant positive and negative evidence across its reachable entry points.
- Every X01–X28 scenario is executed, explicitly inapplicable, or blocked with a concrete missing prerequisite.
- R1–R6 and S1–S6 have reconciled statuses for the audited baselines, including Grok's newer changes.
- High-risk mutation families have concurrency, retry, revocation, and failure coverage where applicable.
- Core human and agent journeys have an outcome and recovery-state assessment.
- Findings are reproducible, deduplicated, prioritized, and assigned a proposed fix acceptance test.
- Test and package evidence is tied to exact source; uncommitted, committed, CI, and live states are distinct.
- Remaining manual/device/provider/production evidence is listed without being counted as passed.
- Temporary listeners/processes are stopped, shared files are preserved, and audit claims are released at the checkpoint.

Audit completion does not mean release readiness or that all defects are fixed. The report must explicitly distinguish those outcomes. The product can remain release-blocked while the audit itself is complete and useful.

## 20. Expected outputs and immediate next step

Keep the artifact set small:

1. This plan: the audit method and scope.
2. A third-pass report with the execution/coverage ledger, consolidated findings, and links to prior IDs.
3. Minimal reproducible probes and selected screenshots/test receipts in an isolated evidence location; promote regressions into the repository only through an agreed implementation lane.
4. A sequenced remediation backlog grouped by shared root cause and reviewable change, not by how many findings a file happens to contain.

The immediate execution step is Wave 0–1: freeze the committed and local-prototype baselines, enumerate dispatch and mutation surfaces, and produce the route/auth and state-policy matrices. Then verify Grok's partial MCP fixes before treating S5/S6 as current failures. The already confirmed thread, halt, diagnostic, and import problems anchor the first cross-feature tests.

The largest unresolved questions about SSO, retention policy, public-community scope, production storage, real users/devices, and hosted operation should be gathered into a short decision list when they actually block a test. They do not prevent the substantial local audit work above from proceeding.
