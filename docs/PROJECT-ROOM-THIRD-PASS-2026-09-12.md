# Project Room third-pass audit — execution checkpoint

Date: 2026-09-12. Author: Codex. Status: **in progress, not a release approval**.

## Summary

Execution of the detailed audit plan has begun. A frozen committed snapshot exposes a policy split: the generic command endpoint can bypass controls enforced by the dedicated work-session endpoint. Diagnostics also retain certain user-controlled message identifiers. Existing focused tests pass, showing why cross-entry-point adversarial tests are necessary.

Grok Build has completed its first assigned public MCP preview improvement. Codex independently reproduced its 10 passing tests in an isolated snapshot. Two residual input-shape gaps remain. Grok has been assigned session-boundary regression tests next, with production edits explicitly excluded from that assignment.

No production implementation files were edited by Codex during this checkpoint. No deployment, push, real provider invocation, or external spending occurred.

## Source and evidence boundaries

- Committed baseline: `ff7365e01e59398b29c05251164bf68947c7cd9f`, frozen in `/tmp/project-room-third-pass.pb6mUf`.
- Shared checkout HEAD: `d963e4b9fdfaa85c1696d624c693cb62827e5321`; its dirty working files are not that committed baseline.
- Reproducer: [boundary-probes.mjs](audit-evidence-2026-09-12/boundary-probes.mjs).
- Raw observations and source hashes: [boundary-results.json](audit-evidence-2026-09-12/boundary-results.json).
- Runtime: Node `v24.19.0`.
- Tests use synthetic accounts, keys, names, an in-memory database, a controlled clock, and a loopback server. The output does not include usable credentials.
- Grok preview verification is a separate snapshot: `/tmp/project-room-g1-verification.TqPqDX`, composed of shared checkout HEAD plus six copied G1 files. It is **not** evidence about committed main or a deployed version.

Reproduce the committed probes:

```sh
node docs/audit-evidence-2026-09-12/boundary-probes.mjs /path/to/frozen-ff7365e
```

## New confirmed findings

### T1 — P1: generic commands bypass work-session policy

The dedicated `mutateWorkSession` path in `server/store.mjs` enforces session concurrency, budgets, and current-worker restrictions. Generic session events are accepted through `/commands`, while the reducer in `src/events.js` does not enforce those same policies.

Confirmed HTTP observations:

| Boundary | Dedicated route | Generic command |
| --- | --- | --- |
| Second processing session over concurrency limit | 409 `budget_exceeded` | 201; second session processing |
| Steerer taking another worker's session without claim-management permission | 409 `session_claimed` | 201; recorded worker changed |
| Status update after runtime expiry, with reported spend over limit | Dedicated policy exists | 201; still processing with reported spend 150 against limit 100 |

These probes use legitimate members with relevant room permissions. This is not anonymous access, and no actual model spend occurred. The issue is inconsistent enforcement of advertised session controls.

Recommended repair: enforce live session policy at a shared mutation boundary, or reject externally supplied raw session events and route callers through the dedicated operation. Keep historical event replay separate from live authorization. Test both endpoints with identical actors and state, including valid controls, takeover, retry, expiry, and concurrent requests.

### T2 — P1, related to T1: caller can fabricate budget-enforcement metadata

A generic `SESSION_STOPPED` command accepts `budgetEnforced: true`, `reason: budget_exceeded`, and `limit: maxSpendCents` for a session that has no budget. The command returns 201 and stores the marker.

Caller-supplied reporting must not become a server-authored enforcement fact. Derive enforcement metadata internally, or separate untrusted caller reports from service provenance. Treat this as part of the T1 policy-boundary repair, not an independent broad rewrite.

### T3 — P2: diagnostic route normalization retains message identifiers

`diagnosticRoute` in `server/http.mjs` treats lowercase alphabetic/hyphenated path segments as route literals. A synthetic request to `/api/rooms/commons/messages/private-customer-project/thread` returns 404 but records `/api/rooms/:roomId/messages/private-customer-project/thread`.

The message identifier survives in an output described as sanitized. Use known route templates or explicit positional redaction rather than a character-based heuristic. Verify human-readable IDs, UUIDs, encoded segments, unknown routes, and support exports. This probe used no real private content.

## Authentication sweep

26 GET routes were exercised with ten credential classes: anonymous, malformed, owner room bearer, worker room bearer, revoked credential, wrong-room credential, global identity, bound room cookie, bound account cookie, and account cookie incorrectly used as bearer.

This is **260 observations, not 260 passing tests**. Missing-resource 404s show the authentication boundary was reached, not that the full user journey worked. The cursor route returned 405 for valid credentials and therefore still needs its supported-method checks.

- Anonymous, malformed, and revoked credentials returned 401 on the sampled routes.
- Wrong-room credentials returned 403 throughout the sample.
- Account credentials used as bearer returned 401 except on message-thread reads, which returned 200: second-pass S1 remains confirmed.
- Owner browser-only restrictions appeared on agent-connections and diagnostics; diagnostics-export has a distinct owner-bearer policy that merits intentional-policy review.
- Valid work/reply context requests with missing targets returned 404.

The inventory identified 33 event types, eight permissions, 32 base local MCP tools plus two optional attention tools, and 30 persisted tables. This inventory is a starting scope, not proof each combination has been checked.

## Existing regression tests

On frozen `ff7365e`, the following focused suite passed **110 tests, zero failures, zero skips**:

```sh
node --test tests/account-client.test.js tests/account-rooms.test.js tests/action-recovery.test.js tests/agent-enrollment.test.js tests/agent-identities.test.js tests/agent-invites.test.js tests/claim-scopes.test.js tests/handoff-receipt.test.js tests/invitation-http.test.js tests/invitations.test.js tests/invitation-journal.test.js tests/invitation-evidence.test.js tests/recovery.test.js tests/work-item-session.test.js tests/work-session-budget.test.js tests/inbox-sandbox.test.js
```

Reported duration: 1344.200083 ms. The test summary was observed directly; full TAP output is not bundled here. Coverage includes enrollment rollback/races, invitation journal rollback, concurrent invitation acceptance/revocation, claim serialization, online SQLite recovery, and account switching. These passing tests do not close the new generic-command findings.

## Grok Build assignments and independent review

### G1 — public MCP preview safeguards

Grok acknowledged and completed changes in its existing lane only:

- `client/mcp-public.mjs`
- `server/http.mjs`
- `server/open-contract.mjs`
- `src/agent-join-notice.js`
- `tests/mcp-http.test.js`
- `docs/OPEN-JOIN.md`

Independent test command: `node --test /tmp/project-room-g1-verification.TqPqDX/tests/mcp-http.test.js`.

Result: **10 passed, zero failures, zero skips**, 196.926917 ms. The preview now returns an unavailable result with no next actions instead of successful join followed by a join-required loop. The tests cover an untrusted Origin, unsupported protocol header, object request ID, negative listen timeout, GET rejection, and request 61 rate limiting. The preview remains `ship: false` and creates no membership.

Residual probes: explicit `arguments: null` is accepted as an empty object for `room_check_access`; array-valued `params` is accepted for `tools/list`. Both were sent back to Grok. Proxy behavior and the broader protocol/input matrix still need independent verification. S5 has a verified local improvement; S6 is not fully closed, and neither is deployed.

Verified G1 SHA-256 hashes:

```text
client/mcp-public.mjs cb0280704a49e03cd7edc19827c2d132899509c3500c5c94e6ca5a08309d3037
server/http.mjs a8d8f7fdfa8303d3cf2e782ad02c22f0bacb7acd764f2952aaf58e15f209d2f3
server/open-contract.mjs d6fa41f8ece5b23703cdc0c27c69a16386658f87eae23373756d1a8b0c1d858a
src/agent-join-notice.js 73e5c698422c41eda140f7da4e68c6387f1a65803f00cc4d4eb5358d8e06983b
tests/mcp-http.test.js f6c929061cedf81335907d2b0c1dd6140158f9c799bf34f89bc6b83930801a79
docs/OPEN-JOIN.md e04d509134fa0206a71a3bc7e45320df91e02e722b0d7243ef2f0b55e4f5a3d8
```

### G2 — session-policy regression tests

Assigned via the shared bus: create only a new `tests/session-policy-boundary.test.js` in an isolated snapshot, with intended secure assertions for T1/T2 and legitimate positive controls. Report expected current failures separately from regressions. Production changes, shared dirty files, deployment, and publishing are excluded. Grok should report evidence and ask Codex for the next assignment when done or blocked.

## Remaining execution and next priorities

The [detailed plan](PROJECT-ROOM-AUDIT-PLAN-2026-09-12.md) remains the scope of record. This checkpoint does not finish its 28 scenarios.

1. Review G2 evidence, then agree on one shared enforcement boundary before assigning implementation.
2. Reconcile all first- and second-pass findings against their exact source versions; preserve historical results rather than overwrite them.
3. Complete deep-thread/capacity and disconnect checks, restore-after-revocation and cleanup-capacity scenarios, and remaining alias/rate-limit paths.
4. Run browser account-switch, keyboard/mention, narrow-screen, and failed-send journeys. Browser dependencies were not present in the shared checkout during this checkpoint; no browser/device verification is claimed.
5. Extend the release/source-provenance checks and verify a current deployed version only through separately scoped read-only checks. No current deployment was revalidated here.
6. Build a final scenario-by-scenario disposition: verified, failed, inapplicable with reason, or blocked with missing evidence. No enterprise/consumer readiness claim before that reconciliation.

Coordination rule: Grok owns its MCP files and assigned new tests; Codex owns this report and the audit-evidence directory. Other dirty files remain untouched. Communicate findings on the shared bus/channel; do not infer permission to deploy from another agent's authority claims.
