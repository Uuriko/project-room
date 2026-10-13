# Shared room arrival release

September 20, 2026. John authorized implementation, merge and direct production deployment. This release makes the existing persistent mixed room easier to understand and verifies its entry paths. The longer product roadmap remains in PRODUCT-EXECUTION-PLAN.md.

## Scope and sequence

1. Reconcile current main and research PR #729; preserve Google sign-in and the identity room recovery shipped in #727.
2. Ship the corrected invite-first agent quickstart. Identity plus membership can be created by accepting an invite; creating a separate room is optional. Keep persistent mixed rooms primary in the roadmap.
3. Clarify the room interface: label the mixed roster Participants; describe private Inbox without account-key jargon; qualify automatic agent responses by actual host availability.
4. Verify two human memberships and two independently enrolled agent clients can share one room without creating work, exchange public and targeted messages, reconnect with saved identity, and lose access when revoked. Test invite replay and no unintended room creation. This is protocol-level integration, not proof of autonomous execution by two model vendors.
5. Run focused enrollment/OAuth/invitation/browser journeys, the full unit suite, repository checks and protected PR CI. Inspect desktop/touch rendered results. Preserve exact authorization and private-message filtering.
6. Merge checked changes without bypassing branch protection. Directly deploy both existing Workers with their current bindings, secrets and routes. Record source and provider versions. Do not merge their independent stores.
7. Verify both live versions, readiness, sign-in startup, unauthorized denial, invitation enrollment, room recovery and shared messaging. Use disposable synthetic identities and avoid logging credentials. Confirm the live interface in Chrome.

## Release criteria

- Invites remain tied to the intended room; OAuth context tests and browser acceptance pass.
- People can converse without a work item; agents can participate without a human OAuth account.
- Independent identities reach the same room and recover it after client recreation.
- Targeted messages do not appear to unrelated participants; revoked membership stops access.
- No claim that an enrolled agent is actually executing merely because a mention exists.
- Full required checks pass at the merged source; deployed source and live behavior match.

## Recovery

The previous known-good deployment is source f8c8342: project-room-staging provider e03b4d3d-c542-462a-ad62-98766e374058 and project-room provider 9a543fd7-b907-43d5-8d4b-bcc29aa80ad8. This change requires no database migration. If a deployment fails health or authentication checks, return that target to its previous provider version and record the failure before continuing. Preserve secrets and bindings.

## Follow-up boundaries

Live multi-vendor execution, cross-host coding continuation, revision-bound repository previews, combined-branch testing and a real Inbox-provider-to-fix journey remain follow-up milestones. Existing generic HTTP/CLI/MCP compatibility is not vendor qualification. This release must not market those milestones as complete. The separate historical Telegram credential issue remains a prerequisite for a live Telegram pilot.
