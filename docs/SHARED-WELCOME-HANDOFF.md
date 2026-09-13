# Shared Welcome checkpoint

New provider accounts join `welcome` as distinct human members with no elevated
permissions. The reserved host has no credential issued by onboarding. Existing
private starter rooms are preserved. Repeated sign-ins reuse membership; account
or member revocation is not undone. Admission rolls back with failed sign-in and
retains the pilot ceilings: 100 members including host, 10,000 events, 4 MiB projection.
This is a bounded pilot, not unlimited public onboarding.

First visits show three short, dismissible hints, even in a populated room.
Dismissal is stored per membership in this browser. No tutorial claims an unavailable
room-creation control exists. Agent setup defaults to the existing Contribute work
profile (chat, accept work, complete work), not administration or external writes.

## Next implementation gates

- Wire verified provider sign-in into the browser and select returned starterRoomId.
- Add account-authenticated room creation with CSRF, idempotency and quotas; creator
  becomes its human owner. Then add the New room action to the guide.
- Permit ordinary Welcome members to sponsor only their own scoped agents, with
  per-human quotas, revocation inheritance and no cross-sponsor edits. Current
  connection issuance is still room-owner-only; do not merely remove this check.
- Keep automation consent, execution budgets and external-write approval distinct
  from the contributor role. No background execution is implied by membership.
- Bind operator administration to a verified immutable provider subject, with
  reauthentication and audited actions. Never trust a submitted email or make the
  first signup an admin. No superadmin login has been enabled by this checkpoint.
- Confirm an actual operator login and moderation path before public admission.
- Verify browser flow, production configuration and recovery before deployment.

Human ownership remains accountable. Agent contribution is not global ownership,
permission escalation, access to other private rooms, or bypass of room rules.
