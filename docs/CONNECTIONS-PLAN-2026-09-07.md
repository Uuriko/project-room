# One connection experience, one work model

September 7, 2026 (local time). Root source audit plus three independent read-only
reviews. User priority: connect agents and other useful tools as seamlessly and
fully as possible. This takes priority over the generic action-dialog polish
backlog. The product goal remains broader; its scheduler is currently paused.

## September 8 implementation update

The original plan below is retained as design history. A is implemented. B now
has local owner-browser enrollment, generation-aware replacement/disconnection,
hash-only credentials, sponsorship checks and schema-9 migration/recovery audits.
The compact desktop/mobile flow and two independent actual-agent contributions
have been exercised using disposable rooms. C has a local, tools-only MCP
2025-11-25 stdio adapter plus a direct client; native vendor-host acceptance is
still pending. No remote OAuth server or hosted execution was added. See
[host routes](AGENT-HOSTS.md) for supported contracts and unverified host recipes,
and [deeper workspace plan](AGENT-WORKSPACE-ROADMAP-2026-09-08.md) for the next scope.

This is local implementation, not a live upgrade or complete onboarding across
all vendors. A schema-9-compatible release fallback still needs qualification;
the frozen v8 package remains useful only for pre-upgrade data and historical tests.

## Decision

Build a single connection lifecycle, with different adapters behind it. Do not
add separate work truth for HTTP, MCP, copied prompts, hosted AI or Dasha.
The human-facing core stays join, talk, choose work, contribute, review, return.
Manual contribution remains first-class and does not require configuration.

The most important missing capability is **room-owner agent enrollment**. Current
member commands can create an agent, but keys require database-side provisioning.
People & agents is display-only. Hosted bootstrap supplies the initial owner,
not arbitrary self-service agent enrollment. An API wrapper or setup card alone
does not close this gap. Do not advertise this foundation as finished onboarding.

## Model and responsibilities

| Component | Owns | Must not imply |
| --- | --- | --- |
| Member | Attributable human/agent identity and room permissions | Verified model/provider identity |
| Connection | Approved route, credential generation, scope, expiry, revocation | A running AI or task |
| Adapter | Delivering a selected request to an approved runtime/tool | Independent authority or task truth |
| Work | Outcome, accountable member, current revision, claims, dependencies | Permission to access outside systems |
| Attempt | Explicit dispatch, identity, budget, status/reconciliation | Completion or human approval |
| Evidence/review | Exact artifact/version and accountable findings | Approval of replaced evidence |

These are proposed responsibilities, not six new dashboards or a claim that all
objects exist today. Reuse existing members/work/events/receipts. Add persistence
only where lifecycle, authority or crash recovery needs durable state.

## Calm human flow

People & agents → **Connect agent** → name and access → private setup → check.

Default access is **Read and chat**, including room history. This truth matters:
`permissions: []` still permits messages/reactions. Assigned-work capabilities
require an explicit choice. Administrative/owner-decision permissions stay human.
Put expiry, capabilities and revoke behind Connection details. Setup instructions
remain secret-free; credentials go only into an approved runtime's secret storage.

After a successful check, offer **Read this work** when a task is selected or
**Catch up** otherwise. Never dispatch just because connection setup succeeded.
Keep **Use my AI** for users who prefer a copied prompt and reviewed draft return.

Status vocabulary must describe evidence:

- Waiting for connection: enrollment/setup exists; no runtime activity proved.
- Access checked at time: the expected credential authenticated at that time.
- Last contact: requires an explicit measured event and a documented freshness rule.
- Working, reported: linked to a work/attempt transition, not inferred from a check.
- Stopping: stop was requested; acknowledged stopping is a separate fact.

No green online dot from token creation, browser transport or periodic polling alone.

## Implementation sequence

### A. Connection foundation — this local implementation

Add an explicit metadata-only client check using existing GET `/api/session`
without a room query. Validate exact room/member, agent kind, active state,
known unique capabilities, expiry and absence of human-account/session bindings.
Return only an allowlisted observation. Check does not read history or work.

Add one strict versioned private configuration reused by CLI reads and watcher.
Exactly one source per process: saved file or environment. Validate the opened
file, not just its name. Save exclusively into a newly selected private directory
after access succeeds; never rotate, overwrite, chmod or silently repair a secret.
Reject malformed/nonprivate/linked files and bound reads. Preserve legacy human
watchers; strict agent setup requires a pinned member. Fixed local errors must not
echo remote text. Pinned operations check identity before the actual authorized
request and bind selected/snapshot/catch-up responses to that member.

Tests: no writes/context during check; expected identity and current access;
expiry/clock uncertainty; TLS/redirect/cancel/timeout behavior; source ambiguity;
file permissions/size/type/links; wrong-viewer response; revoked-key refusal before
watch state creation; unchanged room events, credentials and read markers. A real
agent should use the guide to read a task and deliberately contribute one draft.

This removes repeated configuration and opaque diagnostics. It still requires
an operator to supply credentials; no GUI, MCP or hosted enrollment claim.

### B. Room-owner enrollment — next complete feature

1. Design a versioned issuance/rotation/revocation operation ledger. Include exact
   operation ID/fingerprint, authorized human, member, policy version, expected
   member revision, credential generation, expiry and lifecycle state.
2. Require current authorized human membership administration and browser session
   binding; set kind/accountable sponsor on the server. Check authorization inside
   the same transaction that creates membership and credential metadata.
3. Reuse member events and hash-only credentials. Never expose `issueAccessKey()`
   directly as a retryable button: it currently revokes all old keys on every call.
4. Choose a one-time secret protocol explicitly. A browser-generated random secret
   retained in its owned pending operation can support exact retries without server
   plaintext storage, analogous to invitation creation. Never include it in ordinary
   events, logs, setup prompts or URLs. Lost secret means deliberate rotation, not reveal.
5. Same request/content returns its original result and current lifecycle status.
   Changed content conflicts. Concurrent rotations use expected generation. Old
   retries cannot rotate twice or revive revoked/expired generations.
6. Define sponsorship policy before shipping. Normal owner logout need not stop an
   intentionally running agent; suspended account or lost sponsorship authority must
   not silently leave a privileged orphan. `accountableHumanId` alone does not enforce
   this today. Use current account/member authority plus durable sponsor binding.
7. Rotate preserves member/work attribution. Disconnect revokes future Room access
   and deactivates membership, retaining history. Never claim this kills an outside
   process or retracts already exported text.
8. If owner-visible first contact is needed, use an explicit authenticated metadata
   check-in bound to generation and stable request ID. The current read-only check
   intentionally leaves no shared presence record.
9. Add schema/writer fencing, Node/DO parity, restart, exact-retry, account-change,
   stale-session and concurrent-operation tests. Qualify a lifecycle-aware fallback;
   frozen v8 source is not automatically a safe rollback for new enrollment state.
10. Only then build the compact browser flow, keyboard/mobile/large-text recovery
    and two distinct actual-agent first-contribution exercises.

### C. Native agent adapters, without a second authority model

Start with local stdio MCP backed by the configured agent and existing client.
Choose and test one real host/SDK version. Expose narrow access-check, selected-read
and proposal tools, then explicit workflow operations. Inputs/outputs need contracts;
tool annotations are not authorization. Maintain stable Room command IDs separately
from transport request IDs. Host reconnect must not duplicate business actions.

Remote HTTP MCP is a separate authorization milestone: protected resource discovery,
audience-bound tokens, consent and host compatibility. Do not accept a broad incoming
MCP token as arbitrary downstream authority. Publish an accurate compatibility matrix,
not a universal-MCP claim. An installable skill can explain the same workflow; it must
not contain secrets, self-authorize work, or consume a user's unused budget by default.

### D. Other connections: repository, Dasha, hosted AI, notifications

The same visible connection controls can manage these routes, but their permissions
and costs remain distinct. A Room key is never a GitHub/provider/Compute key.

- Repository: user selects repo/ref/path scope; credential scope, claims/leases,
  branch/write/review policy and conflict handling are checked before mutation.
- Dasha/hosted AI: selected context package and digest, runtime/model identity,
  explicit dispatch grant, deadline and spending ceiling. Persist outbound attempt
  before dispatch; reconcile lost responses; keep unknown cost/status unknown. Start
  with fake backend duplicate/restart/cancel cases, not live paid inference.
- Notifications: explicit destination/opt-in and delivery/outbox semantics; never
  infer permission to email, publish or contact a third party from Room membership.
- External results: portable prompts, skill users and repository PRs return to the
  same work with attributable submission and explicit provenance. Reported authorship
  is not verified production; only exact reviewed evidence supports a decision.

Every adapter needs a useful first action, clear scope, preview where relevant,
stable retry identity, status/recovery, stop/revoke and credential-redacted evidence.
Avoid a connector marketplace full of setup forms before these basics work.

## Research applied, not copied code

- [Linear agents](https://linear.app/developers/agents) separates agent app identity
  and installation from human identity. Inference for Room: creation, authorization
  and actual work/contact should remain different facts; permissions belong at setup.
- [Paperclip authentication](https://docs.paperclip.ing/reference/api/authentication/)
  separates operator and agent credentials and uses one-time returned, hashed keys.
  Borrow identity separation and lifecycle inspection, not trusted-local bypasses.
- [MCP 2026-07-28 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
  remove initialization/protocol sessions in favor of per-request metadata and
  discovery. This is a reason to pin actual compatibility tests. The Room command
  ID must survive a new transport request ID after a broken response.
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
  distinguishes HTTP authorization from local stdio credential configuration.
  Use that separation when staging adapters; setup should not pretend local keys
  alone make a remote OAuth-compatible service.

No third-party source code, SDK or dependency was imported. Product patterns are
design inputs, not proof of our compatibility, user preference or readiness.

## Deferred, preserved findings

Generic work-action dialogs still need exact matching receipts, sticky unknown
retries, preserved fields and explicit stale-evidence review. Never rebase approval
silently. Claim-conflict and invalid-claim-scope rejection are post-ledger cases;
release/reclaim and time-expired leases need distinct confirmation. Older action
responses must not close a newer dialog. Keep this backlog after enrollment.

No production connection, provider account, live key rotation, deployment, payment,
outreach or automatic agent work is authorized by this local implementation plan.
