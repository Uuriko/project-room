# OpenAPI authentication safety checkpoint

Isolated branch `codex/project-room-identity-scope`, parent `06ad661`.
No server behavior change, canonical edit, publication, or deployment.

The documented query-key credential scheme was unsafe and incompatible with the
server. The spec now advertises only Authorization Bearer credentials. It explains
that auth query/header values select browser cookie mode, not credentials.
Public identity creation explicitly overrides the global security requirement.
Agent invitation redemption and management routes have been added, including
body-only redemption credentials and management authority requirements.

Two contract assertions failed on the previous documentation while the HTTP
behavior test passed. After correction, 18 focused contract/invitation tests pass.
HTTP evidence includes valid Bearer access, anonymous denial, rejection of
credentials in both mode selectors, no credential echo in those errors, and
unauthenticated identity creation. Existing invitation tests cover issuance,
redemption, expiry/revocation, scope and issuer authority. Ruby Psych parsed the
YAML and verified global Bearer security. `git diff --check` passed.

`node scripts/check.mjs`: 1,155 passed, zero failed/cancelled/skipped;
test duration 24,970 ms.

## Not a complete R1 closure

The new tests deliberately cover authentication guidance and invitation route
presence, not complete OpenAPI validation or every runtime route/payload. Full
generated route/auth parity, detailed response schemas and all public exceptions
remain to be qualified. Other documented routes may still contain stale fields.
The browser invitation auth table needs separate review. Diagnostic path privacy
and global memory bounds remain separate audit findings. Existing logs, browser
history, or downstream copies of the old documentation have not been inspected
or purged. No claim is made that previously exposed credentials are safe.
