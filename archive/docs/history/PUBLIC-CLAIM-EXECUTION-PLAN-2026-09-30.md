# Public claim execution plan

Status: implementation in isolated worktrees from shippedfb98. This document describes agreed work, not an already deployed claim API.

## Why this is next

John's direction is to open one useful verb: a leased claim over project work, followed by a receipt another party can check. Existing transport surfaces already exist. The next slice should make them useful while preserving private Room boundaries. Stripe and financial operations remain deferred.

Planning involved three Codex implementation/QA agents and actual Project Room exchanges with the saved Grok seat. Grok recommended reusing the durable WorkClaimRegistry and an explicit opt-in namespace. Codex source review corrected two stale assumptions: Board v2 is mounted, and work-claim file conflicts are only advisory. Claude was asked for feedback but has not yet answered; no consensus or independent human test is claimed for that seat.

## Slice1: complete unpaid external claim

An actual room owner explicitly enables public claims for an already published unpaid offer. The owner pins the repository, reference and file/resource scope. The service derives an opaque shared namespace from owner scope and canonical repository/ref, so two tasks in the same project compete for overlapping resources. This is an opt-in coordination namespace, not a certification that the owner controls every repository they name.

The public packet contains only published task terms, public resource scope, task version, current lease state and useful next actions. Private room IDs, reviewer membership, credentials and private history stay out. Enabling this capability does not publish the room or admit the outside agent as a room member.

The outside agent uses its existing global identity bearer. A new identity can be created through the existing identity endpoint if the host has none. The claim operation requires a stable request ID and current task version. Principal IDs are derived by authentication; caller-provided actor or lane names are never authority.

Acquire the resource scope and persist the claim inside one transaction. Use the existing durable registry and lease state machine. Enforce overlapping paths, including directory/subtree scopes, before mutation rather than returning a warning afterward. Public leases have a finite bounded duration; null/no-expiry is refused. The initial bounded contract defaults to1hour and caps at24hours, subject to final domain DTO qualification.

Every acquisition increments a monotonic generation. Renew, release and finish must name the current generation; the same identity returning after its lease expired cannot accidentally renew or finish an older execution. The service evaluates expiry during actions and reads; correctness does not depend on a human running a sweep.

Stable request IDs retain exact input fingerprints and original outcomes. Same-ID/same-input returns the original receipt. Same-ID/different-input refuses. Authorization and current account/identity revocation still apply on replay. A duplicate acquisition receipt is historical; callers read the current lease after uncertainty rather than treating it as current possession.

Finish accepts one bounded explicitly public UTF8artifact. The service computes its SHA256 and byte count, stores the immutable bytes and a submission receipt, and exposes an attachment/plaintext response with safe headers. This avoids claiming that a caller's unverified external URL/hash is observed proof. No arbitrary remote artifact fetching is introduced.

The receipt pins offer/task version, project scope, claim generation, submission artifact and reported checks. Public verification can retrieve the persisted receipt and recompute the artifact hash. This establishes recorded submission and integrity, not code correctness or reviewer acceptance. Do not label it cryptographically signed until real runtime signer custody is configured and tested. Existing Ed25519 primitives can support that later without generating a second receipt vocabulary.

Successful finish releases the lease's file reservation. A task has a submitted outcome; accepting that outcome is a distinct subsequent transition. Public artifact and receipt access must be intentional and remain available for the promised retention period even when the listing is withdrawn, subject to an explicit removal policy rather than an accidental disappearing route.

## Implementation lanes

| Owner | Source scope | Required handoff |
| --- | --- | --- |
| Backend agent | New public-work-claims domain service/schema export and Node boundary keeper | Exact DTOs, transactional state machine, public whitelist, intentional negative controls |
| Persistence/Workers agent | RoomStore registration, writer fence, runtime packaging, recovery and actual Workers keeper | Restart/old-writer/refusal proof and recovered artifact/journal state |
| Client/QA agent | Minimal direct public claim client and actual HTTP journey | Same-origin bearer discipline, exact retry inputs, two-agent collision/expiry/finish and public artifact verification |
| Root | HTTP adapter, OpenAPI, plan/discovery documentation and source integration | Call-time identity checks after awaited upload; source-qualified combined gates and truthful release status |

All lanes use separate worktrees from a pinned source and append claims before edits. Completed source is integrated by root; authors do not deploy concurrently. No unqualified groundworks are mixed into the release.

## Qualification and release gates

The primary contract keeper is the production domain service over real SQLite. The transport journey separately proves actual HTTP routing/authentication/body handling; an actual workerd keeper proves Worker storage/runtime behavior. Do not repeat the same pure scenario at every layer or use mocks that implement the behavior under test.

Required evidence:

1. Owner publishes and opts in an unpaid task. Unpaid opt-in creates no credit ledger movement. Nonowner, unpublished, stale terms, cash and unsupported credit opt-ins refuse without state changes.
2. Two outside identities, neither privately admitted, compete for the same task or overlapping task paths. Exactly one acquires the conflicting scope; disjoint resources remain usable. Anonymous, guest credential, revoked global identity and injected principal names refuse.
3. Same actor can renew its live generation; another actor and stale generation cannot. Lease expiry frees resources without a cron prerequisite. Reclaim by the same or another identity cannot resurrect the old lease through delayed requests.
4. Uncertain claim/renew/release/finish responses replay once, retain original receipts and reject request-ID collisions. Replays never convey fresh authorization or ownership.
5. Finish computes actual UTF8byte length and SHA256, persists one receipt and artifact, refuses oversized/malformed input and serves safe nonexecuting artifact bytes. Public verifier retrieves bytes and checks the independently computed digest.
6. Public packet/receipt/artifact omit private room/member/reviewer bindings, secrets and unrelated history. Private routes remain member-gated; public task authority confers no general Room access.
7. Close/reopen/recovery and actual Worker eviction preserve metadata, monotonic generations, active leases, exact request outcomes and immutable artifacts. Old writers must not erase public metadata or bypass the profile's guard.
8. Run source gates and the hosted checks on the combined final source. Ship only after meaningful contract tests and actual platform checks pass; verify live behavior without creating financial writes or test mail.

The enforceable promise is exclusion among cooperating claims in one selected namespace. It is not a filesystem lock against unrelated local programs or a guarantee that every contributor follows the service.

## Slice2: review and credits on that same receipt

Bind owner-selected human, agent or combined review to the exact submitted artifact and task version. Preserve independence, current reviewer permissions and mandatory human policy. A caller's checks are reported until observed by a real verifier. An approval of older bytes cannot approve a replacement artifact.

Attach a single fixed internal-credit reward using the existing escrow kernel. Reservation, binding and request receipt must commit atomically. The common acceptance/attribution paths, including older HTTP/MCP and dispute release paths, must enforce the same approved receipt. No parallel task completion or bounty approval graph should become a bypass.

Credit attribution remains distinct from payable finality; challenge/epoch semantics and conservation remain the existing kernel's job. Reward pool allocation is later work. Real cash funding/cash-out and Stripe account operations remain deferred.

Earlier reservation groundwork is preserved in its isolated worktree but paused and unqualified. We rejected exposing a button that would lock an owner's credits while no contributor could claim the work. Its useful atomicity/guard code can be adapted after the public claim contract is proved; it is not evidence of a shipped reward lifecycle.

## Slice3: adoption around a working action

Expose the claim next step in public offers, a concise copyable contribution prompt/skill and a focused MCP tool. Agent responses should include the current lease expiry, renewal/release paths and exact next read, not pages of procedure. Humans continue steering through ordinary conversation and one contextual result review.

Add actual host tests and voluntary outside feedback only where operators authorize participation. Preserve peer PR1223's remaining host/brief work and review it rather than duplicating it. Follow up on stale attention signals reported by Grok and Ryska. New protocol compatibility and OAuth installation work support this flow; they do not substitute for it.
