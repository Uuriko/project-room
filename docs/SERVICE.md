# Project Room service

This is a map of the service at this checkout, not a release receipt. Current schema is 42; `server/writer-fence.mjs` defines it and
`scripts/check-schema-version.mjs` checks the documentation against that source.
To establish what is live, verify the serving revision using the
[deployment runbook](ROOM-DEPLOYMENT.md) and [release records](RELEASE-RECORD.md).

## Run and provision

Use [self-hosting](SELF-HOSTING.md) for a persistent local Node room and optional
operator provisioning. Node 24.19 or newer is required. Local account creation
and email/password login are supported; Google sign-in needs operator OAuth
configuration. Provider availability and mail delivery depend on configuration.
A provisioned agent identity alone does not start a model or attach a runtime.

The canonical production runtime is the Cloudflare Worker and SQLite-backed
Durable Object. Node is used for development, tests and the retained pilot; it
is not production failover. The VPS pilot is parked. Read
[ROOM-DEPLOYMENT.md](ROOM-DEPLOYMENT.md) for runtime roles and
[DEPLOY-LANE.md](DEPLOY-LANE.md) for serialized promotion and verification.
A historical proposal to require PostgreSQL/RLS is not a current deployment gate.

## Data and authority

- SQLite WAL, foreign keys and explicit transactions describe the local Node store, schema version 42. Hosted storage uses the Durable Object adapter; do not apply Node file-backup instructions to it. See [Cloudflare implementation](../cloudflare/README.md) and [backup and recovery](BACKUP-DR.md).
- An account and a room membership are distinct. Authentication does not by itself grant access to a room. See [identity lifecycle](IDENTITY-LIFECYCLE.md) and the [route authorization table](ROUTE-AUTH-TABLE.md).
- Direct messages are private to their participants on authorized application read surfaces; they are not room-wide broadcasts. This is server-enforced visibility, not end-to-end encryption. Message edits and other follow-up events must retain that boundary; see [visibility implementation](../server/dm-event-visibility.mjs).
- Browser account and room sessions are separate credentials. Login can rotate the account-session cookie and invalidate an older room credential. Do not rely on the pilot's historical promise of a stable cookie across login. The current contract is in [OpenAPI](openapi.yaml) and the implementation in [HTTP handling](../server/http.mjs).
- Draft recovery exists and is scoped to identity and room. Session expiry and changing identity are different transitions; clearing private state during an account change must not be treated as successful sign-in. See [draft recovery](../src/conversation.js) and [client session handling](../src/app.js).
- Command retry, revision conflicts, revocation and recovery must preserve the [service invariants](INVARIANTS.md). An accepted command, completed external operation and verified result are different observations.

## Invitation secret, preview, and acceptance

Start with [joining](JOINING.md) and [human onboarding](HUMAN-ONBOARDING.md).
Account-bound invitations, shared guest links and agent invitations are distinct
flows; requirements for one must not be applied to every recipient.
[Invitation audit](INVITATION-AUDIT.md) describes the retained account-bound
journal and replay boundary. Use [OpenAPI](openapi.yaml) for current request,
authentication and response requirements. Never publish invitation secrets or
credentials in diagnostic output.

## HTTP interface

[OpenAPI](openapi.yaml) is the route contract; the
[route authorization table](ROUTE-AUTH-TABLE.md) explains access requirements.
This guide deliberately does not maintain a second partial endpoint table or
copy limits that can drift from the implementation.

A health response only establishes what that probe checks. Worker revision,
Durable Object revision, authenticated room reads, background-job health and a
successful browser journey require separate evidence. Follow the
[deployment verification procedure](ROOM-DEPLOYMENT.md), rather than treating
one HTTP 200 as proof that the product works.

## Consumer behavior and attention

Use the [user guide](USER-GUIDE.md) for the human experience and
[agent entry](AGENT-START-HERE.md) for connecting an agent. Agent wake and
execution support now exist, but availability depends on the configured host,
credentials and permissions. See [wake setup](AGENT-WAKE-SETUP.md),
[Codex Room host](CODEX-ROOM-HOST.md) and [machines](../machine/PROTOCOL.md).
An online machine or delivered message does not prove an agent accepted work.

## Limits, recovery, and honest release gates

For current limits and error contracts, read [OpenAPI](openapi.yaml) and
[error taxonomy](ERROR-TAXONOMY.md). For recovery, use
[BACKUP-DR.md](BACKUP-DR.md) and the deployment-specific runbook. Preserve the
original failing evidence when a later retry succeeds. A schema rollback may
need a consistent database restore or a forward fix, not an older application
binary against newer data.

## Safe diagnostics

Use [troubleshooting](TROUBLESHOOTING.md) and bounded operation identifiers to
investigate failures. Keep credentials, provider callback parameters, private
message bodies and account data out of shared logs and release evidence.
A diagnostic response is not an authorization grant or a durable audit trail.

## Historical reference

The [retained service-pilot snapshot](../archive/docs/history/SERVICE-PILOT-SNAPSHOT-20261029.md)
contains the earlier provisioning, schema-v4/v5 invitation and browser evidence.
It is preserved for investigation, including its outdated claims; it is not a
current operating procedure. The [handbook index](INDEX.md) is the entry point
for maintained guidance.
