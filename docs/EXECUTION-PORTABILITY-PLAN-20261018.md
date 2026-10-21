# Execution portability implementation plan

Status: implementation in progress. This is not a platform qualification receipt.

## Outcome

People can choose an available execution target without knowing sandbox internals.
Agents receive explicit capabilities and actionable errors before accepting work.
Room coordination, provenance, cancellation, recovery and result publication remain
shared; backend-specific enforcement is verified independently.

## Current evidence

The generic configured command host hardcodes Linux bubblewrap. Mac test fixtures
also use temporary path aliases that the production policy correctly refuses.
Resolving those paths exposes the missing Linux isolation backend; it does not
make generic execution supported on Mac. The Codex adapter is a separate path:
it delegates model-tool policy to Codex and must not be presented as equivalent
to isolating an arbitrary process. Official platform reference:
https://learn.chatgpt.com/docs/permissions

Attachment collaboration is separately published in draft PR #4204, head
9fb35762. Preserve that work and its continuity/cross-platform ancestry.

## Phase 1: readiness before work acceptance

- Add a versioned result with backend, platform, ready, reason code and message.
- Distinguish unsupported OS, absent launcher, invalid configuration and failed
  sandbox startup. Never treat executable existence alone as readiness.
- Launch a system no-op inside the same sandbox arguments with a short timeout,
  no ambient environment and no diagnostic output. Never probe by running the
  configured untrusted program.
- Add generic runner --check requiring no Room connection or request journal.
- Refuse unavailable execution before claiming work. --check opens no journal;
  normal retries may open the journal to recover a saved result without execution.
- Preserve actionable structured errors in CLI output.
- Cover these contracts portably with injected probe outcomes and actual CLI
  refusal on unsupported platforms. An injected success is not OS qualification.

Exit: unsupported Mac generic-host runs fail before claiming work, with a precise
reason and no unsandboxed fallback. Linux readiness includes a real launch probe.

## Phase 2: enforce the contract at every entry point

- Audit programmatic runner entry points, not just the CLI; require or invoke
  backend preparation before claiming a new request.
- Preserve reconciliation of already-owned attempts even if readiness changes.
- Recheck execution authorization at use; startup readiness is not permission.
- Avoid a costly repeated probe for every harmless read. Bind readiness evidence
  to backend/configuration and invalidate it when configuration changes.
- Make unsupported-policy errors distinguishable from transport failures.

Exit: no caller can accidentally claim new work for an unavailable backend.

## Phase 3: platform test structure

- Canonicalize test-created temporary directories using realpath; do not relax
  production path-alias refusal.
- Keep pure policy validation, serialization, state and recovery tests portable.
- Identify actual Linux execution tests explicitly. Run them in a required Linux
  CI job with installed bubblewrap and an exercised namespace probe.
- Report unsupported local integration tests explicitly. Do not skip a failing
  probe on a supported CI platform or turn existing failures into blanket skips.
- Add Mac Codex integration checks for actual filesystem and network restrictions,
  private-profile handling, stop, recovery and cleanup. A handshake is insufficient.
- Keep real provider authentication/turn qualification separate from OS checks.

Exit: a Mac portable run is meaningful, Linux isolation is mandatory in CI, and
Mac execution has its own demonstrated contract.

## Phase 4: user and agent interfaces

- Use the existing setup/doctor surfaces to display target readiness, with one
  relevant recovery action. Do not add a new dashboard.
- Give agents the same structured capability response, including policy limits.
- Present Mac Codex and an explicitly selected Linux worker only when configured
  and verified. Do not silently migrate work or credentials to another target.
- Keep third-party executable isolation distinct from trusted Codex tool policy.
- Add an OS-native generic backend only if user demand justifies implementing and
  verifying equivalent guarantees; do not clone a partial sandbox prematurely.

## Phase 5: qualification and release

- Focused contract tests, real supported-backend integration tests, lint, affected
  checks, then required hosted checks. Record unsupported local tests honestly.
- Retain earlier failures and timing controls; do not rerun for a green verdict.
- Publish reviewable commits with exact capability limits. Preserve existing
  merge/deployment coordination and generated-manifest ownership.
- Independently verify the deployed setup flow and request lifecycle.
- Developer ID/public notarized Mac distribution remains deferred. Real-human,
  physical-device and real-provider evidence remain separate qualifications.

## Scope control

No new provider, worker fleet, virtual machine provisioning, silent fallback or
permission expansion is part of the first readiness change. Investigate existing
execution targets before choosing infrastructure. Add follow-up work only when a
specific unsupported journey requires it.

## Implementation checkpoint

Implemented in this branch: structured Linux startup readiness, credential-free
CLI --check, programmatic preparation before new attempts, preserved saved-result
redelivery, canonical temporary fixtures and explicit Linux-only integration
tests. Linux tests skip only on other operating systems: missing bubblewrap or
denied namespaces on Linux remain failures. Existing required Linux CI installs
bubblewrap; the new qualification test requires a real successful sandbox launch.

Local evidence: 50 portable host/reply tests passed with 23 explicitly unsupported
integration cases; the separate readiness suite passed 5 tests with its one Linux
qualification case skipped. An initial syntax error in that new test was repaired
before the successful rerun. Lint reports zero errors and 291 existing warnings.

Not yet qualified: real Linux execution of this revision, native Mac Codex
filesystem/network enforcement, native provider turns, setup UI integration and
deployment. The pinned Codex 0.162.1 sandbox CLI requires a named permission
profile and differs from newer documentation; the attempted isolated probe
refused before executing. This is evidence of an uncompleted qualification, not a
sandbox pass. No credentials were used and no policy fallback was introduced.

## Native Mac boundary receipt — October 18, 2026

Pinned Codex 0.162.1, SHA-256
`74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`.
A disposable App Server used Room's existing legacy sandbox settings,
approval_policy=never, shell_environment_policy.inherit=none, a fresh private
HOME/CODEX_HOME and no credentials. Its command/exec qualification API executed
synthetic commands directly; Room's production RPC allowlist remains unchanged.

| Configured mode | Workspace write | Outside write | Live loopback connection |
| --- | --- | --- | --- |
| read-only | blocked | blocked | blocked |
| workspace-write | allowed | blocked | blocked |

An unsandboxed control connected to the same listener before each check.
Observed command statuses were 1/1/7 and 0/1/7 respectively (touch/touch/curl).
The test launcher terminated each process group and removed disposable files.

This qualifies those command boundaries on this exact runtime and Mac.
It does not establish outside-read isolation, provider authentication, model
execution, app approval UX, physical-device behavior or an end-to-end model turn.
No new backend, VM, setup dashboard or automatic credential migration is needed.
Retain these receipts while runtime and policy are unchanged; run supported
Linux integration in CI and keep provider qualification separately tracked.

The earlier hosted contract failure was a missing documentation reachability
link. The Codex host guide now links this plan; no runtime change was needed.

The separate existing provider qualification also passed on the pinned runtime:
one synthetic model turn produced and published ROOM-QUALIFIED-42 in a local Room;
after stopping and reopening the host, retry returned the same result without a
second model start. Runtime input evidence survived restart (2690 bytes).
This used the existing dedicated qualification profile, not operator credentials.
No production Room was accessed. Physical sleep and interrupted in-flight model
recovery remain outside this receipt.

Hosted Linux unit shards 1/3, 2/3 and 3/3 passed for f0a7f687 in Actions run
39203782981, including the mandatory real Linux sandbox tests. The follow-up
changes only documentation linkage and this receipt; runtime source is unchanged.
Remaining browser/release gates must still pass before merge or deployment.
