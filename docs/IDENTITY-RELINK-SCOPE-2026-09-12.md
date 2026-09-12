# Identity relink scope repair

## Change

An identity reconnect now applies the newly requested permissions through the
existing live membership command boundary. It no longer restores the member's
historical permissions. This also applies when a separate operation has already
reactivated an unlinked member.

Both initial link and relink responses include the effective `permissions` read
from the committed-in-transaction membership projection. Existing response fields
remain unchanged. No schema migration is required.

The permission change and identity-link insertion share a transaction. Invalid
permissions, insufficient administrator authority, or insertion failure leave the
identity disconnected and roll back the membership event/projection.

## Evidence

Baseline: `ff7365e01e59398b29c05251164bf68947c7cd9f`.
Branch: `codex/project-room-identity-scope`.
Worktree: `/Users/johnpotter/src/project-room-identity-scope`.
Runtime: Node 24.19.0.

Before implementation, the corrected five-case regression fixture had four
failures and one passing duplicate-link control. These failures included missing
effective-scope responses, invalid permission acceptance, and retaining broad
permissions for an independently reactivated member. An initial fixture typo was
corrected before this baseline; that harness error is not defect evidence.

The final eight new tests cover narrower scope, explicitly changed broader scope,
invalid and human-only grants, active-but-unlinked records, duplicate links,
limited administrators, demoted administrators with old credentials, and injected
link-insertion failure with complete rollback. Existing HTTP integration tests
now verify the effective-scope response for initial links and relinks.

Verification:

```sh
node --test tests/agent-identity-scope.test.js tests/agent-identities.test.js tests/agent-invites.test.js tests/agent-enrollment.test.js tests/invitations.test.js tests/invitation-journal.test.js
node scripts/check.mjs
git diff --check
```

- Focused tests: 63 passed, zero failures/skips; 1195.408 ms.
- Full repository check: syntax checks, journey-evidence check, shadow-import
  check, and 1,140 tests passed; zero failures/skips; test duration 23810.156666 ms.
- Whitespace check passed.
- No browser, hosted, real-user, physical-device, or deployment verification is
  implied by this server-only repair.

Verified source SHA-256:

```text
b32711d93ae3c9f328cf696194314f526446738b83ea0928a2fddbd433167cbb  server/agent-identities.mjs
b643a9c1490a46f5352e0d668de9e85d60117a512af684aeba216390f30beb2a  tests/agent-identity-scope.test.js
08d54373ed75ede83aed9d5769856b10dd4a122517ea2f55171ef43121955d2f  tests/agent-identities.test.js
```

## Remaining scope and handoff

This fixes the specific R3 reconnect-permission defect locally. It does not close
the broader identity-lifecycle roadmap: credential rotation, global revocation,
expiry/audience design, explicit multi-connection relink races, and independent
release review remain. Existing historical test evidence must not be relabeled as
proof of those additional capabilities.

The canonical shared checkout and Grok's MCP/session-test lanes are unchanged.
No push, merge, deployment, production data mutation, or external model execution
was performed. Review this isolated branch before integrating the repair into the
active release branch. The ambitious product goal remains active.
