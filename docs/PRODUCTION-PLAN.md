# Project Room: consumer and enterprise readiness plan

Working plan, 5 September 2026. This is an execution contract, not a claim that the product is finished, certified, highly available, or production deployed. Each gate below needs recorded evidence. The current reviewed reference is [PR #3](https://github.com/Uuriko/project-room/pull/3) at `c7f5c47eae35ea67d4b70bc868bd17d895011f98`; [Instinct's independent review](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5551116929) covers that version only.

## 1. The product we are actually building

An open, persistent place for people and agents to hang out and work together. The room, not a task dashboard, is home. Social conversation is useful even if it never produces a work item. When someone deliberately turns an idea into work, its context, owner, evidence, verification, and next decision remain attached.

Consumer quality means the experience is welcoming, fast, understandable, accessible, forgiving, and worth returning to. Enterprise quality means the same experience can be operated with verifiable identities, bounded permissions, durable records, isolation, recovery, administration, and accountable change. These are two sets of acceptance criteria for one product, not two separate products.

“Perfect” is not a release condition. We use measurable readiness gates and keep looking for counterexamples. A passing reducer suite does not establish identity security, usable onboarding, service availability, or genuine human-agent collaboration.

## 2. Principles that constrain every slice

1. Conversation first; work is optional structure beside it.
2. Humans and agents share the room but do not share credentials or pretend to be one another.
3. Membership, attention, authorization, completion, verification, and external action are different facts.
4. Never require a person to ferry a transcript between authorized participants.
5. No hidden background listening. Show who can access context and what participation is configured.
6. A message or mention cannot grant a capability, accept work, or authorize spending.
7. No fabricated online status, read receipt, test PASS, evidence version, or completion explanation.
8. Preserve a person's draft and place in the conversation when another member sends a message.
9. Make recovery a normal flow, not an instruction to reset everything.
10. Default to a small, explicit policy; delete unused abstractions before adding machinery.

## 3. Baseline and immediate architectural decision

The reviewed prototype has a useful room UI and six-state work reducer. Its browser log, actor selector, canned receipt buttons, and BroadcastChannel are demonstrations, not a shared service. The immediate slice moves the record and identity checks to the server and removes those demonstration shortcuts from the connected experience.

Use Node 24 and its SQLite interface for a bounded, single-node pilot that can be run without provisioning a paid service. Transactions serialize commands; durable events, command deduplication, and the current projection commit together. Persist only hashes of randomly generated access/session tokens. Use separately provisioned accounts for pilot humans and agents. Human browser access exchanges a key for a short-lived HttpOnly session; agents authenticate using their own key. This is not public account registration, organizational SSO, or a verified connection to a named AI runtime.

The production target remains PostgreSQL plus a real identity provider and organization isolation. Do not hide the pilot's synchronous SQLite calls, single-host storage, provisioned keys, or full-room projections behind a claim of enterprise scalability. Do not create a second database implementation until it can be exercised against a real database in CI.

Research checked on 5 September 2026:

- [Node SQLite documentation](https://nodejs.org/api/sqlite.html): the synchronous interface fits a small local pilot, but long database work blocks the process. Bound requests and measure before expansion.
- [SQLite WAL](https://www.sqlite.org/wal.html): concurrent readers do not make concurrent writes unlimited, and this is not a network-filesystem or multi-region database strategy.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): plan default-deny tenant policies and a restricted application role; account explicitly for table owners and bypass roles.
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): use short-lived server-side sessions, HttpOnly/SameSite cookies, CSRF checks, and a fixed trusted origin. SameSite is not the only defense.
- [HTML server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): give events durable sequence cursors and resume from recorded data. A connected stream is not proof that a person read a message.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): acceptance includes keyboard use, reflow, visible focus, usable targets, clear errors, and status changes that do not steal focus.

These sources inform our design choices; they do not certify this implementation.

## 4. Execution order and stop conditions

Implementation checkpoint, 5 September 2026: slice 10 has a server-backed room, provisioned identity, revisioned/revocable access, protected commands, durable cursor reads and SSE, and a connected UI without simulated identity or seeded presence. [Instinct's review of PR #4](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5551311396) covers `17d2edb031c7aa4614d66fe5e54b2900127d331e`: its service assertions were executed; its rendered desktop/mobile checks covered signed-out entry only. Authenticated layout was source-inspected, not rendered. The supported service version remains Node 24.19 or newer.

Slice 12a adds threads, actor-owned reactions, room search, separate in-memory discussion drafts, and retained message nodes. It clarifies draft lifetime and removes the unused browser storage module identified in that review. The local domain/service/client suite now passes 50/50. The authenticated desktop/mobile browser gate and exact-revision review receipt are required for this slice; prior version PASS results do not carry forward. No deployment or merge has occurred.

### Slice 10: authoritative single-room service

Implement now:

- SQLite schema with version tracking, foreign keys, WAL, durable transaction settings, and prepared statements.
- Append-only ordered events; snapshot projection committed in the same transaction.
- Per-room/per-actor command IDs. An identical retry returns the original event; changed content using that ID conflicts.
- Server-assigned event ID, actor, timestamp, room binding, and idempotency key. Reject attempts to supply them in command JSON.
- Active membership and current capability checks before every read/write, including replayed command requests.
- Separate provisioned human and agent credentials, expiry, rotation/revocation, and child-session invalidation.
- Bounded JSON, strict command shape, structured errors, current revision checks, rate limits, and an explicit static asset allowlist.
- Browser sessions, exact-origin verification, CSRF protection, logout, no browser-stored credentials.
- Paginated cursor reads and server-sent events with reconnect recovery and slow-client handling.
- Authenticated browser client; no actor-switch control or browser-authoritative shared log.
- Explicit “caught up” cursor for the current member only, never a claimed peer processing receipt.
- Honest empty/login/unavailable/offline states; failed sends retain drafts and retry IDs.
- Receipt/check/decision forms require the actual explanation and evidence rather than inserting canned PASS text.

Proof required: two independently authenticated clients exchange a message through the service; restart retains it; duplicate submission persists once; simultaneous stale work edits admit one winner; revoked members cannot read or mutate; one room cannot read another; CSRF and unauthenticated commands are denied; failures leave both log and projection unchanged; missed events can be read after reconnect.

Boundaries: this slice does not connect real remote agents, run their tools, create cloud resources, merge PRs, or deploy publicly.

### Slice 11: production identity and organization isolation

- Select a maintained OIDC provider integration rather than writing password authentication.
- Define account, organization, room membership, invitation, and service-account lifecycles without conflating them.
- Support passkey/SSO-capable sign-in through that provider. Verify issuer, audience, signature, nonce/state, and logout behavior.
- Start with owner, moderator, member, guest, and explicit agent grants; map those to capabilities rather than scattering role-name checks.
- Organization-specific domain/SSO enforcement must be explicit, not inferred from email suffix alone.
- Add member removal, agent-key rotation, session inventory, and account recovery; revoke active streams and refresh rights consistently.
- Move to PostgreSQL with a restricted runtime role and RLS tested under the actual non-owner connection.
- Migrate pilot events without changing their identifiers or retroactively attributing simulated activity to verified accounts.
- Add organization/room access policies to every search, export, attachment, queue, and realtime path.

Proof: two organizations with similar names cannot leak across API, search, events, exports, invites, or agent context. A removed member loses all future access, including existing streams. Restore a backup into an isolated environment and re-run the same checks.

### Slice 12: consumer conversation quality

Implemented in slice 12a: existing reply links form threads; reactions record each member's explicit choice; search returns original room messages; source-to-work links open their original discussion. Room/thread navigation keeps distinct in-memory drafts and retry IDs. Incoming message updates preserve the selected message body and the conversation's scroll anchor. [CONVERSATION.md](CONVERSATION.md) defines the behavior, browser gate, and remaining limits. Create/join/archive navigation, persistent drafts, unread presentation, pinning, moderation, notification delivery, and physical-device accessibility evaluation remain later work.

- Replace inactive room placeholders with real create/join/leave/archive navigation once room membership is durable.
- Threads/replies keep topic context without hiding decisions. “Make this work” links to a message/thread, never clones its transcript.
- Add lightweight reactions with notification budgets, plain-text search, unread markers, pinning, and member mentions only where they reduce friction.
- Future draft persistence must be device-local, scoped to identity and room, and opt-in for sensitive rooms. The current in-memory drafts expire on leaving/reload/session end. Never restore one member's private draft into another account.
- Incoming messages do not reset recipients, forms, selections, scroll, or keyboard focus.
- Let members choose quiet notification defaults; social chat must not wake every agent.
- Make onboarding, empty rooms, denied access, expired sessions, and reconnect recovery understandable without documentation.
- Support reduced motion, keyboard-only use, screen readers, 200% text enlargement, and narrow screens.
- Assess voice or drop-in calls only after text, identity, moderation, and consent are sound; do not ship decorative nonfunctional call buttons.

Proof: a new second human can enter, converse, reply, find context, and leave without making work. A returning member can find a relevant discussion without asking for a recap. Test on actual mobile browsers as well as responsive screenshots.

### Slice 13: agent attention and genuine participation

- Finish [Instinct's attention-contract task](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5551121397).
- Keep connection state and participation policy separate: connected does not mean listening; delivered does not mean processed; replied does not mean acted.
- Route a direct address or task handoff to a named agent with an event cursor and correlation ID. Deduplicate overlapping routes.
- Room subscriptions require explicit scope and a visible opt-in; no ambient scanning of unrelated/private rooms.
- Add queue expiry/cancellation, backpressure, per-room/per-agent response budgets, and a human pause control.
- Treat agent-to-agent output as untrusted conversation; require a fresh task capability before an external action.
- Recheck permissions at execution, not only at enqueue. An offline return cannot resurrect revoked authority.
- Show an honest pending/unavailable state when no runtime is connected. Do not insert a simulated reply while implying a live model answered.

Proof: two real independently authenticated agent runtimes handle a permitted shared task, return evidence, avoid ACK loops, and recover after disconnect without a human carrying context. Measure cost before enabling ambient participation.

### Slice 14: GitHub evidence ingestion

- Use a least-privilege GitHub App bound to approved repositories.
- Validate delivery signatures, deduplicate delivery IDs, record ingest status, and acknowledge promptly.
- Fetch authoritative current resources after a wake-up; keep supplied event data distinct from source verification.
- Normalize immutable PR heads, commit/check results, reviews, and source-linked conversation as evidence.
- Ensure a changed PR head cannot inherit an earlier PASS or approval.
- Preserve inaccessible-source status without fetching with someone else's credentials or leaking private previews.
- Test retries, delayed events, edits, duplicate comments, renamed repos, deleted sources, and rate limits.

Proof: a real source-to-room evidence round trip requires zero pasted transcripts and cannot silently mark unavailable evidence verified.

### Slice 15: controlled external actions

- Start with one small approved action type, not arbitrary commands or a universal agent execution service.
- Intersect identity, active membership, room capability, connector permission, task scope, and contested-write claim.
- Persist intent before calling the source; persist the receipt afterward. An uncertain outcome must be reconciled at the source before retry.
- Bind approval to the exact operation and version; invalidate it if consequential input changes.
- Offer a clear preview, cancel path, and visible history. Keep deployment, spending, and irreversible actions gated.
- Run agents outside the web process with bounded resources, explicit tool allowlists, and no implicit access to application secrets.

Proof: interrupted and duplicated requests never cause a repeated external side effect in the exercised cases. Use source-issued operation IDs or a reconciliation strategy; do not promise universal exactly-once delivery.

### Slice 16: operations, trust, and launch readiness

- Add bounded structured diagnostics with no tokens, message bodies, or private source content by default.
- Define indicators for accepted-command durability, message delivery latency, error rate, queue lag, and recovery time.
- Set capacity and availability objectives only after load measurements; publish tested limits rather than invented numbers.
- Exercise migrations, rollback of application versions, backup/restore, key rotation, worker failure, storage exhaustion, and source outages.
- Deploy staging with synthetic data first; test a separate production configuration with TLS and secret management before real users.
- Prepare runbooks for account loss, abusive agents, spam, data deletion, connector revocation, and incident communication.
- Define privacy, retention, export, account deletion, and moderation behavior before collecting customer/candidate data.
- Treat compliance certification as a separate evidence program. Do not imply SOC 2, GDPR compliance, or enterprise procurement readiness from code checks.

Proof: a recorded restore drill, operational owner, tested alert, bounded incident procedure, agreed privacy/retention policy, and explicit release authorization.

## 5. Acceptance matrix

| Area | Consumer expectation | Enterprise expectation | Required evidence |
| --- | --- | --- | --- |
| Identity | Easy, recoverable entry | SSO/service accounts and revocation | Provider integration + removal tests |
| Conversation | Natural, fast, draft-safe | Scoped history and moderation | Real second-user flow + access tests |
| Agents | Visible, useful, quiet when not needed | Bounded tools/context/cost | Real runtime receipts + pause/revoke tests |
| Work | Context stays attached | Exact provenance and separate checks | Versioned loop + restart replay |
| Storage | Messages do not vanish | Recovery, retention, tenant isolation | Transaction/restart/restore tests |
| Notifications | No spam or needless interruption | Auditable routing policies | Duplicate/offline/cancel scenarios |
| Accessibility | Usable on a phone and keyboard | Documented evaluation | Rendered/browser/assistive-tech checks |
| Operations | Failures explain what to do | Ownership, monitoring, incident process | Staging drills + release evidence |

## 6. Things to delete or refuse to add

- Browser actor switching from any connected environment.
- Fictional “here now,” “read,” or “listening” claims derived from membership.
- Canned evidence, checks, approval reasons, and pretend agent replies.
- Shared credentials and implicit owner impersonation.
- An all-purpose workflow engine, speculative microservices, model marketplace, or second project/task object.
- Unbounded full-history broadcasts for each small message.
- Disabled navigation that looks like an available product feature.
- Features whose only success metric is more agent messages.

## 7. How Codex and Instinct work together

Codex owns the scoped implementation branch and records the exact changed paths. Instinct pressure-tests the next design and then independently reviews a concrete commit. Reviews state whether they are code reading, executed assertions, rendered UI checks, or live delivery observations. A PASS applies only to the checked version and scope.

The shared mailbox is [Dasha Desk PR #167](https://github.com/Uuriko/dasha-desk/pull/167). Product changes live in product PRs. No additional ACK chatter is needed. The pre-existing PR #1 conflict is kept visible and must be resolved/re-reviewed before stack integration; it is not a reason to force a merge.

## 8. Definition of this iteration being done

The current conversation slice is implemented above the durable service, relevant domain and authenticated browser checks pass, exact changed files and limitations are recorded, and the independent review handoff is posted. The product remains unfinished until later gates pass. There is no promise of continuous execution, instantaneous replies, or an unattended production release.
